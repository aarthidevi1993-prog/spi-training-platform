import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { classesService } from "./classes.service";
import {
  attendanceRepository,
  AttendanceRepositoryError,
  type AttendanceScope,
} from "@/repositories/attendance.repository";
import type { AuthUser } from "@/types/auth";
import type { ClassWithRelations } from "@/types/class";
import {
  ATTENDANCE_REMARKS_MAX_LENGTH,
  ATTENDANCE_STATUSES,
  type AttendanceMarkInput,
  type AttendanceOverview,
  type AttendanceRow,
  type AttendanceSummary,
  type AttendanceTrendPoint,
  type ClassAttendanceRoster,
} from "@/types/attendance";
import { formatDate } from "@/utils/format";

/**
 * Attendance service — resolves the caller's identity server-side via
 * authService (never from a client-supplied argument), derives the
 * scope from it, computes summaries, and validates marking before it
 * reaches the database. RLS + triggers (0005) remain the authoritative
 * boundary.
 */

export class AttendanceAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "AttendanceAuthorizationError";
  }
}

export class AttendanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceValidationError";
  }
}

/** How many class dates the trend chart shows (most recent). */
const TREND_POINTS = 7;

async function requireUser(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new AttendanceAuthorizationError("You need to be signed in.");
  return user;
}

/**
 * Admin: all records. Trainer: batches they run. Student: own records
 * (students.id = profiles.id = auth user id, proven in the database by
 * owns_student_record). Unknown role: nothing.
 */
function resolveScope(user: AuthUser): AttendanceScope {
  switch (user.role) {
    case "admin":
      return { kind: "all" };
    case "trainer":
      return { kind: "trainer", trainerId: user.id };
    case "student":
      return { kind: "student", studentId: user.id };
    default:
      return { kind: "none" };
  }
}

/** Today in India time as YYYY-MM-DD (UI-level "no future classes" rule). */
function todayInIndia(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function summarise(rows: AttendanceRow[]): AttendanceSummary {
  const summary: AttendanceSummary = { present: 0, absent: 0, late: 0, excused: 0, countable: 0 };
  for (const r of rows) summary[r.status] += 1;
  summary.countable = summary.present + summary.absent + summary.late;
  return summary;
}

/** Present (present + late) vs absent per class date, most recent dates. */
function trendOf(rows: AttendanceRow[]): AttendanceTrendPoint[] {
  const byDate = new Map<string, AttendanceTrendPoint>();
  for (const r of rows) {
    if (!r.date || r.status === "excused") continue;
    const point = byDate.get(r.date) ?? { label: r.date, present: 0, absent: 0 };
    if (r.status === "absent") point.absent += 1;
    else point.present += 1;
    byDate.set(r.date, point);
  }
  return Array.from(byDate.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(-TREND_POINTS)
    .map((p) => ({ ...p, label: formatDate(p.label, { year: undefined }) }));
}

export const attendanceService = {
  /** Review data for the Attendance page of the current user's portal. */
  async getOverview(): Promise<AttendanceOverview> {
    const user = await requireUser();
    const rows = await attendanceRepository.findRecords(resolveScope(user));
    return {
      rows,
      summary: summarise(rows),
      trend: trendOf(rows),
      batches: Array.from(new Set(rows.map((r) => r.batch))).sort(),
    };
  },

  /**
   * The Attendance tab of a class the caller can already see (the class
   * comes from classesService.getClass, so it is scoped). Null in demo
   * mode, where the tab keeps its placeholder.
   */
  async getClassRoster(trainingClass: ClassWithRelations): Promise<ClassAttendanceRoster | null> {
    if (authConfig.mode === "demo") return null;

    const user = await requireUser();
    const entries = await attendanceRepository.findRoster(trainingClass.id, trainingClass.batchId);

    let readOnlyReason: string | null = null;
    if (user.role === "student") {
      readOnlyReason = "Attendance is recorded by your trainer.";
    } else if (user.role !== "admin" && user.role !== "trainer") {
      readOnlyReason = "You don't have permission to mark attendance.";
    } else if (trainingClass.status === "cancelled") {
      readOnlyReason = "This class was cancelled, so attendance can't be recorded.";
    } else if (trainingClass.classDate > todayInIndia()) {
      readOnlyReason = `Attendance can be marked from the class date (${formatDate(trainingClass.classDate)}).`;
    } else if (user.role === "trainer") {
      const batchTrainerId = await attendanceRepository.findBatchTrainerId(trainingClass.batchId);
      if (batchTrainerId !== user.id) {
        readOnlyReason = "Only the batch's current trainer can mark attendance for this class.";
      }
    }

    return { classId: trainingClass.id, canMark: readOnlyReason === null, readOnlyReason, entries };
  },

  /** Save (insert or correct) attendance marks for one class. */
  async markAttendance(classId: string, marks: AttendanceMarkInput[]): Promise<void> {
    const user = await requireUser();
    if (user.role !== "admin" && user.role !== "trainer") {
      throw new AttendanceAuthorizationError("Only admins and trainers can mark attendance.");
    }
    if (authConfig.mode === "demo") {
      throw new AttendanceValidationError("Attendance marking isn't available in demo mode.");
    }

    // Scoped: a trainer only gets their own classes; anything else is null.
    const trainingClass = await classesService.getClass(classId);
    if (!trainingClass) throw new AttendanceAuthorizationError("That class doesn't exist or isn't available to you.");

    if (trainingClass.status === "cancelled") {
      throw new AttendanceValidationError("This class was cancelled, so attendance can't be recorded.");
    }
    if (trainingClass.classDate > todayInIndia()) {
      throw new AttendanceValidationError("Attendance can't be marked before the class date.");
    }
    if (user.role === "trainer") {
      const batchTrainerId = await attendanceRepository.findBatchTrainerId(trainingClass.batchId);
      if (batchTrainerId !== user.id) {
        throw new AttendanceAuthorizationError("Only the batch's current trainer can mark attendance for this class.");
      }
    }

    if (marks.length === 0) throw new AttendanceValidationError("Choose a status for at least one student.");

    // Only current (non-withdrawn) students on this class's roster.
    const roster = await attendanceRepository.findRoster(trainingClass.id, trainingClass.batchId);
    const editable = new Set(roster.filter((e) => e.editable).map((e) => e.studentId));
    const seen = new Set<string>();

    const clean: AttendanceMarkInput[] = marks.map((m) => {
      if (!editable.has(m.studentId)) {
        throw new AttendanceValidationError("One of the students isn't a current student of this class's batch.");
      }
      if (seen.has(m.studentId)) throw new AttendanceValidationError("A student was included more than once.");
      seen.add(m.studentId);
      if (!ATTENDANCE_STATUSES.includes(m.status)) throw new AttendanceValidationError("Invalid attendance status.");

      const remarks = m.remarks?.trim() ? m.remarks.trim() : null;
      if (remarks && remarks.length > ATTENDANCE_REMARKS_MAX_LENGTH) {
        throw new AttendanceValidationError(`Remarks must be ${ATTENDANCE_REMARKS_MAX_LENGTH} characters or fewer.`);
      }
      return { studentId: m.studentId, status: m.status, remarks };
    });

    await attendanceRepository.upsertMarks(trainingClass.id, trainingClass.batchId, clean);
  },
};

export { AttendanceRepositoryError };
