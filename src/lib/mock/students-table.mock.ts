/**
 * PART 3 UI-only mock rows for the Students table page. Deliberately
 * separate from src/lib/mock/students.mock.ts (which backs the
 * authoritative students.repository.ts) — these rows carry extra
 * display-only fields (batch, course, attendance/performance %) that
 * don't belong on the core Student entity yet. Replace with a real
 * query once the students module has a backing table.
 */
import type { StudentSummary } from "@/types/student";

/** Demo-mode student row shape — the same view model Supabase mode returns. */
export type StudentTableRow = StudentSummary;

export const studentTableRows: StudentTableRow[] = [
  { id: "std_001", name: "Arun Kumar", email: "arun.kumar@example.com", batch: "Batch A", course: "Instrumentation Basics", attendance: 94, performance: 88, status: "active" },
  { id: "std_002", name: "Divya Menon", email: "divya.menon@example.com", batch: "Batch A", course: "Instrumentation Basics", attendance: 89, performance: 76, status: "active" },
  { id: "std_003", name: "Rohit Sharma", email: "rohit.sharma@example.com", batch: "Batch B", course: "Control Systems", attendance: 0, performance: 0, status: "invited" },
  { id: "std_004", name: "Priya Nair", email: "priya.nair@example.com", batch: "Batch A", course: "Instrumentation Basics", attendance: 96, performance: 91, status: "active" },
  { id: "std_005", name: "Arjun Kumar", email: "arjun.kumar2@example.com", batch: "Batch B", course: "Control Systems", attendance: 82, performance: 79, status: "active" },
  { id: "std_006", name: "Sneha Iyer", email: "sneha.iyer@example.com", batch: "Batch A", course: "Instrumentation Basics", attendance: 91, performance: 84, status: "active" },
  { id: "std_007", name: "Karthik Raman", email: "karthik.raman@example.com", batch: "Batch C", course: "Process Safety", attendance: 68, performance: 61, status: "active" },
  { id: "std_008", name: "Meera Pillai", email: "meera.pillai@example.com", batch: "Batch C", course: "Process Safety", attendance: 0, performance: 0, status: "inactive" },
];

export function getStudentsForBatches(batches: string[]): StudentTableRow[] {
  return studentTableRows.filter((s) => batches.includes(s.batch));
}
