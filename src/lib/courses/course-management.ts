/**
 * Course Management — validation, refusal messages and history labels,
 * as pure functions so they can be tested without a database. The
 * database (0030: Super Admin functions, guards, history lock) is the
 * authority; this layer only refuses early and turns answers into safe
 * sentences. Course and module codes are never input: the database
 * assigns them.
 */
import {
  COURSE_INPUT_LIMITS,
  COURSE_LEVELS,
  type CourseDetailsInput,
  type CourseLevel,
  type CourseValidationErrors,
  type CreateCourseInput,
  type ModuleInput,
  type ModuleUpdateInput,
  type ModuleValidationErrors,
} from "@/types/course";

/**
 * Lifecycle names shown to people. The database keeps its statuses: draft · published · archived —
 * shown as Draft · Active · Inactive.
 */
export const COURSE_STATUS_LABEL: Record<string, string> = { draft: "Draft", published: "Active", archived: "Inactive" };
export const courseStatusLabel = (status: string | null | undefined) => (status ? COURSE_STATUS_LABEL[status] ?? status : "");

export const COURSE_PERMISSION_ERROR = "Only a Super Admin can manage courses.";
export const COURSE_GENERIC_ERROR = "Something went wrong. Please try again.";
export const COURSE_DEMO_ERROR = "Course management requires Supabase mode.";
/** The Course Management database update (migration 0030) isn't applied to this database. */
export const COURSE_MIGRATION_MISSING_TITLE = "Course management isn't set up in the database yet";
export const COURSE_MIGRATION_MISSING_ERROR =
  "This page needs the Course Management database update (migration 0030_course_management.sql), which hasn't been applied to this database. Ask your administrator to apply it.";

/** What every Course Management action returns to the browser (plain, serializable). */
export type CourseActionResult =
  | { ok: true; message: string; courseId?: string; courseCode?: string }
  | { ok: false; error: string; errors?: CourseValidationErrors & ModuleValidationErrors };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Hours: a finite number, more than 0 and at most 9999.9, at most one decimal place (numeric(6, 1)). */
