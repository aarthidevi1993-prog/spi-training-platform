import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createDashboardRepository } from "./dashboard.repository.core";

/**
 * The dashboard repository bound to the caller's own Supabase session
 * (cookies; RLS decides what is visible). Never the service-role client.
 * Demo mode has no database: no client (fails closed).
 */
export const dashboardRepository = createDashboardRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export { DashboardRepositoryError, DashboardPermissionError, DashboardValidationError } from "./dashboard.repository.core";
export type { DashboardRepository } from "./dashboard.repository.core";
