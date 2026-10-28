import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createInvitationAcceptanceRepository } from "./invitation-acceptance.repository.core";

/**
 * The invitation acceptance repository bound to the invitee's own
 * Supabase session (cookies). Never the service-role client. Demo mode
 * has no Supabase invitations, so it gets no client (fails closed).
 */
export const invitationAcceptanceRepository = createInvitationAcceptanceRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export type { InvitationAcceptanceRepository } from "./invitation-acceptance.repository.core";
