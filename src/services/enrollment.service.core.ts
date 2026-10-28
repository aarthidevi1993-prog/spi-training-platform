/**
 * Enrolment service (Phase 7 P3.8). The signed-in user comes from the
 * session (never from the browser); the database stays the final
 * authority (functions + RLS).
 *
 *   getBatchDetail(batchId)
 *     Super Admin: any batch — roster (incl. withdrawn), history, and the
 *       AVAILABLE students not yet in this batch as candidates.
 *     Trainer: only batches assigned to them (others → null) — roster
 *       without withdrawn rows (RLS), history (RLS: batches they currently
 *       teach), and as candidates the students currently enrolled in their
 *       other current batches. Account status isn't visible to trainers, so
 *       the database answers student_not_available when it applies.
 *   setEnrollment(...)   Super Admin: enrol / re-enrol / withdraw / complete
 *   trainerEnrol(...)    trainer: enrol an in-scope student
 *
 * Every outcome becomes a fixed sentence; raw errors never leave here.
 */
import {
  ENROLLMENT_ADMIN_ONLY_ERROR,
  ENROLLMENT_GENERIC_ERROR,
  ENROLLMENT_SOURCE_LABEL,
  ENROLLMENT_TRAINER_SCOPE_ERROR,
  enrollmentActions,
  ENROLMENT_CLOSED_NOTE,
  isEnrolmentClosedForCourse,
  enrollmentRefusalMessage,
  enrollmentSuccessMessage,
  isUuid,
  parseAdminEnrollmentInput,
  parseTrainerEnrollmentInput,
  type BatchEnrollmentDetail,
  type BatchStatusValue,
  type EnrollmentActionResult,
  type EnrollmentCandidate,
} from "@/lib/enrollments/enrollment";
import type { AuthUser } from "@/types/auth";
import { EnrollmentPermissionError, type EnrollmentRepository, type EnrollmentRpcResult } from "@/repositories/enrollment.repository.core";

export class EnrollmentAuthorizationError extends Error {
  constructor(message = "You don't have permission to view or change enrolments.") {
    super(message);
    this.name = "EnrollmentAuthorizationError";
  }
}

export interface EnrollmentServiceDeps {
  repository: Pick<EnrollmentRepository, "setEnrollment" | "trainerEnrol" | "getBatchHeader" | "listRoster" | "listHistory" | "listStudents" | "listTrainerScope">;
  getCurrentUser: () => Promise<AuthUser | null>;
}

const BATCH_STATUS = new Set(["upcoming", "ongoing", "completed", "cancelled"]);
const byName = (a: EnrollmentCandidate, b: EnrollmentCandidate) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code);

