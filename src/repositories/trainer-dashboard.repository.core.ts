/**
 * Trainer dashboard repository (P4.2) — reads only, through the caller's
 * own Supabase session, so RLS stays the authoritative boundary (batches,
 * batch_students, classes, class_attendance, assignment_submissions,
 * tests and the security_invoker view test_best_results). Never the
 * service-role client, no writes, no database functions, no Super Admin
 * analytics.
 *
 * Every read is bounded: by the trainer's current batches (upcoming /
 * ongoing) or by the class ids of the dashboard's India-date window
 * (classes themselves come from the existing Classes service). Lists larger
 * than one PostgREST response are read page by page on a stable order.
 *
 * Factory with an injected client so it can be tested against a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type {
  AttendanceMarkRecord,
  BestResultRecord,
  EnrolmentRecord,
  PendingSubmissionRecord,
  TrainerBatchRecord,
  TrainerTestRecord,
} from "@/lib/dashboard/trainer-dashboard";

type Client = SupabaseClient<Database, "public">;

export class TrainerDashboardRepositoryError extends Error {
  constructor(message = "The dashboard data couldn't be loaded.") {
    super(message);
    this.name = "TrainerDashboardRepositoryError";
  }
}

/** Code and name only — never row data or a raw message. */
function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : error instanceof Error ? error.name : "unknown";
  console.error(`[trainer-dashboard] ${context}:`, detail);
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const PAGE_SIZE = 1000;
/** Keep `.in(...)` filters to a safe URL length. */
const IN_CHUNK = 100;
function chunk<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

const CURRENT_BATCH_STATUSES = ["upcoming", "ongoing"] as const;
/** Tests that exist for students (drafts are never shown on the dashboard). */
const VISIBLE_TEST_STATUSES = ["scheduled", "active", "closed"] as const;

const BATCH_SELECT = "id, batch_code, name, status, courses ( title )";
const ENROLMENT_SELECT = "batch_id, student_id, enrollment_status, students ( full_name, student_code )";
// tests has no foreign key to batches (batch_id is only part of the composite key to classes): batch and
// course come through the test's class, as in the Tests page's repository.
const TEST_SELECT = "id, title, test_type, status, available_from, available_until, batch_id, class_id, classes ( batches ( name ), courses ( title ) )";

