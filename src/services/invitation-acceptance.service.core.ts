/**
 * Invitation acceptance service (Phase 7 P3.5).
 *
 *   confirmInvitation   the Continue step: re-check the link values,
 *                       verifyOtp(invite), confirm a user now exists
 *   acceptPageState     what /auth/accept shows: no session → /login;
 *                       already active → their portal; invited → form
 *   completeInvitation  password check (before any Auth call) →
 *                       getUser → already active? → updateUser(password)
 *                       → accept_user_invitation() → role → portal.
 *                       Any refusal after the password update signs out.
 *
 * Only accept_user_invitation() activates an account; the destination
 * is always the database role's fixed home. Nothing here logs or
 * returns a token, password or raw Auth/database error.
 */
import {
  acceptRefusalMessage,
  isPortalHome,
  parseInviteInput,
  PASSWORD_UPDATE_ERROR,
  PASSWORD_WEAK_ERROR,
  SESSION_MISSING_ERROR,
  SETUP_GENERIC_ERROR,
  enrolmentSkippedNotice,
  validateNewPassword,
  type CompleteInvitationResult,
  type ConfirmInvitationResult,
  type PortalHome,
} from "@/lib/auth/invite-acceptance";
import { getHomeRouteForRole } from "@/lib/auth/roles";
import type { UserRole } from "@/types/user";
import type { InvitationAcceptanceRepository } from "@/repositories/invitation-acceptance.repository.core";

export interface InvitationAcceptanceServiceDeps {
  repository: Pick<InvitationAcceptanceRepository, "open">;
}

export type AcceptPageState = { kind: "session_missing" } | { kind: "active"; home: PortalHome } | { kind: "invited"; email: string | null };

/** The fixed portal of an application role, or null if it is not one of the three. */
function homeFor(role: UserRole | null): PortalHome | null {
  if (!role) return null;
  const home = getHomeRouteForRole(role);
  return isPortalHome(home) ? home : null;
}

export function createInvitationAcceptanceService(deps: InvitationAcceptanceServiceDeps) {
  return {
    async confirmInvitation(tokenHash: unknown, type: unknown): Promise<ConfirmInvitationResult> {
      const link = parseInviteInput(tokenHash, type);
      if (!link.ok) return { ok: false, code: "invite_invalid" };
      const session = await deps.repository.open();
      if (!session) return { ok: false, code: "invite_failed" };
      const verified = await session.verifyInvite(link.tokenHash);
      if (verified === "invalid") return { ok: false, code: "invite_invalid" };
      if (verified !== "verified") return { ok: false, code: "invite_failed" };
      const user = await session.getUser();
      return user ? { ok: true } : { ok: false, code: "invite_failed" };
    },

    async acceptPageState(): Promise<AcceptPageState> {
      const session = await deps.repository.open();
      const user = session ? await session.getUser() : null;
      if (!session || !user) return { kind: "session_missing" };
      const home = homeFor(await session.fetchRole(user.id));
      return home ? { kind: "active", home } : { kind: "invited", email: user.email };
    },

    async completeInvitation(password: unknown, confirmPassword: unknown): Promise<CompleteInvitationResult> {
      // 1. The password is checked before anything talks to Auth.
      const check = validateNewPassword(password, confirmPassword);
      if (!check.ok) return { ok: false, error: check.error, field: check.field, ended: false };

      // 2. The invitee's own session.
      const session = await deps.repository.open();
      if (!session) return { ok: false, error: SETUP_GENERIC_ERROR, ended: true };
      const user = await session.getUser();
      if (!user) return { ok: false, error: SESSION_MISSING_ERROR, ended: true };

      // 3. Already active (accepted earlier): go home, leave the password alone.
      const current = homeFor(await session.fetchRole(user.id));
      if (current) return { ok: true, home: current };

      // 4. Password first, so an accepted account always has one.
      const updated = await session.updatePassword(check.password);
      if (!updated.ok) {
        return updated.reason === "weak_password"
          ? { ok: false, error: PASSWORD_WEAK_ERROR, field: "password", ended: false }
          : { ok: false, error: PASSWORD_UPDATE_ERROR, ended: false };
      }

      // 5. The database activates the account (or refuses).
      const accepted = await session.acceptInvitation();
      if (!accepted.ok) {
        await session.signOut();
        return { ok: false, error: acceptRefusalMessage(accepted.reason), ended: true };
      }

      // 6. The destination comes from the database role, never from the request.
      const home = homeFor(await session.fetchRole(user.id));
      if (!home) {
        await session.signOut();
        return { ok: false, error: SETUP_GENERIC_ERROR, ended: true };
      }
      // 7. 0030: active but not enrolled (the invitation's course was archived) — say so, with what to do next.
      const notice = enrolmentSkippedNotice(accepted.enrolmentSkipped);
      return notice ? { ok: true, home, notice } : { ok: true, home };
    },
  };
}

export type InvitationAcceptanceService = ReturnType<typeof createInvitationAcceptanceService>;
