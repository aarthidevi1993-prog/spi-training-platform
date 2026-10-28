/**
 * Class assignments (0006_assignments.sql). Assignments belong to one
 * class (several per class); files live in SharePoint/OneDrive, so only
 * http(s) links are stored. "Late" is never stored — it is
 * submitted_at > due_at, computed on read.
 */

export type AssignmentStatus = "draft" | "published" | "closed";
export type SubmissionStatus = "submitted" | "returned";

/** Mirrors the 0006 CHECK constraints. */
export const ASSIGNMENT_LIMITS = {
  titleMax: 200,
  instructionsMax: 5000,
  urlMax: 2000,
  noteMax: 1000,
  feedbackMax: 5000,
  /** numeric(6,2) */
  scoreMax: 9999.99,
} as const;

/** One student's submission as shown to managers or to the student. */
export interface AssignmentSubmissionView {
  studentId: string;
  status: SubmissionStatus;
  submissionUrl: string;
  note: string | null;
  submittedAt: string;
  /** submitted_at > due_at (false when there is no due date). */
  isLate: boolean;
  score: number | null;
  feedback: string | null;
  reviewedAt: string | null;
}

/** A line of the manager's submission review table. */
export interface AssignmentRosterEntry {
  studentId: string;
  name: string;
  studentCode: string;
  /** False for students no longer enrolled (read-only history). */
  current: boolean;
  submission: AssignmentSubmissionView | null;
}

export interface AssignmentView {
  id: string;
  title: string;
  instructions: string | null;
  resourceUrl: string | null;
  /** ISO timestamp, or null when there is no due date. */
  dueAt: string | null;
  /** The due date as an India-time "YYYY-MM-DDTHH:mm" value for the editor. */
  dueAtLocal: string | null;
  maxScore: number | null;
  status: AssignmentStatus;
  /** Manager view only: batch roster with submissions. Null for everyone else. */
  roster: AssignmentRosterEntry[] | null;
  /** Student view only: the student's own submission (null when none yet). */
  ownSubmission: AssignmentSubmissionView | null;
}

/**
 * The Assignment tab of a class:
 *   - manager: super admin, or the batch's current trainer
 *   - reader:  a previous trainer (assignments only, no submissions)
 *   - student: an enrolled student (published/closed assignments, own submissions)
 */
export type AssignmentViewer = "manager" | "reader" | "student";

export interface ClassAssignmentsPanelData {
  classId: string;
  viewer: AssignmentViewer;
  /** Class is cancelled: no new assignments, publishing or submissions. */
  classCancelled: boolean;
  /** Shown above the list (e.g. previous-trainer or cancelled-class notes). */
  notice: string | null;
  assignments: AssignmentView[];
}

/** Assignment editor input. dueAtLocal is India time "YYYY-MM-DDTHH:mm". */
export interface AssignmentInput {
  title: string;
  instructions: string | null;
  resourceUrl: string | null;
  dueAtLocal: string | null;
  maxScore: number | null;
}

export interface SubmissionInput {
  submissionUrl: string;
  note: string | null;
}

export interface ReviewInput {
  score: number | null;
  feedback: string | null;
}
