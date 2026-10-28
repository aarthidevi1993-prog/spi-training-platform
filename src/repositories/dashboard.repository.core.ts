/**
 * Dashboard repository (Super Admin dashboard, D1) — reads only, through
 * the caller's own Supabase session (RLS decides what is visible). Never
 * the service-role client; no writes, no database functions.
 *
 * Totals are database counts (`count: "exact", head: true` — no rows are
 * transferred, so no response cap can truncate them). Lists are bounded
 * (`limit`), or read page by page on the primary key (current batches),
 * never whole tables in one response.
 *
 * Factory with an injected client so it can be tested without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readAllByKeyset } from "@/lib/supabase/paging";
import { BATCH_STATUS_ORDER, type BatchStatusCounts, type CompletionStatusEvent, type CurrentBatchRecord } from "@/lib/dashboard/admin-dashboard";

type Client = SupabaseClient<Database, "public">;

export class DashboardRepositoryError extends Error {
  constructor(message = "The dashboard data couldn't be loaded.") {
    super(message);
    this.name = "DashboardRepositoryError";
  }
}

/** dashboard_analytics refused the caller (42501). */
export class DashboardPermissionError extends Error {
  constructor(message = "Only Super Admins can view dashboard analytics.") {
    super(message);
    this.name = "DashboardPermissionError";
  }
}

/** dashboard_analytics rejected the period (22023), e.g. an end date after the database's India today. */
export class DashboardValidationError extends Error {
  constructor(message = "The dashboard period was not accepted.") {
    super(message);
    this.name = "DashboardValidationError";
  }
}

export interface ClassRecord {
  id: string;
  title: string;
  class_date: string;
  start_time: string;
  end_time: string;
  status: string;
  class_type: string;
  batch_name: string;
}

export interface TestRecord {
  id: string;
  title: string;
  test_type: string;
  status: string;
  available_from: string | null;
  available_until: string | null;
  batch_name: string;
}

/** Code and name only — never row data or a raw message. */
function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : error instanceof Error ? error.name : "unknown";
  console.error(`[dashboard] ${context}:`, detail);
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** Class statuses that still take place (everything except cancelled). */
const HELD_CLASS_STATUSES = ["scheduled", "live", "completed"] as const;
const CURRENT_BATCH_STATUSES = ["upcoming", "ongoing"] as const;
const PUBLISHED_TEST_STATUSES = ["scheduled", "active"] as const;

const CLASS_SELECT = "id, title, class_date, start_time, end_time, status, class_type, batches ( name )";
// tests has no foreign key to batches (batch_id is only part of the composite key to classes), so
// the batch comes through the test's class — as in the Tests page's repository.
const TEST_SELECT = "id, title, test_type, status, available_from, available_until, classes ( batches ( name ) )";
const CURRENT_BATCH_SELECT =
  "id, status, max_seats, start_date, trainer_id, course_id, courses ( title ), trainers ( status, profiles ( role, account_status ) ), batch_students ( student_id, enrollment_status )";
const COMPLETION_STATUS_EVENTS = ["recommended", "recommendation_withdrawn", "approved", "rejected"] as const;
/**
 * Status events read for one look-back window; more than this is refused rather than guessed. Kept below
 * the 1000-row response cap so `cap + 1` rows always fit in one response (the overflow check can't be truncated).
 */
export const COMPLETION_EVENT_CAP = 900;

function toClass(row: unknown): ClassRecord {
  const r = row as Omit<ClassRecord, "batch_name"> & { batches: unknown };
  return {
    id: r.id,
    title: r.title,
    class_date: r.class_date,
    start_time: r.start_time,
    end_time: r.end_time,
    status: r.status,
    class_type: r.class_type,
    batch_name: one(r.batches as { name?: string } | null)?.name ?? "",
  };
}

function toTest(row: unknown): TestRecord {
  const r = row as Omit<TestRecord, "batch_name"> & { classes: unknown };
  const cls = one(r.classes as { batches?: unknown } | null);
  return {
    id: r.id,
    title: r.title,
    test_type: r.test_type,
    status: r.status,
    available_from: r.available_from,
    available_until: r.available_until,
    batch_name: one(cls?.batches as { name?: string } | null | undefined)?.name ?? "",
  };
}

