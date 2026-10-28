import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import {
  certificatesRepository,
  CertificateRepositoryError,
  type CertificateDocumentRecord,
  type RequirementOptionRecord,
} from "@/repositories/certificates.repository";
import type { AuthUser } from "@/types/auth";
import {
  CERTIFICATE_NUMBER_PATTERN,
  COMPLETION_LIMITS,
  VERIFICATION_CODE_PATTERN,
  type AssignmentRequirementState,
  type CertificateDocument,
  type CertificateSignatory,
  type CertificateStatus,
  type CompletionBatchSummary,
  type CompletionStatus,
  type FinalAssessmentState,
  type PublicVerificationResult,
  type RequirementOption,
  type RequirementsLockReason,
  type StaffBatchCompletion,
  type StaffCertificateSummary,
  type StaffCompletionStudent,
  type StaffEligibility,
  type StudentCertificate,
  type StudentCompletionItem,
} from "@/types/certificate";

/**
 * Certificates service — completion management and certificates on top
 * of the 0011 database functions.
 *
 * Identity always comes from authService (never from a client argument).
 * The database is authoritative for eligibility, requirement locking,
 * role/batch scope, certificate numbers, verification codes, snapshots
 * and all stamps; nothing here recalculates or overrides them. This
 * layer checks the caller's role early (for clear messages), validates
 * ids and text lengths, maps the database's JSON into typed shapes, and
 * turns blocked reasons into friendly messages. Raw Postgres errors are
 * never exposed.
 */

export class CertificateAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "CertificateAuthorizationError";
  }
}

export class CertificateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificateValidationError";
  }
}

/** A business outcome refused by the database ({ok:false, reason}). */
export class CertificateBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "CertificateBlockedError";
    this.reason = reason;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

const LOCK_MESSAGES: Record<RequirementsLockReason, string> = {
  batch_completed: "Requirements are locked because the batch is completed.",
  batch_cancelled: "Requirements are locked because the batch is cancelled.",
  approvals_exist: "Requirements are locked because a completion in this batch has already been approved.",
};

/** Friendly text for the reasons the 0011 functions return. */
const BLOCKED_MESSAGES: Record<string, string> = {
  not_found: "That record wasn't found, or you don't have permission to see it.",
  test_not_in_batch: "That test doesn't belong to this batch.",
  not_final_exam: "Only a final exam can be the required final assessment.",
  test_draft: "The final assessment must be a published test.",
  class_cancelled: "That item's class is cancelled.",
  assignment_not_in_batch: "That assignment doesn't belong to this batch.",
  assignment_draft: "Only published assignments can be required.",
  already_required: "That assignment is already required.",
  not_required: "That assignment isn't a requirement of this batch.",
  note_too_long: `Notes must be ${COMPLETION_LIMITS.noteMax} characters or fewer.`,
  note_required: "A note is required to reject a completion.",
  not_enrolled: "This student isn't enrolled in the batch.",
  already_recommended: "This student has already been recommended.",
  already_approved: "This student's completion has already been approved.",
  not_eligible: "This student doesn't meet the completion requirements yet.",
  not_recommended: "Only a recommended completion can be changed this way.",
  not_approved: "A certificate can only be issued for an approved completion.",
  already_issued: "This student already has an active certificate for this batch.",
  invalid_reason: `The reason must be ${COMPLETION_LIMITS.revocationReasonMin}–${COMPLETION_LIMITS.revocationReasonMax} characters.`,
  already_revoked: "This certificate has already been revoked.",
};

function blockedMessage(reason: string, lockReason?: string | null): string {
  if (reason === "requirements_locked") {
    return (lockReason && LOCK_MESSAGES[lockReason as RequirementsLockReason]) || "Requirements are locked for this batch.";
  }
  return BLOCKED_MESSAGES[reason] ?? "This action isn't available right now.";
}

// -------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------

function requireSupabaseMode(): void {
  if (authConfig.mode === "demo") {
    throw new CertificateValidationError("Certificates require Supabase mode.");
  }
}

async function requireUser(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new CertificateAuthorizationError("You need to be signed in.");
  return user;
}

async function requireStaff(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin" && user.role !== "trainer") throw new CertificateAuthorizationError();
  return user;
}

