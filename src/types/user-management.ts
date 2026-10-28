import type { UserRole } from "./user";

/**
 * Advanced User Management — read-only Users view (Phase 7 P3.2).
 *
 * Two different statuses, never merged:
 *   - AccountStatus: public.profiles.account_status (0016) — whether the
 *     account may sign in at all (only "active" has a usable role).
 *   - PersonStatus:  public.students.status / public.trainers.status —
 *     the state of the person's domain record. Same values as the older
 *     UserStatus, kept as its own name so the two cannot be confused.
 */
export type AccountStatus = "invited" | "active" | "suspended";

export type PersonStatus = "active" | "inactive" | "invited";

export type DomainRecordKind = "student" | "trainer";

/**
 * The domain record the account's CURRENT role needs:
 *   present         — the matching students/trainers row exists
 *   missing         — a student/trainer account without its record
 *   not_applicable  — Super Admins have no domain record
 */
export type DomainRecordState = "present" | "missing" | "not_applicable";

export interface DomainRecordSummary {
  kind: DomainRecordKind;
  code: string;
  status: PersonStatus;
}

/** One batch as shown next to a user (code + name + lifecycle status). */
export interface UserBatchRef {
  id: string;
  code: string;
  name: string;
  status: "upcoming" | "ongoing" | "completed" | "cancelled";
}

/** Students: their enrolments. Trainers: the batches assigned to them. */
export interface UserBatchSummary {
  /** Student: enrolled (non-cancelled batch). Trainer: assigned upcoming/ongoing batches. */
  current: UserBatchRef[];
  /** Student: completed enrolments. Trainer: assigned completed batches. */
  completed: number;
  /** Student: withdrawn enrolments. Always 0 for trainers. */
  withdrawn: number;
}

export interface UserSummary {
  /** profiles.id (= the auth user id). */
  id: string;
  /** Domain record full name, else the name of the account's accepted invitation (Super Admins); null when neither exists. */
  name: string | null;
  /** From student_details / trainer_details only; null when none is readable (never an invitation's address). */
  email: string | null;
  /** Application role (super_admin → "admin"); null only for an unrecognised value. */
  role: UserRole | null;
  accountStatus: AccountStatus;
  accountStatusChangedAt: string;
  recordState: DomainRecordState;
  /** The record for the current role (null unless recordState is "present"). */
  record: DomainRecordSummary | null;
  /** A record of another kind left behind by an earlier role (e.g. after a role change). */
  otherRecord: DomainRecordSummary | null;
  /** Null when the role has no batches (Super Admin, or no record). */
  batches: UserBatchSummary | null;
  createdAt: string;
  updatedAt: string;
}

export type UserRoleFilter = "all" | UserRole;
export type AccountStatusFilter = "all" | AccountStatus;
/** Record filter: a person status, or accounts missing the record their role needs. */
export type DomainRecordFilter = "all" | PersonStatus | "missing";

/** Validated filters (only whitelisted values ever reach this shape). */
export interface UserListFilters {
  q: string;
  role: UserRoleFilter;
  status: AccountStatusFilter;
  record: DomainRecordFilter;
  page: number;
}

export interface UserListTotals {
  /** Every account the viewer may read (before filters). */
  all: number;
  byStatus: Record<AccountStatus, number>;
  /** Student/trainer accounts without the record their role needs. */
  missingRecord: number;
}

/** One page of the Users view — the only rows sent to the browser. */
export interface UserListPage {
  rows: UserSummary[];
  filters: UserListFilters;
  /** Rows matching the filters (all pages). */
  matching: number;
  page: number;
  pageCount: number;
  pageSize: number;
  totals: UserListTotals;
}

// -------------------------------------------------------------------
// Lifecycle actions (Phase 7 P3.3)
// -------------------------------------------------------------------

/** Contact/profile fields of the current role's record, as editable by a Super Admin. */
export interface StudentDetailFields {
  fullName: string;
  phone: string | null;
  organization: string | null;
  designation: string | null;
}

