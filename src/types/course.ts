export type CourseLevel = "foundation" | "intermediate" | "advanced";

export type CourseStatus = "draft" | "published" | "archived";

/** Editable course details. The course code is never input: the database assigns it (0030). */
export interface CourseDetailsInput {
  title: string;
  description: string;
  level: CourseLevel;
  /** Planned total duration of the course, in hours. */
  durationHours: number;
}

/** Add Course form input. New courses start as draft or published (never archived). */
export interface CreateCourseInput extends CourseDetailsInput {
  status: Exclude<CourseStatus, "archived">;
}

export type CourseValidationErrors = Partial<Record<keyof CreateCourseInput, string>> & {
  form?: string;
};

/** Add / edit module input. The module code and position are assigned by the database. */
export interface ModuleInput {
  title: string;
  description: string;
  durationHours: number;
}

/** Edit module: planned hours are sent only when they change (so a legacy 0-hour module stays editable). */
export type ModuleUpdateInput = Omit<ModuleInput, "durationHours"> & { durationHours?: number };

export type ModuleValidationErrors = Partial<Record<keyof ModuleInput, string>> & { form?: string };

/** Form limits — the same limits the 0030 functions enforce (numeric(6, 1) hours). */
export const COURSE_INPUT_LIMITS = {
  titleMax: 150,
  descriptionMax: 2000,
  moduleDescriptionMax: 1000,
  durationMax: 9999.9,
} as const;

export const COURSE_LEVELS: readonly CourseLevel[] = ["foundation", "intermediate", "advanced"];

/** A batch that uses the course (the batch owns its dates, trainer, students and records). */
export interface CourseBatchSummary {
  id: string;
  batchCode: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  trainerName: string | null;
}

/** Course Management state for the Super Admin course page (from admin_course_usage). */
export interface CourseUsage {
  /** Delivered training exists: title, level, duration and modules are locked. */
  hasHistory: boolean;
  /** Nothing references the course: it may be deleted (otherwise it is archived). */
  canDelete: boolean;
  batchCount: number;
  /** Batches archiving affects: upcoming ones take no new students; ongoing ones continue. */
  upcomingBatchCount: number;
  ongoingBatchCount: number;
  /** Pending invitations into its upcoming batches (they'd activate the account without enrolling it once archived). */
  pendingUpcomingInvitationCount: number;
  classCount: number;
  questionCount: number;
  batches: CourseBatchSummary[];
}

/** One course_events row, as shown in Course history. */
export interface CourseHistoryEntry {
  id: number;
  occurredAt: string;
  eventType: string;
  /** "you", an actor id, or null (system / SQL Editor). */
  actor: string | null;
  summary: string;
}

export interface Course {
  id: string;
  courseCode: string;
  title: string;
  description: string;
  level: CourseLevel;
  durationHours: number;
  status: CourseStatus;
  moduleIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A course as shown on the Courses grid. Built from public.courses +
 * its modules + its batches' trainers (Supabase mode), or from the
 * demo data (demo mode).
 *
 * `topics` and `progress` have no data source in the database yet
 * (topics aren't modelled; progress needs Attendance/Tests), so they
 * are left undefined there and the UI hides them.
 */
export interface CourseSummary {
  id: string;
  /** Database-assigned code (Supabase mode). */
  courseCode?: string;
  title: string;
  description: string;
  status: CourseStatus;
  modules: number;
  durationHours: number;
  /** Batch trainer name(s), or "Trainer not assigned". */
  trainer: string;
  topics?: number;
  progress?: number;
}

export type CourseModuleProgress = "completed" | "in_progress" | "not_started";

export interface CourseDetailModule {
  id: string;
  sequence: number;
  title: string;
  /** Database-assigned module code (Supabase mode). */
  moduleCode?: string;
  description?: string | null;
  durationHours?: number;
  /** Not modelled in the database yet — hidden when undefined. */
  topics?: number;
  /** Learner progress — hidden when undefined (no Attendance/Tests data yet). */
  status?: CourseModuleProgress;
}

/** A single course as shown on the course detail page. */
export interface CourseDetail {
  id: string;
  /** Database-assigned code, level and status (Supabase mode). */
  courseCode?: string;
  level?: CourseLevel;
  status?: CourseStatus;
  title: string;
  description: string;
  durationHours: number;
  /** Batch trainer name(s), or "Trainer not assigned". */
  trainer: string;
  modules: CourseDetailModule[];
  topics?: number;
  progress?: number;
}
