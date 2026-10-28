/**
 * Add Batch — validation and the create flow, as pure functions so they
 * can be tested without a database. batches.service.ts wires the real
 * session, option lists and repository. The database (RLS + table
 * constraints) remains the final authority.
 */
import type { AuthUser } from "@/types/auth";
import { BATCH_INPUT_LIMITS, type BatchFormOptions, type BatchValidationErrors, type CreateBatchInput } from "@/types/batch";

export class BatchCreateAuthorizationError extends Error {
  constructor(message = "Only a Super Admin can create batches.") {
    super(message);
    this.name = "BatchCreateAuthorizationError";
  }
}

export class BatchCreateValidationError extends Error {
  readonly errors: BatchValidationErrors;
  constructor(errors: BatchValidationErrors) {
    super("The batch details are invalid.");
    this.name = "BatchCreateValidationError";
    this.errors = errors;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Validate the form against the caller's available courses/trainers.
 * Returns field errors (empty when valid) and the cleaned input.
 * Status is not accepted — new batches are always "upcoming".
 */
export function validateCreateBatchInput(
  input: Partial<CreateBatchInput> | null | undefined,
  options: BatchFormOptions
): { errors: BatchValidationErrors; clean: CreateBatchInput } {
  const errors: BatchValidationErrors = {};
  const batchCode = text(input?.batchCode);
  const name = text(input?.name);
  const courseId = text(input?.courseId);
  const trainerId = text(input?.trainerId) || null;
  const startDate = text(input?.startDate);
  const endDate = text(input?.endDate);
  const maxSeats = input?.maxSeats;

  if (!batchCode) errors.batchCode = "Batch code is required.";
  else if (batchCode.length > BATCH_INPUT_LIMITS.codeMax) errors.batchCode = `Batch code must be ${BATCH_INPUT_LIMITS.codeMax} characters or fewer.`;

  if (!name) errors.name = "Batch name is required.";
  else if (name.length > BATCH_INPUT_LIMITS.nameMax) errors.name = `Batch name must be ${BATCH_INPUT_LIMITS.nameMax} characters or fewer.`;

  const course = options.courses.find((c) => c.id === courseId);
  if (!courseId) errors.courseId = "Select a course.";
  else if (!course) errors.courseId = "Select a valid course.";
  else if (!course.selectable) errors.courseId = "This course isn't active, so a batch can't be created for it.";

  if (trainerId) {
    const trainer = options.trainers.find((t) => t.id === trainerId);
    if (!trainer) errors.trainerId = "Select a valid trainer, or leave the trainer unassigned.";
    else if (!trainer.selectable) errors.trainerId = "This trainer isn't active.";
  }

  if (!isIsoDate(startDate)) errors.startDate = "Enter a valid start date.";
  if (!isIsoDate(endDate)) errors.endDate = "Enter a valid end date.";
  else if (isIsoDate(startDate) && endDate < startDate) errors.endDate = "The end date can't be before the start date.";

  if (typeof maxSeats !== "number" || !Number.isInteger(maxSeats) || maxSeats < 1) {
    errors.maxSeats = "Max seats must be a whole number of at least 1.";
  } else if (maxSeats > BATCH_INPUT_LIMITS.maxSeatsMax) {
    errors.maxSeats = `Max seats must be ${BATCH_INPUT_LIMITS.maxSeatsMax.toLocaleString("en-IN")} or fewer.`;
  }

  return {
    errors,
    clean: { batchCode, name, courseId, trainerId, startDate, endDate, maxSeats: typeof maxSeats === "number" ? maxSeats : 0 },
  };
}

/** A repository failure the create flow understands. */
export interface BatchInsertFailure {
  /** "duplicate_code": the batch code already exists (unique constraint). */
  kind: "duplicate_code" | "invalid_reference" | "rejected" | "permission" | "unavailable" | "trainer_unavailable" | "course_unavailable";
}

/**
 * What an insert failure means, from the Postgres code the repository
 * keeps on its error: 23505 unique (batch code taken) · 23503 foreign
 * key (course/trainer gone) · 23514/23502/22007/22008 check, not-null or
 * date · 42501 RLS / permission. Anything else is unexpected. The 0021
 * guard refuses an unavailable trainer with 23514 + hint
 * "trainer_not_available", and the 0030 guard a course that isn't
 * published with 23514 + hint "course_not_published" (both checked first).
 */
export function classifyBatchInsertError(error: unknown): BatchInsertFailure["kind"] | null {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const hint = error && typeof error === "object" && "hint" in error ? String((error as { hint?: unknown }).hint ?? "") : "";
  if (code === "23514" && hint === "trainer_not_available") return "trainer_unavailable";
  if (code === "23514" && hint === "course_not_published") return "course_unavailable";
  if (code === "23505") return "duplicate_code";
  if (code === "23503") return "invalid_reference";
  if (code === "23514" || code === "23502" || code === "22007" || code === "22008") return "rejected";
  if (code === "42501") return "permission";
  return null;
}

export interface CreateBatchDeps {
  getCurrentUser: () => Promise<AuthUser | null>;
  getOptions: () => Promise<BatchFormOptions>;
  /** Insert with the caller's own session; resolves the new id, or rejects with a BatchInsertFailure-like error. */
  insert: (input: CreateBatchInput, createdBy: string) => Promise<string>;
  /** Classify an insert error (e.g. Postgres 23505 → duplicate_code). */
  classify: (error: unknown) => BatchInsertFailure["kind"] | null;
}

/**
 * Super Admin only. Validates, then inserts as status "upcoming". A
 * duplicate code (the database's unique constraint) comes back as a
 * field error, never as a raw database message.
 */
export async function createBatchWith(deps: CreateBatchDeps, input: Partial<CreateBatchInput>): Promise<{ id: string }> {
  const user = await deps.getCurrentUser();
  if (!user) throw new BatchCreateAuthorizationError("You need to be signed in.");
  if (user.role !== "admin") throw new BatchCreateAuthorizationError();

  const { errors, clean } = validateCreateBatchInput(input, await deps.getOptions());
  if (Object.keys(errors).length > 0) throw new BatchCreateValidationError(errors);

  try {
    return { id: await deps.insert(clean, user.id) };
  } catch (err) {
    switch (deps.classify(err)) {
      case "duplicate_code":
        throw new BatchCreateValidationError({ batchCode: "A batch with this code already exists. Use a different code." });
      case "trainer_unavailable":
        throw new BatchCreateValidationError({
          trainerId: "This trainer isn't available (an active trainer with an active account is required). Choose another trainer or leave it unassigned.",
        });
      case "course_unavailable":
        throw new BatchCreateValidationError({
          courseId: "This course isn't active (it may have been deactivated or moved back to draft). Choose an active course.",
        });
      case "invalid_reference":
        throw new BatchCreateValidationError({ form: "The selected course or trainer no longer exists. Reload the page and try again." });
      case "rejected":
        throw new BatchCreateValidationError({ form: "The database rejected these batch details. Check the dates and seats and try again." });
      case "permission":
        throw new BatchCreateAuthorizationError();
      default:
        throw err;
    }
  }
}
