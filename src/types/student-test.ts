/**
 * Student-side test engine types (0009/0010 database functions).
 *
 * Student-safe by construction: while an attempt is in progress nothing
 * here carries an answer key, correctness or explanation. The review
 * shapes (StudentAttemptReviewQuestion) are only ever filled from
 * get_attempt_result() after the database has released results
 * (test effectively closed).
 */
import type { TestStatus, TestType } from "./test";

export type StudentQuestionType = "single_choice" | "multiple_choice" | "true_false";

export type AttemptStatus = "in_progress" | "submitted" | "finalized";

export type AttemptFinalizeReason =
  | "student_submit"
  | "deadline"
  | "test_closed"
  | "class_cancelled"
  | "batch_cancelled"
  | "withdrawn"
  | "enrollment_ended";

/** Where a test stands for this student (derived from the database response). */
export type StudentTestState =
  | "scheduled"
  | "available"
  | "in_progress"
  | "submitted"
  | "closed"
  | "attempts_exhausted"
  | "not_available";

export interface StudentBestResult {
  attemptId: string;
  score: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
}

/** One row of student_available_tests(). */
export interface StudentTestSummary {
  testId: string;
  title: string;
  testType: TestType;
  instructions: string | null;
  classTitle: string;
  classDate: string | null;
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  effectiveStatus: TestStatus;
  classCancelled: boolean;
  batchCancelled: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  timeLimitMinutes: number | null;
  attemptLimit: number;
  questionCount: number;
  attemptsUsed: number;
  activeAttemptId: string | null;
  canStart: boolean;
  resultsAvailable: boolean;
  /** Only present once the test is effectively closed. */
  bestResult: StudentBestResult | null;
  /** UI state derived server-side from the fields above. */
  state: StudentTestState;
}

export interface StudentPaperOption {
  id: string;
  text: string;
}

/** An issued question in the attempt's stored order — NO answer key. */
export interface StudentPaperQuestion {
  testQuestionId: string;
  position: number;
  questionType: StudentQuestionType;
  questionText: string;
  marks: number;
  options: StudentPaperOption[];
  selected: string[];
}

/** get_attempt_paper() for an in-progress attempt. */
export interface StudentAttemptPaper {
  attemptId: string;
  attemptNumber: number;
  testId: string;
  testTitle: string;
  testType: TestType;
  instructions: string | null;
  timeLimitMinutes: number | null;
  startedAt: string;
  deadlineAt: string;
  effectiveDeadline: string;
  graceSeconds: number;
  serverNow: string;
  questions: StudentPaperQuestion[];
}

export interface StudentReviewOption {
  id: string;
  text: string;
  isCorrect: boolean;
  selected: boolean;
}

/** Released review (only after the test is effectively closed). */
export interface StudentAttemptReviewQuestion {
  position: number;
  questionType: StudentQuestionType;
  questionText: string;
  marks: number;
  explanation: string | null;
  isCorrect: boolean | null;
  marksAwarded: number | null;
  options: StudentReviewOption[];
}

/** get_attempt_result(): state always; score/review only when released. */
export interface StudentAttemptResult {
  attemptId: string;
  attemptNumber: number;
  testId: string;
  testTitle: string;
  status: AttemptStatus;
  finalizeReason: AttemptFinalizeReason | null;
  startedAt: string;
  finalizedAt: string | null;
  questionCount: number;
  answeredCount: number;
  resultsAvailable: boolean;
  released: {
    score: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
    passMarkPercent: number | null;
    isBestAttempt: boolean;
    review: StudentAttemptReviewQuestion[];
  } | null;
}

/** The attempt page: either the live paper or the finished state/result. */
export type StudentAttemptView =
  | { kind: "paper"; paper: StudentAttemptPaper }
  | { kind: "result"; result: StudentAttemptResult };
