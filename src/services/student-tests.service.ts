import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { studentTestsRepository, StudentTestRepositoryError } from "@/repositories/student-tests.repository";
import type { AuthUser } from "@/types/auth";
import type { TestStatus, TestType } from "@/types/test";
import type { Json } from "@/lib/supabase/types";
import {
  MAX_EVENTS_PER_REPORT,
  isReportedClientEventKind,
  sanitizeClientEventDetail,
} from "@/lib/student-tests/client-events";
import type {
  AttemptFinalizeReason,
  AttemptStatus,
  StudentAttemptPaper,
  StudentAttemptResult,
  StudentAttemptView,
  StudentPaperQuestion,
  StudentQuestionType,
  StudentTestState,
  StudentTestSummary,
} from "@/types/student-test";

/**
 * Student tests service — the signed-in student is resolved server-side
 * (authService, never a client argument); ids are validated; every
 * operation is delegated to the 0009/0010 database functions, which
 * decide eligibility, timing, grading and result release. This layer
 * never computes a score, correctness or deadline itself — it only maps
 * the database's JSON into typed, student-safe shapes and turns blocked
 * reasons into friendly messages.
 */

export class StudentTestAuthorizationError extends Error {
  constructor(message = "You need to be signed in as a student.") {
    super(message);
    this.name = "StudentTestAuthorizationError";
  }
}

export class StudentTestBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "StudentTestBlockedError";
    this.reason = reason;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Friendly text for the reasons the database returns. */
const BLOCKED_MESSAGES: Record<string, string> = {
  not_found: "This test isn't available to you.",
  not_enrolled: "You're not enrolled in this test's batch any more, so you can't take it.",
  cancelled: "This test's class or batch was cancelled.",
  test_not_open: "This test isn't open yet.",
  test_closed: "This test has closed.",
  attempt_limit: "You've used all of your attempts for this test.",
  attempt_finished: "This attempt has already finished.",
  deadline: "Time is up — this attempt has been submitted automatically.",
  class_cancelled: "This test's class was cancelled, so the attempt has been closed.",
  batch_cancelled: "This test's batch was cancelled, so the attempt has been closed.",
  withdrawn: "You've been withdrawn from this batch, so the attempt has been closed.",
  enrollment_ended: "Your enrolment in this batch has ended, so the attempt has been closed.",
  invalid_question: "That question isn't part of this attempt.",
  invalid_options: "That answer isn't valid for this question.",
  invalid_request: "That request wasn't valid. Please reload the page.",
};

export function blockedMessage(reason: string): string {
  return BLOCKED_MESSAGES[reason] ?? "This action isn't available right now.";
}

async function requireStudent(): Promise<AuthUser> {
  if (authConfig.mode === "demo") {
    throw new StudentTestAuthorizationError("Tests require Supabase mode.");
  }
  const user = await authService.getCurrentUser();
  if (!user) throw new StudentTestAuthorizationError();
  if (user.role !== "student") throw new StudentTestAuthorizationError("Only students can take tests.");
  return user;
}

