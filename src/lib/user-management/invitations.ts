/**
 * Invitation sending (Phase 7 P3.4) — pure logic: the confirmation
 * redirect built from configuration only, the whitelist of fields a
 * Super Admin may submit, classification of Supabase Auth errors, and
 * safe messages for every outcome.
 *
 * Authorization is NOT decided here. create_user_invitation and
 * begin_invitation_delivery (0017/0019) decide who may invite whom,
 * expiry, cooldown and resend limits; record_invitation_delivery
 * (service_role) decides what may be recorded. Nothing here can widen
 * what the database allows.
 */
import type { Json } from "@/lib/supabase/types";
import type {
  AuthInviteFailure,
  InvitationCreateRefusal,
  InvitationDeliverRefusal,
  InvitationRecoveryOutcome,
  InvitationRecoveryRefusal,
  InvitationRevokeRefusal,
  InvitationSendOutcome,
} from "@/types/user-management";
import { isUuid, parseTargetRole, type ValidationResult } from "./lifecycle";

/** The application route invitation links land on (implemented in P3.5). */
export const INVITATION_CONFIRM_PATH = "/auth/confirm";

/**
 * The redirect sent to Supabase Auth, from the configured public app
 * URL only (never a request header or browser value). HTTPS is required
 * except for a local development host. Null when not safely configured —
 * then nothing is sent.
 */
export function invitationRedirectUrl(appUrl: string | null | undefined): string | null {
  const raw = appUrl?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return `${url.origin}${INVITATION_CONFIRM_PATH}`;
}

/**
 * P5.2: the server-only switch for recovery e-mails (INVITATION_RECOVERY_EMAILS_ENABLED). On ONLY for the exact
 * string "true"; missing or anything else = off. An APPLICATION-level switch: it decides what the application
 * offers and does, not what the database functions allow a Super Admin calling them directly.
 */
export function invitationRecoveryEnabled(value: string | null | undefined): boolean {
  return value === "true";
}

/** P5.2: where an invitation-recovery sign-in link lands (a page that consumes nothing until Continue). */
export const RECOVERY_CONFIRM_PATH = "/auth/recover";

/** The recovery sign-in redirect — same rules as invitationRedirectUrl (configured app URL only; HTTPS except locally). */
export function recoveryRedirectUrl(appUrl: string | null | undefined): string | null {
  const invite = invitationRedirectUrl(appUrl);
  return invite ? `${new URL(invite).origin}${RECOVERY_CONFIRM_PATH}` : null;
}

// -------------------------------------------------------------------
// Invitation input (a whitelist; the database validates the values)
// -------------------------------------------------------------------
export interface InviteUserInput {
  email?: unknown;
  /** Application role name: "admin" | "trainer" | "student". */
  role?: unknown;
  fullName?: unknown;
  phone?: unknown;
  organization?: unknown;
  designation?: unknown;
  specializations?: unknown;
  batchId?: unknown;
  expiresInDays?: unknown;
}

const TEXT_FIELDS: [keyof InviteUserInput, string, number][] = [
  ["email", "email", 254],
  ["fullName", "full_name", 200],
  ["phone", "phone", 40],
  ["organization", "organization", 200],
  ["designation", "designation", 200],
];

/**
 * The create_user_invitation payload: only known keys, trimmed text,
 * role mapped from the application name. Shape errors are refused here;
 * every rule (role/batch combinations, codes, availability, scope) is
 * left to the database.
 */
