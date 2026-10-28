"use server";

/**
 * Server Actions — the RPC boundary the class Assignment tab calls.
 * Each action delegates to assignmentsService (which resolves the
 * caller's identity and authorization server-side) and returns a plain,
 * serializable result. Internal error details are logged, never
 * returned to the browser.
 */

import { revalidatePath } from "next/cache";
import {
  assignmentsService,
  AssignmentAuthorizationError,
  AssignmentRepositoryError,
  AssignmentValidationError,
} from "./assignments.service";
import type { AssignmentInput, AssignmentStatus, ReviewInput, SubmissionInput } from "@/types/assignment";

export interface AssignmentActionResult {
  ok: boolean;
  error?: string;
}

function revalidateClass(classId: string) {
  for (const portal of ["admin", "trainer", "student"]) {
    revalidatePath(`/${portal}/classes/${classId}`);
  }
}

async function run(context: string, fn: () => Promise<string>): Promise<AssignmentActionResult> {
  try {
    const classId = await fn();
    revalidateClass(classId);
    return { ok: true };
  } catch (err) {
    if (
      err instanceof AssignmentValidationError ||
      err instanceof AssignmentAuthorizationError ||
      err instanceof AssignmentRepositoryError
    ) {
      // These carry messages written to be shown to users.
      return { ok: false, error: err.message };
    }
    console.error(`[assignments.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function createAssignmentAction(classId: string, input: AssignmentInput): Promise<AssignmentActionResult> {
  return run("createAssignment", () => assignmentsService.createAssignment(classId, input));
}

export async function updateAssignmentAction(assignmentId: string, input: AssignmentInput): Promise<AssignmentActionResult> {
  return run("updateAssignment", () => assignmentsService.updateAssignment(assignmentId, input));
}

export async function changeAssignmentStatusAction(
  assignmentId: string,
  next: AssignmentStatus
): Promise<AssignmentActionResult> {
  return run("changeStatus", () => assignmentsService.changeStatus(assignmentId, next));
}

export async function deleteAssignmentAction(assignmentId: string): Promise<AssignmentActionResult> {
  return run("deleteAssignment", () => assignmentsService.deleteAssignment(assignmentId));
}

export async function submitAssignmentAction(assignmentId: string, input: SubmissionInput): Promise<AssignmentActionResult> {
  return run("submit", () => assignmentsService.submit(assignmentId, input));
}

export async function returnSubmissionAction(
  assignmentId: string,
  studentId: string,
  review: ReviewInput
): Promise<AssignmentActionResult> {
  return run("returnSubmission", () => assignmentsService.returnSubmission(assignmentId, studentId, review));
}

export async function reopenSubmissionAction(assignmentId: string, studentId: string): Promise<AssignmentActionResult> {
  return run("reopenSubmission", () => assignmentsService.reopenSubmission(assignmentId, studentId));
}
