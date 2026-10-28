"use server";

/**
 * Server Actions — the RPC boundary the student test pages call. Each
 * action delegates to studentTestsService (which resolves the signed-in
 * student server-side) and returns a plain, serializable result. Only
 * ids, selected option ids and an ordering number are accepted from the
 * browser — never a student id, score, correctness, status or time.
 * Internal error details are logged, never returned.
 */

import { revalidatePath } from "next/cache";
import {
  studentTestsService,
  StudentTestAuthorizationError,
  StudentTestBlockedError,
  StudentTestRepositoryError,
  blockedMessage,
} from "./student-tests.service";
import type { AttemptFinalizeReason, AttemptStatus } from "@/types/student-test";

function friendlyError(context: string, err: unknown): string {
  if (
    err instanceof StudentTestBlockedError ||
    err instanceof StudentTestAuthorizationError ||
    err instanceof StudentTestRepositoryError
  ) {
    return err.message;
  }
  console.error(`[student-tests.actions] ${context}:`, err instanceof Error ? err.message : err);
  return "Something went wrong. Please try again.";
}

export interface StartAttemptResult {
  ok: boolean;
  attemptId?: string;
  reason?: string;
  error?: string;
}

export async function startTestAttemptAction(testId: string): Promise<StartAttemptResult> {
  try {
    const attemptId = await studentTestsService.startAttempt(testId);
    revalidatePath("/student/tests", "layout");
    return { ok: true, attemptId };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof StudentTestBlockedError ? err.reason : undefined,
      error: friendlyError("startAttempt", err),
    };
  }
}

export interface SaveAnswerResult {
  ok: boolean;
  /** An older/duplicate save that the database ignored (not an error). */
  ignored?: boolean;
  /** Set when the database refused the save (e.g. deadline, attempt_finished). */
  reason?: string;
  error?: string;
  serverNow?: string | null;
  effectiveDeadline?: string | null;
  /** True when the attempt is over and the page should reload its state. */
  attemptOver?: boolean;
}

const ATTEMPT_OVER_REASONS = new Set([
  "attempt_finished",
  "deadline",
  "test_closed",
  "class_cancelled",
  "batch_cancelled",
  "withdrawn",
  "enrollment_ended",
]);

export async function saveTestAnswerAction(
  attemptId: string,
  testQuestionId: string,
  optionIds: string[],
  clientSeq: number
): Promise<SaveAnswerResult> {
  try {
    const out = await studentTestsService.saveAnswer(attemptId, testQuestionId, optionIds, clientSeq);
    if (out.ok) {
      return { ok: true, ignored: out.ignored, serverNow: out.serverNow, effectiveDeadline: out.effectiveDeadline };
    }
    const reason = out.reason ?? "invalid_request";
    return { ok: false, reason, error: blockedMessage(reason), attemptOver: ATTEMPT_OVER_REASONS.has(reason) };
  } catch (err) {
    return { ok: false, error: friendlyError("saveAnswer", err) };
  }
}

export interface ClientEventsResult {
  ok: boolean;
  /** Stop reporting: the attempt is no longer in progress. */
  stop?: boolean;
}

/**
 * Best-effort browser activity signals for an in-progress attempt (0015).
 * Never throws and never returns error text: a failed report must not
 * affect the test. Details are reduced server-side to non-sensitive fields.
 */
export async function recordAttemptClientEventsAction(attemptId: string, events: unknown): Promise<ClientEventsResult> {
  try {
    const out = await studentTestsService.recordClientEvents(attemptId, events);
    return { ok: true, stop: out.stop };
  } catch (err) {
    console.error("[student-tests.actions] recordClientEvents:", err instanceof Error ? err.message : err);
    return { ok: false };
  }
}

export interface SubmitAttemptResult {
  ok: boolean;
  status?: AttemptStatus;
  finalizeReason?: AttemptFinalizeReason | null;
  alreadyFinished?: boolean;
  error?: string;
}

export async function submitTestAttemptAction(attemptId: string): Promise<SubmitAttemptResult> {
  try {
    const out = await studentTestsService.submitAttempt(attemptId);
    revalidatePath("/student/tests", "layout");
    return { ok: true, status: out.status, finalizeReason: out.finalizeReason, alreadyFinished: out.alreadyFinished };
  } catch (err) {
    return { ok: false, error: friendlyError("submitAttempt", err) };
  }
}
