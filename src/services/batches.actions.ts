"use server";

/**
 * Server Actions — the RPC boundary the Add Batch form and the
 * Assign/Change trainer dialog call. Each action
 * delegates to batchesService (which resolves the caller's identity and
 * authorization server-side) and returns a plain, serializable result.
 * Actions never redirect; the calling component decides how to navigate.
 */

import { revalidatePath } from "next/cache";
import {
  batchesService,
  BatchCreateAuthorizationError,
  BatchCreateValidationError,
  BatchRepositoryError,
} from "./batches.service";
import { batchTrainerService, BatchTrainerAuthorizationError } from "./batch-trainer.service";
import { ASSIGN_GENERIC_ERROR, type AssignTrainerActionResult } from "@/lib/batches/assign-trainer";
import type { BatchValidationErrors, CreateBatchInput } from "@/types/batch";

export interface BatchActionResult {
  ok: boolean;
  batchId?: string;
  errors?: BatchValidationErrors;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

export async function createBatchAction(input: CreateBatchInput): Promise<BatchActionResult> {
  try {
    const created = await batchesService.createBatch(input);
    revalidatePath("/admin/batches");
    revalidatePath("/trainer/batches");
    return { ok: true, batchId: created.id };
  } catch (err) {
    if (err instanceof BatchCreateValidationError) return { ok: false, errors: err.errors };
    if (err instanceof BatchCreateAuthorizationError || err instanceof BatchRepositoryError) {
      // Both carry messages written to be shown to users.
      return { ok: false, errors: { form: err.message } };
    }
    console.error("[batches.actions] createBatch:", err instanceof Error ? err.message : err);
    return { ok: false, errors: { form: GENERIC_ERROR } };
  }
}

/**
 * Assign or change the trainer of a batch (Super Admin only; the 0017
 * database function decides). Only the two ids are taken from the
 * browser; removal is not offered.
 */
export async function assignBatchTrainerAction(batchId: string, trainerId: string): Promise<AssignTrainerActionResult> {
  try {
    const result = await batchTrainerService.assignTrainer(batchId, trainerId);
    if (result.ok) {
      revalidatePath("/admin/batches");
      revalidatePath("/trainer/batches");
    }
    return result;
  } catch (err) {
    if (err instanceof BatchTrainerAuthorizationError) return { ok: false, error: err.message };
    console.error("[batches.actions] assignBatchTrainer:", err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: ASSIGN_GENERIC_ERROR };
  }
}
