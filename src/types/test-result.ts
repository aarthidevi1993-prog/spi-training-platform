/**
 * Test results (0009/0010). Every score here is read from the database
 * exactly as it was graded at finalization — nothing is re-graded in
 * the application.
 *
 * Two deliberately separate families:
 *   - Staff*  : Super Admin / the batch's CURRENT trainer (RLS-scoped
 *               table reads). May include per-student rows, per-question
 *               correctness rates and security indicators.
 *   - Student*: the signed-in student's own RELEASED results, taken
 *               only from student_available_tests(). No answer keys,
 *               question data, other students or security events.
 */
import type { TestType } from "./test";
import type { AttemptFinalizeReason, AttemptStatus, StudentTestState } from "./student-test";

// -------------------------------------------------------------------
// Staff
// -------------------------------------------------------------------

/** One student's result on one test (staff view). */
export interface StaffStudentResult {
  studentId: string;
  studentName: string;
  studentCode: string;
  /** All attempts started, including one in progress. */
  attemptsUsed: number;
  finishedAttempts: number;
  inProgress: boolean;
  /** Best finished attempt (test_best_results); null when none finished yet. */
  best: {
    attemptId: string;
    score: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
    finalizedAt: string;
  } | null;
  /** The most recent attempt (any state). */
  latest: {
    attemptNumber: number;
    status: AttemptStatus;
    finalizeReason: AttemptFinalizeReason | null;
    startedAt: string;
    finalizedAt: string | null;
  } | null;
  /** Count of activity indicators recorded for this student on this test. */
  indicatorCount: number;
}

/** How often one frozen question was answered correctly (finished attempts). */
export interface StaffQuestionStat {
  testQuestionId: string;
  position: number;
  questionText: string;
  marks: number;
  /** Finished attempts that were issued this question. */
  graded: number;
  correct: number;
  /** correct / graded × 100; null when graded is 0. */
  correctPercent: number | null;
}

/** A counted activity indicator (never an accusation). */
export interface StaffActivityIndicator {
  eventType: string;
  label: string;
  count: number;
}

export interface StaffTestResultsTotals {
  studentsAttempted: number;
  studentsWithResult: number;
  attemptsInProgress: number;
  /** In-progress attempts past their effective deadline (display estimate; the database decides). */
  attemptsOverdue: number;
  studentsPassed: number;
  /** studentsPassed / studentsWithResult × 100; null when no results. */
  passRate: number | null;
  /** Mean best percentage; null when no results. */
  averageBestPercentage: number | null;
}

/** The Results section of a staff test page. */
export interface StaffTestResults {
  testId: string;
  /** Whether the caller may run the finalize sweep (Super Admin or current trainer). */
  canFinalize: boolean;
  totals: StaffTestResultsTotals;
  students: StaffStudentResult[];
  questions: StaffQuestionStat[];
  indicators: StaffActivityIndicator[];
}

/**
 * Staff results availability for a test page. "unavailable" when the
 * caller is outside the results scope (e.g. a previous trainer of a
 * completed batch) — the database would return nothing anyway.
 */
export type StaffTestResultsState =
  | { kind: "draft" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; results: StaffTestResults };

// -------------------------------------------------------------------
// Student
// -------------------------------------------------------------------

/** A released result (only once the test is effectively closed). */
export interface StudentReleasedResult {
  attemptId: string;
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
}

/** One row of the student's Results page. */
export interface StudentResultRow {
  testId: string;
  title: string;
  testType: TestType;
  courseCode: string;
  courseTitle: string;
  batchLabel: string;
  state: StudentTestState;
  attemptsUsed: number;
  attemptLimit: number;
  /** When the test closes / closed (India time on display). */
  closesAt: string | null;
  /** null until the database releases results (test closed) or when there is no finished attempt. */
  released: StudentReleasedResult | null;
  /** True while the test is not yet closed and the student has used an attempt. */
  awaitingResults: boolean;
}
