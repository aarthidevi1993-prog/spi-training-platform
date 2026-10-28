/**
 * Course Management service (0030) — Super Admin only (checked here from
 * the authenticated session, and again by every database function).
 *
 *   createCourse / updateCourse / setCourseStatus / deleteCourse
 *   createModule / updateModule / moveModule / deleteModule
 *   getManagement   usage, history lock, batches and audit for the page
 *
 * Validates first (same limits as the database), sends only the known
 * fields (never a code — the database assigns course and module codes),
 * and turns every answer into a fixed, safe sentence. The database is the
 * authority for permissions, duplicates, the history lock and deletion.
 */
import {
  COURSE_DEMO_ERROR,
  COURSE_GENERIC_ERROR,
  COURSE_MIGRATION_MISSING_ERROR,
  COURSE_PERMISSION_ERROR,
  COURSE_REACTIVATED_MESSAGE,
  COURSE_STATUS_ACTIONS,
  courseHistorySummary,
  courseRefusalMessage,
  isUuid,
  validateCourseDetailsPatch,
  validateCreateCourse,
  validateModule,
  validateModuleUpdate,
  type CourseActionResult,
} from "@/lib/courses/course-management";
import type { AuthUser } from "@/types/auth";
import type { CourseDetailsInput, CourseHistoryEntry, CourseUsage, CreateCourseInput, ModuleInput, ModuleUpdateInput } from "@/types/course";
import {
  CourseManagementPermissionError,
  CourseManagementUnavailableError,
  type CourseFunctionResult,
  type CourseManagementRepository,
} from "@/repositories/course-management.repository.core";

export class CourseManagementAuthorizationError extends Error {
  constructor(message = COURSE_PERMISSION_ERROR) {
    super(message);
    this.name = "CourseManagementAuthorizationError";
  }
}

export interface CourseManagementServiceDeps {
  repository: Omit<CourseManagementRepository, never>;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** Demo mode has no database: every write is refused with a clear message. */
  isDemo?: () => boolean;
}

const NOT_FOUND: CourseActionResult = { ok: false, error: courseRefusalMessage("not_found") };
const s = (v: unknown) => (typeof v === "string" ? v : null);

