/**
 * Class test types (0008_tests.sql) for Admin/Trainer test management.
 * Staff-only: TestQuestionView carries the frozen answer key and must
 * never be used by a student-facing page or data structure. The
 * student-safe shapes arrive with attempts (0009).
 */

export type TestType = "quiz" | "module_test" | "final_exam" | "practical";

/** Stored lifecycle: draft → scheduled | active → closed (reopen: closed → scheduled | active). */
export type TestStatus = "draft" | "scheduled" | "active" | "closed";

export const TEST_TYPE_LABEL: Record<TestType, string> = {
  quiz: "Quiz",
  module_test: "Module test",
  final_exam: "Final exam",
  practical: "Practical",
};

/** Mirrors the 0008 constraints. */
export const TEST_LIMITS = {
  titleMax: 200,
  instructionsMax: 5000,
  passMarkMin: 0,
  passMarkMax: 100,
  timeLimitMin: 1,
  timeLimitMax: 600,
  attemptLimitMin: 1,
  attemptLimitMax: 10,
  questionsPerAdd: 100,
} as const;

export interface TestSummary {
  id: string;
  classId: string;
  classTitle: string;
  classDate: string | null;
  batchId: string;
  batchCode: string;
  batchName: string;
  courseId: string | null;
  courseCode: string;
  courseTitle: string;
  testType: TestType;
  title: string;
  instructions: string | null;
  /** As stored in the database. */
  status: TestStatus;
  /** Where the test is right now (time moves scheduled → active → closed). */
  effectiveStatus: TestStatus;
  passMarkPercent: number | null;
  timeLimitMinutes: number | null;
  attemptLimit: number;
  availableFrom: string | null;
  availableUntil: string | null;
  /** "YYYY-MM-DDTHH:mm" in India time, for the editor. */
  availableFromLocal: string | null;
  availableUntilLocal: string | null;
  /** Null when the caller can't read the frozen question set (previous class trainer). */
  questionCount: number | null;
  totalMarks: number | null;
  /** Server-decided: super admin, or the batch's CURRENT trainer (upcoming/ongoing). */
  canManage: boolean;
}

export interface TestQuestionOptionView {
  text: string;
  isCorrect: boolean;
}

/** Frozen question — staff-only (includes the answer key). */
export interface TestQuestionView {
  id: string;
  position: number;
  questionType: "single_choice" | "multiple_choice" | "true_false";
  questionText: string;
  marks: number;
  sourceQuestionId: string;
  sourceRevision: number;
  options: TestQuestionOptionView[];
}

/** An active bank question that can be added to a draft (no answer key needed). */
export interface TestCandidateQuestion {
  id: string;
  text: string;
  questionType: "single_choice" | "multiple_choice" | "true_false";
  marks: number;
  moduleTitle: string | null;
}

export interface TestDetail extends TestSummary {
  /** Null when the caller can't read the frozen question set. */
  questions: TestQuestionView[] | null;
  /** Filled for a manageable draft only. */
  candidates: TestCandidateQuestion[];
}

/** A class the caller may create tests for. */
export interface TestClassOption {
  id: string;
  title: string;
  classDate: string;
  batchId: string;
  batchCode: string;
  courseCode: string;
}

export interface TestManagementData {
  /** False in demo mode (no real data; the page shows an empty state). */
  enabled: boolean;
  classes: TestClassOption[];
  tests: TestSummary[];
}

/** What the settings editor sends. Status and audit fields are never part of it. */
export interface TestInput {
  classId: string;
  testType: TestType;
  title: string;
  instructions: string | null;
  passMarkPercent: number | null;
  timeLimitMinutes: number | null;
  attemptLimit: number;
  availableFromLocal: string | null;
  availableUntilLocal: string | null;
}
