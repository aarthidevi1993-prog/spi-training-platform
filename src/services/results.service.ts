import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { studentTestsService } from "./student-tests.service";
import {
  resultsRepository,
  ResultsRepositoryError,
  type ResultsTestRecord,
} from "@/repositories/results.repository";
import type { AuthUser } from "@/types/auth";
import type { TestSecurityEventTypeColumn } from "@/lib/supabase/types";
import type { AttemptFinalizeReason, AttemptStatus } from "@/types/student-test";
import type {
  StaffActivityIndicator,
  StaffQuestionStat,
  StaffStudentResult,
  StaffTestResults,
  StaffTestResultsState,
  StudentResultRow,
} from "@/types/test-result";

/**
 * Results service — identity always from authService (never a client
 * argument).
 *
 *   - Staff (Super Admin / the batch's CURRENT trainer): per-test results
 *     read from the RLS-protected 0009 tables and the test_best_results
 *     view. Scores are summarised, never re-graded.
 *   - Student: their own RELEASED results only, from
 *     student_available_tests() (via the student tests service). No
 *     answer keys, question data or security events.
 */

export class ResultsAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ResultsAuthorizationError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = "Test not found, or you don't have permission to manage it.";
/** Matches the 0009 grace period after the effective deadline. */
const GRACE_MS = 5_000;

/**
 * Non-routine activity events shown to staff as indicators. Routine
 * events (attempt started, answer saved, submit, automatic finalization)
 * are not read. These are prompts for review — never proof of misconduct.
 */
const INDICATOR_LABELS: Partial<Record<TestSecurityEventTypeColumn, string>> = {
  repeated_start: "Reopened an attempt already in progress",
  blocked_start: "Start refused (not open, limit reached, or not eligible)",
  blocked_answer_save: "Answer save refused (e.g. after time ran out)",
  blocked_submission: "Submission refused",
  deadline_reached: "Reached the time limit",
  invalid_attempt_access: "Tried to open an attempt that isn't theirs or doesn't exist",
  suspicious_repeated_access: "Very frequent repeated requests",
};
const INDICATOR_TYPES = Object.keys(INDICATOR_LABELS) as TestSecurityEventTypeColumn[];

async function requireStaff(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new ResultsAuthorizationError("You need to be signed in.");
  if (user.role !== "admin" && user.role !== "trainer") throw new ResultsAuthorizationError();
  return user;
}

