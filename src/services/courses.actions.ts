"use server";

/**
 * Server Actions — the RPC boundary of Course Management (Add / Edit
 * course, status, delete, modules). Each action delegates to
 * courseManagementService (which resolves the caller's identity and
 * authorization server-side; the 0030 database functions decide again)
 * and returns a plain, serializable result. Only ids and the known form
 * fields are taken from the browser — never a course or module code.
 * Actions never redirect; the calling component decides how to navigate.
 */

import { revalidatePath } from "next/cache";
import { courseManagementService } from "./course-management.service";
import type { CourseActionResult } from "@/lib/courses/course-management";
import type { CourseDetailsInput, CreateCourseInput, ModuleInput, ModuleUpdateInput } from "@/types/course";

function refresh(courseId?: string) {
  revalidatePath("/admin/courses");
  if (courseId) revalidatePath(`/admin/courses/${courseId}`);
  // Course lists elsewhere: the Add Batch course choices and the trainer / student course pages.
  revalidatePath("/admin/batches/new");
  revalidatePath("/trainer/courses");
  revalidatePath("/student/courses");
}

const done = (result: CourseActionResult, courseId?: string): CourseActionResult => {
  if (result.ok) refresh(courseId ?? result.courseId);
  return result;
};

export async function createCourseAction(input: CreateCourseInput): Promise<CourseActionResult> {
  return done(await courseManagementService.createCourse(input));
}

/** Only the changed fields are sent (an unchanged legacy value is never re-validated). */
export async function updateCourseAction(courseId: string, input: Partial<CourseDetailsInput>): Promise<CourseActionResult> {
  return done(await courseManagementService.updateCourse(courseId, input), courseId);
}

export async function setCourseStatusAction(courseId: string, status: string): Promise<CourseActionResult> {
  return done(await courseManagementService.setCourseStatus(courseId, status), courseId);
}

export async function deleteCourseAction(courseId: string): Promise<CourseActionResult> {
  return done(await courseManagementService.deleteCourse(courseId));
}

export async function createModuleAction(courseId: string, input: ModuleInput): Promise<CourseActionResult> {
  return done(await courseManagementService.createModule(courseId, input), courseId);
}

export async function updateModuleAction(courseId: string, moduleId: string, input: ModuleUpdateInput): Promise<CourseActionResult> {
  return done(await courseManagementService.updateModule(moduleId, input), courseId);
}

export async function moveModuleAction(courseId: string, moduleId: string, direction: "up" | "down"): Promise<CourseActionResult> {
  return done(await courseManagementService.moveModule(moduleId, direction), courseId);
}

export async function deleteModuleAction(courseId: string, moduleId: string): Promise<CourseActionResult> {
  return done(await courseManagementService.deleteModule(moduleId), courseId);
}
