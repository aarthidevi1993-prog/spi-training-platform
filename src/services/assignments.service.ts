import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { classesService } from "./classes.service";
import {
  assignmentsRepository,
  AssignmentRepositoryError,
  type AssignmentFields,
  type AssignmentRecord,
  type SubmissionRecord,
} from "@/repositories/assignments.repository";
import { classesRepository } from "@/repositories/classes.repository";
import { pickPendingAssignments, type PendingAssignmentItem } from "@/lib/dashboard/student-dashboard";
import type { AuthUser } from "@/types/auth";
import type { ClassWithRelations } from "@/types/class";
import {
  ASSIGNMENT_LIMITS,
  type AssignmentInput,
  type AssignmentRosterEntry,
  type AssignmentStatus,
  type AssignmentSubmissionView,
  type AssignmentView,
  type AssignmentViewer,
  type ClassAssignmentsPanelData,
  type ReviewInput,
  type SubmissionInput,
} from "@/types/assignment";

/**
 * Assignments service — resolves the caller's identity server-side via
 * authService (never from a client-supplied argument), decides who may
 * manage a class's assignments, and validates every write before it
 * reaches the repository so users get clear messages. The database
 * (0006 RLS + triggers) remains the final security boundary.
 */

export class AssignmentAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "AssignmentAuthorizationError";
  }
}

export class AssignmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentValidationError";
  }
}

const INDIA_TIME_ZONE = "Asia/Kolkata";
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Allowed lifecycle moves (published/closed never go back to draft). */
const NEXT_STATUSES: Record<AssignmentStatus, AssignmentStatus[]> = {
  draft: ["published"],
  published: ["closed"],
  closed: ["published"],
};

async function requireUser(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new AssignmentAuthorizationError("You need to be signed in.");
  return user;
}

// -------------------------------------------------------------------
// India-time helpers (due dates are entered and shown in Asia/Kolkata)
// -------------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in India time → ISO timestamp. */
function indiaLocalToIso(local: string): string {
  if (!LOCAL_DATETIME.test(local)) throw new AssignmentValidationError("Enter a valid due date and time.");
  const date = new Date(`${local}:00+05:30`);
  if (Number.isNaN(date.getTime())) throw new AssignmentValidationError("Enter a valid due date and time.");
  return date.toISOString();
}

/** ISO timestamp → "YYYY-MM-DDTHH:mm" in India time (for the editor). */
function isoToIndiaLocal(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// -------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Trimmed text, or null when empty; enforces the database length limit. */
function optionalText(value: string | null, max: number, label: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (trimmed.length > max) throw new AssignmentValidationError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function optionalLink(value: string | null, label: string): string | null {
  const link = optionalText(value, ASSIGNMENT_LIMITS.urlMax, label);
  if (link && !isHttpUrl(link)) {
    throw new AssignmentValidationError(`${label} must be a link starting with http:// or https://.`);
  }
  return link;
}

/** A score/max score with at most two decimals, within numeric(6,2). */
function validNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new AssignmentValidationError(`${label} must be a number.`);
  // Tolerance guards float artefacts (e.g. 0.29 * 100 = 28.999…).
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
    throw new AssignmentValidationError(`${label} can have at most two decimal places.`);
  }
  if (value > ASSIGNMENT_LIMITS.scoreMax) {
    throw new AssignmentValidationError(`${label} must be ${ASSIGNMENT_LIMITS.scoreMax} or less.`);
  }
  return value;
}

function validateAssignment(input: AssignmentInput): AssignmentFields {
  const title = input.title.trim();
  if (!title) throw new AssignmentValidationError("Title is required.");
  if (title.length > ASSIGNMENT_LIMITS.titleMax) {
    throw new AssignmentValidationError(`Title must be ${ASSIGNMENT_LIMITS.titleMax} characters or fewer.`);
  }

  let maxScore: number | null = null;
  if (input.maxScore !== null) {
    maxScore = validNumber(input.maxScore, "Maximum score");
    if (maxScore <= 0) throw new AssignmentValidationError("Maximum score must be greater than 0.");
  }

  return {
    title,
    instructions: optionalText(input.instructions, ASSIGNMENT_LIMITS.instructionsMax, "Instructions"),
    resource_url: optionalLink(input.resourceUrl, "Resource link"),
    due_at: input.dueAtLocal?.trim() ? indiaLocalToIso(input.dueAtLocal.trim()) : null,
    max_score: maxScore,
  };
}

// -------------------------------------------------------------------
// Access
// -------------------------------------------------------------------