/** Mirrors is_current_batch_trainer — the RLS on every 0009 table re-checks it. */
function canSeeResults(user: AuthUser, test: ResultsTestRecord): boolean {
  if (user.role === "admin") return true;
  const batch = test.classes?.batches;
  return Boolean(batch && batch.trainer_id === user.id && (batch.status === "upcoming" || batch.status === "ongoing"));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round2(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** Display estimate of "past the effective deadline"; staff_finalize_due_attempts decides for real. */
function isOverdue(deadlineAt: string, test: ResultsTestRecord, now: number): boolean {
  const deadline = new Date(deadlineAt).getTime();
  const until = test.available_until ? new Date(test.available_until).getTime() : Infinity;
  return test.status === "closed" || now > Math.min(deadline, until) + GRACE_MS;
}

export const resultsService = {
  /**
   * The Results section of a staff test page. "unavailable" for callers
   * outside the results scope (e.g. a previous trainer of a completed
   * batch); the database's RLS would return nothing to them anyway.
   */
  async getStaffTestResults(testId: string): Promise<StaffTestResultsState> {
    if (authConfig.mode === "demo") return { kind: "unavailable" };
    const user = await requireStaff();
    if (!UUID_PATTERN.test(testId)) return { kind: "unavailable" };

    const test = await resultsRepository.getTest(testId);
    if (!test || !canSeeResults(user, test)) return { kind: "unavailable" };
    if (test.status === "draft") return { kind: "draft" };

    const [attempts, best, questions, indicators] = await Promise.all([
      resultsRepository.listAttempts(testId),
      resultsRepository.listBestResultsForTest(testId),
      resultsRepository.listFrozenQuestions(testId),
      resultsRepository.listIndicators(testId, INDICATOR_TYPES),
    ]);

    const finishedIds = attempts.filter((a) => a.status !== "in_progress").map((a) => a.id);
    const answers = await resultsRepository.listGradedAnswers(finishedIds);

    // Per student ----------------------------------------------------
    const now = Date.now();
    const bestByStudent = new Map(best.map((b) => [b.student_id, b]));
    const indicatorsByStudent = new Map<string, number>();
    for (const e of indicators) {
      if (e.student_id) indicatorsByStudent.set(e.student_id, (indicatorsByStudent.get(e.student_id) ?? 0) + 1);
    }

    const byStudent = new Map<string, typeof attempts>();
    for (const a of attempts) {
      const list = byStudent.get(a.student_id) ?? [];
      list.push(a);
      byStudent.set(a.student_id, list);
    }

    let inProgress = 0;
    let overdue = 0;
    const students: StaffStudentResult[] = [];
    for (const [studentId, list] of Array.from(byStudent.entries())) {
      list.sort((x, y) => x.attempt_number - y.attempt_number);
      const latest = list[list.length - 1];
      const active = list.find((a) => a.status === "in_progress");
      if (active) {
        inProgress += 1;
        if (isOverdue(active.deadline_at, test, now)) overdue += 1;
      }
      const b = bestByStudent.get(studentId);
      const who = list[0]?.students;
      students.push({
        studentId,
        studentName: who?.full_name ?? "Unknown student",
        studentCode: who?.student_code ?? "",
        attemptsUsed: list.length,
        finishedAttempts: list.filter((a) => a.status !== "in_progress").length,
        inProgress: Boolean(active),
        best: b
          ? {
              attemptId: b.best_attempt_id,
              score: Number(b.score),
              maxScore: Number(b.max_score),
              percentage: Number(b.percentage),
              passed: b.passed,
              finalizedAt: b.finalized_at,
            }
          : null,
        latest: latest
          ? {
              attemptNumber: latest.attempt_number,
              status: latest.status as AttemptStatus,
              finalizeReason: (latest.finalize_reason as AttemptFinalizeReason | null) ?? null,
              startedAt: latest.started_at,
              finalizedAt: latest.finalized_at,
            }
          : null,
        indicatorCount: indicatorsByStudent.get(studentId) ?? 0,
      });
    }
    students.sort((x, y) => x.studentName.localeCompare(y.studentName));

    // Per question (all finished attempts) ---------------------------
    const tally = new Map<string, { graded: number; correct: number }>();
    for (const ans of answers) {
      const t = tally.get(ans.test_question_id) ?? { graded: 0, correct: 0 };
      t.graded += 1;
      if (ans.is_correct) t.correct += 1;
      tally.set(ans.test_question_id, t);
    }
    const questionStats: StaffQuestionStat[] = questions.map((q) => {
      const t = tally.get(q.id) ?? { graded: 0, correct: 0 };
      return {
        testQuestionId: q.id,
        position: q.position,
        questionText: q.question_text,
        marks: Number(q.marks),
        graded: t.graded,
        correct: t.correct,
        correctPercent: t.graded > 0 ? round2((t.correct / t.graded) * 100) : null,
      };
    });

    // Indicators (test totals) ---------------------------------------
    const indicatorCounts = new Map<string, number>();
    for (const e of indicators) indicatorCounts.set(e.event_type, (indicatorCounts.get(e.event_type) ?? 0) + 1);
    const indicatorList: StaffActivityIndicator[] = INDICATOR_TYPES.filter((type) => indicatorCounts.has(type)).map((type) => ({
      eventType: type,
      label: INDICATOR_LABELS[type] ?? type,
      count: indicatorCounts.get(type) ?? 0,
    }));

    const withResult = students.filter((s) => s.best);
    const passed = withResult.filter((s) => s.best?.passed).length;
    const results: StaffTestResults = {
      testId,
      canFinalize: canSeeResults(user, test),
      totals: {
        studentsAttempted: students.length,
        studentsWithResult: withResult.length,
        attemptsInProgress: inProgress,
        attemptsOverdue: overdue,
        studentsPassed: passed,
        passRate: withResult.length > 0 ? round2((passed / withResult.length) * 100) : null,
        averageBestPercentage: mean(withResult.map((s) => s.best?.percentage ?? 0)),
      },
      students,
      questions: questionStats,
      indicators: indicatorList,
    };
    return { kind: "ready", results };
  },

  /**
   * Run the database's finalize sweep for a test (staff only). The
   * database re-checks the caller (super admin / current trainer),
   * decides which attempts are due and grades them. Returns the count.
   */
  async finalizeOverdueAttempts(testId: string): Promise<number> {
    if (authConfig.mode === "demo") throw new ResultsAuthorizationError("Results require Supabase mode.");
    const user = await requireStaff();
    if (typeof testId !== "string" || !UUID_PATTERN.test(testId)) throw new ResultsAuthorizationError(NOT_FOUND);
    const test = await resultsRepository.getTest(testId);
    if (!test || !canSeeResults(user, test)) throw new ResultsAuthorizationError(NOT_FOUND);

    const data = await resultsRepository.finalizeDueAttempts(testId);
    const o = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!o || o.ok !== true) throw new ResultsRepositoryError("We couldn't finalize the attempts. Please try again.");
    const count = Number(o.finalized);
    return Number.isFinite(count) ? count : 0;
  },

  /**
   * The signed-in student's results page rows (student_available_tests()).
   * Scores appear only when the database has released them (test
   * closed). null in demo mode.
   */
  async listStudentResults(): Promise<StudentResultRow[] | null> {
    const tests = await studentTestsService.listTests();
    if (tests === null) return null;
    return tests.map((t) => {
      const released = t.resultsAvailable && t.bestResult ? t.bestResult : null;
      return {
        testId: t.testId,
        title: t.title,
        testType: t.testType,
        courseCode: t.courseCode,
        courseTitle: t.courseTitle,
        batchLabel: t.batchCode || t.batchName,
        state: t.state,
        attemptsUsed: t.attemptsUsed,
        attemptLimit: t.attemptLimit,
        closesAt: t.availableUntil,
        released: released
          ? {
              attemptId: released.attemptId,
              score: released.score,
              maxScore: released.maxScore,
              percentage: released.percentage,
              passed: released.passed,
            }
          : null,
        awaitingResults: !t.resultsAvailable && t.attemptsUsed > 0,
      };
    });
  },
};

export { ResultsRepositoryError };
