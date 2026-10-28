import "server-only";
import { authService } from "./auth.service";
import { batchTrainerRepository } from "@/repositories/batch-trainer.repository";
import { createBatchTrainerService } from "./batch-trainer.service.core";

/** The batch trainer service bound to the real session and the caller's own Supabase client. */
export const batchTrainerService = createBatchTrainerService({
  repository: batchTrainerRepository,
  getCurrentUser: () => authService.getCurrentUser(),
});

export { BatchTrainerAuthorizationError } from "./batch-trainer.service.core";
