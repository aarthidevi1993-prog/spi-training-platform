/**
 * Batch trainer repository (Phase 7 P3.6) — the Super Admin's OWN
 * session (never the service role):
 *
 *   rpc admin_assign_batch_trainer(batch, trainer)   0017, unchanged:
 *     caller check, batch row lock, upcoming/ongoing only, available
 *     trainer only, audit, classes follow the batch
 *   trainers + profiles                               the available
 *     trainers (read under the Super Admin's RLS)
 *
 * Nothing here writes a table directly (0021 refuses that anyway) or
 * decides a rule. Factory without `server-only` so it can be tested
 * against a local database; batch-trainer.repository.ts wires the real
 * server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { isTrainerAvailable, type AvailableTrainerOption } from "@/lib/batches/assign-trainer";

type Client = SupabaseClient<Database, "public">;

export class BatchTrainerRepositoryError extends Error {
  constructor(message = "The trainer assignment could not be processed.") {
    super(message);
    this.name = "BatchTrainerRepositoryError";
  }
}

/** The database refused the caller (42501): not a Super Admin. */
export class BatchTrainerPermissionError extends BatchTrainerRepositoryError {
  constructor() {
    super();
    this.name = "BatchTrainerPermissionError";
  }
}

export type AssignTrainerResult = { ok: true; previousTrainerId: string | null; trainerId: string } | { ok: false; reason: string };

/** Code and a short message only (never row data). */
function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : error instanceof Error ? error.name : "unknown";
  console.error(`[batch-trainer] ${context}:`, detail);
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: unknown): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function createBatchTrainerRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new BatchTrainerRepositoryError();
    }
    if (!supabase) throw new BatchTrainerRepositoryError();
    return supabase;
  }

  return {
    async assignTrainer(batchId: string, trainerId: string): Promise<AssignTrainerResult> {
      const supabase = await client("assignTrainer");
      let result: { data: Json | null; error: unknown };
      try {
        result = await supabase.rpc("admin_assign_batch_trainer", { p_batch_id: batchId, p_trainer_id: trainerId });
      } catch (err) {
        logDbError("assignTrainer", err);
        throw new BatchTrainerRepositoryError();
      }
      if (result.error) {
        logDbError("assignTrainer", result.error);
        if ((result.error as { code?: unknown }).code === "42501") throw new BatchTrainerPermissionError();
        throw new BatchTrainerRepositoryError();
      }
      const d = asObject(result.data);
      if (d?.ok === true && typeof d.trainer_id === "string") {
        return { ok: true, previousTrainerId: typeof d.previous === "string" ? d.previous : null, trainerId: d.trainer_id };
      }
      if (d?.ok === false) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
      logDbError("assignTrainer", "unexpected result");
      throw new BatchTrainerRepositoryError();
    },

    /** Trainers that may be assigned (active record, trainer role, active account), by name. */
    async listAvailableTrainers(): Promise<AvailableTrainerOption[]> {
      const supabase = await client("listAvailableTrainers");
      try {
        const { data, error } = await supabase
          .from("trainers")
          .select("id, full_name, status, profiles ( role, account_status )")
          .order("full_name");
        if (error) throw error;
        return ((data ?? []) as unknown as { id: string; full_name: string; status: string; profiles: unknown }[])
          .filter((t) => {
            const p = one(t.profiles as { role?: unknown; account_status?: unknown } | null);
            return isTrainerAvailable({ status: t.status, role: p?.role, accountStatus: p?.account_status });
          })
          .map((t) => ({ id: t.id, name: t.full_name }));
      } catch (err) {
        logDbError("listAvailableTrainers", err);
        throw new BatchTrainerRepositoryError();
      }
    },
  };
}

export type BatchTrainerRepository = ReturnType<typeof createBatchTrainerRepository>;
