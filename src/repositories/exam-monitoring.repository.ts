import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createExamMonitoringRepository } from "./exam-monitoring.repository.core";

/**
 * The exam monitoring repository bound to the caller's own Supabase
 * session (cookies; RLS applies). Never the service-role client.
 */
export const examMonitoringRepository = createExamMonitoringRepository(createSupabaseServerClient);

export { ExamMonitoringRepositoryError } from "./exam-monitoring.repository.core";
export type { ExamMonitoringRepository } from "./exam-monitoring.repository.core";