export interface TrainerDetailFields {
  fullName: string;
  phone: string | null;
  organization: string | null;
  designation: string | null;
  specializations: string[];
  bio: string | null;
}

export type UserContactDetails =
  | { kind: "student"; fields: StudentDetailFields }
  | { kind: "trainer"; fields: TrainerDetailFields };

/** One entry of the account's audit history (public.user_admin_events, newest first). */
export interface UserAuditEntry {
  id: number;
  occurredAt: string;
  /** Plain-language description built from the event type and its detail. */
  summary: string;
  /** "you" when the viewer performed it; otherwise the actor's id, or null for system changes. */
  actor: string | null;
  /** The actor's name when known (Super Admin view only); absent for "you", system changes and unknown names. */
  actorName?: string;
}

/**
 * Which controls the panel offers. A presentation hint only — derived
 * from the same rules the database enforces, which still decides every
 * action (self-protection, last Super Admin, transitions, scope).
 */
export interface UserActionAvailability {
  suspend: boolean;
  reactivate: boolean;
  changeRole: boolean;
  editDetails: boolean;
  /** Why status/role controls are unavailable (e.g. your own account), when they are. */
  note: string | null;
}

/**
 * The latest invitation bound to an INVITED account (P3.9). Lifecycle
 * facts only — never the address, a token or any Auth data. `status`
 * "expired" also covers a pending invitation already past its expiry
 * (the database marks it expired on the next attempt). The two flags only
 * decide which buttons to show; the database decides every attempt.
 */
export interface UserInvitationSummary {
  id: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  lastSentAt: string | null;
  resendCount: number;
  canResend: boolean;
  canRevoke: boolean;
}

export interface UserDetail {
  user: UserSummary;
  isSelf: boolean;
  hasStudentRecord: boolean;
  hasTrainerRecord: boolean;
  contact: UserContactDetails | null;
  history: UserAuditEntry[];
  /** When the account's invitation was accepted (from that accepted invitation); null when unknown. */
  invitationAcceptedAt: string | null;
  actions: UserActionAvailability;
  /** Only for invited accounts with a bound invitation; null otherwise. */
  invitation: UserInvitationSummary | null;
  /**
   * P5.2 (0029a): present only when this invited account is a never-activated placeholder whose address has a
   * pending, unexpired, UNBOUND invitation it could recover (Auth refused to re-send because it is registered).
   */
  recovery?: UserRecoveryCandidate;
}

/** The invitation a placeholder account can recover with a sign-in link (lifecycle facts only — no address). */
export interface UserRecoveryCandidate {
  invitationId: string;
  expiresAt: string;
  lastSentAt: string | null;
  resendCount: number;
  /** When a Super Admin last REQUESTED a sign-in link for it (recorded before the e-mail is attempted; null = never). */
  recoveryRequestedAt: string | null;
  /** Whether the server-side recovery switch is on; when off the panel explains instead of offering the action. */
  available: boolean;
}

/** Plain, serializable result of a lifecycle server action. */
export type UserActionResult = { ok: true; message: string } | { ok: false; error: string };

// -------------------------------------------------------------------
// Invitation sending (Phase 7 P3.4)
// -------------------------------------------------------------------

/** Why Supabase Auth refused to send an invitation email (classified; raw errors stay on the server). */
export type AuthInviteFailure = "already_registered" | "rate_limited" | "address_not_allowed" | "invalid_address" | "auth_error";

/**
 * Why the database refused to create an invitation: the reasons the
 * invitation-creation function returns, plus the raised-error mappings
 * (42501 → permission, 22023/22P02/23514 → invalid, 23505 → already_invited).
 */
export type InvitationCreateRefusal =
  | "account_exists"
  | "already_invited"
  | "batch_not_current"
  | "course_archived"
  | "rate_limited"
  | "email_unavailable"
  | "permission"
  | "invalid";

/** Why the database refused a delivery attempt: the delivery-authorization function's reasons plus the raised-error mappings. */
export type InvitationDeliverRefusal = "not_found" | "expired" | "not_pending" | "cooldown" | "resend_limit" | "permission" | "invalid";

