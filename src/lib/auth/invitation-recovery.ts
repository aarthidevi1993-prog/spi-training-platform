/**
 * Invitation recovery (P5.2) — pure rules for /auth/recover, its server
 * action and the Continue form. No `server-only`: the form shares them; the
 * server re-checks everything.
 *
 * Flow (an already-registered, never-activated invited account whose
 * invitation Auth could not re-send): a Super Admin sends a sign-in link →
 * e-mail → /auth/recover?token_hash=…&type=email (a page that consumes
 * nothing, so a mail scanner opening the link cannot use it up) → Continue
 * (server action: verifyOtp(email) signs the person in, then
 * complete_invitation_recovery() binds the invitation on that fresh
 * sign-in) → /auth/accept (set a password, accept). Any other account
 * (active, suspended, not requested…) is signed out at once and sent to
 * /login — this is never a way into a portal. Every redirect is one of the
 * fixed paths; no `next` or other user-supplied destination is read.
 */
import { INVITE_ACCEPT_PATH, TOKEN_HASH_PATTERN, inviteLoginErrorPath } from "./invite-acceptance";

/** The only e-mail-link type this flow accepts (Supabase passwordless sign-in link via token hash). */
export const RECOVERY_OTP_TYPE = "email";

export type RecoveryLinkResult = { ok: true; tokenHash: string } | { ok: false };

/** Re-check of the two values the Continue action receives. */
export function parseRecoveryInput(tokenHash: unknown, type: unknown): RecoveryLinkResult {
  if (type !== RECOVERY_OTP_TYPE) return { ok: false };
  if (typeof tokenHash !== "string" || !TOKEN_HASH_PATTERN.test(tokenHash)) return { ok: false };
  return { ok: true, tokenHash };
}

/** The /auth/recover query: exactly one token_hash and one type=email; repeated parameters are refused; others ignored. */
export function parseRecoveryLink(params: Record<string, string | string[] | undefined> | null | undefined): RecoveryLinkResult {
  const tokenHash = params?.token_hash;
  const type = params?.type;
  if (Array.isArray(tokenHash) || Array.isArray(type)) return { ok: false };
  return parseRecoveryInput(tokenHash, type);
}

/**
 * The Continue step's result. Only an eligible invited account succeeds, and then always to the fixed
 * /auth/accept path — this flow never opens a portal, so it is not a passwordless login. `code` sends the browser
 * to a fixed /login error ("recovery_not_eligible" after the session was ended for an account this flow is not
 * for: active, suspended, not requested, not eligible, nothing pending); `error` is shown on the page for an
 * eligible invitee who must act (expired invitation, old link, stale sign-in) — the session was ended too.
 */
export type ConfirmRecoveryResult =
  | { ok: true; destination: typeof INVITE_ACCEPT_PATH }
  | { ok: false; code: RecoveryFailureCode }
  | { ok: false; error: string };

/**
 * "signout_unconfirmed": a session may have been created by this flow and ending it could not be confirmed.
 * It must NOT go to /login (which sends signed-in users to their portal), but to RECOVERY_INCOMPLETE_PATH.
 */
export type RecoveryFailureCode = "invite_invalid" | "invite_failed" | "recovery_not_eligible" | "signout_unconfirmed";

/** The safe page after an unconfirmed sign-out: it never redirects anyone, signed in or not. */
export const RECOVERY_INCOMPLETE_PATH = "/auth/recover/incomplete";

/** The only destinations of a failed Continue: the safe page for an unconfirmed sign-out, else a fixed /login error. */
export function recoveryFailurePath(code: unknown): string {
  return code === "signout_unconfirmed" ? RECOVERY_INCOMPLETE_PATH : inviteLoginErrorPath(code);
}

/**
 * complete_invitation_recovery() refusals that mean "this account is not one this flow is for" → signed out and
 * sent to /login. The others (expired, recovery_window_passed, stale_sign_in, errors) keep their own message.
 */
export const RECOVERY_NOT_ELIGIBLE_REASONS: readonly string[] = ["not_pending", "not_requested", "not_recoverable"];

/** complete_invitation_recovery() refusals → what the person is told (never raw database text). */
export const RECOVERY_REASON_MESSAGE: Record<string, string> = {
  not_pending:
    "There's no pending invitation for this account any more — it may have been accepted, revoked or replaced. Ask your administrator for a new invitation.",
  not_requested: "This sign-in link can't be used to finish setting up your account. Ask your administrator to send you a new sign-in link.",
  expired: "Your invitation has expired. Ask your administrator for a new invitation.",
  recovery_window_passed: "This sign-in link is too old. Ask your administrator to send you a new sign-in link.",
  stale_sign_in: "We couldn't confirm that you just signed in from the email link. Open the newest sign-in link from your email and continue again.",
  not_recoverable: "Your account can't be set up from this link. Contact your administrator.",
};

export const RECOVERY_GENERIC_ERROR = "We couldn't finish setting up your account. Please try again later or contact your administrator.";

/** The Continue request itself failed (network/server): nothing is claimed about the session. */
export const RECOVERY_REQUEST_FAILED_MESSAGE =
  "We couldn't finish this step, and we can't tell whether you're signed in on this device. Don't use the same email link again. Close any session on this device, then ask your administrator for a new sign-in link if you still need one.";

/** Shown on RECOVERY_INCOMPLETE_PATH and after its "end the session" button. */
export const RECOVERY_INCOMPLETE_MESSAGE =
  "Sign-in was not completed. We couldn't confirm that the session started by this link was closed, so nothing else will open from here.";
export const RECOVERY_SESSION_ENDED_MESSAGE = "The session on this device has been closed. You can now sign in normally.";
export const RECOVERY_SESSION_STILL_OPEN_MESSAGE =
  "We still couldn't close the session on this device. Close every window of this browser (or clear this site's data), then open the sign-in page again. If you're unsure, contact your administrator.";

export function recoveryRefusalMessage(reason: unknown): string {
  const known = typeof reason === "string" && Object.prototype.hasOwnProperty.call(RECOVERY_REASON_MESSAGE, reason);
  return (known && RECOVERY_REASON_MESSAGE[reason as string]) || RECOVERY_GENERIC_ERROR;
}
