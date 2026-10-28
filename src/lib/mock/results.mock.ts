/** PART 3 UI-only mock rows for the student Results page. */
export interface ResultRow {
  id: string;
  test: string;
  course: string;
  score: number;
  totalMarks: number;
  date: string;
  status: "pass" | "fail" | "pending_review";
}

export const studentResultRows: ResultRow[] = [
  { id: "res_001", test: "Instrumentation Basics - Test 1", course: "Instrumentation Basics", score: 85, totalMarks: 100, date: "2026-05-26", status: "pass" },
  { id: "res_002", test: "Instrumentation Basics - Quiz 2", course: "Instrumentation Basics", score: 72, totalMarks: 100, date: "2026-04-18", status: "pass" },
  { id: "res_003", test: "Control Systems - Midterm", course: "Control Systems", score: 58, totalMarks: 100, date: "2026-03-30", status: "fail" },
  { id: "res_004", test: "P&ID Fundamentals - Quiz 1", course: "P&ID Fundamentals", score: 0, totalMarks: 50, date: "2026-05-28", status: "pending_review" },
];
