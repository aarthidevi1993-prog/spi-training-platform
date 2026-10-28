/**
 * Enrolment repository (Phase 7 P3.8) — the caller's OWN session (never
 * the service role):
 *
 *   rpc admin_set_enrollment(batch, student, status, reason)   Super Admin
 *   rpc trainer_enroll_student(batch, student)                  trainer
 *     (0017, hardened by 0023: availability, scope, capacity, transitions,
 *     history and audit are all decided there)
 *   reads (RLS-scoped): batch header, roster, enrolment history, and the
 *     students that may be offered for a new enrolment
 *
 * No table is written here: batch_students and enrollment_events are only
 * ever changed by the database functions (0023 refuses direct client
 * writes anyway). Factory without `server-only` so it can be tested
 * against a local database; enrollment.repository.ts wires the real
 * server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import type { EnrollmentStatus } from "@/lib/enrollments/enrollment";

type Client = SupabaseClient<Database, "public">;

export class EnrollmentRepositoryError extends Error {
  constructor(message = "The enrolment data could not be processed.") {
    super(message);
    this.name = "EnrollmentRepositoryError";
  }
}

/** The database refused the caller (42501): not allowed, or (trainer) out of scope. */
export class EnrollmentPermissionError extends EnrollmentRepositoryError {
  constructor() {
    super();
    this.name = "EnrollmentPermissionError";
  }
}

export type EnrollmentRpcResult =
  | { ok: true; previous: EnrollmentStatus | null; status: EnrollmentStatus }
  | { ok: false; reason: string };

export interface BatchHeaderRecord {
  id: string;
  batch_code: string;
  name: string;
  status: string;
  start_date: string;
  end_date: string;
  max_seats: number;
  trainer_id: string | null;
  course: string;
  /** draft / published / archived (null when the course isn't readable). */
  course_status: string | null;
  trainer_name: string | null;
}

export interface RosterRecord {
  student_id: string;
  enrollment_status: EnrollmentStatus;
  enrolled_at: string;
  completed_at: string | null;
  student_code: string | null;
  full_name: string | null;
}

export interface HistoryRecord {
  id: number;
  occurred_at: string;
  student_id: string;
  previous_status: EnrollmentStatus | null;
  new_status: EnrollmentStatus;
  source: string;
  reason: string | null;
}

export interface StudentRecord {
  id: string;
  student_code: string;
  full_name: string;
  status: string;
  /** Profile fields — readable by a Super Admin only (null for others under RLS). */
  role: string | null;
  account_status: string | null;
}

/** For a trainer: students currently enrolled in one of the trainer's batches. */
export interface TrainerScopeRecord {
  student_id: string;
  batch_id: string;
  batch_status: string | null;
  batch_trainer_id: string | null;
  student_code: string | null;
  full_name: string | null;
  student_status: string | null;
}

/** Code and name only — never row data or a raw message. */
function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : error instanceof Error ? error.name : "unknown";
  console.error(`[enrollment] ${context}:`, detail);
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: unknown): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const ENROLLMENT_STATUS = new Set(["enrolled", "withdrawn", "completed"]);
const asStatus = (v: unknown): EnrollmentStatus | null => (typeof v === "string" && ENROLLMENT_STATUS.has(v) ? (v as EnrollmentStatus) : null);

