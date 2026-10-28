"use server";

/**
 * Server Actions for enrolment (Phase 7 P3.8). Each takes only the ids
 * (and, for the Super Admin action, the target status and an optional
 * reason) and delegates to enrollmentService, which resolves the caller
 * from the session; the database functions decide. Results are plain and
 * safe; unexpected errors are logged by name only.
 */

import { revalidatePath } from "next/cache";
import { enrollmentService, EnrollmentAuthorizationError } from "./enrollment.service";
import { ENROLLMENT_GENERIC_ERROR, isUuid, type EnrollmentActionResult } from "@/lib/enrollments/enrollment";

/** Pages that show enrolments or seat counts. */
function revalidateEnrollmentPages(batchId: string) {
  revalidatePath("/admin/batches");
  revalidatePath("/trainer/batches");
  if (isUuid(batchId)) {
    revalidatePath(`/admin/batches/${batchId}`);
    revalidatePath(`/trainer/batches/${batchId}`);
  }
  revalidatePath("/admin/students");
  revalidatePath("/trainer/students");
  revalidatePath("/admin/users");
}

async function run(context: string, batchId: string, fn: () => Promise<EnrollmentActionResult>): Promise<EnrollmentActionResult> {
  try {
    const result = await fn();
    if (result.ok) revalidateEnrollmentPages(batchId);
    return result;
  } catch (err) {
    if (err instanceof EnrollmentAuthorizationError) return { ok: false, error: err.message };
    console.error(`[enrollment.actions] ${context}:`, err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: ENROLLMENT_GENERIC_ERROR };
  }
}

/** Super Admin: enrol / re-enrol ("enrolled"), withdraw ("withdrawn") or complete ("completed"), with an optional reason. */
export async function setEnrollmentAction(batchId: string, studentId: string, status: string, reason?: string | null): Promise<EnrollmentActionResult> {
  return run("setEnrollment", batchId, () => enrollmentService.setEnrollment(batchId, studentId, status, reason ?? null));
}

/** Trainer: enrol one of their current students into a batch they currently teach. */
export async function trainerEnrolStudentAction(batchId: string, studentId: string): Promise<EnrollmentActionResult> {
  return run("trainerEnrolStudent", batchId, () => enrollmentService.trainerEnrol(batchId, studentId));
}
