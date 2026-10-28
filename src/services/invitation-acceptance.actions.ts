"use server";

/**
 * Server Actions for invitation acceptance (Phase 7 P3.5), called by
 * InvitationContinueForm and AcceptInvitationForm. Same-origin POSTs
 * only (Next.js checks the Origin of every Server Action). Results are
 * plain and safe; the browser navigates only to fixed paths. Unexpected
 * errors are logged by name only — never a token, password or message.
 */

import { invitationAcceptanceService } from "./invitation-acceptance.service";
import {
  SETUP_GENERIC_ERROR,
  type CompleteInvitationResult,
  type ConfirmInvitationResult,
} from "@/lib/auth/invite-acceptance";

/** Continue on /auth/confirm: verify the invite link and start the invitee's session. */
export async function confirmInvitationAction(tokenHash: string, type: string): Promise<ConfirmInvitationResult> {
  try {
    return await invitationAcceptanceService.confirmInvitation(tokenHash, type);
  } catch (err) {
    console.error("[invite-acceptance.actions] confirm:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, code: "invite_failed" };
  }
}

/** Set the password and accept the invitation; returns the fixed portal of the database role. */
export async function completeInvitationAction(password: string, confirmPassword: string): Promise<CompleteInvitationResult> {
  try {
    return await invitationAcceptanceService.completeInvitation(password, confirmPassword);
  } catch (err) {
    console.error("[invite-acceptance.actions] complete:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: SETUP_GENERIC_ERROR, ended: false };
  }
}
