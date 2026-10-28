/**
 * Invitations service (Phase 7 P3.4) — Super Admin invitation sending.
 *
 *   create_user_invitation()        caller's session  (who may invite whom; address rules)
 *        ↓
 *   begin_invitation_delivery()     caller's session  (scope, pending/unexpired, lock,
 *        ↓                                             60 s cooldown, ≤5 resends; returns the address)
 *   auth.admin.inviteUserByEmail()  service role      (address from the step above only)
 *        ↓
 *   record_invitation_delivery()    service role      (sent / failed, Auth-account binding)
 *
 * Identity comes from getCurrentUser (the server session); only an
 * active Super Admin may use this service in P3.4. The database decides
 * every rule; this service only sequences the calls and turns every
 * answer into one InvitationSendOutcome. It never retries an Auth invite
 * on its own and never writes invitation rows directly — in particular,
 * when Auth sent the email but recording failed, it reports
 * "sent_unrecorded" and leaves the database exactly as
 * begin_invitation_delivery left it.
 *
 * Observability: every delivery attempt that does not end in "sent"
 * writes exactly one server log line with the invitation id, the outcome
 * kind and safe codes (never an address, token or raw error).
 *
 * Factory without `server-only` so it can be tested with fakes and
 * against a local database; invitations.service.ts wires the real parts.
 */
import type { AuthUser } from "@/types/auth";
import type {
  InvitationCreateRefusal,
  InvitationDeliverRefusal,
  InvitationRecoveryOutcome,
  InvitationRecoveryRefusal,
  InvitationRevokeOutcome,
  InvitationRevokeRefusal,
  InvitationSendOutcome,
} from "@/types/user-management";
import {
  asCreateRefusal,
  asDeliverRefusal,
  asRecoveryRefusal,
  asRevokeRefusal,
  buildInvitationPayload,
  type InviteUserInput,
} from "@/lib/user-management/invitations";
import { isUuid, normalizeReason } from "@/lib/user-management/lifecycle";
import { InvitationsFunctionError, InvitationsRepositoryError, type InvitationsRepository } from "@/repositories/invitations.repository.core";
import type { AuthAdminDelivery, AuthAdminRepository } from "@/repositories/auth-admin.repository.core";
import type { RecoveryMailerRepository } from "@/repositories/recovery-mailer.repository.core";

export class InvitationsAuthorizationError extends Error {
  constructor(message = "Only Super Admins can send invitations.") {
    super(message);
    this.name = "InvitationsAuthorizationError";
  }
}

/** Invalid input refused before any database call; the message is safe to show. */
export class InvitationsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationsInputError";
  }
}

export interface InvitationsServiceDeps {
  invitations: InvitationsRepository;
  authAdmin: AuthAdminRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** The confirmation redirect from configuration (null = not safely configured). */
  redirectUrl: () => string | null;
  isDemoMode?: () => boolean;
  /** P5.2: the session-less sign-in e-mail sender (never the service role). Recovery is unavailable without it. */
  recoveryMailer?: RecoveryMailerRepository;
  /** P5.2: the recovery sign-in redirect from configuration (null = not safely configured). */
  recoveryRedirectUrl?: () => string | null;
  /**
   * P5.2: server-side switch for recovery e-mails. DISABLED unless this returns true — turned on only after the
   * Magic Link template and the staging verification are confirmed (docs/runbooks/live-migration-0029a.md).
   */
  recoveryEnabled?: () => boolean;
}

/** Raised database errors → a refusal reason, by SQLSTATE only. */
function raisedReason(err: unknown): "permission" | "invalid" | "already_invited" | null {
  if (!(err instanceof InvitationsFunctionError)) return null;
  if (err.code === "42501") return "permission";
  if (err.code === "23505") return "already_invited"; // concurrent create hit the one-pending-per-address index
  if (err.code === "22023" || err.code === "22P02" || err.code === "23514") return "invalid";
  return null;
}

/** One safe diagnostic line per non-success delivery: invitation id, outcome kind, codes. */
function logDelivery(invitationId: string, kind: string, fields: Record<string, string | boolean>) {
  const detail = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.error(`[invitations] delivery ${kind}: invitation=${invitationId} ${detail}`);
}

/**
 * Sending is not configured: one log line naming the missing server setting (a fixed setting name, never a value),
 * so an operator can fix it from the server log. The user only ever sees the generic "not configured" outcome.
 */
