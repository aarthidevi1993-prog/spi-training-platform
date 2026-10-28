import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  Json,
  TestAttemptAnswersRow,
  TestAttemptsRow,
  TestBestResultsRow,
  TestSecurityEventTypeColumn,
  TestsRow,
} from "@/lib/supabase/types";

/**
 * Results repository — staff reads of the 0009 result data
 * (test_attempts, test_best_results, test_attempt_answers,
 * test_security_events) and the staff finalize sweep
 * (staff_finalize_due_attempts).
 *
 * Always the caller's own session (never the service role): RLS limits
 * every read to super admins and the batch's CURRENT trainer
 * (upcoming/ongoing batch). Nothing here writes result data — scores
 * are graded once by the database at finalization. Students never
 * reach this module (they use student_available_tests()).
 */

const GENERIC_DB_ERROR = "We couldn't load the results. Please try again.";

export class ResultsRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "ResultsRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[results] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new ResultsRepositoryError();
  return supabase;
}

const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax/i;

async function run<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ResultsRepositoryError) throw err;
    logDbError(context, err);
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
    const message = err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : "";
    // 42501 raised by staff_finalize_due_attempts carries a user-facing message.
    if (code === "42501") {
      throw new ResultsRepositoryError(
        message && !RAW_POSTGRES_MESSAGE.test(message) ? message : "You don't have permission to do that."
      );
    }
    throw new ResultsRepositoryError();
  }
}

/** PostgREST returns at most 1000 rows per request: read every page. */
const PAGE_SIZE = 1000;
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

/** Keep `.in(...)` filters to a safe URL length. */
const IN_CHUNK = 100;
export function chunk<T>(values: T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export type ResultsTestRecord = Pick<
  TestsRow,
  "id" | "batch_id" | "status" | "available_from" | "available_until" | "pass_mark_percent"
> & {
  classes: { batches: { trainer_id: string | null; status: string } | null } | null;
};

export type AttemptRecord = Pick<
  TestAttemptsRow,
  | "id"
  | "student_id"
  | "attempt_number"
  | "status"
  | "started_at"
  | "deadline_at"
  | "finalized_at"
  | "finalize_reason"
> & { students: { full_name: string; student_code: string } | null };

export type BestResultRecord = Pick<
  TestBestResultsRow,
  "test_id" | "batch_id" | "student_id" | "best_attempt_id" | "score" | "max_score" | "percentage" | "passed" | "finalized_at"
>;

export type GradedAnswerRecord = Pick<TestAttemptAnswersRow, "attempt_id" | "test_question_id" | "is_correct" | "marks_awarded">;

export interface FrozenQuestionRecord {
  id: string;
  position: number;
  question_text: string;
  marks: number;
}

export interface IndicatorRecord {
  event_type: TestSecurityEventTypeColumn;
  student_id: string | null;
}

export const resultsRepository = {
  /** The test with its batch's trainer/status (null when missing or not visible). */
  getTest(testId: string): Promise<ResultsTestRecord | null> {
    return run(`getTest(${testId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("tests")
        .select("id, batch_id, status, available_from, available_until, pass_mark_percent, classes ( batches ( trainer_id, status ) )")
        .eq("id", testId)
        .maybeSingle();
      if (error) throw error;
      return data;
    });
  },

  /** Every attempt of a test (RLS: admin / current batch trainer). */
  listAttempts(testId: string): Promise<AttemptRecord[]> {
    return run(`listAttempts(${testId})`, async () => {
      const supabase = await client();
      return readAllPages((from, to) =>
        supabase
          .from("test_attempts")
          .select(
            "id, student_id, attempt_number, status, started_at, deadline_at, finalized_at, finalize_reason, students ( full_name, student_code )"
          )
          .eq("test_id", testId)
          .order("id")
          .range(from, to)
      );
    });
  },

  /** Best finished attempt per student for one test (test_best_results). */
  listBestResultsForTest(testId: string): Promise<BestResultRecord[]> {
    return run(`listBestResultsForTest(${testId})`, async () => {
      const supabase = await client();
      return readAllPages((from, to) =>
        supabase
          .from("test_best_results")
          .select("test_id, batch_id, student_id, best_attempt_id, score, max_score, percentage, passed, finalized_at")
          .eq("test_id", testId)
          .order("student_id")
          .range(from, to)
      );
    });
  },

  /** Graded answers of the given (finished) attempts. */
  listGradedAnswers(attemptIds: string[]): Promise<GradedAnswerRecord[]> {
    if (attemptIds.length === 0) return Promise.resolve([]);
    return run("listGradedAnswers", async () => {
      const supabase = await client();
      const rows: GradedAnswerRecord[] = [];
      for (const ids of chunk(attemptIds)) {
        rows.push(
          ...(await readAllPages((from, to) =>
            supabase
              .from("test_attempt_answers")
              .select("attempt_id, test_question_id, is_correct, marks_awarded")
              .in("attempt_id", ids)
              .not("is_correct", "is", null)
              .order("attempt_id")
              .order("test_question_id")
              .range(from, to)
          ))
        );
      }
      return rows;
    });
  },

  /** The frozen question set (text + marks only; no answer key is read here). */
  listFrozenQuestions(testId: string): Promise<FrozenQuestionRecord[]> {
    return run(`listFrozenQuestions(${testId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("test_questions")
        .select("id, position, question_text, marks")
        .eq("test_id", testId)
        .order("position");
      if (error) throw error;
      return data ?? [];
    });
  },

  /** Non-routine activity events of a test (routine saves/starts/submits are not read). */
  listIndicators(testId: string, types: TestSecurityEventTypeColumn[]): Promise<IndicatorRecord[]> {
    return run(`listIndicators(${testId})`, async () => {
      const supabase = await client();
      return readAllPages((from, to) =>
        supabase
          .from("test_security_events")
          .select("event_type, student_id")
          .eq("test_id", testId)
          .in("event_type", types)
          .order("id")
          .range(from, to)
      );
    });
  },

  /**
   * Finalize every in-progress attempt of the test that must stop now
   * (staff_finalize_due_attempts: super admin or current trainer; the
   * database decides which attempts are due and grades them).
   */
  finalizeDueAttempts(testId: string): Promise<Json> {
    return run(`finalizeDueAttempts(${testId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase.rpc("staff_finalize_due_attempts", { p_test_id: testId });
      if (error) throw error;
      return data;
    });
  },
};