async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new CertificateAuthorizationError("Only a Super Admin can do that.");
  return user;
}

async function requireStudent(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "student") throw new CertificateAuthorizationError("Only students can view this page.");
  return user;
}

/** A 42501 from the database means "not yours / not visible". */
function isPermissionError(err: unknown): boolean {
  return err instanceof CertificateRepositoryError && err.code === "42501";
}

// -------------------------------------------------------------------
// Defensive JSON readers (the database is trusted, but shapes are checked)
// -------------------------------------------------------------------
type Obj = Record<string, unknown>;
function asObj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CertificateRepositoryError("Unexpected response from the certificate service.");
  return v as Obj;
}
function sub(o: Obj, k: string): Obj {
  const v = o[k];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function subOrNull(o: Obj, k: string): Obj | null {
  const v = o[k];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function str(o: Obj, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
function strOrNull(o: Obj, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}
function num(o: Obj, k: string): number {
  const v = o[k];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(o: Obj, k: string): number | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(o: Obj, k: string): boolean {
  return o[k] === true;
}
function arr(o: Obj, k: string): unknown[] {
  const v = o[k];
  return Array.isArray(v) ? v : [];
}
function strings(v: unknown[]): string[] {
  return v.filter((x): x is string => typeof x === "string");
}

/** Throws a friendly blocked error unless the function returned {ok:true}. */
function expectOk(data: unknown): Obj {
  const o = asObj(data);
  if (o.ok !== true) {
    const reason = str(o, "reason") || "not_found";
    throw new CertificateBlockedError(reason, blockedMessage(reason, strOrNull(o, "lock_reason")));
  }
  return o;
}

// -------------------------------------------------------------------
// Mapping
// -------------------------------------------------------------------

function toStaffEligibility(value: unknown): StaffEligibility {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
  const batch = sub(o, "batch_completed");
  const enrolment = sub(o, "enrolment");
  const attendance = sub(o, "attendance");
  const fa = sub(o, "final_assessment");
  const as = sub(o, "assignments");
  return {
    eligible: bool(o, "eligible"),
    reason: strOrNull(o, "reason"),
    computedAt: strOrNull(o, "computed_at"),
    batchCompleted: bool(batch, "ok"),
    batchStatus: strOrNull(batch, "batch_status"),
    enrolmentOk: bool(enrolment, "ok"),
    enrollmentStatus: strOrNull(enrolment, "enrollment_status"),
    attendance: {
      ok: bool(attendance, "ok"),
      attended: num(attendance, "attended"),
      eligibleClasses: num(attendance, "eligible_classes"),
      percent: numOrNull(attendance, "percent"),
      minimumPercent: numOrNull(attendance, "minimum_percent") ?? COMPLETION_LIMITS.minimumAttendancePercent,
    },
    finalAssessment: {
      ok: bool(fa, "ok"),
      state: (strOrNull(fa, "state") as FinalAssessmentState | null) ?? null,
      testId: strOrNull(fa, "test_id"),
      bestPercentage: numOrNull(fa, "best_percentage"),
    },
    assignments: {
      ok: bool(as, "ok"),
      state: (strOrNull(as, "state") as AssignmentRequirementState | null) ?? null,
      required: num(as, "required"),
      satisfied: num(as, "satisfied"),
      missingIds: strings(arr(as, "missing_ids")),
      invalidIds: strings(arr(as, "invalid_ids")),
    },
  };
}

function toStaffStudent(value: unknown): StaffCompletionStudent {
  const o = asObj(value);
  const completion = subOrNull(o, "completion");
  const certificate = subOrNull(o, "active_certificate");
  return {
    studentId: str(o, "student_id"),
    studentCode: str(o, "student_code"),
    fullName: str(o, "full_name"),
    enrollmentStatus: str(o, "enrollment_status"),
    eligibility: toStaffEligibility(o.eligibility),
    completion: completion
      ? {
          id: str(completion, "id"),
          status: str(completion, "status") as CompletionStatus,
          recommendedAt: strOrNull(completion, "recommended_at"),
          decidedAt: strOrNull(completion, "decided_at"),
          decisionNote: strOrNull(completion, "decision_note"),
          completionDate: strOrNull(completion, "completion_date"),
        }
      : null,
    activeCertificate: certificate
      ? { id: str(certificate, "id"), certificateNumber: str(certificate, "certificate_number"), issuedAt: str(certificate, "issued_at") }
      : null,
    revokedCertificates: num(o, "revoked_certificates"),
  };
}

function toOption(row: RequirementOptionRecord): RequirementOption {
  return {
    id: row.id,
    title: row.title,
    classTitle: row.classes?.title ?? "Unknown class",
    classDate: row.classes?.class_date ?? null,
  };
}

function toSignatories(value: unknown): CertificateSignatory[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v))
    .map((v) => ({ name: str(v, "name"), title: strOrNull(v, "title") }))
    .filter((s) => s.name.length > 0);
}

/** Snapshot → document; accepts both the student function's JSON and the staff RLS row (same keys). */
function toDocument(value: unknown): CertificateDocument {
  const o = asObj(value);
  return {
    certificateNumber: str(o, "certificate_number"),
    verificationCode: str(o, "verification_code"),
    status: str(o, "status") as CertificateStatus,
    studentName: str(o, "student_name"),
    courseCode: str(o, "course_code"),
    courseTitle: str(o, "course_title"),
    batchCode: str(o, "batch_code"),
    batchName: str(o, "batch_name"),
    batchStartDate: str(o, "batch_start_date"),
    batchEndDate: str(o, "batch_end_date"),
    completionDate: str(o, "completion_date"),
    trainerName: strOrNull(o, "trainer_name"),
    issuerName: str(o, "issuer_name"),
    templateVersion: str(o, "template_version"),
    signatories: toSignatories(o.signatories),
    snapshotSha256: str(o, "snapshot_sha256"),
    issuedAt: str(o, "issued_at"),
    revokedAt: strOrNull(o, "revoked_at"),
  };
}

function toStudentItem(value: unknown): StudentCompletionItem {
  const o = asObj(value);
  const requirements = sub(o, "requirements");
  const e = sub(o, "eligibility");
  const attendance = sub(e, "attendance");
  const fa = sub(e, "final_assessment");
  const as = sub(e, "assignments");
  const completion = subOrNull(o, "completion");
  return {
    courseCode: str(o, "course_code"),
    courseTitle: str(o, "course_title"),
    batchCode: str(o, "batch_code"),
    batchName: str(o, "batch_name"),
    batchStatus: str(o, "batch_status"),
    batchEndDate: strOrNull(o, "batch_end_date"),
    requirements: {
      finalAssessment: strOrNull(requirements, "final_assessment"),
      requiredAssignments: strings(arr(requirements, "required_assignments")),
    },
    eligibility: {
      eligible: bool(e, "eligible"),
      batchCompleted: bool(e, "batch_completed"),
      attendance: {
        ok: bool(attendance, "ok"),
        attended: num(attendance, "attended"),
        eligibleClasses: num(attendance, "eligible_classes"),
        percent: numOrNull(attendance, "percent"),
        minimumPercent: numOrNull(attendance, "minimum_percent") ?? COMPLETION_LIMITS.minimumAttendancePercent,
      },
      finalAssessment: { ok: bool(fa, "ok"), state: (strOrNull(fa, "state") as FinalAssessmentState | null) ?? null },
      assignments: { ok: bool(as, "ok"), required: num(as, "required"), satisfied: num(as, "satisfied") },
    },
    completion: completion
      ? {
          status: str(completion, "status") as CompletionStatus,
          completionDate: strOrNull(completion, "completion_date"),
          rejectionNote: strOrNull(completion, "rejection_note"),
          mayBecomeEligible: bool(completion, "may_become_eligible"),
        }
      : null,
  };
}

function documentFromRecord(row: CertificateDocumentRecord): CertificateDocument {
  return toDocument(row as unknown as Obj);
}

// -------------------------------------------------------------------
// Validation helpers
// -------------------------------------------------------------------

function requireId(value: unknown, label: string): string {
  if (!isUuid(value)) throw new CertificateValidationError(`Choose a valid ${label}.`);
  return value;
}

function optionalNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CertificateValidationError("Invalid note.");
  const note = value.trim();
  if (!note) return null;
  if (note.length > COMPLETION_LIMITS.noteMax) {
    throw new CertificateValidationError(`Notes must be ${COMPLETION_LIMITS.noteMax} characters or fewer.`);
  }
  return note;
}

/** Normalises a certificate number as the database does (trim + upper case); null when malformed. */
export function normaliseCertificateNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  return CERTIFICATE_NUMBER_PATTERN.test(v) ? v : null;
}

function normaliseVerificationCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  return VERIFICATION_CODE_PATTERN.test(v) ? v : null;
}

export const certificatesService = {
  // -----------------------------------------------------------------
  // Staff reads
  // -----------------------------------------------------------------

  /** Batches for the completion pages: admin all; trainer their assigned batches (any status). null in demo mode. */
  async listCompletionBatches(): Promise<CompletionBatchSummary[] | null> {
    if (authConfig.mode === "demo") return null;
    const user = await requireStaff();
    const [rows, statuses] = await Promise.all([
      certificatesRepository.listBatches(user.role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id }),
      certificatesRepository.listStatusRows(),
    ]);

    // Counts only — read straight from the stored statuses (RLS-scoped).
    const counts = new Map<string, CompletionBatchSummary["counts"]>();
    const countsFor = (batchId: string) => {
      let c = counts.get(batchId);
      if (!c) {
        c = { recommended: 0, approved: 0, issued: 0, revoked: 0 };
        counts.set(batchId, c);
      }
      return c;
    };
    for (const r of statuses.completions) {
      if (r.status === "recommended") countsFor(r.batch_id).recommended += 1;
      else if (r.status === "approved") countsFor(r.batch_id).approved += 1;
    }
    for (const r of statuses.certificates) {
      if (r.status === "issued") countsFor(r.batch_id).issued += 1;
      else countsFor(r.batch_id).revoked += 1;
    }

    return rows.map((b) => ({
      id: b.id,
      batchCode: b.batch_code,
      name: b.name,
      status: b.status,
      startDate: b.start_date,
      endDate: b.end_date,
      courseCode: b.courses?.course_code ?? "",
      courseTitle: b.courses?.title ?? "Unknown course",
      trainerName: b.trainers?.full_name ?? null,
      counts: counts.get(b.id) ?? { recommended: 0, approved: 0, issued: 0, revoked: 0 },
    }));
  },

  /**
   * One batch's completion overview (staff_batch_completion). null when
   * the batch doesn't exist or the caller may not see it (→ notFound).
   */
  async getBatchCompletion(batchId: string): Promise<StaffBatchCompletion | null> {
    if (authConfig.mode === "demo") return null;
    const user = await requireStaff();
    if (!isUuid(batchId)) return null;

    let data: unknown;
    try {
      data = await certificatesRepository.staffBatchCompletion(batchId);
    } catch (err) {
      if (isPermissionError(err)) return null;
      throw err;
    }
    const o = asObj(data);
    if (o.ok !== true) return null;
    // Course and trainer for the header (RLS read of the same batch).
    const batchRow = await certificatesRepository.getBatch(batchId);

    const batch = sub(o, "batch");
    const fa = subOrNull(o, "final_assessment");
    const lockReason = (strOrNull(o, "lock_reason") as RequirementsLockReason | null) ?? null;
    const requirementsLocked = bool(o, "requirements_locked");
    const canManage = user.role === "admin";

    // Choices for the requirement editor: admin only, and only while unlocked.
    let finalAssessmentOptions: RequirementOption[] = [];
    let assignmentOptions: RequirementOption[] = [];
    if (canManage && !requirementsLocked) {
      const [tests, assignments] = await Promise.all([
        certificatesRepository.listFinalExamOptions(batchId),
        certificatesRepository.listAssignmentOptions(batchId),
      ]);
      finalAssessmentOptions = tests.filter((t) => t.classes?.status !== "cancelled").map(toOption);
      assignmentOptions = assignments.filter((a) => a.classes?.status !== "cancelled").map(toOption);
    }

    return {
      batch: {
        id: str(batch, "id"),
        batchCode: str(batch, "batch_code"),
        name: str(batch, "name"),
        status: str(batch, "status"),
        startDate: strOrNull(batch, "start_date"),
        endDate: strOrNull(batch, "end_date"),
        courseCode: batchRow?.courses?.course_code ?? "",
        courseTitle: batchRow?.courses?.title ?? "",
        trainerName: batchRow?.trainers?.full_name ?? null,
      },
      requirementsLocked,
      lockReason,
      requirements: {
        finalAssessment: fa
          ? { testId: str(fa, "test_id"), title: str(fa, "title"), designatedAt: str(fa, "designated_at") }
          : null,
        requiredAssignments: arr(o, "required_assignments").map((v) => {
          const a = asObj(v);
          return { assignmentId: str(a, "assignment_id"), title: str(a, "title"), addedAt: str(a, "added_at") };
        }),
      },
      students: arr(o, "students").map(toStaffStudent),
      canManage,
      finalAssessmentOptions,
      assignmentOptions,
    };
  },

  /** Certificates the caller may see (RLS), optionally for one batch. null in demo mode. */
  async listCertificates(batchId?: string): Promise<StaffCertificateSummary[] | null> {
    if (authConfig.mode === "demo") return null;
    await requireStaff();
    if (batchId !== undefined && !isUuid(batchId)) return [];
    const rows = await certificatesRepository.listCertificates(batchId);
    return rows.map((c) => ({
      id: c.id,
      certificateNumber: c.certificate_number,
      status: c.status,
      batchId: c.batch_id,
      studentName: c.student_name,
      courseCode: c.course_code,
      courseTitle: c.course_title,
      batchCode: c.batch_code,
      batchName: c.batch_name,
      completionDate: c.completion_date,
      issuedAt: c.issued_at,
      revokedAt: c.revoked_at,
      replacesCertificateId: c.replaces_certificate_id,
    }));
  },

  /** A certificate snapshot for the staff print view (RLS); null when not visible. */
  async getStaffCertificate(certificateNumber: string): Promise<CertificateDocument | null> {
    if (authConfig.mode === "demo") return null;
    await requireStaff();
    const number = normaliseCertificateNumber(certificateNumber);
    if (!number) return null;
    const row = await certificatesRepository.getCertificateDocument(number);
    return row ? documentFromRecord(row) : null;
  },

  // -----------------------------------------------------------------
  // Student reads (own data only; identity from the session)
  // -----------------------------------------------------------------

  /** The signed-in student's completion status per enrolment. null in demo mode. */
  async getStudentCompletion(): Promise<StudentCompletionItem[] | null> {
    if (authConfig.mode === "demo") return null;
    await requireStudent();
    const data = await certificatesRepository.studentCompletionStatus();
    return (Array.isArray(data) ? data : []).map(toStudentItem);
  },

  /** The signed-in student's certificates (issued and revoked). null in demo mode. */
  async getStudentCertificates(): Promise<StudentCertificate[] | null> {
    if (authConfig.mode === "demo") return null;
    await requireStudent();
    const data = await certificatesRepository.studentCertificates();
    return (Array.isArray(data) ? data : []).map(toDocument);
  },

  /** One of the signed-in student's certificates by number, or null. */
  async getStudentCertificate(certificateNumber: string): Promise<StudentCertificate | null> {
    const number = normaliseCertificateNumber(certificateNumber);
    if (!number) return null;
    const certificates = await this.getStudentCertificates();
    return certificates?.find((c) => c.certificateNumber === number) ?? null;
  },

  // -----------------------------------------------------------------
  // Public verification (no sign-in required)
  // -----------------------------------------------------------------

  /**
   * verify_certificate(number, code). Both values are required; any
   * malformed input or non-matching pair gets the same {found:false}.
   */
  async verifyCertificate(certificateNumber: unknown, verificationCode: unknown): Promise<PublicVerificationResult> {
    if (authConfig.mode === "demo") return { found: false };
    const number = normaliseCertificateNumber(certificateNumber);
    const code = normaliseVerificationCode(verificationCode);
    if (!number || !code) return { found: false };

    const o = asObj(await certificatesRepository.verifyCertificate(number, code));
    if (o.found !== true) return { found: false };
    return {
      found: true,
      certificate: {
        certificateNumber: str(o, "certificate_number"),
        studentName: str(o, "student_name"),
        courseCode: str(o, "course_code"),
        courseTitle: str(o, "course_title"),
        batchCode: str(o, "batch_code"),
        batchName: str(o, "batch_name"),
        completionDate: str(o, "completion_date"),
        issueDate: str(o, "issue_date"),
        status: str(o, "status") as CertificateStatus,
        revokedDate: strOrNull(o, "revoked_date"),
      },
    };
  },

  // -----------------------------------------------------------------
  // Requirements (Super Admin)
  // -----------------------------------------------------------------

  async setFinalAssessment(batchId: string, testId: string): Promise<string> {
    requireSupabaseMode();
    await requireAdmin();
    const batch = requireId(batchId, "batch");
    expectOk(await certificatesRepository.setFinalAssessment(batch, requireId(testId, "final exam")));
    return batch;
  },

  async clearFinalAssessment(batchId: string): Promise<string> {
    requireSupabaseMode();
    await requireAdmin();
    const batch = requireId(batchId, "batch");
    expectOk(await certificatesRepository.clearFinalAssessment(batch));
    return batch;
  },

  async addRequiredAssignment(batchId: string, assignmentId: string): Promise<string> {
    requireSupabaseMode();
    await requireAdmin();
    const batch = requireId(batchId, "batch");
    expectOk(await certificatesRepository.addRequiredAssignment(batch, requireId(assignmentId, "assignment")));
    return batch;
  },

  async removeRequiredAssignment(batchId: string, assignmentId: string): Promise<string> {
    requireSupabaseMode();
    await requireAdmin();
    const batch = requireId(batchId, "batch");
    expectOk(await certificatesRepository.removeRequiredAssignment(batch, requireId(assignmentId, "assignment")));
    return batch;
  },

  // -----------------------------------------------------------------
  // Workflow
  // -----------------------------------------------------------------

  /** Super Admin, or the batch's assigned trainer (checked by the database). */
  async recommendCompletion(batchId: string, studentId: string, note?: string | null): Promise<string> {
    requireSupabaseMode();
    await requireStaff();
    const batch = requireId(batchId, "batch");
    expectOk(await certificatesRepository.recommendCompletion(batch, requireId(studentId, "student"), optionalNote(note)));
    return batch;
  },

  async withdrawRecommendation(completionId: string): Promise<void> {
    requireSupabaseMode();
    await requireStaff();
    expectOk(await certificatesRepository.withdrawRecommendation(requireId(completionId, "completion record")));
  },

  /** Approve: the database re-checks live eligibility and sets completion_date = batch end date. */
  async approveCompletion(completionId: string, note?: string | null): Promise<void> {
    requireSupabaseMode();
    await requireAdmin();
    expectOk(await certificatesRepository.decideCompletion(requireId(completionId, "completion record"), true, optionalNote(note)));
  },

  /** Reject: a note is required (the student can see it). */
  async rejectCompletion(completionId: string, note: string): Promise<void> {
    requireSupabaseMode();
    await requireAdmin();
    const id = requireId(completionId, "completion record");
    const text = optionalNote(note);
    if (!text) throw new CertificateValidationError("A note is required to reject a completion.");
    expectOk(await certificatesRepository.decideCompletion(id, false, text));
  },

  /** Issue (or reissue after revocation). Returns the database-generated certificate number. */
  async issueCertificate(completionId: string): Promise<string> {
    requireSupabaseMode();
    await requireAdmin();
    const o = expectOk(await certificatesRepository.issueCertificate(requireId(completionId, "completion record")));
    return str(o, "certificate_number");
  },

  async revokeCertificate(certificateId: string, reason: string): Promise<void> {
    requireSupabaseMode();
    await requireAdmin();
    const id = requireId(certificateId, "certificate");
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text.length < COMPLETION_LIMITS.revocationReasonMin || text.length > COMPLETION_LIMITS.revocationReasonMax) {
      throw new CertificateValidationError(blockedMessage("invalid_reason"));
    }
    expectOk(await certificatesRepository.revokeCertificate(id, text));
  },
};

export { CertificateRepositoryError };
