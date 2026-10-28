import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AttendanceStatusColumn, BatchStatusColumn } from "@/lib/supabase/types";
import { chunk, readAllPages, type BestResultRecord } from "./results.repository";

/**
 * Performance repository — staff and student reads for the Performance
 * pages. Always the caller's own session (never the service role), so
 * RLS stays the authoritative boundary:
 *
 *   - Test results: test_best_results / test_attempt_answers (staff only:
 *     super admin, or the batch's CURRENT trainer). Students never read
 *     these tables — their released results come from
 *     student_available_tests() via the student tests service.
 *   - Attendance / assignment submissions: admin all; trainer per 0005/0006
 *     (the service narrows further to CURRENT batches); student own rows
 *     (owns_student_record).
 *   - Question → module: questions/modules (admin, or current course trainer).
 *
 * Read-only: nothing here writes.
 */

const GENERIC_DB_ERROR = "We couldn't load performance data. Please try again.";

export class PerformanceRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "PerformanceRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[performance] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new PerformanceRepositoryError();
  return supabase;
}

async function run<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PerformanceRepositoryError) throw err;
    logDbError(context, err);
    throw new PerformanceRepositoryError();
  }
}

export interface ScopeBatchRecord {
  id: string;
  batch_code: string;
  name: string;
  status: BatchStatusColumn;
}

export interface BatchStudentRecord {
  student_id: string;
  students: { full_name: string; student_code: string } | null;
}

export interface TestMetaRecord {
  id: string;
  title: string;
  status: string;
  available_from: string | null;
  available_until: string | null;
  classes: { class_date: string } | null;
}

export interface ScoredSubmissionRecord {
  score: number | null;
  class_assignments: { max_score: number | null } | null;
}

export interface FrozenQuestionSourceRecord {
  id: string;
  marks: number;
  source_question_id: string;
}

export interface QuestionModuleRecord {
  id: string;
  module_id: string | null;
  modules: { id: string; title: string; sequence: number } | null;
}

/** Records are filtered either by batches (staff) or by the student (own rows). */
export type RowFilter = { batchIds: string[]; studentId: string | null } | { ownStudentId: string };

