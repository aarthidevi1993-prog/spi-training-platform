import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { reportsRepository } from "@/repositories/reports.repository";
import { createReportsService } from "./reports.service.core";

/**
 * The Reports service bound to the real session (authService) and the
 * caller's own Supabase client (RLS applies). Super Admins and trainers
 * only; scope comes from the session, never from the URL.
 */
export const reportsService = createReportsService({
  repository: reportsRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  isDemoMode: () => authConfig.mode === "demo",
});

export { ReportsAuthorizationError } from "./reports.service.core";
export type { ReportResult, ReportOption } from "./reports.service.core";
export { ReportsRepositoryError } from "@/repositories/reports.repository";
