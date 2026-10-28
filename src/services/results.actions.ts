"use server";

/**
 * Server Actions for staff results. The only action is the finalize
 * sweep, which runs the database's staff_finalize_due_attempts with the
 * caller's own session — the database decides which attempts are due
 * and grades them. No score, pass/fail or status is ever accepted from
 * the browser.
 */

import { revalidatePath } from "next/cache";
import { resultsService, ResultsAuthorizationError, ResultsRepositoryError } from "./results.service";

export interface FinalizeAttemptsResult {
  ok: boolean;
  error?: string;
  /** How many attempts the database finalized. */
  finalized?: number;
}

export async function finalizeOverdueAttemptsAction(testId: string): Promise<FinalizeAttemptsResult> {
  try {
    const finalized = await resultsService.finalizeOverdueAttempts(testId);
    revalidatePath("/admin/tests", "layout");
    revalidatePath("/trainer/tests", "layout");
    revalidatePath("/admin/performance");
    revalidatePath("/trainer/performance");
    return { ok: true, finalized };
  } catch (err) {
    if (err instanceof ResultsAuthorizationError || err instanceof ResultsRepositoryError) {
      return { ok: false, error: err.message };
    }
    console.error("[results.actions] finalizeOverdueAttempts:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