export const performanceRepository = {
  /**
   * Batches the caller may analyse: all (super admin) or the trainer's
   * CURRENT batches (upcoming/ongoing), matching is_current_batch_trainer.
   */
  listScopeBatches(scope: { kind: "all" } | { kind: "trainer"; trainerId: string }): Promise<ScopeBatchRecord[]> {
    return run("listScopeBatches", async () => {
      const supabase = await client();
      let query = supabase.from("batches").select("id, batch_code, name, status").order("start_date", { ascending: false });
      if (scope.kind === "trainer") {
        query = query.eq("trainer_id", scope.trainerId).in("status", ["upcoming", "ongoing"]);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    });
  },

  /** Students of one batch (for the student filter). */
  listBatchStudents(batchId: string): Promise<BatchStudentRecord[]> {
    return run("listBatchStudents", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("batch_students")
        .select("student_id, students ( full_name, student_code )")
        .eq("batch_id", batchId);
      if (error) throw error;
      return data ?? [];
    });
  },

  /** Best finished attempt per test × student in the given batches (staff RLS). */
  listBestResults(batchIds: string[], studentId: string | null): Promise<BestResultRecord[]> {
    if (batchIds.length === 0) return Promise.resolve([]);
    return run("listBestResults", async () => {
      const supabase = await client();
      const rows: BestResultRecord[] = [];
      for (const ids of chunk(batchIds)) {
        rows.push(
          ...(await readAllPages((from, to) => {
            let query = supabase
              .from("test_best_results")
              .select("test_id, batch_id, student_id, best_attempt_id, score, max_score, percentage, passed, finalized_at")
              .in("batch_id", ids);
            if (studentId) query = query.eq("student_id", studentId);
            return query.order("test_id").order("student_id").range(from, to);
          }))
        );
      }
      return rows;
    });
  },

  /** Title / lifecycle fields of the given tests (for release status + ordering). */
  listTestMeta(testIds: string[]): Promise<TestMetaRecord[]> {
    if (testIds.length === 0) return Promise.resolve([]);
    return run("listTestMeta", async () => {
      const supabase = await client();
      const rows: TestMetaRecord[] = [];
      for (const ids of chunk(testIds)) {
        const { data, error } = await supabase
          .from("tests")
          .select("id, title, status, available_from, available_until, classes ( class_date )")
          .in("id", ids);
        if (error) throw error;
        rows.push(...(data ?? []));
      }
      return rows;
    });
  },

  /** Attendance statuses (one per marked student × class). */
  listAttendanceStatuses(filter: RowFilter): Promise<AttendanceStatusColumn[]> {
    return run("listAttendanceStatuses", async () => {
      const supabase = await client();
      if ("ownStudentId" in filter) {
        const rows = await readAllPages((from, to) =>
          supabase
            .from("class_attendance")
            .select("status")
            .eq("student_id", filter.ownStudentId)
            .order("class_id")
            .range(from, to)
        );
        return rows.map((r) => r.status);
      }
      const out: AttendanceStatusColumn[] = [];
      for (const ids of chunk(filter.batchIds)) {
        const rows = await readAllPages((from, to) => {
          let query = supabase.from("class_attendance").select("status").in("batch_id", ids);
          if (filter.studentId) query = query.eq("student_id", filter.studentId);
          return query.order("class_id").order("student_id").range(from, to);
        });
        out.push(...rows.map((r) => r.status));
      }
      return out;
    });
  },

  /** Returned submissions with a score, with the assignment's max score. */
  listScoredSubmissions(filter: RowFilter): Promise<ScoredSubmissionRecord[]> {
    return run("listScoredSubmissions", async () => {
      const supabase = await client();
      const select = "score, class_assignments ( max_score )";
      if ("ownStudentId" in filter) {
        return readAllPages((from, to) =>
          supabase
            .from("assignment_submissions")
            .select(select)
            .eq("student_id", filter.ownStudentId)
            .eq("status", "returned")
            .not("score", "is", null)
            .order("assignment_id")
            .range(from, to)
        );
      }
      const out: ScoredSubmissionRecord[] = [];
      for (const ids of chunk(filter.batchIds)) {
        out.push(
          ...(await readAllPages((from, to) => {
            let query = supabase
              .from("assignment_submissions")
              .select(select)
              .in("batch_id", ids)
              .eq("status", "returned")
              .not("score", "is", null);
            if (filter.studentId) query = query.eq("student_id", filter.studentId);
            return query.order("assignment_id").order("student_id").range(from, to);
          }))
        );
      }
      return out;
    });
  },

  /** Graded answers of the given attempts (staff RLS). */
  listGradedAnswers(attemptIds: string[]): Promise<{ test_question_id: string; marks_awarded: number | null }[]> {
    if (attemptIds.length === 0) return Promise.resolve([]);
    return run("listGradedAnswers", async () => {
      const supabase = await client();
      const out: { test_question_id: string; marks_awarded: number | null }[] = [];
      for (const ids of chunk(attemptIds)) {
        out.push(
          ...(await readAllPages((from, to) =>
            supabase
              .from("test_attempt_answers")
              .select("test_question_id, marks_awarded")
              .in("attempt_id", ids)
              .not("is_correct", "is", null)
              .order("attempt_id")
              .order("test_question_id")
              .range(from, to)
          ))
        );
      }
      return out;
    });
  },

  /** Frozen questions of the given tests with their source bank question (marks only, no answer key). */
  listFrozenQuestionSources(testIds: string[]): Promise<FrozenQuestionSourceRecord[]> {
    if (testIds.length === 0) return Promise.resolve([]);
    return run("listFrozenQuestionSources", async () => {
      const supabase = await client();
      const out: FrozenQuestionSourceRecord[] = [];
      for (const ids of chunk(testIds)) {
        out.push(
          ...(await readAllPages((from, to) =>
            supabase
              .from("test_questions")
              .select("id, marks, source_question_id")
              .in("test_id", ids)
              .order("id")
              .range(from, to)
          ))
        );
      }
      return out;
    });
  },

  /** Bank question → module (RLS: admin, or current course trainer). */
  listQuestionModules(questionIds: string[]): Promise<QuestionModuleRecord[]> {
    if (questionIds.length === 0) return Promise.resolve([]);
    return run("listQuestionModules", async () => {
      const supabase = await client();
      const out: QuestionModuleRecord[] = [];
      for (const ids of chunk(questionIds)) {
        const { data, error } = await supabase
          .from("questions")
          .select("id, module_id, modules ( id, title, sequence )")
          .in("id", ids);
        if (error) throw error;
        out.push(...(data ?? []));
      }
      return out;
    });
  },
};
