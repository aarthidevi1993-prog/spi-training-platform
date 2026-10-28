/**
 * Batch trainer assignment (Phase 7 P3.6) — pure rules shared by the
 * service, the server action and the Assign/Change trainer dialog.
 *
 * The database decides everything: admin_assign_batch_trainer() (0017,
 * unchanged) checks the caller (Super Admin), locks the batch, accepts
 * only upcoming/ongoing batches and available trainers, and audits the
 * change; 0021 refuses any direct client write of batches.trainer_id.
 * Nothing here can widen that. A trainer is never removed in this phase.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Batch statuses whose trainer may be assigned or changed (the database enforces the same). */
export const ASSIGNABLE_BATCH_STATUSES = ["upcoming", "ongoing"] as const;

export function isAssignableBatchStatus(status: unknown): boolean {
  return typeof status === "string" && (ASSIGNABLE_BATCH_STATUSES as readonly string[]).includes(status);
}

/**
 * An available trainer — the same rule as admin_assign_batch_trainer()
 * and the 0021 guard: active trainer record, profile role trainer,
 * active account.
 */
export function isTrainerAvailable(row: { status?: unknown; role?: unknown; accountStatus?: unknown } | null | undefined): boolean {
  return !!row && row.status === "active" && row.role === "trainer" && row.accountStatus === "active";
}

export type AssignTrainerInput = { ok: true; batchId: string; trainerId: string } | { ok: false; error: string };

/** Both ids are required UUIDs; removal (no trainer) is not offered in this phase. */
export function parseAssignTrainerInput(batchId: unknown, trainerId: unknown): AssignTrainerInput {
  if (!isUuid(batchId)) return { ok: false, error: "Choose a valid batch." };
  if (!isUuid(trainerId)) return { ok: false, error: "Choose a trainer." };
  return { ok: true, batchId, trainerId };
}

/** admin_assign_batch_trainer() refusals → what the Super Admin is told. */
export const ASSIGN_REASON_MESSAGE: Record<string, string> = {
  not_found: "This batch no longer exists. Reload the page.",
  batch_not_current: "Only upcoming or ongoing batches can have their trainer changed.",
  trainer_not_available: "This trainer isn't available — an active trainer with an active account is required.",
  unchanged: "This trainer is already assigned to the batch.",
};

export const ASSIGN_GENERIC_ERROR = "The trainer couldn't be assigned. Please try again.";
export const ASSIGN_PERMISSION_ERROR = "Only Super Admins can assign trainers to batches.";

export function assignRefusalMessage(reason: unknown): string {
  const known = typeof reason === "string" && Object.prototype.hasOwnProperty.call(ASSIGN_REASON_MESSAGE, reason);
  return (known && ASSIGN_REASON_MESSAGE[reason as string]) || ASSIGN_GENERIC_ERROR;
}

/** Success sentence: a first assignment or a change. */
export function assignSuccessMessage(previousTrainerId: string | null, trainerName?: string | null): string {
  const who = trainerName ? ` to ${trainerName}` : "";
  return previousTrainerId ? `Trainer changed${who}.` : `Trainer assigned${who}.`;
}

/** Plain, serializable result of the assignment server action (never raw errors). */
export type AssignTrainerActionResult = { ok: true; message: string } | { ok: false; error: string };

/** An option in the dialog: only available trainers are ever listed. */
export interface AvailableTrainerOption {
  id: string;
  name: string;
}