/**
 * The class, if the caller may manage its assignments: a super admin,
 * or the trainer who currently runs the class's batch.
 */
async function requireManagedClass(user: AuthUser, classId: string): Promise<ClassWithRelations> {
  if (user.role !== "admin" && user.role !== "trainer") {
    throw new AssignmentAuthorizationError("Only admins and trainers can manage assignments.");
  }
  if (authConfig.mode === "demo") {
    throw new AssignmentValidationError("Assignments aren't available in demo mode.");
  }

  // Scoped: a trainer only gets their own classes; anything else is null.
  const trainingClass = await classesService.getClass(classId);
  if (!trainingClass) throw new AssignmentAuthorizationError("That class doesn't exist or isn't available to you.");

  if (user.role === "trainer") {
    const batchTrainerId = await assignmentsRepository.findBatchTrainerId(trainingClass.batchId);
    if (batchTrainerId !== user.id) {
      throw new AssignmentAuthorizationError("Only the batch's current trainer can manage assignments for this class.");
    }
  }
  return trainingClass;
}

async function requireManagedAssignment(
  user: AuthUser,
  assignmentId: string
): Promise<{ assignment: AssignmentRecord; trainingClass: ClassWithRelations }> {
  const assignment = await assignmentsRepository.findById(assignmentId);
  if (!assignment) throw new AssignmentAuthorizationError("That assignment doesn't exist or isn't available to you.");
  const trainingClass = await requireManagedClass(user, assignment.class_id);
  return { assignment, trainingClass };
}

// -------------------------------------------------------------------
// Views
// -------------------------------------------------------------------

function toSubmissionView(s: SubmissionRecord, dueAt: string | null): AssignmentSubmissionView {
  return {
    studentId: s.student_id,
    status: s.status,
    submissionUrl: s.submission_url,
    note: s.note,
    submittedAt: s.submitted_at,
    // Late is derived, never stored: submitted_at > due_at.
    isLate: dueAt !== null && new Date(s.submitted_at).getTime() > new Date(dueAt).getTime(),
    score: s.score,
    feedback: s.feedback,
    reviewedAt: s.reviewed_at,
  };
}

function toView(a: AssignmentRecord): AssignmentView {
  return {
    id: a.id,
    title: a.title,
    instructions: a.instructions,
    resourceUrl: a.resource_url,
    dueAt: a.due_at,
    dueAtLocal: a.due_at ? isoToIndiaLocal(a.due_at) : null,
    maxScore: a.max_score,
    status: a.status,
    roster: null,
    ownSubmission: null,
  };
}

