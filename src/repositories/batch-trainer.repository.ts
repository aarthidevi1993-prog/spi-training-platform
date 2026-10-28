import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createBatchTrainerRepository } from "./batch-trainer.repository.core";

/**
 * The batch trainer repository bound to the caller's own Supabase
 * session (cookies; the database function checks the caller). Never the
 * service-role client. Demo mode has no database: no client (fails closed).
 */
export const batchTrainerRepository = createBatchTrainerRepository(async () =>
  authConfig.mode === "supabase" ? createSupabaseServerClient() : null
);

export { BatchTrainerRepositoryError, BatchTrainerPermissionError } from "./batch-trainer.repository.core";
export type { BatchTrainerRepository } from "./batch-trainer.repository.core";
