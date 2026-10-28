/**
 * Course Management repository (0030) — the Super Admin's OWN session
 * (never the service role). Every write is one database function call:
 *
 *   admin_create_course / admin_update_course / admin_set_course_status /
 *   admin_delete_course, admin_create_module / admin_update_module /
 *   admin_move_module / admin_delete_module, admin_course_usage
 *
 * which check the caller, validate, apply the history lock and audit.
 * Direct writes to courses / modules are refused by the 0030 guards, and
 * course / module codes are assigned by the database. course_events is
 * read under the Super Admin's RLS. Nothing here decides a rule.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; course-management.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import type { CourseBatchSummary, CourseUsage } from "@/types/course";

type Client = SupabaseClient<Database, "public">;

export class CourseManagementRepositoryError extends Error {
  constructor(message = "The course change could not be processed.") {
    super(message);
    this.name = "CourseManagementRepositoryError";
  }
}

/** The database refused the caller (42501): not a Super Admin, or a direct write. */
export class CourseManagementPermissionError extends CourseManagementRepositoryError {
  constructor() {
    super();
    this.name = "CourseManagementPermissionError";
  }
}

/**
 * The Course Management database functions don't exist: migration 0030_course_management.sql
 * hasn't been applied to this database (PostgREST PGRST202 "function not found in the schema
 * cache", or Postgres 42883 "function does not exist").
 */
export class CourseManagementUnavailableError extends CourseManagementRepositoryError {
  constructor() {
    super("Course management needs database migration 0030_course_management.sql, which isn't applied to this database.");
    this.name = "CourseManagementUnavailableError";
  }
}

/** The database refused the input (22023) — the service validates first, so this is a backstop. */
export class CourseManagementInvalidInputError extends CourseManagementRepositoryError {
  constructor() {
    super();
    this.name = "CourseManagementInvalidInputError";
  }
}

/** A function's answer: {ok: true, …data} or {ok: false, reason, …data}. */
export type CourseFunctionResult = { ok: true; data: JsonObject } | { ok: false; reason: string; data: JsonObject };

export interface CourseEventRecord {
  id: number;
  occurred_at: string;
  event_type: string;
  actor_id: string | null;
  detail: Json;
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: unknown): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** Code and a short message only (never row data). */
function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : error instanceof Error ? error.name : "unknown";
  console.error(`[course-management] ${context}:`, detail);
}

export const COURSE_HISTORY_LIMIT = 50;

export function createCourseManagementRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new CourseManagementRepositoryError();
    }
    if (!supabase) throw new CourseManagementRepositoryError();
    return supabase;
  }

  type Fn = keyof Database["public"]["Functions"];
  async function call(fn: Fn, args: Record<string, unknown>): Promise<CourseFunctionResult> {
    const supabase = await client(fn);
    let result: { data: Json | null; error: unknown };
    try {
      // Called as a method (rpc needs its client as `this`); the typed per-function args are built by the callers below.
      result = (await supabase.rpc(fn, args as never)) as { data: Json | null; error: unknown };
    } catch (err) {
      logDbError(fn, err);
      throw new CourseManagementRepositoryError();
    }
    if (result.error) {
      logDbError(fn, result.error);
      const code = (result.error as { code?: unknown }).code;
      if (code === "42501") throw new CourseManagementPermissionError();
      if (code === "PGRST202" || code === "42883") {
        console.error(`[course-management] ${fn}: database function missing — migration 0030_course_management.sql is not applied`);
        throw new CourseManagementUnavailableError();
      }
      if (code === "22023") throw new CourseManagementInvalidInputError();
      throw new CourseManagementRepositoryError();
    }
    const d = asObject(result.data);
    if (d?.ok === true) return { ok: true, data: d };
    if (d?.ok === false) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown", data: d };
    logDbError(fn, "unexpected result");
    throw new CourseManagementRepositoryError();
  }

  return {
    createCourse: (p: { title: string; description: string; level: string; duration_hours: number; status: string }) =>
      call("admin_create_course", { p }),
    /** Only the fields present are changed (the form sends just what was edited). */
    updateCourse: (courseId: string, p: { title?: string; description?: string; level?: string; duration_hours?: number }) =>
      call("admin_update_course", { p_course_id: courseId, p }),
    setCourseStatus: (courseId: string, status: string) => call("admin_set_course_status", { p_course_id: courseId, p_status: status }),
    deleteCourse: (courseId: string) => call("admin_delete_course", { p_course_id: courseId }),
    createModule: (courseId: string, p: { title: string; description: string; duration_hours: number }) =>
      call("admin_create_module", { p_course_id: courseId, p }),
    updateModule: (moduleId: string, p: { title: string; description: string; duration_hours?: number }) =>
      call("admin_update_module", { p_module_id: moduleId, p }),
    moveModule: (moduleId: string, direction: "up" | "down") => call("admin_move_module", { p_module_id: moduleId, p_direction: direction }),
    deleteModule: (moduleId: string) => call("admin_delete_module", { p_module_id: moduleId }),

    /** Usage, history lock and batches of one course; null when it doesn't exist. */
    async getUsage(courseId: string): Promise<CourseUsage | null> {
      const r = await call("admin_course_usage", { p_course_id: courseId });
      if (!r.ok) return null;
      const d = r.data;
      const batches: CourseBatchSummary[] = (Array.isArray(d.batches) ? d.batches : []).map((b) => {
        const o = asObject(b) ?? {};
        return {
          id: s(o.id),
          batchCode: s(o.batch_code),
          name: s(o.name),
          status: s(o.status),
          startDate: s(o.start_date),
          endDate: s(o.end_date),
          trainerName: typeof o.trainer_name === "string" ? o.trainer_name : null,
        };
      });
      return {
        hasHistory: d.has_history === true,
        canDelete: d.can_delete === true,
        batchCount: n(d.batch_count),
        upcomingBatchCount: n(d.upcoming_batch_count),
        ongoingBatchCount: n(d.ongoing_batch_count),
        pendingUpcomingInvitationCount: n(d.pending_upcoming_invitation_count),
        classCount: n(d.class_count),
        questionCount: n(d.question_count),
        batches,
      };
    },

    /** The course's most recent audit rows, newest first (Super Admin RLS). */
    async listEvents(courseId: string): Promise<CourseEventRecord[]> {
      const supabase = await client("listEvents");
      try {
        const { data, error } = await supabase
          .from("course_events")
          .select("id, occurred_at, event_type, actor_id, detail")
          .eq("course_id", courseId)
          .order("id", { ascending: false })
          .limit(COURSE_HISTORY_LIMIT);
        if (error) throw error;
        return (data ?? []) as CourseEventRecord[];
      } catch (err) {
        logDbError("listEvents", err);
        throw new CourseManagementRepositoryError();
      }
    },
  };
}

export type CourseManagementRepository = ReturnType<typeof createCourseManagementRepository>;
