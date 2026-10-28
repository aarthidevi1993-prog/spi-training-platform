import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createAuthAdminRepository } from "./auth-admin.repository.core";

/**
 * The ONLY module that imports the service-role client
 * (src/lib/supabase/admin.ts). Server-only: importing it from a client
 * component fails the build. Used exclusively by invitations.service,
 * after the database has authorized the delivery attempt.
 */
export const authAdminRepository = createAuthAdminRepository(createSupabaseAdminClient);

export type { AuthAdminRepository } from "./auth-admin.repository.core";
