import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { invitationsRepository } from "@/repositories/invitations.repository";
import { authAdminRepository } from "@/repositories/auth-admin.repository";
import { recoveryMailerRepository } from "@/repositories/recovery-mailer.repository";
import { invitationRecoveryEnabled, invitationRedirectUrl, recoveryRedirectUrl } from "@/lib/user-management/invitations";
import { createInvitationsService } from "./invitations.service.core";

/**
 * The invitations service bound to the real session (authService), the
 * caller's own Supabase client for the database decisions, the
 * server-only Auth Admin repository for invitation e-mails and (P5.2) the
 * session-less recovery mailer for sign-in links. Redirects come from
 * NEXT_PUBLIC_APP_URL only.
 */
export const invitationsService = createInvitationsService({
  invitations: invitationsRepository,
  authAdmin: authAdminRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  redirectUrl: () => invitationRedirectUrl(process.env.NEXT_PUBLIC_APP_URL),
  isDemoMode: () => authConfig.mode === "demo",
  recoveryMailer: recoveryMailerRepository,
  recoveryRedirectUrl: () => recoveryRedirectUrl(process.env.NEXT_PUBLIC_APP_URL),
  // Server-only switch (never NEXT_PUBLIC_): recovery e-mails stay OFF unless it is exactly "true".
  recoveryEnabled: () => invitationRecoveryEnabled(process.env.INVITATION_RECOVERY_EMAILS_ENABLED),
});

export { InvitationsAuthorizationError, InvitationsInputError } from "./invitations.service.core";
export { InvitationsRepositoryError } from "@/repositories/invitations.repository";