export function createEnrollmentRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new EnrollmentRepositoryError();
    }
    if (!supabase) throw new EnrollmentRepositoryError();
    return supabase;
  }

  /** Runs one enrolment function; 42501 → permission error; any other error → generic error. */
  async function rpc(context: string, run: (s: Client) => PromiseLike<{ data: Json | null; error: unknown }>): Promise<EnrollmentRpcResult> {
    const supabase = await client(context);
    let result: { data: Json | null; error: unknown };
    try {
      result = await run(supabase);
    } catch (err) {
      logDbError(context, err);
      throw new EnrollmentRepositoryError();
    }
    if (result.error) {
      logDbError(context, result.error);
      if ((result.error as { code?: unknown }).code === "42501") throw new EnrollmentPermissionError();
      throw new EnrollmentRepositoryError();
    }
    const d = asObject(result.data);
    const status = asStatus(d?.status);
    if (d?.ok === true && status) return { ok: true, previous: asStatus(d.previous), status };
    if (d?.ok === false) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
    logDbError(context, "unexpected result");
    throw new EnrollmentRepositoryError();
  }

  /** Read helper: any error → generic repository error (never the raw message). */
  async function read<T>(context: string, run: (s: Client) => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
    const supabase = await client(context);
    try {
      const { data, error } = await run(supabase);
      if (error) throw error;
      return data;
    } catch (err) {
      logDbError(context, err);
      throw new EnrollmentRepositoryError();
    }
  }

  return {
    // ---------------------------------------------------------------- writes (database functions only)

    setEnrollment(batchId: string, studentId: string, status: EnrollmentStatus, reason: string | null): Promise<EnrollmentRpcResult> {
      return rpc("admin_set_enrollment", (s) =>
        s.rpc("admin_set_enrollment", { p_batch_id: batchId, p_student_id: studentId, p_status: status, p_reason: reason })
      );
    },

    trainerEnrol(batchId: string, studentId: string): Promise<EnrollmentRpcResult> {
      return rpc("trainer_enroll_student", (s) => s.rpc("trainer_enroll_student", { p_batch_id: batchId, p_student_id: studentId }));
    },

    // ---------------------------------------------------------------- reads (RLS-scoped)

    /** The batch, if the caller may see it (null otherwise). */
    async getBatchHeader(batchId: string): Promise<BatchHeaderRecord | null> {
      const row = await read("getBatchHeader", (s) =>
        s
          .from("batches")
          .select("id, batch_code, name, status, start_date, end_date, max_seats, trainer_id, courses ( title, status ), trainers ( full_name )")
          .eq("id", batchId)
          .maybeSingle()
      );
      if (!row) return null;
      const r = row as unknown as Omit<BatchHeaderRecord, "course" | "course_status" | "trainer_name"> & { courses: unknown; trainers: unknown };
      return {
        id: r.id,
        batch_code: r.batch_code,
        name: r.name,
        status: r.status,
        start_date: r.start_date,
        end_date: r.end_date,
        max_seats: r.max_seats,
        trainer_id: r.trainer_id,
        course: one(r.courses as { title?: string } | null)?.title ?? "",
        course_status: one(r.courses as { status?: string } | null)?.status ?? null,
        trainer_name: one(r.trainers as { full_name?: string } | null)?.full_name ?? null,
      };
    },

    /** Enrolments of the batch the caller may see (a trainer does not see withdrawn rows — RLS). */
    async listRoster(batchId: string): Promise<RosterRecord[]> {
      const rows = await read("listRoster", (s) =>
        s
          .from("batch_students")
          .select("student_id, enrollment_status, enrolled_at, completed_at, students ( student_code, full_name )")
          .eq("batch_id", batchId)
          .order("enrolled_at")
      );
      return ((rows ?? []) as unknown as (Omit<RosterRecord, "student_code" | "full_name"> & { students: unknown })[]).map((r) => {
        const st = one(r.students as { student_code?: string; full_name?: string } | null);
        return {
          student_id: r.student_id,
          enrollment_status: r.enrollment_status,
          enrolled_at: r.enrolled_at,
          completed_at: r.completed_at,
          student_code: st?.student_code ?? null,
          full_name: st?.full_name ?? null,
        };
      });
    },

    /** Latest enrolment history of the batch (Super Admin; trainer only for batches they currently teach — RLS). */
    async listHistory(batchId: string, limit = 50): Promise<HistoryRecord[]> {
      const rows = await read("listHistory", (s) =>
        s
          .from("enrollment_events")
          .select("id, occurred_at, student_id, previous_status, new_status, source, reason")
          .eq("batch_id", batchId)
          .order("id", { ascending: false })
          .limit(limit)
      );
      return (rows ?? []) as unknown as HistoryRecord[];
    },

    /** Every student record with its profile (Super Admin: all; profile fields are null for anyone else). */
    async listStudents(): Promise<StudentRecord[]> {
      const rows = await read("listStudents", (s) =>
        s.from("students").select("id, student_code, full_name, status, profiles ( role, account_status )").order("full_name")
      );
      return ((rows ?? []) as unknown as { id: string; student_code: string; full_name: string; status: string; profiles: unknown }[]).map((r) => {
        const p = one(r.profiles as { role?: string; account_status?: string } | null);
        return { id: r.id, student_code: r.student_code, full_name: r.full_name, status: r.status, role: p?.role ?? null, account_status: p?.account_status ?? null };
      });
    },

    /** For a trainer: current enrolments in batches assigned to them (RLS: their batches, non-withdrawn). */
    async listTrainerScope(trainerId: string): Promise<TrainerScopeRecord[]> {
      const rows = await read("listTrainerScope", (s) =>
        s
          .from("batch_students")
          .select("student_id, batch_id, batches ( status, trainer_id ), students ( student_code, full_name, status )")
          .eq("enrollment_status", "enrolled")
      );
      return ((rows ?? []) as unknown as { student_id: string; batch_id: string; batches: unknown; students: unknown }[])
        .map((r) => {
          const b = one(r.batches as { status?: string; trainer_id?: string | null } | null);
          const st = one(r.students as { student_code?: string; full_name?: string; status?: string } | null);
          return {
            student_id: r.student_id,
            batch_id: r.batch_id,
            batch_status: b?.status ?? null,
            batch_trainer_id: b?.trainer_id ?? null,
            student_code: st?.student_code ?? null,
            full_name: st?.full_name ?? null,
            student_status: st?.status ?? null,
          };
        })
        .filter((r) => r.batch_trainer_id === trainerId);
    },
  };
}

export type EnrollmentRepository = ReturnType<typeof createEnrollmentRepository>;