function notConfigured(missing: "app_url" | "service_role"): null {
  console.error(
    missing === "app_url"
      ? "[invitations] sending not configured: NEXT_PUBLIC_APP_URL is missing, invalid or not https"
      : "[invitations] sending not configured: no service-role client (check the Supabase URL and service-role key settings)"
  );
  return null;
}

/** An unrecognised refusal code from the database is an error, never passed on as a reason. */
function unexpectedRefusal(stage: string, reason: string): never {
  console.error(`[invitations] unexpected ${stage} refusal code: ${reason}`);
  throw new InvitationsRepositoryError();
}

export function createInvitationsService(deps: InvitationsServiceDeps) {
  async function requireSuperAdmin(): Promise<AuthUser> {
    const user = await deps.getCurrentUser();
    if (!user) throw new InvitationsAuthorizationError("You need to be signed in.");
    if (user.role !== "admin") throw new InvitationsAuthorizationError();
    return user;
  }

  /** The safe redirect plus one service-role client for this operation — or null when sending isn't configured. */
  function openSending(): { redirectTo: string; delivery: AuthAdminDelivery } | null {
    if (deps.isDemoMode?.()) return null;
    const redirectTo = deps.redirectUrl();
    if (!redirectTo) return notConfigured("app_url");
    const delivery = deps.authAdmin.openDelivery();
    return delivery ? { redirectTo, delivery } : notConfigured("service_role");
  }

  async function deliver(
    invitationId: string,
    sending: { redirectTo: string; delivery: AuthAdminDelivery },
    code: string | null = null
  ): Promise<InvitationSendOutcome> {
    /** The generated code travels with every outcome after creation, so the UI can show it. */
    const withCode = code ? { code } : {};
    // 1. Database authorization of this attempt (caller's session).
    let begun;
    try {
      begun = await deps.invitations.beginDelivery(invitationId);
    } catch (err) {
      const reason = raisedReason(err);
      if (reason === "permission" || reason === "invalid") return { kind: "refused", stage: "deliver", reason, invitationId };
      throw err;
    }
    if (!begun.ok) {
      const reason: InvitationDeliverRefusal = asDeliverRefusal(begun.reason) ?? unexpectedRefusal("delivery", begun.reason);
      return {
        kind: "refused",
        stage: "deliver",
        reason,
        invitationId,
        ...(begun.retryAfterSeconds !== undefined ? { retryAfterSeconds: begun.retryAfterSeconds } : {}),
      };
    }

    // 2. Auth Admin, with the database-owned address only.
    const sent = await sending.delivery.inviteUserByEmail(begun.email, sending.redirectTo);

    if (sent.kind === "unknown") {
      // No definite answer: nothing is recorded (the email may have gone out).
      logDelivery(invitationId, "delivery_unknown", { auth: sent.diagnostic });
      return { kind: "delivery_unknown", invitationId, ...withCode };
    }
    if (sent.kind === "refused") {
      const recorded = await sending.delivery.recordDelivery(invitationId, false, null);
      logDelivery(invitationId, "delivery_failed", {
        reason: sent.failure,
        auth: sent.diagnostic,
        recorded: recorded.ok,
        ...(recorded.ok ? {} : { record: recorded.reason }),
      });
      return { kind: "delivery_failed", invitationId, reason: sent.failure, recorded: recorded.ok, ...withCode };
    }

    // 3. Auth sent it: record the outcome and the Auth account (service role, same client).
    const recorded = await sending.delivery.recordDelivery(invitationId, true, sent.authUserId);
    if (!recorded.ok) {
      // Distinct from a delivery failure: the email went out. No second invite, no compensating write.
      logDelivery(invitationId, "sent_unrecorded", { record: recorded.reason });
      return { kind: "sent_unrecorded", invitationId, ...withCode };
    }
    return { kind: "sent", invitationId, attempt: begun.attempt, ...withCode };
  }

  return {
    /** Create an invitation (database rules) and send it. */
    async inviteUser(input: InviteUserInput | null | undefined): Promise<InvitationSendOutcome> {
      await requireSuperAdmin();
      const sending = openSending();
      if (!sending) return { kind: "unavailable", invitationId: null, reason: "not_configured" };
      const payload = buildInvitationPayload(input);
      if (!payload.ok) throw new InvitationsInputError(payload.error);

      let created;
      try {
        created = await deps.invitations.createInvitation(payload.value);
      } catch (err) {
        const reason = raisedReason(err);
        if (reason) return { kind: "refused", stage: "create", reason, invitationId: null };
        throw err;
      }
      if (!created.ok) {
        const reason: InvitationCreateRefusal = asCreateRefusal(created.reason) ?? unexpectedRefusal("create", created.reason);
        return { kind: "refused", stage: "create", reason, invitationId: null };
      }
      return deliver(created.invitationId, sending, created.code);
    },

    /** Resend a pending invitation (the database enforces cooldown, cap and expiry). */
    async resendInvitation(invitationId: unknown): Promise<InvitationSendOutcome> {
      await requireSuperAdmin();
      if (!isUuid(invitationId)) return { kind: "refused", stage: "deliver", reason: "not_found", invitationId: null };
      const sending = openSending();
      if (!sending) return { kind: "unavailable", invitationId, reason: "not_configured" };
      return deliver(invitationId, sending);
    },

    /**
     * Revoke a pending invitation (P3.9) on the caller's own session. revoke_user_invitation decides
     * scope and state and writes the audit row; only the invitation's state changes — no Auth user,
     * profile or domain record is touched, and no service-role client is opened.
     */
    async revokeInvitation(invitationId: unknown, reason: unknown): Promise<InvitationRevokeOutcome> {
      await requireSuperAdmin();
      if (deps.isDemoMode?.()) throw new InvitationsInputError("Invitation changes aren't available in demo mode.");
      if (!isUuid(invitationId)) return { ok: false, reason: "not_found" };
      const why = normalizeReason(reason);
      if (!why.ok) throw new InvitationsInputError(why.error);
      let result;
      try {
        result = await deps.invitations.revokeInvitation(invitationId, why.value);
      } catch (err) {
        const raised = raisedReason(err);
        if (raised === "permission" || raised === "invalid") return { ok: false, reason: raised };
        throw err;
      }
      if (result.ok) return { ok: true };
      const refusal: InvitationRevokeRefusal = asRevokeRefusal(result.reason) ?? unexpectedRefusal("revoke", result.reason);
      return { ok: false, reason: refusal };
    },

    /**
     * P5.2: send a sign-in link to the existing, never-activated account of a pending UNBOUND invitation whose
     * address Auth refused to invite again (already registered). begin_invitation_recovery (Super Admin's own
     * session) decides eligibility, cooldown and cap and records the request — it binds nothing. The e-mail goes
     * through the session-less mailer to the database-owned address only. The invitation is bound later, only by
     * complete_invitation_recovery on the invitee's own fresh e-mail sign-in.
     */
    async recoverInvitation(invitationId: unknown): Promise<InvitationRecoveryOutcome> {
      await requireSuperAdmin();
      if (!isUuid(invitationId)) return { kind: "refused", reason: "not_found", invitationId: null };
      // Off by default: nothing is recorded or sent until the rollout steps are confirmed and the switch is on.
      if (deps.recoveryEnabled?.() !== true) return { kind: "unavailable", invitationId, reason: "disabled" };
      const redirectTo = deps.isDemoMode?.() ? null : deps.recoveryRedirectUrl?.() ?? null;
      const mailer = deps.recoveryMailer;
      if (!redirectTo || !mailer || !mailer.isConfigured()) return { kind: "unavailable", invitationId, reason: "not_configured" };

      let begun;
      try {
        begun = await deps.invitations.beginRecovery(invitationId);
      } catch (err) {
        const reason = raisedReason(err);
        if (reason === "permission" || reason === "invalid") return { kind: "refused", reason, invitationId };
        throw err;
      }
      if (!begun.ok) {
        const reason: InvitationRecoveryRefusal = asRecoveryRefusal(begun.reason) ?? unexpectedRefusal("recovery", begun.reason);
        return {
          kind: "refused",
          reason,
          invitationId,
          ...(begun.retryAfterSeconds !== undefined ? { retryAfterSeconds: begun.retryAfterSeconds } : {}),
        };
      }

      const sent = await mailer.sendSignInLink(begun.email, redirectTo);
      if (sent.kind === "sent") return { kind: "sent", invitationId };
      if (sent.kind === "unknown") {
        logDelivery(invitationId, "recovery_unknown", { auth: sent.diagnostic });
        return { kind: "delivery_unknown", invitationId };
      }
      logDelivery(invitationId, "recovery_failed", { reason: sent.failure, auth: sent.diagnostic });
      return { kind: "delivery_failed", invitationId, reason: sent.failure };
    },
  };
}

export type InvitationsService = ReturnType<typeof createInvitationsService>;
