import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  AssignmentStatusColumn,
  AssignmentSubmissionsRow,
  ClassAssignmentsRow,
  ClassAssignmentsUpdate,
} from "@/lib/supabase/types";

/**
 * Assignments repository — the only module that knows where assignment
 * data lives (public.class_assignments / assignment_submissions,
 * 0006_assignments.sql). Supabase mode only: there is deliberately no
 * demo/mock assignment data (the service returns null in demo mode and
 * the class tab keeps its placeholder).
 *
 * RLS is the authoritative boundary (admin: all; current batch trainer:
 * manage + review; previous trainer: read assignments only; student:
 * published/closed assignments of enrolled batches + own submissions).
 * Audit fields (created_by, updated_by, submitted_at, reviewed_by,
 * reviewed_at) are stamped by the database and never sent from here.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export class AssignmentRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "AssignmentRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  console.error(`[assignments] ${context}:`, error instanceof Error ? error.message : error);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new AssignmentRepositoryError();
  return supabase;
}

export type AssignmentRecord = Pick<
  ClassAssignmentsRow,
  "id" | "class_id" | "batch_id" | "title" | "instructions" | "resource_url" | "due_at" | "max_score" | "status"
>;

/** A published assignment with its class's title and status (student dashboard). */
export type PublishedAssignmentRecord = Pick<ClassAssignmentsRow, "id" | "class_id" | "title" | "due_at" | "status"> & {
  classes: { title: string; status: string } | { title: string; status: string }[] | null;
};

export type SubmissionRecord = Pick<
  AssignmentSubmissionsRow,
  "assignment_id" | "student_id" | "status" | "submission_url" | "note" | "submitted_at" | "score" | "feedback" | "reviewed_at"
> & { students: { full_name: string; student_code: string } | null };

/** Editable assignment fields (never class/batch/status/audit columns). */
export interface AssignmentFields {
  title: string;
  instructions: string | null;
  resource_url: string | null;
  due_at: string | null;
  max_score: number | null;
}

export interface RosterStudent {
  studentId: string;
  name: string;
  studentCode: string;
}

const ASSIGNMENT_SELECT = "id, class_id, batch_id, title, instructions, resource_url, due_at, max_score, status";
const SUBMISSION_SELECT =
  "assignment_id, student_id, status, submission_url, note, submitted_at, score, feedback, reviewed_at, students ( full_name, student_code )";

/** Wrap a repository call: log details, surface a safe message. */
async function run<T>(context: string, fn: () => Promise<T>, message?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AssignmentRepositoryError) throw err;
    logDbError(context, err);
    throw new AssignmentRepositoryError(message);
  }
}

