/**
 * Class Management — Phase 1 domain model.
 *
 * A Class is the central training activity linking Course → Module →
 * Batch → Trainer. Future phases (recording, materials, assignment,
 * attendance, test, performance) attach to a class by `id` rather
 * than duplicating data here, so none of them require a redesign of
 * this model.
 */

export type ClassStatus = "scheduled" | "live" | "completed" | "cancelled";

export type ClassType = "online" | "offline" | "hybrid";

export const CLASS_STATUSES: ClassStatus[] = ["scheduled", "live", "completed", "cancelled"];
export const CLASS_TYPES: ClassType[] = ["online", "offline", "hybrid"];

export interface TrainingClass {
  id: string;
  courseId: string;
  /** Optional: some classes (e.g. orientation) aren't tied to a specific module. */
  moduleId: string | null;
  batchId: string;
  trainerId: string;
  title: string;
  description: string | null;
  /** ISO date, YYYY-MM-DD. */
  classDate: string;
  /** 24h time, HH:mm. */
  startTime: string;
  endTime: string;
  teamsMeetingUrl: string | null;
  status: ClassStatus;
  classType: ClassType;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A class plus the human-readable labels resolved from its related
 * rows. Produced by a single joined query in the repository — never
 * by issuing one lookup per class (avoids N+1).
 */
export interface ClassWithRelations extends TrainingClass {
  courseTitle: string;
  moduleTitle: string | null;
  batchName: string;
  trainerName: string;
}

export interface CreateClassInput {
  courseId: string;
  moduleId: string | null;
  batchId: string;
  trainerId: string;
  title: string;
  description: string | null;
  classDate: string;
  startTime: string;
  endTime: string;
  teamsMeetingUrl: string | null;
  classType: ClassType;
  status: ClassStatus;
  notes: string | null;
}

export type UpdateClassInput = Partial<CreateClassInput>;

/** Named date windows offered by the Classes list filter bar. */
export type ClassDateRange = "all" | "today" | "upcoming" | "this_week" | "completed" | "custom";

export interface ClassFilters {
  search?: string;
  courseId?: string;
  moduleId?: string;
  batchId?: string;
  trainerId?: string;
  status?: ClassStatus | "all";
  classType?: ClassType | "all";
  dateRange?: ClassDateRange;
  /** Only used when dateRange === "custom". */
  dateFrom?: string;
  dateTo?: string;
}

/** Field-level validation errors, keyed by CreateClassInput field name. */
export type ClassValidationErrors = Partial<Record<keyof CreateClassInput, string>> & {
  form?: string;
};

export interface ClassSummaryCounts {
  today: number;
  upcoming: number;
  completed: number;
  cancelled: number;
}

/**
 * Option lists for the Classes filter bar and create/edit form.
 * Lives here rather than beside its server-only provider so client
 * components can import the type without touching a `server-only`
 * module.
 */
export interface ClassFilterOptions {
  /**
   * `selectable` = may be chosen for a NEW class or a changed link
   * (published courses, upcoming/ongoing batches, active trainers).
   * Non-selectable entries stay listed so the filter bar and existing
   * classes still show them.
   */
  courses: {
    id: string;
    title: string;
    /** draft / published / archived (Supabase mode). Archived courses are selectable only while they have a current batch. */
    status?: string;
    selectable: boolean;
  }[];
  modules: { id: string; title: string; courseId: string }[];
  /**
   * `courseId` lets the form offer only batches of the chosen course;
   * `trainerId` (null = not yet assigned) is the batch's designated
   * trainer, which every class in the batch must use.
   */
  batches: { id: string; name: string; courseId: string; trainerId: string | null; selectable: boolean }[];
  trainers: { id: string; name: string; selectable: boolean }[];
}
