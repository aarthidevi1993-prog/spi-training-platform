import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { batchTableRows, getBatchesForTrainer } from "@/lib/mock/batches-table.mock";
import { isTrainerAvailable } from "@/lib/batches/assign-trainer";
import type { BatchSummary, CreateBatchInput } from "@/types/batch";

/**
 * Batches repository — the only module that knows where batch data
 * lives. Two isolated implementations behind one interface, matching
 * the Courses / Trainers / Students repositories:
 *
 *   - Demo mode  (authConfig.mode === "demo"): the existing demo rows.
 *   - Supabase mode: public.batches + courses + trainers +
 *     batch_students (0003_core_training_model.sql), read with the
 *     caller's session.
 *
 * Reads, plus creating a batch (Super Admin, via RLS). View/Edit are a
 * separate future task — batch edits are admin-only and reassigning a
 * trainer moves the batch's scheduled/live classes. Services call this;
 * UI components never do. RLS is the authoritative boundary; the scope
 * below is the second layer.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export const BATCH_TRAINER_NOT_ASSIGNED = "Trainer not assigned";

export class BatchRepositoryError extends Error {
  /** Postgres error code, when the database raised one. */
  readonly code: string;
  /** Postgres hint, when the database set a machine-readable one (0021: "trainer_not_available"). */
  readonly hint: string;
  constructor(message: string = GENERIC_DB_ERROR, code = "", hint = "") {
    super(message);
    this.name = "BatchRepositoryError";
    this.code = code;
    this.hint = hint;
  }
}

function logDbError(context: string, error: unknown) {
  console.error(`[batches] ${context}:`, error instanceof Error ? error.message : error);
}

/** Which batches the caller's page lists. */
export type BatchScope = { kind: "all" } | { kind: "trainer"; trainerId: string } | { kind: "none" };

/** Demo mapping: the demo trainer, as used by Classes and Courses. */
const DEMO_TRAINER_NAME = "Rajesh Kumar";

/**
 * One round trip: each batch with its course title, assigned trainer's
 * name and enrolments. Trainers only receive their own batches'
 * non-withdrawn enrolments under RLS; the count below excludes
 * withdrawn rows for admins too.
 */
const BATCH_LIST_SELECT = `
  id, name, status, start_date, end_date, max_seats, trainer_id,
  courses ( title, status ),
  trainers ( full_name, status, profiles ( role, account_status ) ),
  batch_students ( student_id, enrollment_status )
`;

export const batchesRepository = {
  async findAll(scope: BatchScope): Promise<BatchSummary[]> {
    if (authConfig.mode === "demo") {
      if (scope.kind === "all") return batchTableRows;
      if (scope.kind === "trainer") return getBatchesForTrainer(DEMO_TRAINER_NAME);
      return [];
    }

    if (scope.kind === "none") return [];

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new BatchRepositoryError();

    try {
      let query = supabase.from("batches").select(BATCH_LIST_SELECT);

      // Trainers: only batches currently assigned to them (not batches
      // where they merely taught a class before a reassignment).
      if (scope.kind === "trainer") query = query.eq("trainer_id", scope.trainerId);

      const { data, error } = await query.order("start_date", { ascending: false }).order("name");
      if (error) throw error;

      return (data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        course: row.courses?.title ?? "",
        courseStatus: row.courses?.status,
        trainer: row.trainers?.full_name ?? BATCH_TRAINER_NOT_ASSIGNED,
        trainerId: row.trainer_id,
        // The Super Admin reads every trainer and profile; a trainer reads only their own.
        trainerUnavailable:
          row.trainer_id !== null &&
          !isTrainerAvailable({
            status: row.trainers?.status,
            role: row.trainers?.profiles?.role,
            accountStatus: row.trainers?.profiles?.account_status,
          }),
        // Seats in use: distinct students whose enrolment isn't
        // withdrawn (enrolled + completed) — the same rule as the
        // database's max_seats capacity trigger.
        students: new Set(
          row.batch_students.filter((bs) => bs.enrollment_status !== "withdrawn").map((bs) => bs.student_id)
        ).size,
        maxSeats: row.max_seats,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
      }));
    } catch (err) {
      logDbError("findAll failed", err);
      throw new BatchRepositoryError();
    }
  },

  /**
   * Insert a new batch with the caller's own session (RLS: Super Admin
   * only). Always status "upcoming". Returns the new id. The Postgres
   * error code is kept (e.g. 23505 for a duplicate batch code) so the
   * service can explain it; raw messages never leave the server.
   */
  async create(input: CreateBatchInput, createdBy: string): Promise<string> {
    if (authConfig.mode === "demo") {
      throw new BatchRepositoryError("Creating batches requires Supabase mode.");
    }
    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new BatchRepositoryError();

    let result: { data: { id: string } | null; error: { code?: string; message?: string; hint?: string | null } | null };
    try {
      result = await supabase
        .from("batches")
        .insert({
          batch_code: input.batchCode,
          name: input.name,
          course_id: input.courseId,
          trainer_id: input.trainerId,
          start_date: input.startDate,
          end_date: input.endDate,
          max_seats: input.maxSeats,
          status: "upcoming",
          created_by: createdBy,
        })
        .select("id")
        .single();
    } catch (err) {
      logDbError("create failed", err);
      throw new BatchRepositoryError("We couldn't create the batch. Please try again.");
    }
    if (result.error || !result.data) {
      logDbError("create failed", result.error ? `${result.error.code ?? ""} ${result.error.message ?? ""}` : "no row returned");
      throw new BatchRepositoryError("We couldn't create the batch. Please try again.", result.error?.code ?? "", result.error?.hint ?? "");
    }
    return result.data.id;
  },
};
