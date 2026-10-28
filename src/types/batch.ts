export type BatchStatus = "upcoming" | "ongoing" | "completed" | "cancelled";

/**
 * Mirrors public.batches (0003_core_training_model.sql). Enrolled
 * students live in batch_students and are not stored on the batch.
 */
export interface Batch {
  id: string;
  batchCode: string;
  courseId: string;
  /** Null until a trainer is assigned. */
  trainerId: string | null;
  name: string;
  startDate: string;
  endDate: string;
  status: BatchStatus;
  maxSeats: number;
  createdAt: string;
  updatedAt: string;
}

/** What the Add Batch form sends. Status is never part of it: new batches are always "upcoming". */
export interface CreateBatchInput {
  batchCode: string;
  name: string;
  courseId: string;
  /** Optional: a batch can be created before a trainer is assigned. */
  trainerId: string | null;
  /** ISO date, YYYY-MM-DD. */
  startDate: string;
  /** ISO date, YYYY-MM-DD. */
  endDate: string;
  maxSeats: number;
}

export type BatchValidationErrors = Partial<Record<keyof CreateBatchInput, string>> & {
  form?: string;
};

/** Form limits (the database requires non-blank code/name, end ≥ start and max seats > 0). */
export const BATCH_INPUT_LIMITS = {
  codeMax: 50,
  nameMax: 150,
  maxSeatsMax: 10000,
} as const;

/** Course and trainer choices for the Add Batch form (read with the caller's session). */
export interface BatchFormOptions {
  courses: { id: string; title: string; selectable: boolean }[];
  trainers: { id: string; name: string; selectable: boolean }[];
}

/**
 * A batch as shown in the Batches table (admin and trainer). Built from
 * public.batches + its course, trainer and enrolments (Supabase mode),
 * or from the demo data (demo mode).
 */
export interface BatchSummary {
  id: string;
  name: string;
  course: string;
  /** The course's status (Supabase mode): an archived course's upcoming batches take no new students (0030). */
  courseStatus?: string;
  /** Assigned trainer's name, or "Trainer not assigned". */
  trainer: string;
  /** Assigned trainer's id (Supabase mode); null when none is assigned. */
  trainerId?: string | null;
  /**
   * True when a trainer is assigned but is no longer available (inactive
   * record, not a trainer, or an invited/suspended account) — shown so a
   * Super Admin can reassign the batch.
   */
  trainerUnavailable?: boolean;
  /** Distinct students whose enrolment isn't withdrawn (enrolled + completed) — the seats in use. */
  students: number;
  maxSeats: number;
  /** ISO date, YYYY-MM-DD. */
  startDate: string;
  /** ISO date, YYYY-MM-DD. */
  endDate: string;
  status: BatchStatus;
}
