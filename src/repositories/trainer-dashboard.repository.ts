import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createTrainerDashboardRepository } from "./trainer-dashboard.repository.core";

/**
 * The trainer dashboard repository bound to the caller's own Supabase
 * session (cookies; RLS decides what is visible). Never the service-role
 * client. Demo mode has no database: no client (fails closed).
 */
export const trainerDashboardRepository = createTrainerDashboardRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export { TrainerDashboardRepositoryError } from "./trainer-dashboard.repository.core";
export type { TrainerDashboardRepository } from "./trainer-dashboard.repository.core";
