export type AttendanceStatus = "present" | "absent" | "late" | "excused";

export const ATTENDANCE_STATUSES: AttendanceStatus[] = ["present", "absent", "late", "excused"];

/** Mirrors the class_attendance_remarks_length constraint (0005). */
export const ATTENDANCE_REMARKS_MAX_LENGTH = 500;

export interface AttendanceRecord {
  id: string;
  classId: string;
  studentId: string;
  status: AttendanceStatus;
  markedAt: string;
  markedBy: string;
  remarks?: string;
}

/** One row of the Attendance review table (one student × one class). */
export interface AttendanceRow {
  id: string;
  student: string;
  batch: string;
  className: string;
  /** ISO date of the class, YYYY-MM-DD. */
  date: string;
  status: AttendanceStatus;
}

/**
 * Counts over marked records. Percentages use
 * (present + late) / (present + absent + late) — excused is excluded
 * from the denominator, and unmarked students are never counted as
 * absent. `countable === 0` means nothing to report yet.
 */
export interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  excused: number;
  /** present + absent + late — the percentage denominator. */
  countable: number;
}

/** One bar group of the attendance trend chart (per class date). */
export interface AttendanceTrendPoint {
  label: string;
  present: number;
  absent: number;
}

/** Everything an Attendance review page renders. */
export interface AttendanceOverview {
  rows: AttendanceRow[];
  summary: AttendanceSummary;
  trend: AttendanceTrendPoint[];
  /** Batch names present in `rows`, for the batch filter. */
  batches: string[];
}

/** One student line on a class's attendance roster. */
export interface ClassRosterEntry {
  studentId: string;
  name: string;
  studentCode: string;
  /** False for students who withdrew after being marked (read-only history). */
  editable: boolean;
  status: AttendanceStatus | null;
  remarks: string | null;
  markedAt: string | null;
}

/** The Attendance tab of a class detail page. */
export interface ClassAttendanceRoster {
  classId: string;
  /** Whether the current user may save attendance for this class now. */
  canMark: boolean;
  /** Why marking is unavailable (shown to the user) — null when canMark. */
  readOnlyReason: string | null;
  entries: ClassRosterEntry[];
}

export interface AttendanceMarkInput {
  studentId: string;
  status: AttendanceStatus;
  remarks: string | null;
}
