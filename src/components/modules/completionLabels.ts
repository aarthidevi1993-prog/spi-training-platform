import type { BadgeProps } from "@/components/ui/Badge";
import type {
  CertificateStatus,
  CompletionStatus,
  FinalAssessmentState,
  RequirementsLockReason,
} from "@/types/certificate";

/**
 * Display labels for the states the 0011 database returns. Presentation
 * only — every state itself comes from the database.
 */

export const COMPLETION_STATUS: Record<CompletionStatus, { label: string; tone: BadgeProps["tone"] }> = {
  recommended: { label: "Recommended", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export const CERTIFICATE_STATUS: Record<CertificateStatus, { label: string; tone: BadgeProps["tone"] }> = {
  issued: { label: "Issued", tone: "green" },
  revoked: { label: "Revoked", tone: "red" },
};

export const FINAL_ASSESSMENT_STATE: Record<FinalAssessmentState, string> = {
  not_designated: "Not designated",
  requirement_invalid: "Requirement invalid",
  pending: "Awaiting result",
  not_attempted: "Not attempted",
  passed: "Passed",
  failed: "Not passed",
};

export const LOCK_REASON: Record<RequirementsLockReason, string> = {
  batch_completed: "The batch is completed, so its requirements are final.",
  batch_cancelled: "The batch is cancelled.",
  approvals_exist: "A completion in this batch has already been approved.",
};

export function finalAssessmentLabel(state: FinalAssessmentState | null): string {
  return state ? FINAL_ASSESSMENT_STATE[state] ?? state : "—";
}