/** Why the database refused a revocation (the 0017 revoke function's reasons plus the raised-error mappings) — P3.9. */
export type InvitationRevokeRefusal = "not_found" | "expired" | "not_pending" | "permission" | "invalid";

/** Result of revoking an invitation: a state change only (nothing is deleted). */
export type InvitationRevokeOutcome = { ok: true } | { ok: false; reason: InvitationRevokeRefusal };

/** P5.2 (0029a): why the database refused a recovery request (begin_invitation_recovery) plus the raised-error mappings. */
export type InvitationRecoveryRefusal =
  | "not_found"
  | "expired"
  | "not_pending"
  | "already_bound"
  | "not_recoverable"
  | "cooldown"
  | "resend_limit"
  | "permission"
  | "invalid";

/**
 * P5.2: result of sending a sign-in link to an already-registered, never-activated invited account.
 *   sent             — the database recorded the request and the sign-in e-mail was handed to Supabase Auth
 *   refused          — the database said no; nothing was sent
 *   delivery_failed  — Auth refused to send (the request stays recorded; it can be retried after the cooldown)
 *   delivery_unknown — Auth gave no answer; it may or may not have been sent
 *   unavailable      — sending isn't configured on this server; nothing was attempted
 */
export type InvitationRecoveryOutcome =
  | { kind: "sent"; invitationId: string }
  | { kind: "refused"; reason: InvitationRecoveryRefusal; invitationId: string | null; retryAfterSeconds?: number }
  | { kind: "delivery_failed"; invitationId: string; reason: AuthInviteFailure }
  | { kind: "delivery_unknown"; invitationId: string }
  /** not_configured: e-mail sending isn't set up; disabled: the server-side recovery switch is off (the default). */
  | { kind: "unavailable"; invitationId: string | null; reason: "not_configured" | "disabled" };

/**
 * Result of creating and/or sending an invitation. Each kind maps to a
 * distinct, safe message (see invitationOutcomeMessage):
 *   sent             — Auth sent the email and the database recorded it
 *   refused          — the database said no (create or delivery); nothing was sent
 *   delivery_failed  — Auth refused to send; recorded as failed when possible
 *   delivery_unknown — the Auth call gave no answer; it may or may not have been sent
 *   sent_unrecorded  — Auth sent the email but recording the outcome failed
 *   unavailable      — sending isn't configured on this server; nothing was attempted
 */
export type InvitationSendOutcome =
  | { kind: "sent"; invitationId: string; attempt: "initial" | "resend"; code?: string }
  | { kind: "refused"; stage: "create"; reason: InvitationCreateRefusal; invitationId: null }
  | { kind: "refused"; stage: "deliver"; reason: InvitationDeliverRefusal; invitationId: string | null; retryAfterSeconds?: number }
  | { kind: "delivery_failed"; invitationId: string; reason: AuthInviteFailure; recorded: boolean; code?: string }
  | { kind: "delivery_unknown"; invitationId: string; code?: string }
  | { kind: "sent_unrecorded"; invitationId: string; code?: string }
  | { kind: "unavailable"; invitationId: string | null; reason: "not_configured" };

/** What the Add Student dialog may send. The role is fixed to student on the server. */
export interface StudentInvitationInput {
  email?: string;
  fullName?: string;
  phone?: string;
  organization?: string;
  designation?: string;
  batchId?: string;
}

/** What the Add Trainer dialog may send. The role is fixed to trainer on the server. */
export interface TrainerInvitationInput {
  email?: string;
  fullName?: string;
  phone?: string;
  organization?: string;
  designation?: string;
  specializations?: string[];
}

/**
 * What the Invite Super Admin dialog may send (P3.12): name and email only. The role is fixed to Super Admin on
 * the server; no batch, code or other field is accepted.
 */
export interface SuperAdminInvitationInput {
  email?: string;
  fullName?: string;
}

/** Plain, serializable result of an invitation server action (never raw errors). */
export type InvitationActionResult =
  | { status: "outcome"; outcome: InvitationSendOutcome; message: string }
  | { status: "error"; error: string };
