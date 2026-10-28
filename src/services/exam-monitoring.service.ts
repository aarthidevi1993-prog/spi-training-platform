import "server-only";
import { authService } from "./auth.service";
import { examMonitoringRepository } from "@/repositories/exam-monitoring.repository";
import { createExamMonitoringService } from "./exam-monitoring.service.core";

/**
 * The exam monitoring service bound to the real session (authService)
 * and the caller's own Supabase client (RLS applies).
 */
export const examMonitoringService = createExamMonitoringService({
  repository: examMonitoringRepository,
  getCurrentUser: () => authService.getCurrentUser(),
});

export { ExamMonitoringAuthorizationError } from "./exam-monitoring.service.core";
export { ExamMonitoringRepositoryError } from "@/repositories/exam-monitoring.repository";