export const assignmentsService = {
  /**
   * Student dashboard: the signed-in student's assignments still to submit (published, class not
   * cancelled, no submission yet — the 0006 rules). The identity is the server-side session only;
   * no id is accepted from the caller. RLS limits both reads to the student's own scope. Null in
   * demo mode (there is no demo assignment data).
   */
  async listPendingForStudent(now: Date = new Date()): Promise<{ items: PendingAssignmentItem[]; total: number } | null> {
    if (authConfig.mode === "demo") return null;
    const user = await requireUser();
    if (user.role !== "student") throw new AssignmentAuthorizationError("Only students have pending assignments.");

    const batchIds = await classesRepository.findEnrolledBatchIds(user.id);
    const assignments = await assignmentsRepository.findPublishedInBatches(batchIds);
    const submissions = await assignmentsRepository.findSubmissions(assignments.map((a) => a.id));
    const submitted = new Set(submissions.filter((s) => s.student_id === user.id).map((s) => s.assignment_id));

    return pickPendingAssignments(
      assignments.map((a) => {
        const cls = Array.isArray(a.classes) ? a.classes[0] ?? null : a.classes;
        return {
          id: a.id,
          classId: a.class_id,
          title: a.title,
          dueAt: a.due_at,
          status: a.status,
          classTitle: cls?.title ?? "",
          // A class the student can't read is treated as unavailable, never as open for submission.
          classStatus: cls?.status ?? "cancelled",
        };
      }),
      submitted,
      now
    );
  },

  /**
   * The Assignment tab of a class the caller can already see (the class
   * comes from classesService.getClass, so it is scoped). Null in demo
   * mode, where the tab keeps its placeholder (no mock data).
   */
  async getClassPanel(trainingClass: ClassWithRelations): Promise<ClassAssignmentsPanelData | null> {
    if (authConfig.mode === "demo") return null;

    const user = await requireUser();
    let viewer: AssignmentViewer;
    const notices: string[] = [];

    if (user.role === "admin") {
      viewer = "manager";
    } else if (user.role === "trainer") {
      const batchTrainerId = await assignmentsRepository.findBatchTrainerId(trainingClass.batchId);
      viewer = batchTrainerId === user.id ? "manager" : "reader";
      if (viewer === "reader") {
        notices.push("You can see this class's assignments. Submissions are visible to the batch's current trainer.");
      }
    } else if (user.role === "student") {
      viewer = "student";
    } else {
      return null;
    }

    const classCancelled = trainingClass.status === "cancelled";
    if (classCancelled) {
      notices.push("This class was cancelled, so new assignments, publishing and submissions aren't possible.");
    }

    let records = await assignmentsRepository.findForClass(trainingClass.id);
    // RLS already hides drafts from students; filter again defensively.
    if (viewer === "student") records = records.filter((a) => a.status !== "draft");

    const views = records.map(toView);
    const ids = records.map((a) => a.id);

    if (viewer === "manager") {
      const [roster, submissions] = await Promise.all([
        assignmentsRepository.findBatchRoster(trainingClass.batchId),
        assignmentsRepository.findSubmissions(ids),
      ]);
      const currentIds = new Set(roster.map((r) => r.studentId));

      for (const view of views) {
        const own = submissions.filter((s) => s.assignment_id === view.id);
        const byStudent = new Map(own.map((s) => [s.student_id, s]));
        const entries: AssignmentRosterEntry[] = roster.map((r) => {
          const s = byStudent.get(r.studentId);
          return {
            studentId: r.studentId,
            name: r.name,
            studentCode: r.studentCode,
            current: true,
            submission: s ? toSubmissionView(s, view.dueAt) : null,
          };
        });
        // Submissions of students no longer enrolled: read-only history.
        for (const s of own) {
          if (currentIds.has(s.student_id)) continue;
          entries.push({
            studentId: s.student_id,
            name: s.students?.full_name ?? "Unknown student",
            studentCode: s.students?.student_code ?? "",
            current: false,
            submission: toSubmissionView(s, view.dueAt),
          });
        }
        view.roster = entries;
      }
    } else if (viewer === "student") {
      // RLS returns only the student's own submissions.
      const submissions = await assignmentsRepository.findSubmissions(ids);
      for (const view of views) {
        const own = submissions.find((s) => s.assignment_id === view.id && s.student_id === user.id);
        view.ownSubmission = own ? toSubmissionView(own, view.dueAt) : null;
      }
    }

    return {
      classId: trainingClass.id,
      viewer,
      classCancelled,
      notice: notices.length > 0 ? notices.join(" ") : null,
      assignments: views,
    };
  },

  /** Create a draft assignment. Returns the class id (for revalidation). */
  async createAssignment(classId: string, input: AssignmentInput): Promise<string> {
    const user = await requireUser();
    const trainingClass = await requireManagedClass(user, classId);
    if (trainingClass.status === "cancelled") {
      throw new AssignmentValidationError("Assignments can't be created for a cancelled class.");
    }
    const fields = validateAssignment(input);
    await assignmentsRepository.insertAssignment(trainingClass.id, trainingClass.batchId, fields);
    return trainingClass.id;
  },

  /** Edit an assignment's details (any status). Returns the class id. */
  async updateAssignment(assignmentId: string, input: AssignmentInput): Promise<string> {
    const user = await requireUser();
    const { assignment, trainingClass } = await requireManagedAssignment(user, assignmentId);
    const fields = validateAssignment(input);

    if (fields.max_score !== null && fields.max_score !== assignment.max_score) {
      const topScore = await assignmentsRepository.findTopScore(assignment.id);
      if (topScore !== null && topScore > fields.max_score) {
        throw new AssignmentValidationError(`Maximum score can't be lower than an existing score (${topScore}).`);
      }
    }

    await assignmentsRepository.updateAssignment(assignment.id, fields);
    return trainingClass.id;
  },

  /** Lifecycle: draft → published → closed, closed → published. Returns the class id. */
  async changeStatus(assignmentId: string, next: AssignmentStatus): Promise<string> {
    const user = await requireUser();
    const { assignment, trainingClass } = await requireManagedAssignment(user, assignmentId);

    if (!NEXT_STATUSES[assignment.status].includes(next)) {
      throw new AssignmentValidationError(
        next === "draft"
          ? "A published assignment can't be moved back to draft."
          : `A ${assignment.status} assignment can't be moved to ${next}.`
      );
    }
    if (next === "published" && trainingClass.status === "cancelled") {
      throw new AssignmentValidationError("Assignments can't be published for a cancelled class.");
    }

    await assignmentsRepository.setAssignmentStatus(assignment.id, next);
    return trainingClass.id;
  },

  /** Delete a draft assignment (it can have no submissions). Returns the class id. */
  async deleteAssignment(assignmentId: string): Promise<string> {
    const user = await requireUser();
    const { assignment, trainingClass } = await requireManagedAssignment(user, assignmentId);
    if (assignment.status !== "draft") {
      throw new AssignmentValidationError("Only draft assignments can be deleted. Close it instead.");
    }
    const deleted = await assignmentsRepository.deleteAssignment(assignment.id);
    if (!deleted) throw new AssignmentAuthorizationError("That assignment couldn't be deleted.");
    return trainingClass.id;
  },

  /** A student submits or resubmits their own work (link + optional note). Returns the class id. */
  async submit(assignmentId: string, input: SubmissionInput): Promise<string> {
    const user = await requireUser();
    if (user.role !== "student") throw new AssignmentAuthorizationError("Only students can submit assignments.");
    if (authConfig.mode === "demo") throw new AssignmentValidationError("Assignments aren't available in demo mode.");

    // RLS: students only see published/closed assignments of enrolled batches.
    const assignment = await assignmentsRepository.findById(assignmentId);
    if (!assignment) throw new AssignmentAuthorizationError("That assignment doesn't exist or isn't available to you.");
    if (assignment.status !== "published") {
      throw new AssignmentValidationError("This assignment is closed and no longer accepts submissions.");
    }

    // Scoped to the student's enrolled batches.
    const trainingClass = await classesService.getClass(assignment.class_id);
    if (!trainingClass) throw new AssignmentAuthorizationError("That class isn't available to you.");
    if (trainingClass.status === "cancelled") {
      throw new AssignmentValidationError("This class was cancelled, so submissions aren't accepted.");
    }

    const enrolment = await assignmentsRepository.findEnrolmentStatus(assignment.batch_id, user.id);
    if (enrolment === null || enrolment === "withdrawn") {
      throw new AssignmentAuthorizationError("Only students currently enrolled in this batch can submit.");
    }

    const existing = await assignmentsRepository.findSubmission(assignment.id, user.id);
    if (existing?.status === "returned") {
      throw new AssignmentValidationError(
        "Your submission has been returned. Ask your trainer to reopen it if you need to resubmit."
      );
    }

    const submissionUrl = optionalLink(input.submissionUrl, "Submission link");
    if (!submissionUrl) throw new AssignmentValidationError("A link to your work is required.");
    const note = optionalText(input.note, ASSIGNMENT_LIMITS.noteMax, "Note");

    await assignmentsRepository.upsertSubmission(assignment.id, assignment.batch_id, user.id, submissionUrl, note);
    return trainingClass.id;
  },

  /** Return a submission with an optional score and feedback. Returns the class id. */
  async returnSubmission(assignmentId: string, studentId: string, review: ReviewInput): Promise<string> {
    const user = await requireUser();
    const { assignment, trainingClass } = await requireManagedAssignment(user, assignmentId);

    const submission = await assignmentsRepository.findSubmission(assignment.id, studentId);
    if (!submission) throw new AssignmentValidationError("That student hasn't submitted this assignment.");

    let score: number | null = null;
    if (review.score !== null) {
      score = validNumber(review.score, "Score");
      if (score < 0) throw new AssignmentValidationError("Score can't be negative.");
      if (assignment.max_score !== null && score > assignment.max_score) {
        throw new AssignmentValidationError(`Score can't be more than the maximum score (${assignment.max_score}).`);
      }
    }
    const feedback = optionalText(review.feedback, ASSIGNMENT_LIMITS.feedbackMax, "Feedback");

    await assignmentsRepository.updateReview(assignment.id, studentId, { status: "returned", score, feedback });
    return trainingClass.id;
  },

  /** Reopen a returned submission: clears the review so the student can resubmit. Returns the class id. */
  async reopenSubmission(assignmentId: string, studentId: string): Promise<string> {
    const user = await requireUser();
    const { assignment, trainingClass } = await requireManagedAssignment(user, assignmentId);

    const submission = await assignmentsRepository.findSubmission(assignment.id, studentId);
    if (!submission) throw new AssignmentValidationError("That student hasn't submitted this assignment.");
    if (submission.status !== "returned") throw new AssignmentValidationError("Only returned submissions can be reopened.");

    await assignmentsRepository.updateReview(assignment.id, studentId, { status: "submitted", score: null, feedback: null });
    return trainingClass.id;
  },
};

export { AssignmentRepositoryError };
