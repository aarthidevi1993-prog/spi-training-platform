import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { newestFirst, readAllByKeyset } from "@/lib/supabase/paging";
import type {
  Json,
  QuestionOptionsRow,
  QuestionStatusColumn,
  QuestionTypeColumn,
  QuestionsRow,
} from "@/lib/supabase/types";

/**
 * Questions repository — the only module that knows where Question Bank
 * data lives (public.questions / question_options, 0007_question_bank.sql).
 * Supabase mode only: there is deliberately no demo/mock question data.
 *
 * RLS is the authoritative boundary (super admin: all; trainer: courses
 * they CURRENTLY teach; student/anon: nothing). Writes never touch the
 * tables directly: create/update go through public.save_question(jsonb)
 * and status changes through public.set_question_status(...), both of
 * which derive identity from auth.uid(). The only direct write is the
 * super admin's draft delete (questions_admin_delete_draft policy).
 * created_by / updated_by / revision / timestamps are stamped by the
 * database and never sent from here.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export class QuestionRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "QuestionRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[questions] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new QuestionRepositoryError();
  return supabase;
}

/**
 * Database errors that carry a message written for users (raised by the
 * 0007 functions/triggers). Raw Postgres messages for the same codes
 * (constraint names, "permission denied for table …") are replaced with
 * a safe per-code fallback so no internals reach the browser.
 */
const USER_FACING_FALLBACK: Record<string, string> = {
  "23514": "This question isn't valid. Please check it and try again.",
  "22023": "Some question details are invalid. Please check them and try again.",
  "42501": "You don't have permission to do that.",
  "23503": "That course or module no longer exists.",
};
const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax/i;

function toRepositoryError(error: unknown, genericMessage?: string): QuestionRepositoryError {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const fallback = USER_FACING_FALLBACK[code];
    if (fallback) {
      const message = String((error as { message?: unknown }).message ?? "");
      return new QuestionRepositoryError(message && !RAW_POSTGRES_MESSAGE.test(message) ? message : fallback);
    }
  }
  return new QuestionRepositoryError(genericMessage);
}

/** Wrap a repository call: log details, surface a safe message. */
async function run<T>(context: string, fn: () => Promise<T>, genericMessage?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QuestionRepositoryError) throw err;
    logDbError(context, err);
    throw toRepositoryError(err, genericMessage);
  }
}

export type QuestionRecord = Pick<
  QuestionsRow,
  | "id"
  | "course_id"
  | "module_id"
  | "question_text"
  | "question_type"
  | "marks"
  | "status"
  | "explanation"
  | "revision"
  | "updated_at"
> & { question_options: Pick<QuestionOptionsRow, "option_text" | "display_order" | "is_correct">[] };

export interface ManageableCourseRecord {
  id: string;
  course_code: string;
  title: string;
  modules: { id: string; module_code: string; title: string; sequence: number }[];
}

/** Who the caller may manage: everything (super admin) or one trainer's current courses. */
export type QuestionScope = { kind: "all" } | { kind: "trainer"; trainerId: string };

/** The save_question(jsonb) payload. Audit fields are never part of it. */
export interface SaveQuestionPayload {
  id?: string;
  course_id: string;
  module_id: string | null;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  explanation: string | null;
  options: { option_text: string; is_correct: boolean }[];
}

const QUESTION_SELECT =
  "id, course_id, module_id, question_text, question_type, marks, status, explanation, revision, updated_at, question_options ( option_text, display_order, is_correct )";

export const questionsRepository = {
  /**
   * Questions the caller may see (RLS), newest change first. courseIds
   * limits to those courses. Reads every page (keyset on id), so banks
   * larger than one response are never silently truncated.
   */
  listQuestions(courseIds: string[] | null): Promise<QuestionRecord[]> {
    if (courseIds && courseIds.length === 0) return Promise.resolve([]);
    return run("listQuestions", async () => {
      const supabase = await client();
      const rows = await readAllByKeyset((afterId, limit) => {
        let query = supabase.from("questions").select(QUESTION_SELECT).order("id", { ascending: true }).limit(limit);
        if (courseIds) query = query.in("course_id", courseIds);
        if (afterId) query = query.gt("id", afterId);
        return query;
      });
      return rows.sort(newestFirst);
    });
  },

  /** One question with its options (null when missing or not visible to the caller). */
  getQuestion(questionId: string): Promise<QuestionRecord | null> {
    return run(`getQuestion(${questionId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("questions").select(QUESTION_SELECT).eq("id", questionId).maybeSingle();
      if (error) throw error;
      return data;
    });
  },

  /**
   * Courses (with modules) the caller may manage questions for. Trainer
   * scope matches 0007's is_course_trainer: the assigned trainer of an
   * UPCOMING or ONGOING batch of the course — historical assignments
   * (completed/cancelled batches) are deliberately excluded.
   */
  listManageableCourses(scope: QuestionScope): Promise<ManageableCourseRecord[]> {
    return run("listManageableCourses", async () => {
      const supabase = await client();

      let courseIds: string[] | null = null;
      if (scope.kind === "trainer") {
        const { data, error } = await supabase
          .from("batches")
          .select("course_id")
          .eq("trainer_id", scope.trainerId)
          .in("status", ["upcoming", "ongoing"]);
        if (error) throw error;
        courseIds = Array.from(new Set((data ?? []).map((row) => row.course_id)));
        if (courseIds.length === 0) return [];
      }

      let query = supabase
        .from("courses")
        .select("id, course_code, title, modules ( id, module_code, title, sequence )")
        .order("course_code");
      if (courseIds) query = query.in("id", courseIds);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((course) => ({
        ...course,
        modules: [...(course.modules ?? [])].sort((a, b) => a.sequence - b.sequence),
      }));
    });
  },

  /** Create (no id) or update (with id) a question + all its options atomically. Returns its id. */
  saveQuestion(payload: SaveQuestionPayload): Promise<string> {
    return run(
      "saveQuestion",
      async () => {
        const supabase = await client();
        const { data, error } = await supabase.rpc("save_question", { payload: payload as unknown as Json });
        if (error) throw error;
        if (!data) throw new QuestionRepositoryError("We couldn't save the question. Please try again.");
        return data;
      },
      "We couldn't save the question. Please try again."
    );
  },

  setQuestionStatus(questionId: string, status: QuestionStatusColumn): Promise<void> {
    return run(
      `setQuestionStatus(${questionId})`,
      async () => {
        const supabase = await client();
        const { error } = await supabase.rpc("set_question_status", { p_question_id: questionId, p_status: status });
        if (error) throw error;
      },
      "We couldn't update the question. Please try again."
    );
  },

  /** Super admin draft delete; returns false when nothing was deleted (RLS / not a draft). */
  deleteDraftQuestion(questionId: string): Promise<boolean> {
    return run(
      `deleteDraftQuestion(${questionId})`,
      async () => {
        const supabase = await client();
        const { data, error } = await supabase
          .from("questions")
          .delete()
          .eq("id", questionId)
          .eq("status", "draft")
          .select("id");
        if (error) throw error;
        return (data ?? []).length > 0;
      },
      "We couldn't delete the question. Please try again."
    );
  },
};