export function buildInvitationPayload(input: InviteUserInput | null | undefined): ValidationResult<Record<string, Json>> {
  const src = input ?? {};
  const p: Record<string, Json> = {};
  const role = parseTargetRole(src.role);
  if (!role.ok) return role;
  p.role = role.value;
  for (const [key, column, max] of TEXT_FIELDS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, error: "Some of the values aren't valid. Check them and try again." };
    const t = v.trim();
    if (t.length > max) return { ok: false, error: "Some of the values are too long. Check them and try again." };
    if (t !== "") p[column] = t;
  }
  if (src.specializations !== undefined && src.specializations !== null) {
    if (!Array.isArray(src.specializations) || src.specializations.some((s) => typeof s !== "string" || s.length > 100) || src.specializations.length > 20) {
      return { ok: false, error: "Specializations must be a short list of text." };
    }
    p.specializations = (src.specializations as string[]).map((s) => s.trim()).filter(Boolean);
  }
  if (src.batchId !== undefined && src.batchId !== null && src.batchId !== "") {
    if (!isUuid(src.batchId)) return { ok: false, error: "Choose a valid batch." };
    p.batch_id = src.batchId;
  }
  if (src.expiresInDays !== undefined && src.expiresInDays !== null) {
    const d = src.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 30) return { ok: false, error: "An invitation lasts between 1 and 30 days." };
    p.expires_in_days = d;
  }
  return { ok: true, value: p };
}

// -------------------------------------------------------------------
// Supabase Auth errors → a small fixed set (raw errors stay server-side)
// -------------------------------------------------------------------
export interface AuthErrorLike {
  status?: number;
  code?: string;
  message?: string;
  name?: string;
}

/**
 * True when Auth gave no definite answer — a network/fetch failure, no
 * status, or a server error — so the email may or may not have gone out.
 * Treated conservatively: nothing is recorded, and the outcome says so.
 */
export function isIndeterminateAuthError(e: AuthErrorLike | null | undefined): boolean {
  if (!e) return false;
  return e.name === "AuthRetryableFetchError" || e.status === undefined || e.status === 0 || (typeof e.status === "number" && e.status >= 500);
}

export function classifyAuthInviteError(e: AuthErrorLike | null | undefined): AuthInviteFailure {
  const code = e?.code ?? "";
  const message = e?.message ?? "";
  if (code === "email_exists" || code === "user_already_exists" || (e?.status === 422 && /already (been )?registered|already exists/i.test(message))) {
    return "already_registered";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || e?.status === 429) return "rate_limited";
  if (code === "email_address_not_authorized") return "address_not_allowed";
  if (code === "email_address_invalid" || code === "validation_failed") return "invalid_address";
  return "auth_error";
}

// -------------------------------------------------------------------
// Safe messages
// -------------------------------------------------------------------
export const CREATE_REASON_MESSAGE: Record<InvitationCreateRefusal, string> = {
  account_exists: "This address already belongs to an account. Use the account's lifecycle actions instead.",
  already_invited: "This address already has a pending invitation. Resend it instead.",
  batch_not_current: "Choose an upcoming or ongoing batch.",
  course_archived: "This batch hasn't started and its course is inactive, so it takes no new students. Choose another batch.",
  rate_limited: "Too many invitations in the last hour. Try again later.",
  email_unavailable: "This address can't be invited.",
  permission: "You don't have permission to do that.",
  invalid: "Some of the values aren't valid. Check them and try again.",
};

export const DELIVER_REASON_MESSAGE: Record<InvitationDeliverRefusal, string> = {
  not_found: "That invitation no longer exists.",
  expired: "This invitation has expired. Create a new invitation instead.",
  not_pending: "This invitation is no longer pending.",
  cooldown: "An invitation email was sent less than a minute ago. Wait a moment before resending.",
  resend_limit: "This invitation has been resent the maximum number of times. Revoke it, then invite the address again if needed.",
  permission: "You don't have permission to do that.",
  invalid: "That invitation can't be sent.",
};

export const DELIVERY_FAILURE_MESSAGE: Record<AuthInviteFailure, string> = {
  already_registered:
    "The email service refused: this address is already registered with a sign-in account. The invitation stays pending. If this person never finished setting up, open their account in Users and send them a sign-in link.",
  rate_limited: "The email service is busy (rate limit). The invitation stays pending; try resending later.",
  address_not_allowed: "The email service isn't allowed to send to this address. Check the project's email (SMTP) settings. The invitation stays pending.",
  invalid_address: "The email service rejected this address. The invitation stays pending.",
  auth_error: "The invitation email couldn't be sent. The invitation stays pending; try resending later.",
};

