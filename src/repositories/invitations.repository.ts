import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createInvitationsRepository } from "./invitations.repository.core";

/**
 * The invitations repository bound to the caller's own Supabase session
 * (cookies; the database functions check the caller). Never the
 * service-role client — that lives only in auth-admin.repository.ts.
 */
export const invitationsRepository = createInvitationsRepository(createSupabaseServerClient);

export { InvitationsRepositoryError, InvitationsFunctionError } from "./invitations.repository.core";
export type { InvitationsRepository } from "./invitations.repository.core";
