/**
 * Student ↔ batch enrolment (Phase 7 P3.8) — pure rules shared by the
 * service, the server actions and (later) the batch detail UI.
 *
 * The database decides everything: admin_set_enrollment() and
 * trainer_enroll_student() (0017, hardened by 0023) check the caller,
 * the trainer's scope, the student's availability, the batch status,
 * capacity and the allowed transitions, and record history and audit;
 * 0023 refuses every direct client write of batch_students. Nothing here
 * can widen that — these rules only validate input early, offer actions
 * the database would accept, and turn its answers into fixed sentences.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export const ENROLLMENT_STATUSES = ["enrolled", "withdrawn", "completed"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export function isEnrollmentStatus(value: unknown): value is EnrollmentStatus {
  return typeof value === "string" && (ENROLLMENT_STATUSES as readonly string[]).includes(value);
}

export const BATCH_STATUSES = ["upcoming", "ongoing", "completed", "cancelled"] as const;
export type BatchStatusValue = (typeof BATCH_STATUSES)[number];

/** Same limit as admin_set_enrollment(). */
export const REASON_MAX_LENGTH = 500;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Optional reason: trimmed; blank → null; over 500 characters refused. */
export function parseReason(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "The reason must be text." };
  const t = value.trim();
  if (t.length > REASON_MAX_LENGTH) return { ok: false, error: `The reason can be at most ${REASON_MAX_LENGTH} characters.` };
  return { ok: true, value: t === "" ? null : t };
}

export interface AdminEnrollmentInput {
  batchId: string;
  studentId: string;
  status: EnrollmentStatus;
  reason: string | null;
}

/** Super Admin change: enrol / re-enrol ('enrolled'), withdraw or complete. */
export function parseAdminEnrollmentInput(batchId: unknown, studentId: unknown, status: unknown, reason: unknown): Parsed<AdminEnrollmentInput> {
  if (!isUuid(batchId)) return { ok: false, error: "Choose a valid batch." };
  if (!isUuid(studentId)) return { ok: false, error: "Choose a valid student." };
  if (!isEnrollmentStatus(status)) return { ok: false, error: "Choose a valid enrolment status." };
  const r = parseReason(reason);
  if (!r.ok) return r;
  return { ok: true, value: { batchId, studentId, status, reason: r.value } };
}

/** Trainer enrolment: two ids only (trainers cannot withdraw, complete or re-enrol). */
export function parseTrainerEnrollmentInput(batchId: unknown, studentId: unknown): Parsed<{ batchId: string; studentId: string }> {
  if (!isUuid(batchId)) return { ok: false, error: "Choose a valid batch." };
  if (!isUuid(studentId)) return { ok: false, error: "Choose a valid student." };
  return { ok: true, value: { batchId, studentId } };
}

// -------------------------------------------------------------------
// Messages (never raw database errors)
// -------------------------------------------------------------------

/** Database refusals → what the person is told. */
export const ENROLLMENT_REASON_MESSAGE: Record<string, string> = {
  unchanged: "Nothing changed — the student already has this enrolment status.",
  transition_not_allowed: "That change isn't allowed for this enrolment (a completed enrolment is final; trainers can only add new students).",
  batch_cancelled: "This batch is cancelled; its enrolments can't be changed.",
  batch_not_current: "Students can only be enrolled into upcoming or ongoing batches.",
  course_archived: "This batch hasn't started and its course is inactive, so it takes no new students. Ongoing batches of inactive courses still accept enrolments.",
  batch_full: "This batch is full.",
  not_found: "That batch or student no longer exists. Reload the page.",
  student_not_available: "This student can't be enrolled — an active student record with an active account is required.",
};

export const ENROLLMENT_GENERIC_ERROR = "The enrolment couldn't be changed. Please try again.";
export const ENROLLMENT_ADMIN_ONLY_ERROR = "Only Super Admins can change enrolments.";
export const ENROLLMENT_TRAINER_SCOPE_ERROR = "You can only add your current students to batches you currently teach.";

export function enrollmentRefusalMessage(reason: unknown): string {
  const known = typeof reason === "string" && Object.prototype.hasOwnProperty.call(ENROLLMENT_REASON_MESSAGE, reason);
  return (known && ENROLLMENT_REASON_MESSAGE[reason as string]) || ENROLLMENT_GENERIC_ERROR;
}

/** Success sentence for a change from `previous` to `status`. */
export function enrollmentSuccessMessage(previous: EnrollmentStatus | null, status: EnrollmentStatus): string {
  if (status === "enrolled") return previous === "withdrawn" ? "Student re-enrolled." : "Student enrolled.";
  if (status === "withdrawn") return "Enrolment withdrawn.";
  return "Enrolment marked as completed.";
}

