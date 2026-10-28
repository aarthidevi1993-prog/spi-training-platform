/**
 * Students write repository (Phase 7 P3.10-B) — the caller's OWN session
 * (never the service role):
 *
 *   readStudentName(id)            public.students.full_name under RLS (a trainer
 *                                  reads only students of batches they are assigned)
 *   trainerUpdateStudent(id, p)    trainer_update_student (0017): active trainer,
 *                                  scope (enrolled in a batch they currently teach),
 *                                  allowed keys, audit row — all decided by the database
 *
 * Nothing here writes a table directly or decides any rule. Factory without
 * `server-only` so it can be tested against a local database;
 * students.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import type { TrainerStudentPatch } from "@/lib/students/trainer-edit";

type Client = SupabaseClient<Database, "public">;

export class StudentsWriteRepositoryError extends Error {
  constructor(message = "The student could not be updated.") {
    super(message);
    this.name = "StudentsWriteRepositoryError";
  }
}

/** The database function raised an error; only its SQLSTATE is kept. */
export class StudentsFunctionError extends StudentsWriteRepositoryError {
  constructor(public readonly code: string | null) {
    super();
    this.name = "StudentsFunctionError";
  }
}

export type TrainerUpdateResult = { ok: true; fields: string[] } | { ok: false; reason: string | null };

function logDbError(context: string, error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  // Code and context only: messages could echo submitted values.
  console.error(`[students] ${context}:`, code || (error instanceof Error ? error.name : "error"));
}

export function createStudentsWriteRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new StudentsWriteRepositoryError();
    }
    if (!supabase) throw new StudentsWriteRepositoryError();
    return supabase;
  }

  return {
    /** The student's current name, or null when the session may not read it (RLS) or it does not exist. */
    async readStudentName(studentId: string): Promise<string | null> {
      const supabase = await client("readStudentName");
      const { data, error } = await supabase.from("students").select("full_name").eq("id", studentId).maybeSingle();
      if (error) {
        logDbError("readStudentName", error);
        throw new StudentsWriteRepositoryError();
      }
      return (data as { full_name: string } | null)?.full_name ?? null;
    },

    /** trainer_update_student on the caller's session; raised errors keep only their SQLSTATE. */
    async trainerUpdateStudent(studentId: string, patch: TrainerStudentPatch): Promise<TrainerUpdateResult> {
      const supabase = await client("trainerUpdateStudent");
      let result: { data: Json | null; error: unknown };
      try {
        result = await supabase.rpc("trainer_update_student", { p_student_id: studentId, p: patch as Json });
      } catch (err) {
        logDbError("trainerUpdateStudent", err);
        throw new StudentsWriteRepositoryError();
      }
      if (result.error) {
        logDbError("trainerUpdateStudent", result.error);
        const code = (result.error as { code?: unknown }).code;
        throw new StudentsFunctionError(typeof code === "string" ? code : null);
      }
      const d = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? (result.data as Record<string, Json | undefined>) : null;
      if (!d || typeof d.ok !== "boolean") {
        logDbError("trainerUpdateStudent", "unexpected function result");
        throw new StudentsWriteRepositoryError();
      }
      if (d.ok) return { ok: true, fields: Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === "string") : [] };
      return { ok: false, reason: typeof d.reason === "string" ? d.reason : null };
    },
  };
}

export type StudentsWriteRepository = ReturnType<typeof createStudentsWriteRepository>;
