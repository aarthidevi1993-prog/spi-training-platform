/**
 * Invitation recovery service (P5.2) — the Continue step of /auth/recover.
 *
 *   1. re-check the link values (token hash format, type "email")
 *   2. verifyOtp(email): consumes the one-time sign-in link and starts the
 *      person's own session — proves they control the mailbox now
 *   3. an account that already has access (ACTIVE) is NOT what this flow is
 *      for: its session is ended at once and the browser goes to /login —
 *      recovery links are never a passwordless way into a portal
 *   4. complete_invitation_recovery() on that fresh session: the database
 *      checks that a Super Admin asked for this account, the request window,
 *      the invitation (pending, unexpired, unbound), eligibility and a fresh
 *      e-mail sign-in, then binds the invitation and audits it
 *   5. success → /auth/accept (set a password; accept_user_invitation)
 *      "not for this account" refusals (nothing pending, not requested, not
 *      eligible — e.g. suspended) → end the session, /login with a message
 *      other refusals (expired, old link, stale sign-in) → end the session, message here
 *
 * Every path that does not continue to /auth/accept ends the session through
 * endSession() (local scope, then a confirming read). When ending it cannot be
 * CONFIRMED — including when verifying the link threw — the result is
 * "signout_unconfirmed", which goes to the safe page (never /login, which
 * sends signed-in users to their portal). Never the service role; the session
 * is the person's own (cookies). Nothing here logs or returns a token,
 * address or raw Auth/database error. Factory without `server-only` so it
 * can be tested with fakes and a local database; invitation-recovery.service.ts
 * wires the real repository.
 */
import { INVITE_ACCEPT_PATH } from "@/lib/auth/invite-acceptance";
import {
  RECOVERY_NOT_ELIGIBLE_REASONS,
  parseRecoveryInput,
  recoveryRefusalMessage,
  type ConfirmRecoveryResult,
} from "@/lib/auth/invitation-recovery";
import type { EndSessionResult, InvitationAcceptanceRepository, InvitationAcceptanceSession } from "@/repositories/invitation-acceptance.repository.core";

export interface InvitationRecoveryServiceDeps {
  repository: Pick<InvitationAcceptanceRepository, "open">;
}

/** End the session this flow may have created; only a CONFIRMED end lets the planned refusal through. */
async function refuse(session: Pick<InvitationAcceptanceSession, "endSession">, result: ConfirmRecoveryResult): Promise<ConfirmRecoveryResult> {
  const ended = await session.endSession();
  return ended === "ended" ? result : { ok: false, code: "signout_unconfirmed" };
}

export function createInvitationRecoveryService(deps: InvitationRecoveryServiceDeps) {
  return {
    async confirmRecovery(tokenHash: unknown, type: unknown): Promise<ConfirmRecoveryResult> {
      const link = parseRecoveryInput(tokenHash, type);
      if (!link.ok) return { ok: false, code: "invite_invalid" };
      const session = await deps.repository.open();
      if (!session) return { ok: false, code: "invite_failed" };

      // Mailbox proof: the one-time link is consumed here, by the deliberate Continue click — never on page load.
      const verified = await session.verifyEmailLink(link.tokenHash);
      // Refused by Auth: no session was created.
      if (verified === "invalid") return { ok: false, code: "invite_invalid" };
      // Verification threw: a session may or may not have been stored — clean up before going anywhere.
      if (verified !== "verified") return refuse(session, { ok: false, code: "invite_failed" });
      const user = await session.getUser();
      if (!user) return refuse(session, { ok: false, code: "invite_failed" });

      // An account that already has access is not an invitee: end this session, use the normal sign-in instead.
      if ((await session.fetchRole(user.id)) !== null) return refuse(session, { ok: false, code: "recovery_not_eligible" });

      const completed = await session.completeRecovery();
      if (completed.ok) return { ok: true, destination: INVITE_ACCEPT_PATH };
      return refuse(
        session,
        RECOVERY_NOT_ELIGIBLE_REASONS.includes(completed.reason)
          ? { ok: false, code: "recovery_not_eligible" }
          : { ok: false, error: recoveryRefusalMessage(completed.reason) }
      );
    },

    /** The safe page's button: try once more to end the session on this device (local scope, confirmed). */
    async endRecoverySession(): Promise<EndSessionResult> {
      const session = await deps.repository.open();
      if (!session) return "unconfirmed";
      return session.endSession();
    },
  };
}

export type InvitationRecoveryService = ReturnType<typeof createInvitationRecoveryService>;
