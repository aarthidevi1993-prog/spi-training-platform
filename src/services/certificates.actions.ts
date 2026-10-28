"use server";

/**
 * Server Actions — the RPC boundary the completion/certificate pages
 * call. Each action delegates to certificatesService, which resolves
 * the caller from the authenticated session; the 0011 database
 * functions decide eligibility, scope, numbers, codes and stamps. Only
 * ids, notes and reasons are accepted from the browser. Internal error
 * details are logged, never returned.
 */

import { revalidatePath } from "next/cache";
import {
  certificatesService,
  CertificateAuthorizationError,
  CertificateBlockedError,
  CertificateRepositoryError,
  CertificateValidationError,
} from "./certificates.service";
import type { CompletionActionResult } from "@/types/certificate";

function revalidateCertificatePages() {
  revalidatePath("/admin/certificates", "layout");
  revalidatePath("/trainer/certificates", "layout");
  revalidatePath("/student/certificates", "layout");
}

type ActionExtras = Omit<CompletionActionResult, "ok" | "error">;

async function run(context: string, fn: () => Promise<ActionExtras | void>): Promise<CompletionActionResult> {
  try {
    const extras = await fn();
    revalidateCertificatePages();
    return { ok: true, ...(extras ?? {}) };
  } catch (err) {
    if (
      err instanceof CertificateValidationError ||
      err instanceof CertificateAuthorizationError ||
      err instanceof CertificateBlockedError ||
      err instanceof CertificateRepositoryError
    ) {
      // These carry messages written to be shown to users.
      return { ok: false, error: err.message };
    }
    console.error(`[certificates.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

// Requirements (Super Admin) --------------------------------------------

export async function setFinalAssessmentAction(batchId: string, testId: string): Promise<CompletionActionResult> {
  return run("setFinalAssessment", async () => {
    await certificatesService.setFinalAssessment(batchId, testId);
  });
}

export async function clearFinalAssessmentAction(batchId: string): Promise<CompletionActionResult> {
  return run("clearFinalAssessment", async () => {
    await certificatesService.clearFinalAssessment(batchId);
  });
}

export async function addRequiredAssignmentAction(batchId: string, assignmentId: string): Promise<CompletionActionResult> {
  return run("addRequiredAssignment", async () => {
    await certificatesService.addRequiredAssignment(batchId, assignmentId);
  });
}

export async function removeRequiredAssignmentAction(batchId: string, assignmentId: string): Promise<CompletionActionResult> {
  return run("removeRequiredAssignment", async () => {
    await certificatesService.removeRequiredAssignment(batchId, assignmentId);
  });
}

// Workflow --------------------------------------------------------------

export async function recommendCompletionAction(batchId: string, studentId: string, note?: string | null): Promise<CompletionActionResult> {
  return run("recommendCompletion", async () => {
    await certificatesService.recommendCompletion(batchId, studentId, note);
  });
}

export async function withdrawRecommendationAction(completionId: string): Promise<CompletionActionResult> {
  return run("withdrawRecommendation", async () => {
    await certificatesService.withdrawRecommendation(completionId);
  });
}

export async function approveCompletionAction(completionId: string, note?: string | null): Promise<CompletionActionResult> {
  return run("approveCompletion", async () => {
    await certificatesService.approveCompletion(completionId, note);
  });
}

export async function rejectCompletionAction(completionId: string, note: string): Promise<CompletionActionResult> {
  return run("rejectCompletion", async () => {
    await certificatesService.rejectCompletion(completionId, note);
  });
}

export async function issueCertificateAction(completionId: string): Promise<CompletionActionResult> {
  return run("issueCertificate", async () => ({ certificateNumber: await certificatesService.issueCertificate(completionId) }));
}

export async function revokeCertificateAction(certificateId: string, reason: string): Promise<CompletionActionResult> {
  return run("revokeCertificate", async () => {
    await certificatesService.revokeCertificate(certificateId, reason);
  });
}
