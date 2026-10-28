import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  attendanceTableRows,
  getAttendanceForBatches,
  getAttendanceForStudent,
} from "@/lib/mock/attendance-table.mock";
import type { AttendanceMarkInput, AttendanceRow, ClassRosterEntry } from "@/types/attendance";

/**
 * Attendance repository — the only module that knows where attendance
 * data lives (public.class_attendance, 0005_class_attendance.sql).
 *
 *   - Demo mode: the existing demo review rows (no roster/marking).
 *   - Supabase mode: typed queries with the caller's session.
 *
 * RLS is the authoritative boundary (admin: all; trainer: batches they
 * run / classes they taught, write only for batches they run, never
 * delete; student: own records via owns_student_record). The scopes
 * below are the second layer. marked_by / marked_at are stamped by the
 * database, never sent from here.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export class AttendanceRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "AttendanceRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  console.error(`[attendance] ${context}:`, error instanceof Error ? error.message : error);
}

/** Which attendance records a review page lists. */
export type AttendanceScope =
  | { kind: "all" }
  | { kind: "trainer"; trainerId: string }
  | { kind: "student"; studentId: string }
  | { kind: "none" };

// Demo identities, matching the demo data used by Classes/Batches/Students.
const DEMO_TRAINER_BATCHES = ["Batch A"];
const DEMO_STUDENT_NAME = "Arun Kumar";

const RECORD_SELECT = `
  class_id, student_id, status,
  students ( full_name ),
  classes ( title, class_date, batches ( name ) )
`;

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new AttendanceRepositoryError();
  return supabase;
}

export const attendanceRepository = {
  /** Review rows (one per student × class), newest class first. */
  async findRecords(scope: AttendanceScope): Promise<AttendanceRow[]> {
    if (authConfig.mode === "demo") {
      if (scope.kind === "all") return attendanceTableRows;
      if (scope.kind === "trainer") return getAttendanceForBatches(DEMO_TRAINER_BATCHES);
      if (scope.kind === "student") return getAttendanceForStudent(DEMO_STUDENT_NAME);
      return [];
    }

    if (scope.kind === "none") return [];

    try {
      const supabase = await client();
      let query = supabase.from("class_attendance").select(RECORD_SELECT);

      if (scope.kind === "trainer") {
        // Attendance of the batches the trainer currently runs.
        const { data: batches, error: batchError } = await supabase
          .from("batches")
          .select("id")
          .eq("trainer_id", scope.trainerId);
        if (batchError) throw batchError;
        const batchIds = (batches ?? []).map((b) => b.id);
        if (batchIds.length === 0) return [];
        query = query.in("batch_id", batchIds);
      } else if (scope.kind === "student") {
        query = query.eq("student_id", scope.studentId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data ?? [])
        .map((row) => ({
          id: `${row.class_id}:${row.student_id}`,
          student: row.students?.full_name ?? "Unknown student",
          batch: row.classes?.batches?.name ?? "Unknown batch",
          className: row.classes?.title ?? "Unknown class",
          date: row.classes?.class_date ?? "",
          status: row.status,
        }))
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) || a.className.localeCompare(b.className) || a.student.localeCompare(b.student)
        );
    } catch (err) {
      if (err instanceof AttendanceRepositoryError) throw err;
      logDbError("findRecords failed", err);
      throw new AttendanceRepositoryError();
    }
  },

  /**
   * The roster for one class: the batch's current (non-withdrawn)
   * students — editable — plus any already-marked students who have
   * since withdrawn — read-only history. RLS narrows this further (a
   * student only ever receives their own lines).
   */
  async findRoster(classId: string, batchId: string): Promise<ClassRosterEntry[]> {
    try {
      const supabase = await client();

      const [enrolments, records] = await Promise.all([
        supabase
          .from("batch_students")
          .select("student_id, enrollment_status, students ( full_name, student_code )")
          .eq("batch_id", batchId),
        supabase
          .from("class_attendance")
          .select("student_id, status, remarks, marked_at, students ( full_name, student_code )")
          .eq("class_id", classId),
      ]);
      if (enrolments.error) throw enrolments.error;
      if (records.error) throw records.error;

      const recordByStudent = new Map((records.data ?? []).map((r) => [r.student_id, r]));
      const entries = new Map<string, ClassRosterEntry>();

      for (const e of enrolments.data ?? []) {
        if (e.enrollment_status === "withdrawn") continue;
        const record = recordByStudent.get(e.student_id);
        entries.set(e.student_id, {
          studentId: e.student_id,
          name: e.students?.full_name ?? "Unknown student",
          studentCode: e.students?.student_code ?? "",
          editable: true,
          status: record?.status ?? null,
          remarks: record?.remarks ?? null,
          markedAt: record?.marked_at ?? null,
        });
      }

      // Marked students who are no longer current: keep as history.
      for (const r of records.data ?? []) {
        if (entries.has(r.student_id)) continue;
        entries.set(r.student_id, {
          studentId: r.student_id,
          name: r.students?.full_name ?? "Unknown student",
          studentCode: r.students?.student_code ?? "",
          editable: false,
          status: r.status,
          remarks: r.remarks,
          markedAt: r.marked_at,
        });
      }

      return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      if (err instanceof AttendanceRepositoryError) throw err;
      logDbError(`findRoster(${classId}) failed`, err);
      throw new AttendanceRepositoryError();
    }
  },

  /** The batch's assigned trainer (null when unassigned or not readable). */
  async findBatchTrainerId(batchId: string): Promise<string | null> {
    try {
      const supabase = await client();
      const { data, error } = await supabase.from("batches").select("trainer_id").eq("id", batchId).maybeSingle();
      if (error) throw error;
      return data?.trainer_id ?? null;
    } catch (err) {
      if (err instanceof AttendanceRepositoryError) throw err;
      logDbError(`findBatchTrainerId(${batchId}) failed`, err);
      throw new AttendanceRepositoryError();
    }
  },

  /**
   * Insert or update one record per student for this class. The
   * database enforces batch/class/enrolment consistency, cancelled
   * classes, withdrawn students and the marked_by stamp.
   */
  async upsertMarks(classId: string, batchId: string, marks: AttendanceMarkInput[]): Promise<void> {
    if (marks.length === 0) return;
    try {
      const supabase = await client();
      const { error } = await supabase.from("class_attendance").upsert(
        marks.map((m) => ({
          class_id: classId,
          batch_id: batchId,
          student_id: m.studentId,
          status: m.status,
          remarks: m.remarks,
        })),
        { onConflict: "class_id,student_id" }
      );
      if (error) throw error;
    } catch (err) {
      if (err instanceof AttendanceRepositoryError) throw err;
      logDbError(`upsertMarks(${classId}) failed`, err);
      throw new AttendanceRepositoryError("We couldn't save the attendance. Please try again.");
    }
  },
};
