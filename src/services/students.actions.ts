"use server";

/**
 * Server Actions for trainer student editing (Phase 7 P3.10-B). The caller
 * comes from the session inside studentsService — never from the browser —
 * and trainer_update_student decides scope and records the audit row. Only
 * the student id and the four editable values are forwarded; anything else
 * the browser sends (a role, a scope, other fields) is dropped. Results are
 * plain and safe; unexpected errors are logged by name only.
 */

import { revalidatePath } from "next/cache";
import { studentsService, StudentEditAuthorizationError } from "./students.service";
import { TRAINER_EDIT_MESSAGE, type TrainerEditResult } from "@/lib/students/trainer-edit";

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Trainer: save an in-scope student's name / phone / organization / designation (blank optional fields keep their values). */
export async function trainerUpdateStudentAction(studentId: string, input: unknown): Promise<TrainerEditResult> {
  const v = asObject(input);
  try {
    const result = await studentsService.updateAsTrainer(studentId, {
      fullName: v.fullName,
      phone: v.phone,
      organization: v.organization,
      designation: v.designation,
    });
    if (result.ok) revalidatePath("/trainer/students");
    return result;
  } catch (err) {
    // This one carries a message written to be shown to users.
    if (err instanceof StudentEditAuthorizationError) return { ok: false, error: err.message };
    console.error("[students.actions] trainerUpdateStudent:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: TRAINER_EDIT_MESSAGE.generic };
  }
}
