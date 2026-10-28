/**
 * Invitation acceptance (Phase 7 P3.5) — pure rules shared by the
 * /auth/confirm and /auth/accept pages, their server actions and the
 * client forms. No `server-only`: the client forms use the same rules
 * for instant feedback; the server re-checks everything.
 *
 * Flow: invite email → /auth/confirm?token_hash=…&type=invite (a page
 * that consumes nothing) → Continue (server action: verifyOtp) →
 * /auth/accept → password → accept_user_invitation() → the portal of
 * the database role. Every redirect is one of the fixed paths below;
 * no `next` or other user-supplied destination is ever read.
 */

/** The only email-link type this flow accepts. */
export const INVITE_OTP_TYPE = "invite";

/** Where a verified invitee sets a password and accepts. */
export const INVITE_ACCEPT_PATH = "/auth/accept";

/** Supabase token hashes are URL-safe; anything else is not a link we sent. */
export const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

export const PASSWORD_MIN_LENGTH = 8;
/** Supabase Auth hashes at most 72 bytes of a password. */
export const PASSWORD_MAX_LENGTH = 72;

/** The only destinations after a successful acceptance (the database role decides which). */
export const PORTAL_HOMES = ["/admin", "/trainer", "/student"] as const;
export type PortalHome = (typeof PORTAL_HOMES)[number];

export function isPortalHome(value: unknown): value is PortalHome {
  return typeof value === "string" && (PORTAL_HOMES as readonly string[]).includes(value);
}

/** Error codes shown on /login (messages live in LoginForm). */
export type InviteLoginError = "invite_invalid" | "invite_session_missing" | "invite_failed" | "recovery_not_eligible";

const INVITE_LOGIN_PATH: Record<InviteLoginError, string> = {
  invite_invalid: "/login?error=invite_invalid",
  invite_session_missing: "/login?error=invite_session_missing",
  invite_failed: "/login?error=invite_failed",
  // P5.2: a recovery sign-in link used by an account that isn't an eligible invited account (signed out first).
  recovery_not_eligible: "/login?error=recovery_not_eligible",
};

/** A fixed /login path for an invite error code; anything unknown becomes invite_failed. */
export function inviteLoginErrorPath(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(INVITE_LOGIN_PATH, code)
    ? INVITE_LOGIN_PATH[code as InviteLoginError]
    : INVITE_LOGIN_PATH.invite_failed;
}

// -------------------------------------------------------------------
// Invitation link
// -------------------------------------------------------------------

export type InviteLinkResult = { ok: true; tokenHash: string } | { ok: false };

/** Re-check of the two values the Continue action receives. */
export function parseInviteInput(tokenHash: unknown, type: unknown): InviteLinkResult {
  if (type !== INVITE_OTP_TYPE) return { ok: false };
  if (typeof tokenHash !== "string" || !TOKEN_HASH_PATTERN.test(tokenHash)) return { ok: false };
  return { ok: true, tokenHash };
}

/**
 * The /auth/confirm query. Exactly one `token_hash` and one `type=invite`;
 * a repeated parameter is refused. Other parameters (including `next`)
 * are ignored — they never influence anything.
 */
export function parseInviteLink(params: Record<string, string | string[] | undefined> | null | undefined): InviteLinkResult {
  const tokenHash = params?.token_hash;
  const type = params?.type;
  if (Array.isArray(tokenHash) || Array.isArray(type)) return { ok: false };
  return parseInviteInput(tokenHash, type);
}

// -------------------------------------------------------------------
// Password
// -------------------------------------------------------------------

export type PasswordField = "password" | "confirmPassword";
export type PasswordCheck = { ok: true; password: string } | { ok: false; field: PasswordField; error: string };

/** Checked before any Auth call. The password is never trimmed or changed. */
export function validateNewPassword(password: unknown, confirmPassword: unknown): PasswordCheck {
  if (typeof password !== "string" || password.length === 0) return { ok: false, field: "password", error: "Enter a password." };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, field: "password", error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, field: "password", error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` };
  }
  if (typeof confirmPassword !== "string" || confirmPassword !== password) {
    return { ok: false, field: "confirmPassword", error: "Passwords do not match." };
  }
  return { ok: true, password };
}

/** Same meter as the password-reset form (kept separate so that form stays untouched). */
export function getPasswordStrength(password: string): { score: number; label: string; tone: "red" | "amber" | "teal" } {
  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score += 34;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 22;
  if (/\d/.test(password)) score += 22;
  if (/[^A-Za-z0-9]/.test(password)) score += 22;

  if (score >= 90) return { score: 100, label: "Strong", tone: "teal" };
  if (score >= 56) return { score, label: "Medium", tone: "amber" };
  return { score, label: password ? "Weak" : "", tone: "red" };
}

// -------------------------------------------------------------------
// Results and messages (never raw Auth / database errors)
// -------------------------------------------------------------------

export type ConfirmInvitationResult = { ok: true } | { ok: false; code: "invite_invalid" | "invite_failed" };

export type CompleteInvitationResult =
  | {
      ok: true;
      home: PortalHome;
      /** Shown before continuing when the account is active but something in the invitation couldn't be done. */
      notice?: string;
    }
  | {
      ok: false;
      error: string;
      /** Set for a password problem the person can fix in the form. */
      field?: PasswordField;
      /** True when the session was ended (or is gone): the form cannot be used again. */
      ended: boolean;
    };

/** 0030: the invitation's batch belongs to an archived course, so the database activated the account without enrolling it. */
export const ENROLMENT_SKIPPED_ARCHIVED_NOTICE =
  "Your account is active, but you weren't added to the batch in your invitation because its course has been deactivated. Please contact your Super Admin to be assigned to an available batch.";

/** A database "why the enrolment was skipped" code → the notice to show, or none (unknown codes are never passed through). */
export function enrolmentSkippedNotice(code: unknown): string | undefined {
  return code === "course_archived" ? ENROLMENT_SKIPPED_ARCHIVED_NOTICE : undefined;
}

export const SETUP_GENERIC_ERROR = "We couldn't complete your account setup. Please try again later or contact your administrator.";
export const SESSION_MISSING_ERROR = "Your invitation session has ended. Open the invitation link from your email again.";
export const PASSWORD_WEAK_ERROR = "Choose a stronger password. The one you entered doesn't meet the password requirements.";
export const PASSWORD_UPDATE_ERROR = "We couldn't save your password. Please try again.";

/** accept_user_invitation() refusals → what the invitee is told. */
export const ACCEPT_REASON_MESSAGE: Record<string, string> = {
  not_pending: "This invitation can no longer be used — it may have been accepted, revoked or replaced. Ask your administrator for a new invitation.",
  expired: "This invitation has expired. Ask your administrator for a new invitation.",
  code_in_use: "Your account couldn't be set up because of a conflict with an existing record. Contact your administrator.",
  // 0029a: the (unexpired) invitation isn't linked to this account yet — the administrator either resends it or,
  // when the address is already registered, sends a sign-in link. An expired one is reported as "expired" instead.
  resend_required:
    "This invitation isn't ready to use yet. Ask your administrator to send you a new invitation link, then open the newest email you receive.",
};

export function acceptRefusalMessage(reason: unknown): string {
  const known = typeof reason === "string" && Object.prototype.hasOwnProperty.call(ACCEPT_REASON_MESSAGE, reason);
  return (known && ACCEPT_REASON_MESSAGE[reason as string]) || SETUP_GENERIC_ERROR;
}
