"use server";

/**
 * Server Actions for invitation recovery (P5.2), called by RecoveryContinueForm on /auth/recover and by the
 * safe page (/auth/recover/incomplete). Same-origin POSTs only (Next.js checks the Origin of every Server
 * Action). Only the token hash and type are accepted from the browser; results are plain and safe, and the
 * browser navigates only to fixed paths. Unexpected errors are logged by name only — never a token, address or
 * message.
 */

import { invitationRecoveryService } from "./invitation-recovery.service";
import type { ConfirmRecoveryResult } from "@/lib/auth/invitation-recovery";
import type { EndSessionResult } from "@/repositories/invitation-acceptance.repository.core";

export async function confirmRecoveryAction(tokenHash: string, type: string): Promise<ConfirmRecoveryResult> {
  try {
    return await invitationRecoveryService.confirmRecovery(tokenHash, type);
  } catch (err) {
    console.error("[invitation-recovery.actions] confirm:", err instanceof Error ? err.name : "unknown error");
    // Something unexpected after the link may have been verified: a session may exist. Never /login (it would
    // send a signed-in account to its portal) — the safe page, which can end the session.
    return { ok: false, code: "signout_unconfirmed" };
  }
}

/** The safe page's "close the session on this device" button. */
export async function endRecoverySessionAction(): Promise<EndSessionResult> {
  try {
    return await invitationRecoveryService.endRecoverySession();
  } catch (err) {
    console.error("[invitation-recovery.actions] end session:", err instanceof Error ? err.name : "unknown error");
    return "unconfirmed";
  }
}