export const assignmentsRepository = {
  /** The class's assignments the caller may see (RLS), oldest first. */
  findForClass(classId: string): Promise<AssignmentRecord[]> {
    return run(`findForClass(${classId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("class_assignments")
        .select(ASSIGNMENT_SELECT)
        .eq("class_id", classId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    });
  },

  /**
   * Student dashboard: PUBLISHED assignments of these batches, with their class (title, status).
   * RLS is the boundary (a student sees published/closed assignments of enrolled/completed batches
   * only); the batch list is a second, explicit scope from the caller's own enrolments.
   */
  findPublishedInBatches(batchIds: string[]): Promise<PublishedAssignmentRecord[]> {
    if (batchIds.length === 0) return Promise.resolve([]);
    return run("findPublishedInBatches", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("class_assignments")
        .select("id, class_id, title, due_at, status, classes ( title, status )")
        .in("batch_id", batchIds)
        .eq("status", "published")
        .order("due_at")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as PublishedAssignmentRecord[];
    });
  },

  findById(id: string): Promise<AssignmentRecord | null> {
    return run(`findById(${id})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("class_assignments").select(ASSIGNMENT_SELECT).eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    });
  },

  /** Submissions of these assignments the caller may see (RLS). */
  findSubmissions(assignmentIds: string[]): Promise<SubmissionRecord[]> {
    if (assignmentIds.length === 0) return Promise.resolve([]);
    return run("findSubmissions", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("assignment_submissions")
        .select(SUBMISSION_SELECT)
        .in("assignment_id", assignmentIds);
      if (error) throw error;
      return data ?? [];
    });
  },

  findSubmission(assignmentId: string, studentId: string): Promise<SubmissionRecord | null> {
    return run("findSubmission", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("assignment_submissions")
        .select(SUBMISSION_SELECT)
        .eq("assignment_id", assignmentId)
        .eq("student_id", studentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    });
  },

  /** Current (non-withdrawn) students of a batch, by name. */
  findBatchRoster(batchId: string): Promise<RosterStudent[]> {
    return run(`findBatchRoster(${batchId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("batch_students")
        .select("student_id, enrollment_status, students ( full_name, student_code )")
        .eq("batch_id", batchId);
      if (error) throw error;
      return (data ?? [])
        .filter((row) => row.enrollment_status !== "withdrawn")
        .map((row) => ({
          studentId: row.student_id,
          name: row.students?.full_name ?? "Unknown student",
          studentCode: row.students?.student_code ?? "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  },

  /** A student's own enrolment status in a batch (null when not readable / none). */
  findEnrolmentStatus(batchId: string, studentId: string) {
    return run("findEnrolmentStatus", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("batch_students")
        .select("enrollment_status")
        .eq("batch_id", batchId)
        .eq("student_id", studentId)
        .maybeSingle();
      if (error) throw error;
      return data?.enrollment_status ?? null;
    });
  },

  /** The batch's assigned trainer (null when unassigned or not readable). */
  findBatchTrainerId(batchId: string): Promise<string | null> {
    return run(`findBatchTrainerId(${batchId})`, async () => {
      const supabase = await client();
      const { data, error } = await supabase.from("batches").select("trainer_id").eq("id", batchId).maybeSingle();
      if (error) throw error;
      return data?.trainer_id ?? null;
    });
  },

  /** Highest existing score for an assignment (null when none). */
  findTopScore(assignmentId: string): Promise<number | null> {
    return run("findTopScore", async () => {
      const supabase = await client();
      const { data, error } = await supabase
        .from("assignment_submissions")
        .select("score")
        .eq("assignment_id", assignmentId)
        .not("score", "is", null)
        .order("score", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0]?.score ?? null;
    });
  },

  /** New assignments always start as drafts. */
  insertAssignment(classId: string, batchId: string, fields: AssignmentFields): Promise<string> {
    return run(
      "insertAssignment",
      async () => {
        const supabase = await client();
        const { data, error } = await supabase
          .from("class_assignments")
          .insert({ ...fields, class_id: classId, batch_id: batchId, status: "draft" })
          .select("id")
          .single();
        if (error) throw error;
        return data.id;
      },
      "We couldn't create the assignment. Please try again."
    );
  },

  updateAssignment(id: string, fields: Omit<ClassAssignmentsUpdate, "id" | "class_id" | "batch_id">): Promise<void> {
    return run(
      `updateAssignment(${id})`,
      async () => {
        const supabase = await client();
        const { error } = await supabase.from("class_assignments").update(fields).eq("id", id);
        if (error) throw error;
      },
      "We couldn't update the assignment. Please try again."
    );
  },

  setAssignmentStatus(id: string, status: AssignmentStatusColumn): Promise<void> {
    return assignmentsRepository.updateAssignment(id, { status });
  },

  /** Deletes the assignment; returns false when nothing was deleted (RLS / not a draft). */
  deleteAssignment(id: string): Promise<boolean> {
    return run(
      `deleteAssignment(${id})`,
      async () => {
        const supabase = await client();
        const { data, error } = await supabase.from("class_assignments").delete().eq("id", id).select("id");
        if (error) throw error;
        return (data ?? []).length > 0;
      },
      "We couldn't delete the assignment. Please try again."
    );
  },

  /** Insert or resubmit the caller's own submission (link + note only). */
  upsertSubmission(
    assignmentId: string,
    batchId: string,
    studentId: string,
    submissionUrl: string,
    note: string | null
  ): Promise<void> {
    return run(
      "upsertSubmission",
      async () => {
        const supabase = await client();
        const { error } = await supabase.from("assignment_submissions").upsert(
          {
            assignment_id: assignmentId,
            batch_id: batchId,
            student_id: studentId,
            submission_url: submissionUrl,
            note,
          },
          { onConflict: "assignment_id,student_id" }
        );
        if (error) throw error;
      },
      "We couldn't save your submission. Please try again."
    );
  },

  /** Review fields only (status/score/feedback); the database stamps the reviewer. */
  updateReview(
    assignmentId: string,
    studentId: string,
    review: { status: "submitted" | "returned"; score: number | null; feedback: string | null }
  ): Promise<void> {
    return run(
      "updateReview",
      async () => {
        const supabase = await client();
        const { error } = await supabase
          .from("assignment_submissions")
          .update(review)
          .eq("assignment_id", assignmentId)
          .eq("student_id", studentId);
        if (error) throw error;
      },
      "We couldn't save the review. Please try again."
    );
  },
};
