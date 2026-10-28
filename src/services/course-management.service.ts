import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { courseManagementRepository } from "@/repositories/course-management.repository";
import { createCourseManagementService } from "./course-management.service.core";

/** Course Management bound to the signed-in session (identity resolved server-side, never from the browser). */
export const courseManagementService = createCourseManagementService({
  repository: courseManagementRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  isDemo: () => authConfig.mode === "demo",
});

export { CourseManagementAuthorizationError } from "./course-management.service.core";
export { CourseManagementUnavailableError } from "@/repositories/course-management.repository";
