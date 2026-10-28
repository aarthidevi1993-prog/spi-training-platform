import "server-only";
import { authService } from "./auth.service";
import { classesRepository, ClassRepositoryError, type ClassScope } from "@/repositories/classes.repository";
import { DEMO_STUDENT_BATCH_ID, DEMO_TRAINER_ID } from "@/lib/mock/classes.mock";
import { authConfig } from "@/config/auth";
import { getClassFilterOptions } from "@/lib/classes/filter-options";
import type {
  ClassFilterOptions,
  ClassFilters,
  ClassSummaryCounts,
  ClassValidationErrors,
  ClassWithRelations,
  CreateClassInput,
  UpdateClassInput,
} from "@/types/class";
import type { AuthUser } from "@/types/auth";

/**
 * Classes service — business rules, validation and authorization.
 *
 * Every exported function resolves the caller's identity server-side
 * via authService (never from a client-supplied argument) and derives
 * the data scope from it. UI code and Server Actions call this; they
 * never call classesRepository directly.
 */

export class ClassAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ClassAuthorizationError";
  }
}

export class ClassValidationError extends Error {
  readonly errors: ClassValidationErrors;
  constructor(errors: ClassValidationErrors) {
    super("The class details are invalid.");
    this.name = "ClassValidationError";
    this.errors = errors;
  }
}

// -------------------------------------------------------------------
// Scope resolution
// -------------------------------------------------------------------

/**
 * Maps the authenticated user to the slice of class data they may
 * see. Admin: everything. Trainer: their own classes. Student: the
 * classes of the batches they are enrolled in (or completed).
 *
 * Supabase mode: trainers.id = students.id = the auth user id, and a
 * student's batches come from batch_students. Demo mode uses the fixed
 * demo identities. RLS enforces the same boundaries in the database;
 * this scope is the defence-in-depth second layer.
 */
async function resolveScope(user: AuthUser): Promise<ClassScope> {
  switch (user.role) {
    case "admin":
      return {};
    case "trainer":
      return { trainerId: ownTrainerId(user) };
    case "student":
      return {
        batchIds:
          authConfig.mode === "demo"
            ? [DEMO_STUDENT_BATCH_ID]
            : await classesRepository.findEnrolledBatchIds(user.id),
      };
    default:
      // Unknown role — fail closed with a scope that matches nothing.
      return { batchIds: [] };
  }
}

/** The trainer id a trainer's classes are assigned to. */
function ownTrainerId(user: AuthUser): string {
  return authConfig.mode === "demo" ? DEMO_TRAINER_ID : user.id;
}

async function requireUser(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new ClassAuthorizationError("You need to be signed in.");
  return user;
}

function canManage(user: AuthUser): boolean {
  return user.role === "admin" || user.role === "trainer";
}

// -------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Shared by create (full input) and update (partial patch). */
export function validateClassInput(input: Partial<CreateClassInput>, requireAll: boolean): ClassValidationErrors {
  const errors: ClassValidationErrors = {};

  if (requireAll || input.courseId !== undefined) {
    if (!input.courseId?.trim()) errors.courseId = "Course is required.";
  }
  if (requireAll || input.batchId !== undefined) {
    if (!input.batchId?.trim()) errors.batchId = "Batch is required.";
  }
  if (requireAll || input.trainerId !== undefined) {
    if (!input.trainerId?.trim()) errors.trainerId = "Trainer is required.";
  }
  if (requireAll || input.title !== undefined) {
    if (!input.title?.trim()) errors.title = "Class title is required.";
    else if (input.title.trim().length > 200) errors.title = "Title must be 200 characters or fewer.";
  }
  if (requireAll || input.classDate !== undefined) {
    if (!input.classDate?.trim()) errors.classDate = "Date is required.";
    else if (!DATE_PATTERN.test(input.classDate)) errors.classDate = "Enter a valid date.";
  }
  if (requireAll || input.startTime !== undefined) {
    if (!input.startTime?.trim()) errors.startTime = "Start time is required.";
    else if (!TIME_PATTERN.test(input.startTime)) errors.startTime = "Enter a valid time (HH:MM).";
  }
  if (requireAll || input.endTime !== undefined) {
    if (!input.endTime?.trim()) errors.endTime = "End time is required.";
    else if (!TIME_PATTERN.test(input.endTime)) errors.endTime = "Enter a valid time (HH:MM).";
  }

  // End must be after start — only checkable when both are present and well-formed.
  if (
    input.startTime &&
    input.endTime &&
    TIME_PATTERN.test(input.startTime) &&
    TIME_PATTERN.test(input.endTime) &&
    input.endTime <= input.startTime
  ) {
    errors.endTime = "End time must be after the start time.";
  }

  if (input.teamsMeetingUrl != null && input.teamsMeetingUrl.trim() !== "") {
    if (!isValidHttpUrl(input.teamsMeetingUrl.trim())) {
      errors.teamsMeetingUrl = "Enter a valid meeting link starting with http:// or https://";
    }
  }

  return errors;
}

