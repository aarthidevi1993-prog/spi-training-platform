/**
 * Exam monitoring repository — staff READS of the 0009/0015 attempt and
 * security-event data, plus the batch/test/student names to label them.
 * Always the caller's own session (never the service role): RLS on
 * test_attempts and test_security_events limits every row to super
 * admins and the batch's CURRENT trainer; students have no read policy
 * on either table. Nothing here writes, and no answer, option, answer
 * key or score column is ever selected.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; exam-monitoring.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BatchesRow,
  Database,
  StudentsRow,
  TestAttemptsRow,
  TestSecurityEventTypeColumn,
  TestSecurityEventsRow,
  TestsRow,
} from "@/lib/supabase/types";
import { readAllByKeyset } from "@/lib/supabase/paging";

type Client = SupabaseClient<Database, "public">;

const GENERIC_DB_ERROR = "We couldn't load exam monitoring. Please try again.";

export class ExamMonitoringRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "ExamMonitoringRepositoryError";
  }
}

export type MonitoringBatchRecord = Pick<BatchesRow, "id" | "batch_code" | "name" | "status">;
export type MonitoringTestRecord = Pick<TestsRow, "id" | "title" | "batch_id" | "available_until">;
export type MonitoringStudentRecord = Pick<StudentsRow, "id" | "full_name" | "student_code">;
export type MonitoringAttemptRecord = Pick<
  TestAttemptsRow,
  "id" | "test_id" | "batch_id" | "student_id" | "attempt_number" | "status" | "started_at" | "deadline_at"
>;
export type MonitoringEventRecord = Pick<
  TestSecurityEventsRow,
  "id" | "occurred_at" | "event_type" | "attempt_id" | "test_id" | "batch_id" | "student_id" | "detail"
>;

export type BatchScope = { kind: "all" } | { kind: "trainer"; trainerId: string };

export interface AttemptQuery {
  /** null = every batch the session may read (RLS). */
  batchIds: string[] | null;
  testId: string | null;
  studentId: string | null;
  attemptId: string | null;
  limit: number;
}

export interface EventQuery extends AttemptQuery {
  /** Only events of these attempts (null = no attempt restriction). */
  attemptIds: string[] | null;
  /** null = every type. */
  types: string[] | null;
  fromIso: string | null;
  toIso: string | null;
}

