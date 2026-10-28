/** PART 3 UI-only mock rows for the Attendance page (demo mode only). */
import type { AttendanceRow } from "@/types/attendance";

/** Demo-mode attendance row shape — the same view model Supabase mode returns. */
export type AttendanceTableRow = AttendanceRow;

export const attendanceSummary = {
  present: 92,
  absent: 5,
  late: 3,
};

export const attendanceTableRows: AttendanceTableRow[] = [
  { id: "att_001", student: "Arun Kumar", batch: "Batch A", className: "Instrumentation Basics", date: "2026-05-26", status: "present" },
  { id: "att_002", student: "Divya Menon", batch: "Batch A", className: "Instrumentation Basics", date: "2026-05-26", status: "present" },
  { id: "att_003", student: "Priya Nair", batch: "Batch A", className: "Instrumentation Basics", date: "2026-05-26", status: "late" },
  { id: "att_004", student: "Arjun Kumar", batch: "Batch B", className: "Control Systems", date: "2026-05-25", status: "present" },
  { id: "att_005", student: "Sneha Iyer", batch: "Batch A", className: "Instrumentation Basics", date: "2026-05-25", status: "absent" },
  { id: "att_006", student: "Karthik Raman", batch: "Batch C", className: "Process Safety", date: "2026-05-24", status: "excused" },
  { id: "att_007", student: "Meera Pillai", batch: "Batch C", className: "Process Safety", date: "2026-05-24", status: "absent" },
];

export function getAttendanceForBatches(batches: string[]): AttendanceTableRow[] {
  return attendanceTableRows.filter((a) => batches.includes(a.batch));
}

export function getAttendanceForStudent(studentName: string): AttendanceTableRow[] {
  return attendanceTableRows.filter((a) => a.student === studentName);
}
