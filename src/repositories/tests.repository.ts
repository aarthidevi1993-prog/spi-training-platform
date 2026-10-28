import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { newestFirst, readAllByKeyset } from "@/lib/supabase/paging";
import type {
  QuestionTypeColumn,
  TestQuestionOptionsRow,
  TestQuestionsRow,
  TestsRow,
  TestsUpdate,
  TestTypeColumn,
} from "@/lib/supabase/types";

/**
 * Tests repository — the only module that knows where class tests live
 * (public.tests / test_questions / test_question_options, 0008_tests.sql).
 * Supabase mode only: there is deliberately no demo/mock test data.
 *
 * RLS is the authoritative boundary (super admin: all; trainer: manage
 * tests of batches they CURRENTLY run, read tests of their batches and
 * classes; student/anon: nothing in 0008). Frozen questions are never
 * written here directly: add_test_questions / remove_test_question copy
 * and remove them server-side. Audit fields and the stored status
 * normalisation are handled by the database (tests_stamp /
 * tests_validate) and never sent from here.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export class TestRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "TestRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[tests] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new TestRepositoryError();
  return supabase;
}

/**
 * Database errors that carry a message written for users (raised by the
 * 0008 triggers/functions). Raw Postgres messages for the same codes
 * (constraint names, "permission denied for table …") are replaced with
 * a safe per-code fallback so no internals reach the browser.
 */
const USER_FACING_FALLBACK: Record<string, string> = {
  "23514": "These test settings aren't valid. Please check them and try again.",
  "22023": "Some test details are invalid. Please check them and try again.",
  "42501": "You don't have permission to do that.",
  "23503": "That class, question or test no longer exists.",
};
const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax/i;

function toRepositoryError(error: unknown, genericMessage?: string): TestRepositoryError {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const fallback = USER_FACING_FALLBACK[code];
    if (fallback) {
      const message = String((error as { message?: unknown }).message ?? "");
      return new TestRepositoryError(message && !RAW_POSTGRES_MESSAGE.test(message) ? message : fallback);
    }
  }
  return new TestRepositoryError(genericMessage);
}

/** Wrap a repository call: log details, surface a safe message. */
async function run<T>(context: string, fn: () => Promise<T>, genericMessage?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TestRepositoryError) throw err;
    logDbError(context, err);
    throw toRepositoryError(err, genericMessage);
  }
}

export type TestRecord = Pick<
  TestsRow,
  | "id"
  | "class_id"
  | "batch_id"
  | "test_type"
  | "title"
  | "instructions"
  | "status"
  | "pass_mark_percent"
  | "time_limit_minutes"
  | "attempt_limit"
  | "available_from"
  | "available_until"
> & {
  classes: {
    title: string;
    class_date: string;
    course_id: string;
    courses: { course_code: string; title: string } | null;
    batches: { batch_code: string; name: string; status: string; trainer_id: string | null } | null;
  } | null;
};

export type TestQuestionRecord = Pick<
  TestQuestionsRow,
  "id" | "position" | "question_type" | "question_text" | "marks" | "source_question_id" | "source_revision"
> & { test_question_options: Pick<TestQuestionOptionsRow, "option_text" | "display_order" | "is_correct">[] };

export interface ClassOptionRecord {
  id: string;
  title: string;
  class_date: string;
  batch_id: string;
  status: string;
  courses: { course_code: string } | null;
  batches: { batch_code: string; status: string } | null;
}

export interface CandidateQuestionRecord {
  id: string;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  updated_at: string;
  modules: { title: string } | null;
}

/** Who the caller may create tests for: everything (super admin) or one trainer's current batches. */
export type TestScope = { kind: "all" } | { kind: "trainer"; trainerId: string };

/** Editable test columns (never class/batch/status/audit). */
export interface TestSettingsFields {
  test_type?: TestTypeColumn;
  title?: string;
  instructions?: string | null;
  pass_mark_percent?: number | null;
  time_limit_minutes?: number | null;
  attempt_limit?: number;
  available_from?: string | null;
  available_until?: string | null;
}

const TEST_SELECT = `
  id, class_id, batch_id, test_type, title, instructions, status, pass_mark_percent,
  time_limit_minutes, attempt_limit, available_from, available_until,
  classes ( title, class_date, course_id, courses ( course_code, title ), batches ( batch_code, name, status, trainer_id ) )
`;