export function createTrainerDashboardRepository(getClient: () => Promise<Client | null>) {
  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new TrainerDashboardRepositoryError();
    }
    if (!supabase) throw new TrainerDashboardRepositoryError();
    return supabase;
  }

  /** Every page of one query (stable order given by the caller), then the next `.in` chunk. */
  async function readAll<T>(
    context: string,
    keys: string[],
    page: (s: Client, keys: string[], from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>
  ): Promise<T[]> {
    if (keys.length === 0) return [];
    const supabase = await client(context);
    const rows: T[] = [];
    try {
      for (const ids of chunk(keys)) {
        for (let from = 0; ; from += PAGE_SIZE) {
          const { data, error } = await page(supabase, ids, from, from + PAGE_SIZE - 1);
          if (error) throw error;
          const batch = (data ?? []) as T[];
          rows.push(...batch);
          if (batch.length < PAGE_SIZE) break;
        }
      }
    } catch (err) {
      logDbError(context, err);
      throw new TrainerDashboardRepositoryError();
    }
    return rows;
  }

  return {
    /** The trainer's CURRENT batches (upcoming / ongoing) — the scope of everything else. */
    async listCurrentBatches(trainerId: string): Promise<TrainerBatchRecord[]> {
      const rows = await readAll<Record<string, unknown>>("listCurrentBatches", [trainerId], (s, ids, from, to) =>
        s
          .from("batches")
          .select(BATCH_SELECT)
          .in("trainer_id", ids)
          .in("status", [...CURRENT_BATCH_STATUSES])
          .order("start_date")
          .order("id")
          .range(from, to)
      );
      return rows.map((r) => ({
        id: r.id as string,
        batch_code: (r.batch_code as string | null) ?? "",
        name: r.name as string,
        status: r.status as TrainerBatchRecord["status"],
        course_title: one(r.courses as { title?: string } | null)?.title ?? "",
      }));
    },

    /** Enrolments of those batches (RLS: the batch's trainer sees enrolled / completed, never withdrawn). */
    async listEnrolments(batchIds: string[]): Promise<EnrolmentRecord[]> {
      const rows = await readAll<Record<string, unknown>>("listEnrolments", batchIds, (s, ids, from, to) =>
        s.from("batch_students").select(ENROLMENT_SELECT).in("batch_id", ids).order("batch_id").order("student_id").range(from, to)
      );
      return rows.map((r) => {
        const st = one(r.students as { full_name?: string; student_code?: string } | null);
        return {
          batch_id: r.batch_id as string,
          student_id: r.student_id as string,
          enrollment_status: r.enrollment_status as EnrolmentRecord["enrollment_status"],
          full_name: st?.full_name ?? null,
          student_code: st?.student_code ?? null,
        };
      });
    },

    /** Attendance marks of the given classes (the window's held classes of current batches). */
    listAttendance(classIds: string[]): Promise<AttendanceMarkRecord[]> {
      return readAll<AttendanceMarkRecord>("listAttendance", classIds, (s, ids, from, to) =>
        s.from("class_attendance").select("class_id, student_id, batch_id, status").in("class_id", ids).order("class_id").order("student_id").range(from, to)
      );
    },

    /** Submissions still waiting for review ("submitted") in the given batches, with their class. */
    async listPendingSubmissions(batchIds: string[]): Promise<PendingSubmissionRecord[]> {
      const rows = await readAll<Record<string, unknown>>("listPendingSubmissions", batchIds, (s, ids, from, to) =>
        s
          .from("assignment_submissions")
          .select("assignment_id, batch_id, student_id, class_assignments ( class_id )")
          .in("batch_id", ids)
          .eq("status", "submitted")
          .order("assignment_id")
          .order("student_id")
          .range(from, to)
      );
      return rows.map((r) => ({
        assignment_id: r.assignment_id as string,
        batch_id: r.batch_id as string,
        class_id: one(r.class_assignments as { class_id?: string } | null)?.class_id ?? null,
      }));
    },

    /** Non-draft tests of the given batches. */
    async listTests(batchIds: string[]): Promise<TrainerTestRecord[]> {
      const rows = await readAll<Record<string, unknown>>("listTests", batchIds, (s, ids, from, to) =>
        s.from("tests").select(TEST_SELECT).in("batch_id", ids).in("status", [...VISIBLE_TEST_STATUSES]).order("id").range(from, to)
      );
      return rows.map((r) => {
        const cls = one(r.classes as { batches?: unknown; courses?: unknown } | null);
        return {
          id: r.id as string,
          title: r.title as string,
          test_type: r.test_type as string,
          status: r.status as TrainerTestRecord["status"],
          available_from: (r.available_from as string | null) ?? null,
          available_until: (r.available_until as string | null) ?? null,
          batch_id: r.batch_id as string,
          class_id: r.class_id as string,
          batch_name: one(cls?.batches as { name?: string } | null | undefined)?.name ?? "",
          course_title: one(cls?.courses as { title?: string } | null | undefined)?.title ?? "",
        };
      });
    },

    /** Best finished attempt per test × student in the given batches (test_best_results, staff RLS). */
    async listBestResults(batchIds: string[]): Promise<BestResultRecord[]> {
      const rows = await readAll<Record<string, unknown>>("listBestResults", batchIds, (s, ids, from, to) =>
        s
          .from("test_best_results")
          .select("test_id, batch_id, student_id, percentage, passed, finalized_at")
          .in("batch_id", ids)
          .order("test_id")
          .order("student_id")
          .range(from, to)
      );
      return rows.map((r) => ({
        test_id: r.test_id as string,
        batch_id: r.batch_id as string,
        student_id: r.student_id as string,
        percentage: Number(r.percentage),
        passed: r.passed === true,
        finalized_at: String(r.finalized_at ?? ""),
      }));
    },
  };
}

export type TrainerDashboardRepository = ReturnType<typeof createTrainerDashboardRepository>;
