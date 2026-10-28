/**
 * Completion management and certificates (0011_certificates_completion.sql).
 *
 * The database is authoritative for everything here: eligibility,
 * requirement locking, certificate numbers, verification codes,
 * snapshots and every stamp. These types only describe what the 0011
 * functions return, split by audience:
 *
 *   - Staff*   : Super Admin / the batch's assigned trainer
 *                (staff_batch_completion + RLS reads). May include
 *                student ids, attendance and scores.
 *   - Student* : the signed-in student's own data (student_completion_status,
 *                student_certificates). No internal ids, staff identities
 *                or audit data.
 *   - Public*  : verify_certificate(number, code) — safe fields only.
 */

export type CompletionStatus = "recommended" | "approved" | "rejected" | "withdrawn";
export type CertificateStatus = "issued" | "revoked";

/** Why a batch's requirements can no longer be changed. */
export type RequirementsLockReason = "batch_completed" | "batch_cancelled" | "approvals_exist";

/** State of the designated final assessment for one student. */
export type FinalAssessmentState =
  | "not_designated"
  | "requirement_invalid"
  | "pending"
  | "not_attempted"
  | "passed"
  | "failed";

/** State of the required assignments for one student. */
export type AssignmentRequirementState = "satisfied" | "incomplete" | "requirement_invalid";

/** Format checks (the database re-validates; these only reject junk early). */
export const CERTIFICATE_NUMBER_PATTERN = /^ARS-SPI-[0-9]{4}-[0-9]{6}$/;
export const VERIFICATION_CODE_PATTERN = /^[0-9A-F]{20}$/;

/** Mirrors the 0011 CHECK constraints. */
export const COMPLETION_LIMITS = {
  noteMax: 1000,
  revocationReasonMin: 10,
  revocationReasonMax: 1000,
  minimumAttendancePercent: 75,
} as const;

// -------------------------------------------------------------------
// Requirements (staff)
// -------------------------------------------------------------------

export interface CompletionRequirements {
  finalAssessment: { testId: string; title: string; designatedAt: string } | null;
  requiredAssignments: { assignmentId: string; title: string; addedAt: string }[];
}

/** A test or assignment an admin may choose as a requirement. */
export interface RequirementOption {
  id: string;
  title: string;
  classTitle: string;
  classDate: string | null;
}

// -------------------------------------------------------------------
// Staff completion
// -------------------------------------------------------------------

/** completion_eligibility() as returned to staff. */
export interface StaffEligibility {
  eligible: boolean;
  /** Set when the student/batch could not be evaluated (e.g. not_enrolled). */
  reason: string | null;
  computedAt: string | null;
  batchCompleted: boolean;
  batchStatus: string | null;
  enrolmentOk: boolean;
  enrollmentStatus: string | null;
  attendance: {
    ok: boolean;
    attended: number;
    eligibleClasses: number;
    percent: number | null;
    minimumPercent: number;
  };
  finalAssessment: {
    ok: boolean;
    state: FinalAssessmentState | null;
    testId: string | null;
    bestPercentage: number | null;
  };
  assignments: {
    ok: boolean;
    state: AssignmentRequirementState | null;
    required: number;
    satisfied: number;
    missingIds: string[];
    invalidIds: string[];
  };
}

export interface StaffCompletionRecord {
  id: string;
  status: CompletionStatus;
  recommendedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  completionDate: string | null;
}

export interface StaffCompletionStudent {
  studentId: string;
  studentCode: string;
  fullName: string;
  enrollmentStatus: string;
  eligibility: StaffEligibility;
  completion: StaffCompletionRecord | null;
  activeCertificate: { id: string; certificateNumber: string; issuedAt: string } | null;
  revokedCertificates: number;
}

export interface CompletionBatchInfo {
  id: string;
  batchCode: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  courseCode: string;
  courseTitle: string;
  trainerName: string | null;
}

/** staff_batch_completion() plus what the caller may do. */
export interface StaffBatchCompletion {
  batch: CompletionBatchInfo;
  requirementsLocked: boolean;
  lockReason: RequirementsLockReason | null;
  requirements: CompletionRequirements;
  students: StaffCompletionStudent[];
  /** Super Admin: requirements, approval, issue and revoke. Trainers: recommend/withdraw only. */
  canManage: boolean;
  /** Choices for the requirement editor (admin only, and only while unlocked). */
  finalAssessmentOptions: RequirementOption[];
  assignmentOptions: RequirementOption[];
}

/** A batch in the staff completion list. */
export interface CompletionBatchSummary {
  id: string;
  batchCode: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  courseCode: string;
  courseTitle: string;
  trainerName: string | null;
  /** Counts read from completion_records / certificates (RLS). */
  counts: { recommended: number; approved: number; issued: number; revoked: number };
}

/** A certificate row in staff lists (no verification code). */
export interface StaffCertificateSummary {
  id: string;
  certificateNumber: string;
  status: CertificateStatus;
  batchId: string;
  studentName: string;
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  completionDate: string;
  issuedAt: string;
  revokedAt: string | null;
  replacesCertificateId: string | null;
}

// -------------------------------------------------------------------
// Certificate document (the immutable snapshot, for the print view)
// -------------------------------------------------------------------

export interface CertificateSignatory {
  name: string;
  title: string | null;
}

export interface CertificateDocument {
  certificateNumber: string;
  verificationCode: string;
  status: CertificateStatus;
  studentName: string;
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  batchStartDate: string;
  batchEndDate: string;
  completionDate: string;
  trainerName: string | null;
  issuerName: string;
  templateVersion: string;
  signatories: CertificateSignatory[];
  snapshotSha256: string;
  issuedAt: string;
  revokedAt: string | null;
}

// -------------------------------------------------------------------
// Student
// -------------------------------------------------------------------

/** One enrolment from student_completion_status() — own data only. */
export interface StudentCompletionItem {
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  batchStatus: string;
  batchEndDate: string | null;
  requirements: {
    finalAssessment: string | null;
    requiredAssignments: string[];
  };
  eligibility: {
    eligible: boolean;
    batchCompleted: boolean;
    attendance: {
      ok: boolean;
      attended: number;
      eligibleClasses: number;
      percent: number | null;
      minimumPercent: number;
    };
    finalAssessment: { ok: boolean; state: FinalAssessmentState | null };
    assignments: { ok: boolean; required: number; satisfied: number };
  };
  completion: {
    status: CompletionStatus;
    completionDate: string | null;
    rejectionNote: string | null;
    mayBecomeEligible: boolean;
  } | null;
}

/** student_certificates() — the student's own certificate snapshots. */
export type StudentCertificate = CertificateDocument;

// -------------------------------------------------------------------
// Public verification
// -------------------------------------------------------------------

export interface PublicCertificate {
  certificateNumber: string;
  studentName: string;
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  completionDate: string;
  issueDate: string;
  status: CertificateStatus;
  revokedDate: string | null;
}

export type PublicVerificationResult = { found: false } | { found: true; certificate: PublicCertificate };

/** Path of the public verification page for a certificate (number + code). */
export function certificateVerificationPath(certificateNumber: string, verificationCode: string): string {
  return `/verify/${encodeURIComponent(certificateNumber)}?code=${encodeURIComponent(verificationCode)}`;
}

// -------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------

export interface CompletionActionResult {
  ok: boolean;
  error?: string;
  /** Set when a certificate was issued. */
  certificateNumber?: string;
}