export const testsRepository = {
  /** Tests the caller may see (RLS), newest first. */
  listTests(): Promise<TestRecord[]> {
    return run("listTests", async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("tests").select(TEST_SELECT).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    });
  },

  /** One test (null when missing or not visible to the caller). */
  getTest(testId: string): Promise<TestRecord | null> {
    return run(`getTest(${testId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("tests").select(TEST_SELECT).eq("id", testId).maybeSingle();
      if (error) throw error;
      return data;
    });
  },

  /** Question count + total marks per test (frozen rows the caller may read). */
  listQuestionStats(testIds: string[]): Promise<Map<string, { count: number; marks: number }>> {
    if (testIds.length === 0) return Promise.resolve(new Map());
    return run("listQuestionStats", async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("test_questions").select("test_id, marks").in("test_id", testIds);
      if (error) throw error;
      const stats = new Map<string, { count: number; marks: number }>();
      for (const row of data ?? []) {
        const entry = stats.get(row.test_id) ?? { count: 0, marks: 0 };
        entry.count += 1;
        entry.marks += Number(row.marks);
        stats.set(row.test_id, entry);
      }
      return stats;
    });
  },

  /** The frozen question set with options (staff only under RLS), in position order. */
  listTestQuestions(testId: string): Promise<TestQuestionRecord[]> {
    return run(`listTestQuestions(${testId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("test_questions")
        .select(
          "id, position, question_type, question_text, marks, source_question_id, source_revision, test_question_options ( option_text, display_order, is_correct )"
        )
        .eq("test_id", testId)
        .order("position");
      if (error) throw error;
      return data ?? [];
    });
  },

  /**
   * Classes the caller may create tests for: not cancelled, in a batch
   * that isn't cancelled. Trainer scope matches 0008's
   * is_current_batch_trainer — batches they are assigned to that are
   * UPCOMING or ONGOING (historical assignments excluded).
   */
  listManageableClasses(scope: TestScope): Promise<ClassOptionRecord[]> {
    return run("listManageableClasses", async () => {
      const supabase = await client();

      let batchIds: string[] | null = null;
      if (scope.kind === "trainer") {
        const { data, error } = await supabase
          .from("batches")
          .select("id")
          .eq("trainer_id", scope.trainerId)
          .in("status", ["upcoming", "ongoing"]);
        if (error) throw error;
        batchIds = (data ?? []).map((row) => row.id);
        if (batchIds.length === 0) return [];
      }

      let query = supabase
        .from("classes")
        .select("id, title, class_date, batch_id, status, courses ( course_code ), batches ( batch_code, status )")
        .neq("status", "cancelled")
        .order("class_date", { ascending: false });
      if (batchIds) query = query.in("batch_id", batchIds);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).filter((row) => row.batches?.status !== "cancelled");
    });
  },

  /**
   * Active bank questions of a course the caller may read (RLS: admin, or
   * current course trainer), newest change first. Reads every page (keyset
   * on id), so courses with more than one response of questions are never
   * silently truncated.
   */
  listCandidateQuestions(courseId: string): Promise<CandidateQuestionRecord[]> {
    return run("listCandidateQuestions", async () => {
      const supabase = await client();
      const rows = await readAllByKeyset((afterId, limit) => {
        let query = supabase
          .from("questions")
          .select("id, question_text, question_type, marks, updated_at, modules ( title )")
          .eq("course_id", courseId)
          .eq("status", "active")
          .order("id", { ascending: true })
          .limit(limit);
        if (afterId) query = query.gt("id", afterId);
        return query;
      });
      return rows.sort(newestFirst);
    });
  },

  /** New tests always start as drafts (the database enforces it too). */
  insertTest(classId: string, batchId: string, fields: Required<Pick<TestSettingsFields, "test_type" | "title">> & TestSettingsFields): Promise<string> {
    return run(
      "insertTest",
      async () => {
        const supabase = await client();
        const { data, error } = await supabase
          .from("tests")
          .insert({ ...fields, class_id: classId, batch_id: batchId, status: "draft" })
          .select("id")
          .single();
        if (error) throw error;
        return data.id;
      },
      "We couldn't create the test. Please try again."
    );
  },

  /** Update settings and/or status; returns false when no row was changed (RLS). */
  updateTest(testId: string, fields: Omit<TestsUpdate, "id" | "class_id" | "batch_id">): Promise<boolean> {
    return run(
      `updateTest(${testId})`,
      async () => {
        const supabase = await client();
        const { data, error } = await supabase.from("tests").update(fields).eq("id", testId).select("id");
        if (error) throw error;
        return (data ?? []).length > 0;
      },
      "We couldn't update the test. Please try again."
    );
  },

  /** Deletes a draft; returns false when nothing was deleted (RLS / not a draft). */
  deleteDraftTest(testId: string): Promise<boolean> {
    return run(
      `deleteDraftTest(${testId})`,
      async () => {
        const supabase = await client();
        const { data, error } = await supabase.from("tests").delete().eq("id", testId).eq("status", "draft").select("id");
        if (error) throw error;
        return (data ?? []).length > 0;
      },
      "We couldn't delete the test. Please try again."
    );
  },

  /** Copy active bank questions into a draft test (server-side copy). Returns how many were added. */
  addQuestions(testId: string, questionIds: string[]): Promise<number> {
    return run(
      `addQuestions(${testId})`,
      async () => {
        const supabase = await client();
        const { data, error } = await supabase.rpc("add_test_questions", { p_test_id: testId, p_question_ids: questionIds });
        if (error) throw error;
        return data ?? 0;
      },
      "We couldn't add the questions. Please try again."
    );
  },

  removeQuestion(testQuestionId: string): Promise<void> {
    return run(
      `removeQuestion(${testQuestionId})`,
      async () => {
        const supabase = await client();
        const { error } = await supabase.rpc("remove_test_question", { p_test_question_id: testQuestionId });
        if (error) throw error;
      },
      "We couldn't remove the question. Please try again."
    );
  },
};
