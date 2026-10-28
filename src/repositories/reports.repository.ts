import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createReportsRepository } from "./reports.repository.core";

/**
 * The Reports repository bound to the caller's own Supabase session
 * (cookies; RLS applies). Never the service-role client.
 */
export const reportsRepository = createReportsRepository(createSupabaseServerClient);

export { ReportsRepositoryError } from "./reports.repository.core";
export type { ReportsRepository } from "./reports.repository.core";
