export type TestAttemptStatus = "not_started" | "in_progress" | "submitted" | "graded";

export interface TestAttempt {
  id: string;
  testId: string;
  studentId: string;
  status: TestAttemptStatus;
  startedAt?: string;
  submittedAt?: string;
  score?: number;
}
