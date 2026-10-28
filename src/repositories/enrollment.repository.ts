import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createEnrollmentRepository } from "./enrollment.repository.core";

/**
 * The enrolment repository bound to the caller's own Supabase session
 * (cookies; the database functions and RLS check the caller). Never the
 * service-role client. Demo mode has no database: no client (fails closed).
 */
export const enrollmentRepository = createEnrollmentRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export { EnrollmentRepositoryError, EnrollmentPermissionError } from "./enrollment.repository.core";
export type { EnrollmentRepository } from "./enrollment.repository.core";
