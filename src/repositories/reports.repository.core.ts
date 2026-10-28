/**
 * Reports repository (read-only): the records the four reports are built
 * from — batches (with their course), enrolments, classes, attendance,
 * best test results, tests, assignments and submissions.
 *
 * Always the caller's own session (never the service role): RLS decides
 * every row read — Super Admin all; a trainer per 0005/0006/0009 (the
 * service narrows further to their CURRENT batches, as Performance does).
 * Nothing here writes, and nothing reads auth.users, addresses or tokens.
 *
 * Reads are chunked by id (at most CHUNK ids per request) and paged with
 * range() (PostgREST caps each response), so large batches never truncate.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; reports.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type {
  ReportAssignmentRecord,
  ReportAttendanceRecord,
  ReportBatchRecord,
  ReportBestResultRecord,
  ReportClassRecord,
  ReportEnrolmentRecord,
  ReportSubmissionRecord,
  ReportTestRecord,
} from "@/lib/reports/reports";

type Client = SupabaseClient<Database, "public">;

const GENERIC_DB_ERROR = "We couldn't load the report. Please try again.";
const CHUNK = 100;
const PAGE = 1000;

export class ReportsRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "ReportsRepositoryError";
  }
}

/** The exact columns each report reads — nothing else is selected. */
export const REPORT_SELECT = {
  batches: "id, batch_code, name, status, course_id, courses ( course_code, title )",
  enrolments: "batch_id, student_id, enrollment_status, students ( full_name, student_code )",
  classes: "id, batch_id, class_date",
  attendance: "class_id, student_id, batch_id, status",
  bestResults: "test_id, batch_id, student_id, score, max_score, percentage, passed, finalized_at",
  tests: "id, batch_id, title, status, available_from, available_until, classes ( class_date )",
  assignments: "id, batch_id, title, due_at, max_score, status",
  submissions: "assignment_id, student_id, batch_id, status, submitted_at, score",
} as const;

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[reports] ${context}:`, detail);
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** Every page of one query (stable order required): stops on a short page. */
async function allPages<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

export function createReportsRepository(getClient: () => Promise<Client | null>) {
  async function run<T>(context: string, fn: (supabase: Client) => Promise<T>): Promise<T> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new ReportsRepositoryError();
    }
    if (!supabase) throw new ReportsRepositoryError();
    try {
      return await fn(supabase);
    } catch (err) {
      logDbError(context, err);
      throw new ReportsRepositoryError();
    }
  }

  /** Rows of `table` whose `column` is in `ids` (chunked + paged), optionally for one student. */
  function byIds<T>(context: string, table: string, select: string, column: string, ids: string[], order: string[], studentId: string | null = null): Promise<T[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return run(context, async (supabase) => {
      const out: T[] = [];
      for (const part of chunks(ids)) {
        out.push(
          ...(await allPages<T>((from, to) => {
            // Dynamic table name: the typed client can't follow it, so the builder is typed loosely here.
            let q: any = (supabase as any).from(table).select(select).in(column, part);
            if (studentId) q = q.eq("student_id", studentId);
            for (const col of order) q = q.order(col);
            return q.range(from, to) as Page<T>;
          }))
        );
      }
      return out;
    });
  }

  return {
    /** Batches the caller may report on: all (Super Admin) or the trainer's CURRENT batches, as Performance. */
    listScopeBatches(scope: { kind: "all" } | { kind: "trainer"; trainerId: string }): Promise<ReportBatchRecord[]> {
      return run("listScopeBatches", async (supabase) =>
        allPages<ReportBatchRecord>((from, to) => {
          let q = supabase.from("batches").select(REPORT_SELECT.batches);
          if (scope.kind === "trainer") q = q.eq("trainer_id", scope.trainerId).in("status", ["upcoming", "ongoing"]);
          return q.order("id").range(from, to) as unknown as Page<ReportBatchRecord>;
        })
      );
    },

    listEnrolments(batchIds: string[], studentId: string | null = null): Promise<ReportEnrolmentRecord[]> {
      return byIds("listEnrolments", "batch_students", REPORT_SELECT.enrolments, "batch_id", batchIds, ["batch_id", "student_id"], studentId);
    },

    listClasses(batchIds: string[]): Promise<ReportClassRecord[]> {
      return byIds("listClasses", "classes", REPORT_SELECT.classes, "batch_id", batchIds, ["id"]);
    },

    listAttendance(batchIds: string[], studentId: string | null = null): Promise<ReportAttendanceRecord[]> {
      return byIds("listAttendance", "class_attendance", REPORT_SELECT.attendance, "batch_id", batchIds, ["class_id", "student_id"], studentId);
    },

    listBestResults(batchIds: string[], studentId: string | null = null): Promise<ReportBestResultRecord[]> {
      return byIds("listBestResults", "test_best_results", REPORT_SELECT.bestResults, "batch_id", batchIds, ["test_id", "student_id"], studentId);
    },

    listTests(testIds: string[]): Promise<ReportTestRecord[]> {
      return byIds("listTests", "tests", REPORT_SELECT.tests, "id", testIds, ["id"]);
    },

    listAssignments(batchIds: string[]): Promise<ReportAssignmentRecord[]> {
      return byIds("listAssignments", "class_assignments", REPORT_SELECT.assignments, "batch_id", batchIds, ["id"]);
    },

    listSubmissions(batchIds: string[], studentId: string | null = null): Promise<ReportSubmissionRecord[]> {
      return byIds("listSubmissions", "assignment_submissions", REPORT_SELECT.submissions, "batch_id", batchIds, ["assignment_id", "student_id"], studentId);
    },
  };
}

export type ReportsRepository = ReturnType<typeof createReportsRepository>;