export function hoursError(value: unknown, label = "Duration"): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${label} must be a number of hours.`;
  if (value <= 0) return `${label} must be more than 0 hours.`;
  if (value > COURSE_INPUT_LIMITS.durationMax) return `${label} must be ${COURSE_INPUT_LIMITS.durationMax.toLocaleString("en-IN")} hours or fewer.`;
  if (Math.round(value * 10) !== value * 10) return `${label} can have at most one decimal place.`;
  return null;
}

/** Course details (title, description, level, planned hours). Unknown keys are ignored, never forwarded. */
export function validateCourseDetails(input: Partial<CourseDetailsInput> | null | undefined): {
  errors: CourseValidationErrors;
  clean: CourseDetailsInput;
} {
  const errors: CourseValidationErrors = {};
  const title = text(input?.title);
  const description = text(input?.description);
  const level = text(input?.level) as CourseLevel;
  const durationHours = input?.durationHours;

  if (!title) errors.title = "Course title is required.";
  else if (title.length > COURSE_INPUT_LIMITS.titleMax) errors.title = `Course title must be ${COURSE_INPUT_LIMITS.titleMax} characters or fewer.`;
  if (description.length > COURSE_INPUT_LIMITS.descriptionMax) {
    errors.description = `Description must be ${COURSE_INPUT_LIMITS.descriptionMax.toLocaleString("en-IN")} characters or fewer.`;
  }
  if (!COURSE_LEVELS.includes(level)) errors.level = "Select a level.";
  const hours = hoursError(durationHours);
  if (hours) errors.durationHours = hours;

  return { errors, clean: { title, description, level, durationHours: typeof durationHours === "number" ? durationHours : 0 } };
}

/**
 * Edit Course: only the fields present are validated and sent — the form sends just what changed. An
 * unchanged legacy value (e.g. a title longer than today's limit) is therefore never re-validated, while
 * any new or changed value gets the full checks. Unknown keys are ignored.
 */
export function validateCourseDetailsPatch(input: Partial<CourseDetailsInput> | null | undefined): {
  errors: CourseValidationErrors;
  patch: Partial<CourseDetailsInput>;
} {
  const has = (k: keyof CourseDetailsInput) => Boolean(input) && Object.prototype.hasOwnProperty.call(input, k);
  const { errors: all, clean } = validateCourseDetails({
    title: has("title") ? input?.title : "x",
    description: has("description") ? input?.description : "",
    level: has("level") ? input?.level : "foundation",
    durationHours: has("durationHours") ? input?.durationHours : 0,
  });
  const errors: CourseValidationErrors = {};
  const patch: Partial<CourseDetailsInput> = {};
  for (const k of ["title", "description", "level", "durationHours"] as const) {
    if (!has(k)) continue;
    if (all[k]) errors[k] = all[k];
    else (patch as Record<string, unknown>)[k] = clean[k];
  }
  return { errors, patch };
}

/** Add Course: the details plus a starting status (Draft or Published, never Archived). */
export function validateCreateCourse(input: Partial<CreateCourseInput> | null | undefined): {
  errors: CourseValidationErrors;
  clean: CreateCourseInput;
} {
  const { errors, clean } = validateCourseDetails(input);
  const status = text(input?.status) as CreateCourseInput["status"];
  if (status !== "draft" && status !== "published") errors.status = "Select Draft or Active.";
  return { errors, clean: { ...clean, status } };
}

/** Add Module: title and planned hours are required (hours more than 0); a missing value is never turned into 0. */
export function validateModule(input: Partial<ModuleInput> | null | undefined): { errors: ModuleValidationErrors; clean: ModuleInput } {
  const { errors, clean } = validateModuleUpdate(input);
  if (clean.durationHours === undefined) errors.durationHours = hoursError(undefined) ?? undefined;
  return { errors, clean: { ...clean, durationHours: clean.durationHours ?? Number.NaN } };
}

/**
 * Edit Module: planned hours are validated only when sent — the form sends them just when they changed — so an
 * existing module with legacy 0 hours can still be renamed or described without touching its hours.
 */
export function validateModuleUpdate(input: Partial<ModuleInput> | null | undefined): { errors: ModuleValidationErrors; clean: ModuleUpdateInput } {
  const errors: ModuleValidationErrors = {};
  const title = text(input?.title);
  const description = text(input?.description);
  const durationHours = input?.durationHours;
  if (!title) errors.title = "Module title is required.";
  else if (title.length > COURSE_INPUT_LIMITS.titleMax) errors.title = `Module title must be ${COURSE_INPUT_LIMITS.titleMax} characters or fewer.`;
  if (description.length > COURSE_INPUT_LIMITS.moduleDescriptionMax) {
    errors.description = `Description must be ${COURSE_INPUT_LIMITS.moduleDescriptionMax.toLocaleString("en-IN")} characters or fewer.`;
  }
  if (durationHours === undefined) return { errors, clean: { title, description } };
  const hours = hoursError(durationHours);
  if (hours) errors.durationHours = hours;
  return { errors, clean: { title, description, durationHours: typeof durationHours === "number" ? durationHours : Number.NaN } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const HISTORY_LOCK_MESSAGE =
  "This course already has training records (ongoing or completed batches, past classes, attendance, tests, assignments or completion), so its title, level, planned duration and modules are locked to protect batch history. You can still edit the description or deactivate it; create a new course for a changed curriculum.";

/** A database refusal ({ok: false, reason}) as a sentence. */
export function courseRefusalMessage(reason: string, detail: { existingCourseCode?: string | null } = {}): string {
  switch (reason) {
    case "not_found":
      return "This course or module no longer exists. Reload the page.";
    case "unchanged":
      return "Nothing changed.";
    case "duplicate_title":
      return detail.existingCourseCode
        ? `A course with this title already exists (${detail.existingCourseCode}). Reuse that course for new batches, or choose a different title.`
        : "A course with this title already exists. Reuse that course for new batches, or choose a different title.";
    case "course_has_history":
      return HISTORY_LOCK_MESSAGE;
    case "has_batches":
      return "This course already has batches, so it can't go back to Draft. Deactivate it instead to stop new batches.";
    case "course_in_use":
      return "This course has batches, classes or questions, so it can't be deleted. Deactivate it instead — its history is kept.";
    case "not_draft":
      return "Only a draft course can be deleted. Active and inactive courses are kept permanently — deactivate it instead.";
    case "was_published":
      return "This course has been published before, so it is kept permanently. Deactivate it instead.";
    case "module_in_use":
      return "This module is used by classes or questions, so it can't be deleted.";
    default:
      return COURSE_GENERIC_ERROR;
  }
}

export const COURSE_STATUS_ACTIONS: Record<"draft" | "published" | "archived", { label: string; success: string }> = {
  published: { label: "Publish", success: "Course published. It is now active and can be used for new batches." },
  archived: { label: "Deactivate", success: "Course deactivated. No new batches can use it and its upcoming batches take no new students; existing batches continue normally." },
  draft: { label: "Move to draft", success: "Course moved back to draft." },
};

/** What archiving this course affects (counts from admin_course_usage). */
export interface ArchiveImpact {
  upcoming: number;
  ongoing: number;
  pendingInvitations: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The archive confirmation's specifics — one sentence per affected group; empty when nothing is affected. */
export function archiveImpactLines(impact: ArchiveImpact | null | undefined): string[] {
  if (!impact) return [];
  const lines: string[] = [];
  if (impact.ongoing > 0) {
    lines.push(`${plural(impact.ongoing, "ongoing batch continues", "ongoing batches continue")} normally, including new enrolments.`);
  }
  if (impact.upcoming > 0) {
    lines.push(
      `${plural(impact.upcoming, "upcoming batch keeps", "upcoming batches keep")} its students and classes but will take no new students until the course is reactivated.`
    );
  }
  if (impact.pendingInvitations > 0) {
    lines.push(
      `${plural(impact.pendingInvitations, "pending invitation", "pending invitations")} into those upcoming batches will activate the account without enrolling it — revoke or re-issue ${impact.pendingInvitations === 1 ? "it" : "them"} from Users.`
    );
  }
  return lines;
}

/** Button label for a status change: an inactive course is "Reactivated", a draft is "Published". */
export function statusActionLabel(current: string, target: "draft" | "published" | "archived"): string {
  return target === "published" && current === "archived" ? "Reactivate" : COURSE_STATUS_ACTIONS[target].label;
}

export const COURSE_REACTIVATED_MESSAGE = "Course reactivated. It is active again and can be used for new batches.";

/** The status changes the course page offers (the database decides; this only avoids offering refusals). */
export function statusActionsFor(status: string, batchCount: number): ("draft" | "published" | "archived")[] {
  switch (status) {
    case "draft":
      return ["published", "archived"];
    case "published":
      return batchCount === 0 ? ["archived", "draft"] : ["archived"];
    case "archived":
      return batchCount === 0 ? ["published", "draft"] : ["published"];
    default:
      return [];
  }
}

const FIELD_LABEL: Record<string, string> = { title: "title", description: "description", level: "level", duration_hours: "planned duration" };

type Detail = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** One course_events row as a short sentence (no raw JSON). */
export function courseHistorySummary(eventType: string, detail: Detail): string {
  const fields = Array.isArray(detail.fields) ? (detail.fields as unknown[]).map((f) => FIELD_LABEL[String(f)] ?? String(f)) : [];
  const mod = str(detail.module_code);
  switch (eventType) {
    case "course_created":
      return `Course created as ${str(detail.status) || "draft"} (${str(detail.course_code)}).`;
    case "course_updated":
      return `Details changed: ${fields.join(", ") || "—"}.`;
    case "course_status_changed":
      return `Status changed from ${courseStatusLabel(str(detail.from))} to ${courseStatusLabel(str(detail.to))}.`;
    case "course_deleted":
      return `Course deleted (${str(detail.course_code)}).`;
    case "module_created":
      return `Module ${mod} added: ${str(detail.title)}.`;
    case "module_updated":
      return `Module ${mod} changed: ${fields.join(", ") || "—"}.`;
    case "module_moved":
      return `Module ${mod} moved from position ${str(detail.from)} to ${str(detail.to)}.`;
    case "module_deleted":
      return `Module ${mod} deleted: ${str(detail.title)}.`;
    default:
      return "Course changed.";
  }
}