/** Trim strings and normalise empty optional fields to null before persisting. */
function normalise(input: CreateClassInput): CreateClassInput {
  const trimOrNull = (v: string | null) => {
    const t = v?.trim();
    return t ? t : null;
  };

  return {
    ...input,
    courseId: input.courseId.trim(),
    moduleId: trimOrNull(input.moduleId),
    batchId: input.batchId.trim(),
    trainerId: input.trainerId.trim(),
    title: input.title.trim(),
    description: trimOrNull(input.description),
    teamsMeetingUrl: trimOrNull(input.teamsMeetingUrl),
    notes: trimOrNull(input.notes),
  };
}

type ClassLinks = Pick<CreateClassInput, "courseId" | "moduleId" | "batchId" | "trainerId">;

/**
 * Checks the course / module / batch / trainer combination against the
 * option lists the caller is allowed to see (RLS-scoped in Supabase
 * mode). Mirrors the database rules so users get a clear field error
 * instead of a generic database failure:
 *   - batch and module must belong to the class's course (composite FKs)
 *   - the class's trainer must be the batch's assigned trainer
 *     (classes_enforce_batch_trainer trigger)
 *   - trainers may only use batches they run (classes_trainer_* RLS)
 * plus the UX-only scheduling rules: new/changed links must be
 * selectable (published course, upcoming/ongoing batch, active trainer).
 *
 * With `previous` (an update), only links that actually changed are
 * checked, so editing an existing class — e.g. one in a batch that has
 * since completed — isn't blocked by rules for new scheduling.
 */
async function validateRelationships(
  links: ClassLinks,
  user: AuthUser,
  options: ClassFilterOptions,
  previous?: ClassLinks
): Promise<ClassValidationErrors> {
  const changed = (key: keyof ClassLinks) => !previous || links[key] !== previous[key];
  const errors: ClassValidationErrors = {};

  if (previous && !changed("courseId") && !changed("moduleId") && !changed("batchId") && !changed("trainerId")) {
    return errors;
  }

  const course = options.courses.find((c) => c.id === links.courseId);
  if (!course) {
    errors.courseId = "Select a valid course.";
  } else if (changed("courseId") && !course.selectable) {
    errors.courseId = "This course isn't open for scheduling (a draft, or inactive with no upcoming or ongoing batch).";
  }

  const batch = options.batches.find((b) => b.id === links.batchId);
  if (!batch) {
    errors.batchId = "Select a valid batch.";
  } else if (batch.courseId !== links.courseId) {
    errors.batchId = "This batch belongs to a different course.";
  } else if (changed("batchId") && !batch.selectable) {
    errors.batchId = "This batch is completed or cancelled.";
  } else if (changed("batchId") || changed("trainerId")) {
    if (!batch.trainerId) {
      errors.batchId = "Assign a trainer to this batch before scheduling classes.";
    } else if (user.role === "trainer" && batch.trainerId !== ownTrainerId(user)) {
      errors.batchId = "You can only schedule classes for batches you run.";
    } else if (links.trainerId !== batch.trainerId) {
      errors.trainerId = "The trainer must be this batch's assigned trainer.";
    }
  }

  if (links.moduleId && (changed("moduleId") || changed("courseId"))) {
    const courseModule = options.modules.find((m) => m.id === links.moduleId);
    if (!courseModule || courseModule.courseId !== links.courseId) {
      errors.moduleId = "This module doesn't belong to the selected course.";
    }
  }

  if (user.role === "admin" && changed("trainerId") && !errors.trainerId) {
    const trainer = options.trainers.find((t) => t.id === links.trainerId);
    if (!trainer) {
      errors.trainerId = "Select a valid trainer.";
    } else if (!trainer.selectable) {
      errors.trainerId = "This trainer isn't active.";
    }
  }

  return errors;
}

/**
 * A trainer may only change or cancel classes in batches they
 * currently run — the same rule as the classes_trainer_update policy,
 * checked first so the user gets a clear message rather than a
 * database rejection (e.g. for a past class in a batch that has since
 * been reassigned to another trainer).
 */
function assertTrainerRunsBatch(user: AuthUser, batchId: string, options: ClassFilterOptions): void {
  if (user.role !== "trainer") return;
  const batch = options.batches.find((b) => b.id === batchId);
  if (!batch || batch.trainerId !== ownTrainerId(user)) {
    throw new ClassAuthorizationError("You can only change classes in batches you currently run.");
  }
}

// -------------------------------------------------------------------
// Service
// -------------------------------------------------------------------