// -------------------------------------------------------------------
// Defensive JSON readers (the database is trusted, but shapes are checked)
// -------------------------------------------------------------------
type Obj = Record<string, unknown>;
function asObj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new StudentTestRepositoryError("Unexpected response from the test service.");
  return v as Obj;
}
function str(o: Obj, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
function strOrNull(o: Obj, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}
function num(o: Obj, k: string): number {
  const v = o[k];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(o: Obj, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(o: Obj, k: string): boolean {
  return o[k] === true;
}
function arr(o: Obj, k: string): unknown[] {
  const v = o[k];
  return Array.isArray(v) ? v : [];
}

function deriveState(t: Omit<StudentTestSummary, "state">): StudentTestState {
  if (t.activeAttemptId) return "in_progress";
  if (t.classCancelled || t.batchCancelled) return "not_available";
  if (t.effectiveStatus === "closed") return "closed";
  if (t.effectiveStatus === "scheduled") return "scheduled";
  if (t.canStart) return "available";
  if (t.attemptsUsed >= t.attemptLimit) return t.attemptsUsed > 0 ? "attempts_exhausted" : "not_available";
  if (t.attemptsUsed > 0) return "submitted";
  return "not_available";
}

function toSummary(value: unknown): StudentTestSummary {
  const o = asObj(value);
  const best = o.best_result && typeof o.best_result === "object" ? (o.best_result as Obj) : null;
  const base = {
    testId: str(o, "test_id"),
    title: str(o, "title"),
    testType: str(o, "test_type") as TestType,
    instructions: strOrNull(o, "instructions"),
    classTitle: str(o, "class_title"),
    classDate: strOrNull(o, "class_date"),
    courseCode: str(o, "course_code"),
    courseTitle: str(o, "course_title"),
    batchCode: str(o, "batch_code"),
    batchName: str(o, "batch_name"),
    effectiveStatus: str(o, "effective_status") as TestStatus,
    classCancelled: bool(o, "class_cancelled"),
    batchCancelled: bool(o, "batch_cancelled"),
    availableFrom: strOrNull(o, "available_from"),
    availableUntil: strOrNull(o, "available_until"),
    timeLimitMinutes: numOrNull(o, "time_limit_minutes"),
    attemptLimit: num(o, "attempt_limit"),
    questionCount: num(o, "question_count"),
    attemptsUsed: num(o, "attempts_used"),
    activeAttemptId: strOrNull(o, "active_attempt_id"),
    canStart: bool(o, "can_start"),
    resultsAvailable: bool(o, "results_available"),
    bestResult: best
      ? {
          attemptId: str(best, "attempt_id"),
          score: num(best, "score"),
          maxScore: num(best, "max_score"),
          percentage: num(best, "percentage"),
          passed: bool(best, "passed"),
        }
      : null,
  };
  return { ...base, state: deriveState(base) };
}

function toQuestion(value: unknown): StudentPaperQuestion {
  const q = asObj(value);
  return {
    testQuestionId: str(q, "test_question_id"),
    position: num(q, "position"),
    questionType: str(q, "question_type") as StudentQuestionType,
    questionText: str(q, "question_text"),
    marks: num(q, "marks"),
    // Only id + text are read — nothing else from an option is passed on.
    options: arr(q, "options").map((opt) => {
      const o = asObj(opt);
      return { id: str(o, "id"), text: str(o, "text") };
    }),
    selected: arr(q, "selected").filter((id): id is string => typeof id === "string"),
  };
}

function toPaper(o: Obj): StudentAttemptPaper {
  return {
    attemptId: str(o, "attempt_id"),
    attemptNumber: num(o, "attempt_number"),
    testId: str(o, "test_id"),
    testTitle: str(o, "test_title"),
    testType: str(o, "test_type") as TestType,
    instructions: strOrNull(o, "instructions"),
    timeLimitMinutes: numOrNull(o, "time_limit_minutes"),
    startedAt: str(o, "started_at"),
    deadlineAt: str(o, "deadline_at"),
    effectiveDeadline: str(o, "effective_deadline"),
    graceSeconds: num(o, "grace_seconds"),
    serverNow: str(o, "server_now"),
    questions: arr(o, "questions").map(toQuestion).sort((a, b) => a.position - b.position),
  };
}

function toResult(o: Obj): StudentAttemptResult {
  const released = bool(o, "results_available");
  return {
    attemptId: str(o, "attempt_id"),
    attemptNumber: num(o, "attempt_number"),
    testId: str(o, "test_id"),
    testTitle: str(o, "test_title"),
    status: str(o, "status") as AttemptStatus,
    finalizeReason: (strOrNull(o, "finalize_reason") as AttemptFinalizeReason | null) ?? null,
    startedAt: str(o, "started_at"),
    finalizedAt: strOrNull(o, "finalized_at"),
    questionCount: num(o, "question_count"),
    answeredCount: num(o, "answered_count"),
    resultsAvailable: released,
    released: released
      ? {
          score: num(o, "score"),
          maxScore: num(o, "max_score"),
          percentage: num(o, "percentage"),
          passed: bool(o, "passed"),
          passMarkPercent: numOrNull(o, "pass_mark_percent"),
          isBestAttempt: bool(o, "is_best_attempt"),
          review: arr(o, "review")
            .map((value) => {
              const q = asObj(value);
              return {
                position: num(q, "position"),
                questionType: str(q, "question_type") as StudentQuestionType,
                questionText: str(q, "question_text"),
                marks: num(q, "marks"),
                explanation: strOrNull(q, "explanation"),
                isCorrect: typeof q.is_correct === "boolean" ? q.is_correct : null,
                marksAwarded: numOrNull(q, "marks_awarded"),
                options: arr(q, "options").map((opt) => {
                  const op = asObj(opt);
                  return { id: str(op, "id"), text: str(op, "text"), isCorrect: bool(op, "is_correct"), selected: bool(op, "selected") };
                }),
              };
            })
            .sort((a, b) => a.position - b.position),
        }
      : null,
  };
}

export interface SaveAnswerOutcome {
  ok: boolean;
  ignored: boolean;
  reason: string | null;
  serverNow: string | null;
  effectiveDeadline: string | null;
}

export interface SubmitOutcome {
  status: AttemptStatus;
  finalizeReason: AttemptFinalizeReason | null;
  alreadyFinished: boolean;
}

export interface ClientEventsOutcome {
  recorded: number;
  /** The attempt is not (or no longer) open for reports: the browser should stop. */
  stop: boolean;
}

export const studentTestsService = {
  /** null in demo mode (the page shows an empty state). */
  async listTests(): Promise<StudentTestSummary[] | null> {
    if (authConfig.mode === "demo") return null;
    await requireStudent();
    const data = await studentTestsRepository.availableTests();
    return (Array.isArray(data) ? data : []).map(toSummary);
  },

  /** One of the student's tests, or null (not found / not theirs). */
  async getTest(testId: string): Promise<StudentTestSummary | null> {
    if (!isUuid(testId)) return null;
    const tests = await this.listTests();
    return tests?.find((t) => t.testId === testId) ?? null;
  },

  /** Start or resume; returns the attempt id or throws a friendly blocked error. */
  async startAttempt(testId: string): Promise<string> {
    await requireStudent();
    if (!isUuid(testId)) throw new StudentTestBlockedError("not_found", blockedMessage("not_found"));
    const o = asObj(await studentTestsRepository.startAttempt(testId));
    if (o.ok !== true) {
      const reason = str(o, "reason") || "not_found";
      throw new StudentTestBlockedError(reason, blockedMessage(reason));
    }
    const attemptId = str(o, "attempt_id");
    if (!isUuid(attemptId)) throw new StudentTestRepositoryError();
    return attemptId;
  },

  /**
   * The attempt page: the live paper while in progress, otherwise the
   * finished state/result. null when the attempt isn't the student's
   * (or doesn't exist) or doesn't belong to testId (→ notFound).
   */
  async getAttemptView(testId: string, attemptId: string): Promise<StudentAttemptView | null> {
    if (authConfig.mode === "demo") return null;
    await requireStudent();
    if (!isUuid(testId) || !isUuid(attemptId)) return null;

    const paper = asObj(await studentTestsRepository.attemptPaper(attemptId));
    if (paper.ok !== true || str(paper, "test_id") !== testId) return null;

    if (str(paper, "status") === "in_progress" && Array.isArray(paper.questions)) {
      return { kind: "paper", paper: toPaper(paper) };
    }
    const result = asObj(await studentTestsRepository.attemptResult(attemptId));
    if (result.ok !== true) return null;
    return { kind: "result", result: toResult(result) };
  },

  async saveAnswer(attemptId: string, testQuestionId: string, optionIds: string[], clientSeq: number): Promise<SaveAnswerOutcome> {
    await requireStudent();
    if (!isUuid(attemptId) || !isUuid(testQuestionId)) {
      return { ok: false, ignored: false, reason: "invalid_request", serverNow: null, effectiveDeadline: null };
    }
    const ids = Array.isArray(optionIds) ? optionIds.filter(isUuid) : [];
    if (!Array.isArray(optionIds) || ids.length !== optionIds.length || ids.length > 10) {
      return { ok: false, ignored: false, reason: "invalid_options", serverNow: null, effectiveDeadline: null };
    }
    if (!Number.isSafeInteger(clientSeq) || clientSeq <= 0) {
      return { ok: false, ignored: false, reason: "invalid_request", serverNow: null, effectiveDeadline: null };
    }
    const o = asObj(await studentTestsRepository.saveAnswer(attemptId, testQuestionId, ids, clientSeq));
    return {
      ok: o.ok === true,
      ignored: bool(o, "ignored"),
      reason: o.ok === true ? null : str(o, "reason") || "invalid_request",
      serverNow: strOrNull(o, "server_now"),
      effectiveDeadline: strOrNull(o, "effective_deadline"),
    };
  },

  async submitAttempt(attemptId: string): Promise<SubmitOutcome> {
    await requireStudent();
    if (!isUuid(attemptId)) throw new StudentTestBlockedError("not_found", blockedMessage("not_found"));
    const o = asObj(await studentTestsRepository.submitAttempt(attemptId));
    if (o.ok !== true) {
      const reason = str(o, "reason") || "not_found";
      throw new StudentTestBlockedError(reason, blockedMessage(reason));
    }
    return {
      status: str(o, "status") as AttemptStatus,
      finalizeReason: (strOrNull(o, "finalize_reason") as AttemptFinalizeReason | null) ?? null,
      alreadyFinished: bool(o, "already_finished"),
    };
  },

  /**
   * Browser activity signals (0015). Only the known kinds, at most
   * MAX_EVENTS_PER_REPORT per call, with details reduced to the known
   * non-sensitive fields. The database checks the student, ownership,
   * that the attempt is in progress, and rate limits; it stamps the time.
   */
  async recordClientEvents(attemptId: string, events: unknown): Promise<ClientEventsOutcome> {
    await requireStudent();
    if (!isUuid(attemptId) || !Array.isArray(events)) return { recorded: 0, stop: false };
    let recorded = 0;
    for (const event of events.slice(0, MAX_EVENTS_PER_REPORT)) {
      const e = asObj(event);
      if (!isReportedClientEventKind(e.kind)) continue;
      const detail = sanitizeClientEventDetail(e.kind, e.detail) as unknown as Json;
      const o = asObj(await studentTestsRepository.recordClientEvent(attemptId, e.kind, detail));
      if (o.ok !== true) return { recorded, stop: true }; // not_found / attempt_finished
      if (o.recorded === true) recorded++;
    }
    return { recorded, stop: false };
  },
};

export { StudentTestRepositoryError };