export function createEnrollmentService(deps: EnrollmentServiceDeps) {
  async function requireUser(): Promise<AuthUser> {
    const user = await deps.getCurrentUser();
    if (!user) throw new EnrollmentAuthorizationError("You need to be signed in.");
    return user;
  }

  /** Database answer → fixed sentence. */
  function toResult(result: EnrollmentRpcResult): EnrollmentActionResult {
    if (!result.ok) return { ok: false, error: enrollmentRefusalMessage(result.reason) };
    return { ok: true, message: enrollmentSuccessMessage(result.previous, result.status) };
  }

  return {
    async getBatchDetail(batchId: unknown): Promise<BatchEnrollmentDetail | null> {
      const user = await requireUser();
      if (user.role !== "admin" && user.role !== "trainer") throw new EnrollmentAuthorizationError();
      if (!isUuid(batchId)) return null;
      const mode = user.role === "admin" ? "admin" : "trainer";

      const header = await deps.repository.getBatchHeader(batchId);
      if (!header || !BATCH_STATUS.has(header.status)) return null;
      // A trainer works only with batches assigned to them (RLS would also show batches they once taught classes in).
      if (mode === "trainer" && header.trainer_id !== user.id) return null;
      const status = header.status as BatchStatusValue;

      const [rosterRows, historyRows] = await Promise.all([deps.repository.listRoster(batchId), deps.repository.listHistory(batchId)]);
      const roster = rosterRows.map((r) => ({
        studentId: r.student_id,
        studentCode: r.student_code,
        studentName: r.full_name,
        enrollmentStatus: r.enrollment_status,
        enrolledAt: r.enrolled_at,
        completedAt: r.completed_at,
        actions: enrollmentActions(mode, status, r.enrollment_status, header.course_status),
      }));
      const inBatch = new Set(rosterRows.map((r) => r.student_id));
      const canEnrol = enrollmentActions(mode, status, null, header.course_status).enrol;
      const enrolmentClosed = isEnrolmentClosedForCourse(status, header.course_status);

      let candidates: EnrollmentCandidate[] = [];
      if (canEnrol && mode === "admin") {
        candidates = (await deps.repository.listStudents())
          .filter((s) => !inBatch.has(s.id) && s.status === "active" && s.role === "student" && s.account_status === "active")
          .map((s) => ({ id: s.id, code: s.student_code, name: s.full_name }))
          .sort(byName);
      } else if (canEnrol && mode === "trainer") {
        const seen = new Map<string, EnrollmentCandidate>();
        for (const r of await deps.repository.listTrainerScope(user.id)) {
          if (r.batch_id === batchId || inBatch.has(r.student_id)) continue;
          if (r.batch_status !== "upcoming" && r.batch_status !== "ongoing") continue;
          if (r.student_status !== "active" || !r.student_code || !r.full_name) continue;
          seen.set(r.student_id, { id: r.student_id, code: r.student_code, name: r.full_name });
        }
        candidates = [...seen.values()].sort(byName);
      }

      return {
        mode,
        batch: {
          id: header.id,
          code: header.batch_code,
          name: header.name,
          status,
          startDate: header.start_date,
          endDate: header.end_date,
          maxSeats: header.max_seats,
          course: header.course,
          trainerId: header.trainer_id,
          trainerName: header.trainer_name,
        },
        seatsUsed: rosterRows.filter((r) => r.enrollment_status !== "withdrawn").length,
        roster,
        history: historyRows.map((h) => ({
          id: h.id,
          occurredAt: h.occurred_at,
          studentId: h.student_id,
          previousStatus: h.previous_status,
          newStatus: h.new_status,
          source: h.source,
          sourceLabel: ENROLLMENT_SOURCE_LABEL[h.source] ?? h.source,
          reason: h.reason,
        })),
        candidates,
        canEnrol,
        ...(enrolmentClosed ? { enrolmentNote: ENROLMENT_CLOSED_NOTE } : {}),
      };
    },

    async setEnrollment(batchId: unknown, studentId: unknown, status: unknown, reason: unknown): Promise<EnrollmentActionResult> {
      const user = await requireUser();
      if (user.role !== "admin") throw new EnrollmentAuthorizationError(ENROLLMENT_ADMIN_ONLY_ERROR);
      const input = parseAdminEnrollmentInput(batchId, studentId, status, reason);
      if (!input.ok) return { ok: false, error: input.error };
      try {
        return toResult(await deps.repository.setEnrollment(input.value.batchId, input.value.studentId, input.value.status, input.value.reason));
      } catch (err) {
        if (err instanceof EnrollmentPermissionError) return { ok: false, error: ENROLLMENT_ADMIN_ONLY_ERROR };
        return { ok: false, error: ENROLLMENT_GENERIC_ERROR };
      }
    },

    async trainerEnrol(batchId: unknown, studentId: unknown): Promise<EnrollmentActionResult> {
      const user = await requireUser();
      if (user.role !== "trainer") throw new EnrollmentAuthorizationError("Only trainers can add students to their batches here.");
      const input = parseTrainerEnrollmentInput(batchId, studentId);
      if (!input.ok) return { ok: false, error: input.error };
      try {
        return toResult(await deps.repository.trainerEnrol(input.value.batchId, input.value.studentId));
      } catch (err) {
        if (err instanceof EnrollmentPermissionError) return { ok: false, error: ENROLLMENT_TRAINER_SCOPE_ERROR };
        return { ok: false, error: ENROLLMENT_GENERIC_ERROR };
      }
    },
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