/** P3.9: revoke_user_invitation refusals → safe sentences. */
export const REVOKE_REASON_MESSAGE: Record<InvitationRevokeRefusal, string> = {
  not_found: "That invitation no longer exists.",
  expired: "This invitation had already expired, so there was nothing to revoke.",
  not_pending: "This invitation is no longer pending — it was already accepted, revoked or replaced. Nothing was changed.",
  permission: "You don't have permission to do that.",
  invalid: "That invitation can't be revoked.",
};

/** P5.2: begin_invitation_recovery refusals → safe sentences for the Super Admin. */
export const RECOVERY_REASON_MESSAGE: Record<InvitationRecoveryRefusal, string> = {
  not_found: "That invitation no longer exists.",
  expired: "This invitation has expired. Create a new invitation instead.",
  not_pending: "This invitation is no longer pending. Nothing was sent.",
  already_bound: "This invitation is already linked to the account. Use Resend invitation instead.",
  not_recoverable:
    "A sign-in link can't be sent for this account: it isn't a never-activated invited account with this invitation's address. Nothing was sent.",
  cooldown: "An email was sent less than a minute ago. Wait a moment before trying again.",
  resend_limit: "This invitation has been sent the maximum number of times. Revoke it, then invite the address again if needed.",
  permission: "You don't have permission to do that.",
  invalid: "A sign-in link can't be sent for this invitation.",
};

/** A database refusal code → the known recovery reason, or null for anything unexpected (never passed through). */
export function asRecoveryRefusal(reason: string): InvitationRecoveryRefusal | null {
  return hasKey(RECOVERY_REASON_MESSAGE, reason) ? reason : null;
}

/** One safe sentence for a recovery outcome (never Auth or database internals, never the address). */
export function recoveryOutcomeMessage(o: InvitationRecoveryOutcome): string {
  switch (o.kind) {
    case "sent":
      return "Sign-in link sent. When the person opens it and continues, they can finish setting up their account.";
    case "refused": {
      const base = fromMap(RECOVERY_REASON_MESSAGE, o.reason, GENERIC_INVITATION_ERROR);
      return o.reason === "cooldown" && o.retryAfterSeconds ? `${base} (about ${o.retryAfterSeconds} s)` : base;
    }
    case "delivery_failed":
      return o.reason === "rate_limited"
        ? "The request was recorded, but the email service is busy (rate limit) and nothing was sent. Try again later."
        : "The request was recorded, but the sign-in link couldn't be sent. Try again later.";
    case "delivery_unknown":
      return "The request was recorded, but we couldn't confirm whether the sign-in link was sent. Wait a minute before trying again.";
    case "unavailable":
      return o.reason === "disabled"
        ? "Sign-in links are turned off on this server until their email setup has been confirmed. Nothing was requested or sent."
        : "Sign-in links aren't configured on this server. Nothing was sent.";
  }
}

/** Shown after a successful revocation: what changed, and what did not. */
export const REVOKE_SUCCESS_MESSAGE =
  "Invitation revoked. It can no longer be accepted; the account and its records are unchanged, and the address can be invited again.";

export const GENERIC_INVITATION_ERROR = "Something went wrong. Please try again.";

const hasKey = <K extends string>(map: Record<K, string>, key: string): key is K => Object.prototype.hasOwnProperty.call(map, key);

/** A database refusal code → the known create reason, or null for anything unexpected (never passed through). */
export function asCreateRefusal(reason: string): InvitationCreateRefusal | null {
  return hasKey(CREATE_REASON_MESSAGE, reason) ? reason : null;
}

/** A database refusal code → the known delivery reason, or null for anything unexpected (never passed through). */
export function asDeliverRefusal(reason: string): InvitationDeliverRefusal | null {
  return hasKey(DELIVER_REASON_MESSAGE, reason) ? reason : null;
}

