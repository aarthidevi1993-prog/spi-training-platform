import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createCourseManagementRepository } from "./course-management.repository.core";

/**
 * The Course Management repository bound to the caller's own Supabase
 * session (cookies; the database functions check the caller). Never the
 * service-role client. Demo mode has no database: no client (fails closed).
 */
export const courseManagementRepository = createCourseManagementRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export {
  CourseManagementRepositoryError,
  CourseManagementPermissionError,
  CourseManagementInvalidInputError,
  CourseManagementUnavailableError,
} from "./course-management.repository.core";
export type { CourseManagementRepository } from "./course-management.repository.core";
