"use server";

/**
 * Server Actions — the RPC boundary the Add Student / Add Trainer
 * dialogs call (Phase 7 P3.4). Each action delegates to
 * invitationsService, which resolves the caller from the authenticated
 * session (Super Admin only) and lets the database decide every rule.
 *
 * The ROLE is fixed here, per action — never taken from the browser:
 * inviteStudentAction always invites a student, inviteTrainerAction a
 * trainer, inviteSuperAdminAction a Super Admin (P3.12: name and email
 * only), and only the fields of that kind are copied from the input
 * (anything else the browser sends, including a role, is dropped).
 * Results are plain and safe: an InvitationSendOutcome with its message,
 * or a fixed error sentence. Raw database/Auth errors never leave the
 * server, and nothing personal is logged.
 */

import { revalidatePath } from "next/cache";
import { invitationsService, InvitationsAuthorizationError, InvitationsInputError } from "./invitations.service";
import {
  GENERIC_INVITATION_ERROR,
  REVOKE_REASON_MESSAGE,
  REVOKE_SUCCESS_MESSAGE,
  invitationOutcomeMessage,
  recoveryOutcomeMessage,
} from "@/lib/user-management/invitations";
import type {
  InvitationActionResult,
  InvitationSendOutcome,
  StudentInvitationInput,
  SuperAdminInvitationInput,
  TrainerInvitationInput,
  UserActionResult,
} from "@/types/user-management";

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Pages showing accounts or their status after any operation that may have changed an invitation. */
function revalidateUserPages() {
  revalidatePath("/admin/students");
  revalidatePath("/admin/trainers");
  revalidatePath("/admin/users");
}

async function run(context: string, fn: () => Promise<InvitationSendOutcome>): Promise<InvitationActionResult> {
  try {
    const outcome = await fn();
    // Anything past "refused before creation" / "not configured" touched the database.
    if (!(outcome.kind === "unavailable" || (outcome.kind === "refused" && outcome.stage === "create"))) revalidateUserPages();
    return { status: "outcome", outcome, message: invitationOutcomeMessage(outcome) };
  } catch (err) {
    // These carry messages written to be shown to users.
    if (err instanceof InvitationsAuthorizationError || err instanceof InvitationsInputError) return { status: "error", error: err.message };
    // Error name only: messages of unexpected errors could contain personal data.
    console.error(`[invitations.actions] ${context}:`, err instanceof Error ? err.name : "unknown error");
    return { status: "error", error: GENERIC_INVITATION_ERROR };
  }
}

/** Invite a student (role fixed to student). */
export async function inviteStudentAction(input: StudentInvitationInput): Promise<InvitationActionResult> {
  const s = asObject(input);
  return run("inviteStudent", () =>
    invitationsService.inviteUser({
      role: "student",
      email: s.email,
      fullName: s.fullName,
      phone: s.phone,
      organization: s.organization,
      designation: s.designation,
      batchId: s.batchId,
    })
  );
}

/** Invite a trainer (role fixed to trainer). */
export async function inviteTrainerAction(input: TrainerInvitationInput): Promise<InvitationActionResult> {
  const t = asObject(input);
  return run("inviteTrainer", () =>
    invitationsService.inviteUser({
      role: "trainer",
      email: t.email,
      fullName: t.fullName,
      phone: t.phone,
      organization: t.organization,
      designation: t.designation,
      specializations: t.specializations,
    })
  );
}

/**
 * Invite a Super Admin (P3.12). The role is fixed here ("admin" = super_admin); only the name and email are
 * copied from the input — never a role, batch or code. invitationsService admits only an active Super Admin and
 * create_user_invitation (0028) re-checks it in the database; delivery and acceptance are the existing ones.
 */
export async function inviteSuperAdminAction(input: SuperAdminInvitationInput): Promise<InvitationActionResult> {
  const a = asObject(input);
  return run("inviteSuperAdmin", () =>
    invitationsService.inviteUser({
      role: "admin",
      email: a.email,
      fullName: a.fullName,
    })
  );
}

/**
 * Resend a pending invitation — the one the dialog just created, or (P3.9) an invited account's
 * existing invitation from the Users panel. The database enforces cooldown, cap and expiry.
 */
export async function resendInvitationAction(invitationId: string): Promise<InvitationActionResult> {
  return run("resendInvitation", () => invitationsService.resendInvitation(invitationId));
}

/**
 * P5.2: send a sign-in link to the existing, never-activated account of a pending invitation that Auth refused to
 * re-send (address already registered). Only the invitation id is accepted from the browser; the database decides
 * eligibility, cooldown and cap and records the request; nothing is bound until the invitee signs in with the link.
 */
export async function recoverInvitationAction(invitationId: string): Promise<UserActionResult> {
  try {
    const outcome = await invitationsService.recoverInvitation(invitationId);
    if (outcome.kind !== "unavailable") revalidateUserPages();
    const message = recoveryOutcomeMessage(outcome);
    return outcome.kind === "sent" ? { ok: true, message } : { ok: false, error: message };
  } catch (err) {
    // These carry messages written to be shown to users.
    if (err instanceof InvitationsAuthorizationError || err instanceof InvitationsInputError) return { ok: false, error: err.message };
    console.error("[invitations.actions] recoverInvitation:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: GENERIC_INVITATION_ERROR };
  }
}

/**
 * P3.9: revoke a pending invitation (Super Admin; the database decides scope and state and audits it).
 * A state change only — no Auth user, profile or domain record is deleted. Only the id and an optional
 * reason are accepted from the browser.
 */
export async function revokeInvitationAction(invitationId: string, reason?: string | null): Promise<UserActionResult> {
  try {
    const outcome = await invitationsService.revokeInvitation(invitationId, reason ?? null);
    // A refusal for an expired/no-longer-pending invitation may itself have changed what the page shows.
    if (outcome.ok || outcome.reason === "expired" || outcome.reason === "not_pending") revalidateUserPages();
    return outcome.ok ? { ok: true, message: REVOKE_SUCCESS_MESSAGE } : { ok: false, error: REVOKE_REASON_MESSAGE[outcome.reason] };
  } catch (err) {
    // These carry messages written to be shown to users.
    if (err instanceof InvitationsAuthorizationError || err instanceof InvitationsInputError) return { ok: false, error: err.message };
    console.error("[invitations.actions] revokeInvitation:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: GENERIC_INVITATION_ERROR };
  }
}