export function createCourseManagementService(deps: CourseManagementServiceDeps) {
  async function requireSuperAdmin(): Promise<AuthUser> {
    const user = await deps.getCurrentUser();
    if (!user) throw new CourseManagementAuthorizationError("You need to be signed in.");
    if (user.role !== "admin") throw new CourseManagementAuthorizationError();
    return user;
  }

  /** Super Admin, and not demo mode — or the refusal to return. Always the first step of a write. */
  async function denied(): Promise<CourseActionResult | null> {
    try {
      await requireSuperAdmin();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : COURSE_PERMISSION_ERROR };
    }
    return deps.isDemo?.() ? { ok: false, error: COURSE_DEMO_ERROR } : null;
  }

  /** Run one database function and map every failure to a sentence. */
  async function run(op: () => Promise<CourseFunctionResult>, success: (r: CourseFunctionResult & { ok: true }) => CourseActionResult): Promise<CourseActionResult> {
    let result: CourseFunctionResult;
    try {
      result = await op();
    } catch (err) {
      if (err instanceof CourseManagementPermissionError) return { ok: false, error: COURSE_PERMISSION_ERROR };
      if (err instanceof CourseManagementUnavailableError) return { ok: false, error: COURSE_MIGRATION_MISSING_ERROR };
      return { ok: false, error: COURSE_GENERIC_ERROR };
    }
    if (!result.ok) {
      const message = courseRefusalMessage(result.reason, { existingCourseCode: s(result.data.existing_course_code) });
      return result.reason === "duplicate_title" ? { ok: false, error: message, errors: { title: message } } : { ok: false, error: message };
    }
    return success(result);
  }

  const invalid = (errors: Record<string, string>): CourseActionResult => ({
    ok: false,
    error: "Check the highlighted fields.",
    errors,
  });

  const detailsPayload = (c: CourseDetailsInput) => ({
    title: c.title,
    description: c.description,
    level: c.level,
    duration_hours: c.durationHours,
  });
  const modulePayload = (m: ModuleInput) => ({ title: m.title, description: m.description, duration_hours: m.durationHours });
  // Edit: planned hours only when sent (changed) — unchanged hours are never re-validated or rewritten.
  const moduleUpdatePayload = (m: ModuleUpdateInput) => ({
    title: m.title,
    description: m.description,
    ...(m.durationHours !== undefined ? { duration_hours: m.durationHours } : {}),
  });

  return {
    async createCourse(input: Partial<CreateCourseInput>): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      const { errors, clean } = validateCreateCourse(input);
      if (Object.keys(errors).length > 0) return invalid(errors);
      return run(
        () => deps.repository.createCourse({ ...detailsPayload(clean), status: clean.status }),
        (r) => {
          const code = s(r.data.course_code) ?? "";
          return { ok: true, message: `Course ${code} created.`, courseId: s(r.data.course_id) ?? undefined, courseCode: code };
        }
      );
    },

    async updateCourse(courseId: unknown, input: Partial<CourseDetailsInput>): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(courseId)) return NOT_FOUND;
      const { errors, patch } = validateCourseDetailsPatch(input);
      if (Object.keys(errors).length > 0) return invalid(errors);
      if (Object.keys(patch).length === 0) return { ok: false, error: courseRefusalMessage("unchanged") };
      // Only the changed fields are sent; the database compares and audits them.
      const p: { title?: string; description?: string; level?: string; duration_hours?: number } = {};
      if (patch.title !== undefined) p.title = patch.title;
      if (patch.description !== undefined) p.description = patch.description;
      if (patch.level !== undefined) p.level = patch.level;
      if (patch.durationHours !== undefined) p.duration_hours = patch.durationHours;
      return run(() => deps.repository.updateCourse(courseId, p), () => ({ ok: true, message: "Course details saved." }));
    },

    async setCourseStatus(courseId: unknown, status: unknown): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(courseId)) return NOT_FOUND;
      if (status !== "draft" && status !== "published" && status !== "archived") return { ok: false, error: COURSE_GENERIC_ERROR };
      return run(
        () => deps.repository.setCourseStatus(courseId, status),
        (r) => ({ ok: true, message: status === "published" && r.data.from === "archived" ? COURSE_REACTIVATED_MESSAGE : COURSE_STATUS_ACTIONS[status].success })
      );
    },

    async deleteCourse(courseId: unknown): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(courseId)) return NOT_FOUND;
      return run(() => deps.repository.deleteCourse(courseId), (r) => ({ ok: true, message: `Course ${s(r.data.course_code) ?? ""} deleted.` }));
    },

    async createModule(courseId: unknown, input: Partial<ModuleInput>): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(courseId)) return NOT_FOUND;
      const { errors, clean } = validateModule(input);
      if (Object.keys(errors).length > 0) return invalid(errors);
      return run(() => deps.repository.createModule(courseId, modulePayload(clean)), (r) => ({ ok: true, message: `Module ${s(r.data.module_code) ?? ""} added.` }));
    },

    async updateModule(moduleId: unknown, input: Partial<ModuleUpdateInput>): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(moduleId)) return NOT_FOUND;
      const { errors, clean } = validateModuleUpdate(input);
      if (Object.keys(errors).length > 0) return invalid(errors);
      return run(() => deps.repository.updateModule(moduleId, moduleUpdatePayload(clean)), () => ({ ok: true, message: "Module saved." }));
    },

    async moveModule(moduleId: unknown, direction: unknown): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(moduleId) || (direction !== "up" && direction !== "down")) return NOT_FOUND;
      return run(() => deps.repository.moveModule(moduleId, direction), () => ({ ok: true, message: "Module order saved." }));
    },

    async deleteModule(moduleId: unknown): Promise<CourseActionResult> {
      const refusal = await denied();
      if (refusal) return refusal;
      if (!isUuid(moduleId)) return NOT_FOUND;
      return run(() => deps.repository.deleteModule(moduleId), () => ({ ok: true, message: "Module deleted." }));
    },

    /**
     * Usage, history lock, batches and recent audit for the Super Admin course page.
     * Null in demo mode or for an unknown/invalid id. Throws for non-Super-Admins.
     */
    async getManagement(courseId: string): Promise<{ usage: CourseUsage; history: CourseHistoryEntry[] } | null> {
      const user = await requireSuperAdmin();
      if (deps.isDemo?.() || !isUuid(courseId)) return null;
      const usage = await deps.repository.getUsage(courseId);
      if (!usage) return null;
      const events = await deps.repository.listEvents(courseId);
      const history = events.map((e) => ({
        id: e.id,
        occurredAt: e.occurred_at,
        eventType: e.event_type,
        actor: e.actor_id === null ? null : e.actor_id === user.id ? "you" : e.actor_id,
        summary: courseHistorySummary(e.event_type, e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {}),
      }));
      return { usage, history };
    },
  };
}

export type CourseManagementService = ReturnType<typeof createCourseManagementService>;
