"use server";

/**
 * Server Actions — the RPC boundary client components call for class
 * mutations. Each action delegates to classesService (which resolves
 * the caller's identity and authorization server-side) and returns a
 * plain, serializable result object. Actions never redirect; the
 * calling component decides how to navigate.
 */

import { revalidatePath } from "next/cache";
import {
  classesService,
  ClassAuthorizationError,
  ClassValidationError,
  ClassRepositoryError,
} from "./classes.service";
import type { ClassValidationErrors, CreateClassInput, UpdateClassInput } from "@/types/class";

export interface ClassActionResult {
  ok: boolean;
  classId?: string;
  errors?: ClassValidationErrors;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Converts a thrown error into a safe, user-facing result. Internal
 * details are logged server-side and never returned to the browser.
 */
function toErrorResult(context: string, err: unknown): ClassActionResult {
  if (err instanceof ClassValidationError) {
    return { ok: false, errors: err.errors };
  }
  if (err instanceof ClassAuthorizationError || err instanceof ClassRepositoryError) {
    // Both carry messages written specifically to be shown to users.
    return { ok: false, errors: { form: err.message } };
  }
  console.error(`[classes.actions] ${context}:`, err instanceof Error ? err.message : err);
  return { ok: false, errors: { form: GENERIC_ERROR } };
}

/** Refresh every portal's class views after a mutation. */
function revalidateClassViews() {
  revalidatePath("/admin/classes");
  revalidatePath("/trainer/classes");
  revalidatePath("/student/classes");
}

export async function createClassAction(input: CreateClassInput): Promise<ClassActionResult> {
  try {
    const created = await classesService.createClass(input);
    revalidateClassViews();
    return { ok: true, classId: created.id };
  } catch (err) {
    return toErrorResult("createClass", err);
  }
}

export async function updateClassAction(id: string, patch: UpdateClassInput): Promise<ClassActionResult> {
  try {
    const updated = await classesService.updateClass(id, patch);
    revalidateClassViews();
    revalidatePath(`/admin/classes/${id}`);
    revalidatePath(`/trainer/classes/${id}`);
    return { ok: true, classId: updated.id };
  } catch (err) {
    return toErrorResult("updateClass", err);
  }
}

export async function cancelClassAction(id: string): Promise<ClassActionResult> {
  try {
    await classesService.cancelClass(id);
    revalidateClassViews();
    revalidatePath(`/admin/classes/${id}`);
    revalidatePath(`/trainer/classes/${id}`);
    return { ok: true, classId: id };
  } catch (err) {
    return toErrorResult("cancelClass", err);
  }
}

export async function deleteClassAction(id: string): Promise<ClassActionResult> {
  try {
    await classesService.deleteClass(id);
    revalidateClassViews();
    return { ok: true };
  } catch (err) {
    return toErrorResult("deleteClass", err);
  }
}
