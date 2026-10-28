import "server-only";
import { authService } from "./auth.service";
import { enrollmentRepository } from "@/repositories/enrollment.repository";
import { createEnrollmentService } from "./enrollment.service.core";

/** The enrolment service bound to the real session and the caller's own Supabase client. */
export const enrollmentService = createEnrollmentService({
  repository: enrollmentRepository,
  getCurrentUser: () => authService.getCurrentUser(),
});

export { EnrollmentAuthorizationError } from "./enrollment.service.core";
