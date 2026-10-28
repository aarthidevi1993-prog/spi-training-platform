import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

/**
 * Student tests repository — the only module that talks to the secure
 * student test engine (0009/0010). Students have NO table access: every
 * call is one of the database functions below, executed with the
 * signed-in student's own session (never the service role). Identity
 * (auth.uid()), ownership, timing, grading and result release are all
 * decided by the database; this layer only passes ids and selections.
 */

const GENERIC_DB_ERROR = "We couldn't reach the test service. Please try again.";

export class StudentTestRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "StudentTestRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[student-tests] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new StudentTestRepositoryError();
  return supabase;
}

/**
 * Raised (not returned) database errors are genuine permission errors
 * (42501, e.g. "Only students can take tests.") or rare races (23514,
 * e.g. "This test is no longer open." when a start loses a race with a
 * close). Their messages are written for users; anything else becomes
 * a generic message and is logged.
 */
const USER_FACING_CODES = new Set(["42501", "23514"]);
const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax/i;

async function run(context: string, fn: () => PromiseLike<{ data: Json | null; error: unknown }>): Promise<Json> {
  let result: { data: Json | null; error: unknown };
  try {
    result = await fn();
  } catch (err) {
    logDbError(context, err);
    throw new StudentTestRepositoryError();
  }
  const { data, error } = result;
  if (error) {
    logDbError(context, error);
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message) : "";
    if (USER_FACING_CODES.has(code) && message && !RAW_POSTGRES_MESSAGE.test(message)) {
      throw new StudentTestRepositoryError(message);
    }
    throw new StudentTestRepositoryError();
  }
  if (data === null || data === undefined) throw new StudentTestRepositoryError();
  return data;
}

export const studentTestsRepository = {
  /** The signed-in student's tests (student_available_tests). */
  async availableTests(): Promise<Json> {
    const supabase = await client();
    return run("availableTests", () => supabase.rpc("student_available_tests"));
  },

  /** Start or resume an attempt (start_test_attempt). */
  async startAttempt(testId: string): Promise<Json> {
    const supabase = await client();
    return run("startAttempt", () => supabase.rpc("start_test_attempt", { p_test_id: testId }));
  },

  /** The attempt paper — no answer key (get_attempt_paper). */
  async attemptPaper(attemptId: string): Promise<Json> {
    const supabase = await client();
    return run("attemptPaper", () => supabase.rpc("get_attempt_paper", { p_attempt_id: attemptId }));
  },

  /** Save (replace) one answer (save_test_answer). */
  async saveAnswer(attemptId: string, testQuestionId: string, optionIds: string[], clientSeq: number): Promise<Json> {
    const supabase = await client();
    return run("saveAnswer", () =>
      supabase.rpc("save_test_answer", {
        p_attempt_id: attemptId,
        p_test_question_id: testQuestionId,
        p_option_ids: optionIds,
        p_client_seq: clientSeq,
      })
    );
  },

  /** Submit (idempotent) (submit_test_attempt). */
  async submitAttempt(attemptId: string): Promise<Json> {
    const supabase = await client();
    return run("submitAttempt", () => supabase.rpc("submit_test_attempt", { p_attempt_id: attemptId }));
  },

  /** Note one browser activity signal (record_attempt_client_event, 0015). */
  async recordClientEvent(attemptId: string, kind: string, detail: Json): Promise<Json> {
    const supabase = await client();
    return run("recordClientEvent", () =>
      supabase.rpc("record_attempt_client_event", { p_attempt_id: attemptId, p_kind: kind, p_detail: detail })
    );
  },

  /** Attempt state; score/review only once released (get_attempt_result). */
  async attemptResult(attemptId: string): Promise<Json> {
    const supabase = await client();
    return run("attemptResult", () => supabase.rpc("get_attempt_result", { p_attempt_id: attemptId }));
  },
};