const IN_CHUNK = 100;
function chunk<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[exam-monitoring] ${context}:`, detail);
}

export function createExamMonitoringRepository(getClient: () => Promise<Client | null>) {
  async function run<T>(context: string, fn: (supabase: Client) => Promise<T>): Promise<T> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(context, err);
      throw new ExamMonitoringRepositoryError();
    }
    if (!supabase) throw new ExamMonitoringRepositoryError();
    try {
      return await fn(supabase);
    } catch (err) {
      if (err instanceof ExamMonitoringRepositoryError) throw err;
      logDbError(context, err);
      throw new ExamMonitoringRepositoryError();
    }
  }
  const unwrap = <T>(result: { data: T | null; error: unknown }): T => {
    if (result.error) throw result.error;
    return (result.data ?? []) as T;
  };

  return {
    /** Batches the viewer may monitor: all (super admin) or those they CURRENTLY teach (upcoming/ongoing). */
    listBatches(scope: BatchScope): Promise<MonitoringBatchRecord[]> {
      return run("listBatches", async (supabase) => {
        let q = supabase.from("batches").select("id, batch_code, name, status");
        if (scope.kind === "trainer") q = q.eq("trainer_id", scope.trainerId).in("status", ["upcoming", "ongoing"]);
        return unwrap(await q.order("batch_code").limit(5000)) as MonitoringBatchRecord[];
      });
    },

    /** Tests of the given batches (null = all visible). */
    listTests(batchIds: string[] | null): Promise<MonitoringTestRecord[]> {
      return run("listTests", async (supabase) => {
        if (batchIds === null) {
          return readAllByKeyset<MonitoringTestRecord>((afterId, limit) => {
            let q = supabase.from("tests").select("id, title, batch_id, available_until");
            if (afterId) q = q.gt("id", afterId);
            return q.order("id").limit(limit);
          });
        }
        const rows: MonitoringTestRecord[] = [];
        for (const ids of chunk(batchIds)) {
          rows.push(...(unwrap(await supabase.from("tests").select("id, title, batch_id, available_until").in("batch_id", ids).order("id").limit(5000)) as MonitoringTestRecord[]));
        }
        return rows;
      });
    },

    /** Students enrolled in the given batches (null = every student record visible). */
    listStudents(batchIds: string[] | null): Promise<MonitoringStudentRecord[]> {
      return run("listStudents", async (supabase) => {
        if (batchIds === null) {
          return readAllByKeyset<MonitoringStudentRecord>((afterId, limit) => {
            let q = supabase.from("students").select("id, full_name, student_code");
            if (afterId) q = q.gt("id", afterId);
            return q.order("id").limit(limit);
          });
        }
        const ids = new Set<string>();
        for (const part of chunk(batchIds)) {
          const rows = unwrap(await supabase.from("batch_students").select("student_id").in("batch_id", part).limit(10000)) as { student_id: string }[];
          rows.forEach((r) => ids.add(r.student_id));
        }
        return this.studentsByIds(Array.from(ids));
      });
    },

    studentsByIds(studentIds: string[]): Promise<MonitoringStudentRecord[]> {
      if (studentIds.length === 0) return Promise.resolve([]);
      return run("studentsByIds", async (supabase) => {
        const rows: MonitoringStudentRecord[] = [];
        for (const ids of chunk(studentIds)) {
          rows.push(...(unwrap(await supabase.from("students").select("id, full_name, student_code").in("id", ids).limit(IN_CHUNK)) as MonitoringStudentRecord[]));
        }
        return rows;
      });
    },

    /** In-progress attempts (oldest start first). */
    listActiveAttempts(query: AttemptQuery): Promise<MonitoringAttemptRecord[]> {
      return run("listActiveAttempts", async (supabase) => {
        let q = supabase
          .from("test_attempts")
          .select("id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at")
          .eq("status", "in_progress");
        if (query.batchIds) q = q.in("batch_id", query.batchIds);
        if (query.testId) q = q.eq("test_id", query.testId);
        if (query.studentId) q = q.eq("student_id", query.studentId);
        if (query.attemptId) q = q.eq("id", query.attemptId);
        return unwrap(await q.order("started_at").limit(query.limit)) as MonitoringAttemptRecord[];
      });
    },

    attemptsByIds(attemptIds: string[]): Promise<MonitoringAttemptRecord[]> {
      if (attemptIds.length === 0) return Promise.resolve([]);
      return run("attemptsByIds", async (supabase) => {
        const rows: MonitoringAttemptRecord[] = [];
        for (const ids of chunk(attemptIds)) {
          rows.push(
            ...(unwrap(
              await supabase
                .from("test_attempts")
                .select("id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at")
                .in("id", ids)
                .limit(IN_CHUNK)
            ) as MonitoringAttemptRecord[])
          );
        }
        return rows;
      });
    },

    /** Most recent matching events first (up to `limit`). */
    listEvents(query: EventQuery): Promise<MonitoringEventRecord[]> {
      return run("listEvents", async (supabase) => {
        let q = supabase
          .from("test_security_events")
          .select("id, occurred_at, event_type, attempt_id, test_id, batch_id, student_id, detail");
        if (query.batchIds) q = q.in("batch_id", query.batchIds);
        if (query.testId) q = q.eq("test_id", query.testId);
        if (query.studentId) q = q.eq("student_id", query.studentId);
        if (query.attemptId) q = q.eq("attempt_id", query.attemptId);
        if (query.attemptIds) q = q.in("attempt_id", query.attemptIds);
        if (query.types) q = q.in("event_type", query.types as TestSecurityEventTypeColumn[]);
        if (query.fromIso) q = q.gte("occurred_at", query.fromIso);
        if (query.toIso) q = q.lte("occurred_at", query.toIso);
        return unwrap(await q.order("id", { ascending: false }).limit(query.limit)) as MonitoringEventRecord[];
      });
    },
  };
}

export type ExamMonitoringRepository = ReturnType<typeof createExamMonitoringRepository>;