/** Plain, serializable result of an enrolment server action. */
export type EnrollmentActionResult = { ok: true; message: string } | { ok: false; error: string };

// -------------------------------------------------------------------
// Which actions to offer (the database enforces the same or stricter)
// -------------------------------------------------------------------

export interface EnrollmentActions {
  enrol: boolean;
  reEnrol: boolean;
  withdraw: boolean;
  complete: boolean;
}

const NONE: EnrollmentActions = { enrol: false, reEnrol: false, withdraw: false, complete: false };
const CURRENT = (s: unknown) => s === "upcoming" || s === "ongoing";

/** 0030: an upcoming batch of an archived course takes no new students (ongoing batches still do). */
export function isEnrolmentClosedForCourse(batchStatus: unknown, courseStatus: unknown): boolean {
  return batchStatus === "upcoming" && courseStatus === "archived";
}

export const ENROLMENT_CLOSED_NOTE =
  "This batch hasn't started and its course is inactive, so it takes no new students. Students already enrolled stay; withdrawals still work. Reactivate the course to reopen enrolment.";

/**
 * Actions for one student in one batch.
 *   Super Admin: enrol (no enrolment) and re-enrol (withdrawn) in
 *     upcoming/ongoing batches; withdraw in upcoming/ongoing batches;
 *     complete in ongoing/completed batches (not before the batch starts —
 *     a UI rule, G3); nothing in a cancelled batch; completed is final.
 *   Trainer: enrol a new student into an upcoming/ongoing batch only.
 *   0030: an UPCOMING batch of an ARCHIVED course takes no new or returning
 *     students (enrol / re-enrol off; withdraw and the rest unchanged) —
 *     the same rule the database enforces (reason course_archived).
 */
export function enrollmentActions(
  role: "admin" | "trainer",
  batchStatus: unknown,
  enrollmentStatus: EnrollmentStatus | null,
  courseStatus?: unknown
): EnrollmentActions {
  if (!(BATCH_STATUSES as readonly unknown[]).includes(batchStatus) || batchStatus === "cancelled") return NONE;
  const open = CURRENT(batchStatus) && !isEnrolmentClosedForCourse(batchStatus, courseStatus);
  if (role === "trainer") return { ...NONE, enrol: enrollmentStatus === null && open };
  if (enrollmentStatus === null) return { ...NONE, enrol: open };
  if (enrollmentStatus === "withdrawn") return { ...NONE, reEnrol: open };
  if (enrollmentStatus === "enrolled") {
    return { ...NONE, withdraw: CURRENT(batchStatus), complete: batchStatus === "ongoing" || batchStatus === "completed" };
  }
  return NONE; // completed: final
}

/** History source → label. */
export const ENROLLMENT_SOURCE_LABEL: Record<string, string> = {
  admin: "Super Admin",
  trainer: "Trainer",
  invitation: "Invitation",
  direct: "Direct (database)",
  baseline: "Initial record",
};

// -------------------------------------------------------------------
// Read models for the batch detail (filled by the service)
// -------------------------------------------------------------------

export interface EnrollmentBatchHeader {
  id: string;
  code: string;
  name: string;
  status: BatchStatusValue;
  startDate: string;
  endDate: string;
  maxSeats: number;
  course: string;
  trainerId: string | null;
  trainerName: string | null;
}

export interface EnrollmentRosterRow {
  studentId: string;
  studentCode: string | null;
  studentName: string | null;
  enrollmentStatus: EnrollmentStatus;
  enrolledAt: string;
  completedAt: string | null;
  actions: EnrollmentActions;
}

export interface EnrollmentHistoryEntry {
  id: number;
  occurredAt: string;
  studentId: string;
  previousStatus: EnrollmentStatus | null;
  newStatus: EnrollmentStatus;
  source: string;
  sourceLabel: string;
  reason: string | null;
}

export interface EnrollmentCandidate {
  id: string;
  code: string;
  name: string;
}

export interface BatchEnrollmentDetail {
  mode: "admin" | "trainer";
  batch: EnrollmentBatchHeader;
  /** Seats in use (enrolled + completed), as the database counts them. */
  seatsUsed: number;
  roster: EnrollmentRosterRow[];
  history: EnrollmentHistoryEntry[];
  /** Students that may be offered for a NEW enrolment (none when the batch can't take one). */
  candidates: EnrollmentCandidate[];
  canEnrol: boolean;
  /** Set when enrolment is closed because the batch's course is archived (shown instead of the Enrol button). */
  enrolmentNote?: string;
}
