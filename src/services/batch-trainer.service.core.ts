/**
 * Batch trainer service (Phase 7 P3.6) — Super Admin only (checked here
 * from the authenticated session, and again by the database function).
 *
 *   assignTrainer          validate the two ids → admin_assign_batch_trainer()
 *                          → a fixed message for every outcome
 *   listAvailableTrainers  the trainers the dialog may offer
 *
 * The database is the authority (0017 function + 0021 guard); this layer
 * only refuses early and turns answers into safe sentences.
 */
import {
  ASSIGN_GENERIC_ERROR,
  ASSIGN_PERMISSION_ERROR,
  assignRefusalMessage,
  assignSuccessMessage,
  parseAssignTrainerInput,
  type AssignTrainerActionResult,
  type AvailableTrainerOption,
} from "@/lib/batches/assign-trainer";
import type { AuthUser } from "@/types/auth";
import {
  BatchTrainerPermissionError,
  type BatchTrainerRepository,
} from "@/repositories/batch-trainer.repository.core";

export class BatchTrainerAuthorizationError extends Error {
  constructor(message = ASSIGN_PERMISSION_ERROR) {
    super(message);
    this.name = "BatchTrainerAuthorizationError";
  }
}

export interface BatchTrainerServiceDeps {
  repository: Pick<BatchTrainerRepository, "assignTrainer" | "listAvailableTrainers">;
  getCurrentUser: () => Promise<AuthUser | null>;
}

export function createBatchTrainerService(deps: BatchTrainerServiceDeps) {
  async function requireSuperAdmin(): Promise<AuthUser> {
    const user = await deps.getCurrentUser();
    if (!user) throw new BatchTrainerAuthorizationError("You need to be signed in.");
    if (user.role !== "admin") throw new BatchTrainerAuthorizationError();
    return user;
  }

  return {
    async listAvailableTrainers(): Promise<AvailableTrainerOption[]> {
      await requireSuperAdmin();
      return deps.repository.listAvailableTrainers();
    },

    async assignTrainer(batchId: unknown, trainerId: unknown): Promise<AssignTrainerActionResult> {
      await requireSuperAdmin();
      const input = parseAssignTrainerInput(batchId, trainerId);
      if (!input.ok) return { ok: false, error: input.error };
      let result;
      try {
        result = await deps.repository.assignTrainer(input.batchId, input.trainerId);
      } catch (err) {
        if (err instanceof BatchTrainerPermissionError) return { ok: false, error: ASSIGN_PERMISSION_ERROR };
        return { ok: false, error: ASSIGN_GENERIC_ERROR };
      }
      if (!result.ok) return { ok: false, error: assignRefusalMessage(result.reason) };
      return { ok: true, message: assignSuccessMessage(result.previousTrainerId) };
    },
  };
}

export type BatchTrainerService = ReturnType<typeof createBatchTrainerService>;