/** A database refusal code → the known revoke reason, or null for anything unexpected (never passed through). */
export function asRevokeRefusal(reason: string): InvitationRevokeRefusal | null {
  return hasKey(REVOKE_REASON_MESSAGE, reason) ? reason : null;
}

const fromMap = (map: Record<string, string>, key: string, fallback: string) =>
  (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined) ?? fallback;

/** One safe, user-facing sentence for any outcome (never Auth or database internals). */
export function invitationOutcomeMessage(o: InvitationSendOutcome): string {
  switch (o.kind) {
    case "sent":
      return o.attempt === "resend" ? "Invitation resent." : "Invitation sent.";
    case "refused": {
      const map = o.stage === "create" ? CREATE_REASON_MESSAGE : DELIVER_REASON_MESSAGE;
      const base = fromMap(map, o.reason, GENERIC_INVITATION_ERROR);
      return o.reason === "cooldown" && o.retryAfterSeconds ? `${base} (about ${o.retryAfterSeconds} s)` : base;
    }
    case "delivery_failed":
      return DELIVERY_FAILURE_MESSAGE[o.reason];
    case "delivery_unknown":
      return "We couldn't confirm whether the invitation email was sent. Wait a minute and check the invitation before resending.";
    case "sent_unrecorded":
      return "The invitation email was sent, but its delivery status couldn't be saved. Don't resend it; check the invitation status shortly.";
    case "unavailable":
      return "Invitation emails aren't configured on this server. Nothing was sent.";
  }
}

// -------------------------------------------------------------------
// Presentation helpers for the invitation dialog (P3.4 slice 2)
// -------------------------------------------------------------------

/** The database's resend cooldown (0019); a new attempt is authorized only after it. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Which form field a create refusal belongs to (otherwise it is a form-level error). */
export function createRefusalField(reason: InvitationCreateRefusal): "email" | null {
  if (reason === "account_exists" || reason === "already_invited" || reason === "email_unavailable") return "email";
  return null;
}

export type OutcomeTone = "success" | "info" | "warning" | "error";

export function outcomeTone(o: InvitationSendOutcome): OutcomeTone {
  switch (o.kind) {
    case "sent":
      return "success";
    case "sent_unrecorded":
      return "info";
    case "delivery_unknown":
      return "warning";
    case "refused":
      return o.reason === "cooldown" ? "info" : "error";
    default:
      return "error";
  }
}

/**
 * Whether the dialog may offer a resend for this outcome, and when. The
 * database still decides (cooldown, cap, expiry) — this only avoids
 * offering what it will certainly refuse, and never offers an immediate
 * second email:
 *   delivery_failed  — only for transient reasons (rate limit / generic Auth error), after the cooldown
 *   delivery_unknown — after the cooldown, with a warning that it may send a second email
 *   cooldown         — after the remaining wait
 *   sent, sent_unrecorded, resend_limit, expired, not_pending, not_found, permission, invalid, unavailable — never
 */
export function resendGuidance(o: InvitationSendOutcome): { allowed: boolean; afterSeconds: number; warning: string | null } {
  const no = { allowed: false, afterSeconds: 0, warning: null };
  switch (o.kind) {
    case "delivery_failed":
      return o.reason === "rate_limited" || o.reason === "auth_error" ? { allowed: true, afterSeconds: RESEND_COOLDOWN_SECONDS, warning: null } : no;
    case "delivery_unknown":
      return {
        allowed: true,
        afterSeconds: RESEND_COOLDOWN_SECONDS,
        warning: "If the first email did arrive, resending will send the person a second one.",
      };
    case "refused":
      return o.stage === "deliver" && o.reason === "cooldown" && o.invitationId
        ? { allowed: true, afterSeconds: Math.max(1, o.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS), warning: null }
        : no;
    default:
      return no;
  }
}