export function createDashboardRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new DashboardRepositoryError();
    }
    if (!supabase) throw new DashboardRepositoryError();
    return supabase;
  }

  /** A database count (no rows transferred). */
  async function count(context: string, run: (s: Client) => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
    const supabase = await client(context);
    try {
      const { count: n, error } = await run(supabase);
      if (error) throw error;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("no count");
      return n;
    } catch (err) {
      logDbError(context, err);
      throw new DashboardRepositoryError();
    }
  }

  async function read<T>(context: string, run: (s: Client) => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
    const supabase = await client(context);
    try {
      const { data, error } = await run(supabase);
      if (error) throw error;
      return data;
    } catch (err) {
      logDbError(context, err);
      throw new DashboardRepositoryError();
    }
  }

  return {
    /**
     * public.dashboard_analytics (0024) for India dates [from, to] — ONE call, through the caller's session
     * (SECURITY INVOKER: their RLS applies). Returns the raw JSON; the service validates it.
     */
    async getAnalytics(from: string, to: string, limit: number): Promise<unknown> {
      const supabase = await client("getAnalytics");
      let result: { data: unknown; error: unknown };
      try {
        result = await supabase.rpc("dashboard_analytics", { p_from: from, p_to: to, p_limit: limit });
      } catch (err) {
        logDbError("getAnalytics", err);
        throw new DashboardRepositoryError();
      }
      if (result.error) {
        logDbError("getAnalytics", result.error);
        const code = (result.error as { code?: unknown }).code;
        if (code === "42501") throw new DashboardPermissionError();
        if (code === "22023") throw new DashboardValidationError();
        throw new DashboardRepositoryError();
      }
      return result.data;
    },

    /** Accounts with this role whose account is active (the Users page's role + status filter). */
    countActiveAccounts(role: "student" | "trainer"): Promise<number> {
      return count(`countActiveAccounts(${role})`, (s) =>
        s.from("profiles").select("id", { count: "exact", head: true }).eq("role", role).eq("account_status", "active")
      );
    },

    /** Batches per status (four counts). */
    async countBatchesByStatus(): Promise<BatchStatusCounts> {
      const counts = await Promise.all(
        BATCH_STATUS_ORDER.map((status) =>
          count(`countBatches(${status})`, (s) => s.from("batches").select("id", { count: "exact", head: true }).eq("status", status))
        )
      );
      return Object.fromEntries(BATCH_STATUS_ORDER.map((status, i) => [status, counts[i]!])) as BatchStatusCounts;
    },

    /** Classes on this date that are not cancelled. */
    countClassesOn(date: string): Promise<number> {
      return count("countClassesOn", (s) =>
        s.from("classes").select("id", { count: "exact", head: true }).eq("class_date", date).in("status", [...HELD_CLASS_STATUSES])
      );
    },

    /** Completion recommendations waiting for a Super Admin decision. */
    countCompletionsAwaitingApproval(): Promise<number> {
      return count("countCompletionsAwaitingApproval", (s) =>
        s.from("completion_records").select("id", { count: "exact", head: true }).eq("status", "recommended")
      );
    },

    /**
     * Completion status events (recommended / withdrawn / approved / rejected) after an instant, oldest first —
     * only what the history rebuild needs (ids, status before/after). Bounded: a look-back window with more than
     * COMPLETION_EVENT_CAP events is refused (error) instead of being truncated.
     */
    async listCompletionStatusEventsAfter(instantIso: string): Promise<CompletionStatusEvent[]> {
      const rows = await read("listCompletionStatusEventsAfter", (s) =>
        s
          .from("completion_events")
          .select("id, completion_id, detail")
          .in("event_type", [...COMPLETION_STATUS_EVENTS])
          .gt("occurred_at", instantIso)
          .order("id")
          .limit(COMPLETION_EVENT_CAP + 1)
      );
      const list = (rows ?? []) as unknown as { id: number; completion_id: string | null; detail: unknown }[];
      if (list.length > COMPLETION_EVENT_CAP) {
        logDbError("listCompletionStatusEventsAfter", "too many events");
        throw new DashboardRepositoryError();
      }
      return list
        .filter((r) => typeof r.completion_id === "string")
        .map((r) => {
          const d = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {};
          return {
            id: Number(r.id),
            completionId: r.completion_id as string,
            status: typeof d.status === "string" ? d.status : null,
            previousStatus: typeof d.previous_status === "string" ? d.previous_status : null,
          };
        });
    },

    /** Upcoming and ongoing batches with trainer availability and seats in use, read page by page on the id. */
    async listCurrentBatches(): Promise<CurrentBatchRecord[]> {
      const supabase = await client("listCurrentBatches");
      try {
        const rows = await readAllByKeyset<{ id: string }>((afterId, limit) => {
          let q = supabase.from("batches").select(CURRENT_BATCH_SELECT).in("status", [...CURRENT_BATCH_STATUSES]);
          if (afterId) q = q.gt("id", afterId);
          return q.order("id").limit(limit) as unknown as PromiseLike<{ data: { id: string }[] | null; error: unknown }>;
        });
        return rows.map((row) => {
          const r = row as unknown as {
            id: string;
            status: string;
            max_seats: number;
            start_date: string;
            trainer_id: string | null;
            course_id: string;
            courses: unknown;
            trainers: unknown;
            batch_students: unknown;
          };
          const trainer = one(r.trainers as { status?: unknown; profiles?: unknown } | null);
          const profile = one(trainer?.profiles as { role?: unknown; account_status?: unknown } | null | undefined);
          const enrolments = Array.isArray(r.batch_students) ? (r.batch_students as { student_id: string; enrollment_status: string }[]) : [];
          return {
            id: r.id,
            status: r.status,
            maxSeats: r.max_seats,
            startDate: r.start_date,
            trainerId: r.trainer_id,
            courseId: r.course_id,
            course: one(r.courses as { title?: string } | null)?.title ?? "",
            trainerStatus: trainer?.status,
            trainerRole: profile?.role,
            trainerAccountStatus: profile?.account_status,
            seatsUsed: new Set(enrolments.filter((e) => e.enrollment_status !== "withdrawn").map((e) => e.student_id)).size,
          };
        });
      } catch (err) {
        logDbError("listCurrentBatches", err);
        throw new DashboardRepositoryError();
      }
    },

    /** Classes on this date that are not cancelled, by start time (at most `limit`). */
    async listClassesOn(date: string, limit: number): Promise<ClassRecord[]> {
      const rows = await read("listClassesOn", (s) =>
        s.from("classes").select(CLASS_SELECT).eq("class_date", date).in("status", [...HELD_CLASS_STATUSES]).order("start_time").limit(limit)
      );
      return ((rows ?? []) as unknown[]).map(toClass);
    },

    /** The next scheduled classes after this date, by date then start time (at most `limit`). */
    async listUpcomingClasses(afterDate: string, limit: number): Promise<ClassRecord[]> {
      const rows = await read("listUpcomingClasses", (s) =>
        s
          .from("classes")
          .select(CLASS_SELECT)
          .gt("class_date", afterDate)
          .eq("status", "scheduled")
          .order("class_date")
          .order("start_time")
          .limit(limit)
      );
      return ((rows ?? []) as unknown[]).map(toClass);
    },

    /** Published tests whose window has not ended yet, soonest first (at most `limit`). */
    async listUpcomingTests(nowIso: string, limit: number): Promise<TestRecord[]> {
      const rows = await read("listUpcomingTests", (s) =>
        s
          .from("tests")
          .select(TEST_SELECT)
          .in("status", [...PUBLISHED_TEST_STATUSES])
          .gt("available_until", nowIso)
          .order("available_from")
          .limit(limit)
      );
      return ((rows ?? []) as unknown[]).map(toTest);
    },
  };
}

export type DashboardRepository = ReturnType<typeof createDashboardRepository>;