export const classesService = {
  /** Classes visible to the current user, honouring their role scope. */
  async listClasses(filters: ClassFilters = {}): Promise<ClassWithRelations[]> {
    const user = await requireUser();
    return classesRepository.findAll(filters, await resolveScope(user));
  },

  /** A single class, or null if it doesn't exist *or* is out of the caller's scope. */
  async getClass(id: string): Promise<ClassWithRelations | null> {
    const user = await requireUser();
    return classesRepository.findById(id, await resolveScope(user));
  },

  /** Counts for the dashboard/summary cards, computed from the caller's own scope. */
  async getSummary(): Promise<ClassSummaryCounts> {
    const user = await requireUser();
    const all = await classesRepository.findAll({}, await resolveScope(user));
    const today = new Date().toISOString().slice(0, 10);

    return {
      today: all.filter((c) => c.classDate === today && c.status !== "cancelled").length,
      upcoming: all.filter((c) => c.classDate > today && c.status !== "cancelled").length,
      completed: all.filter((c) => c.status === "completed").length,
      cancelled: all.filter((c) => c.status === "cancelled").length,
    };
  },

  async createClass(input: CreateClassInput): Promise<ClassWithRelations> {
    const user = await requireUser();
    if (!canManage(user)) throw new ClassAuthorizationError("Only admins and trainers can create classes.");

    // A trainer may only ever create classes assigned to themselves —
    // enforced here as well as by RLS, so a forged trainerId in the
    // form payload can't reassign the class. Applied before validation
    // because the trainer field is locked (empty) in their form.
    const candidate: CreateClassInput =
      user.role === "trainer" ? { ...input, trainerId: ownTrainerId(user) } : input;

    const errors = validateClassInput(candidate, true);
    if (Object.keys(errors).length > 0) throw new ClassValidationError(errors);

    const clean = normalise(candidate);

    const linkErrors = await validateRelationships(clean, user, await getClassFilterOptions());
    if (Object.keys(linkErrors).length > 0) throw new ClassValidationError(linkErrors);

    return classesRepository.create(clean, user.id);
  },

  async updateClass(id: string, patch: UpdateClassInput): Promise<ClassWithRelations> {
    const user = await requireUser();
    if (!canManage(user)) throw new ClassAuthorizationError("Only admins and trainers can edit classes.");

    // Trainers can't reassign a class to someone else.
    if (user.role === "trainer") delete patch.trainerId;

    const errors = validateClassInput(patch, false);
    const scope = await resolveScope(user);

    const touchesTimes = Boolean(patch.startTime || patch.endTime);
    const touchesLinks =
      patch.courseId !== undefined ||
      patch.moduleId !== undefined ||
      patch.batchId !== undefined ||
      patch.trainerId !== undefined;

    // A partial patch can still break the time range or the
    // course/module/batch/trainer relationship against values already
    // stored, so re-validate against the persisted row. Trainers are
    // always checked against the persisted row: they may only change
    // classes in batches they currently run.
    if (touchesTimes || touchesLinks || user.role === "trainer") {
      const existing = await classesRepository.findById(id, scope);
      if (!existing) throw new ClassAuthorizationError("That class doesn't exist or isn't available to you.");

      const options = touchesLinks || user.role === "trainer" ? await getClassFilterOptions() : null;
      if (options) assertTrainerRunsBatch(user, existing.batchId, options);

      if (touchesTimes) {
        const start = patch.startTime ?? existing.startTime;
        const end = patch.endTime ?? existing.endTime;
        if (end <= start) errors.endTime = "End time must be after the start time.";
      }

      if (options && touchesLinks && Object.keys(errors).length === 0) {
        const previous: ClassLinks = {
          courseId: existing.courseId,
          moduleId: existing.moduleId,
          batchId: existing.batchId,
          trainerId: existing.trainerId,
        };
        const next: ClassLinks = {
          courseId: patch.courseId ?? existing.courseId,
          moduleId: patch.moduleId !== undefined ? patch.moduleId : existing.moduleId,
          batchId: patch.batchId ?? existing.batchId,
          // A trainer's class stays theirs; for admins the trainer
          // follows the batch unless explicitly (and validly) set.
          trainerId: patch.trainerId ?? existing.trainerId,
        };
        Object.assign(errors, await validateRelationships(next, user, options, previous));
      }
    }

    if (Object.keys(errors).length > 0) throw new ClassValidationError(errors);

    return classesRepository.update(id, patch, scope);
  },

  /** Cancelling is a status change, not a delete — history is preserved. */
  async cancelClass(id: string): Promise<ClassWithRelations> {
    const user = await requireUser();
    if (!canManage(user)) throw new ClassAuthorizationError("Only admins and trainers can cancel classes.");

    const scope = await resolveScope(user);
    if (user.role === "trainer") {
      const existing = await classesRepository.findById(id, scope);
      if (!existing) throw new ClassAuthorizationError("That class doesn't exist or isn't available to you.");
      assertTrainerRunsBatch(user, existing.batchId, await getClassFilterOptions());
    }

    return classesRepository.update(id, { status: "cancelled" }, scope);
  },

  /**
   * Hard delete. Admin-only, and refused for classes that already
   * happened so historical/attendance records can't be silently
   * destroyed — cancel those instead.
   */
  async deleteClass(id: string): Promise<void> {
    const user = await requireUser();
    if (user.role !== "admin") throw new ClassAuthorizationError("Only admins can delete classes.");

    const existing = await classesRepository.findById(id);
    if (!existing) return;

    if (existing.status === "completed") {
      throw new ClassAuthorizationError("Completed classes can't be deleted. Cancel or archive it instead.");
    }

    return classesRepository.remove(id);
  },
};

export { ClassRepositoryError };
