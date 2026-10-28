import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { courseCards, getCoursesForTrainer, getEnrolledCourses } from "@/lib/mock/courses-table.mock";
import { courseDetails, defaultCourseDetail } from "@/lib/mock/course-detail.mock";
import type { CourseDetail, CourseSummary } from "@/types/course";

/**
 * Courses repository — the only module that knows where course data
 * lives. Two isolated implementations behind one interface, matching
 * classes.repository.ts:
 *
 *   - Demo mode  (authConfig.mode === "demo"): the existing demo course
 *     data, so the app stays fully usable with no Supabase project.
 *   - Supabase mode: public.courses + modules + batches → trainers
 *     (0003_core_training_model.sql), read with the caller's session.
 *
 * Services call this; UI components never do. RLS (can_read_course and
 * the batches/trainers policies) is the authoritative access boundary
 * in Supabase mode; the scope arguments below are a second layer.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export const TRAINER_NOT_ASSIGNED = "Trainer not assigned";

export class CourseRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "CourseRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  console.error(`[courses] ${context}:`, error instanceof Error ? error.message : error);
}

/** Which courses the caller's portal lists. */
export type CourseScope =
  | { kind: "all" }
  | { kind: "trainer"; trainerId: string }
  | { kind: "student"; studentId: string }
  | { kind: "none" };

// -------------------------------------------------------------------
// Demo mode
// -------------------------------------------------------------------

/** Demo identity mapping, matching the demo trainer used by Classes. */
const DEMO_TRAINER_NAME = "Rajesh Kumar";

function demoCoursesFor(scope: CourseScope): CourseSummary[] {
  switch (scope.kind) {
    case "all":
      return courseCards;
    case "trainer":
      return getCoursesForTrainer(DEMO_TRAINER_NAME);
    case "student":
      return getEnrolledCourses();
    default:
      return [];
  }
}

// -------------------------------------------------------------------
// Supabase mode
// -------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One round trip per query. The batch → trainer embed yields the
 * course's trainer(s); a trainer row the caller may not read under RLS
 * comes back null and is simply skipped.
 */
const COURSE_LIST_SELECT = `
  id, course_code, title, description, status, duration_hours,
  modules ( id ),
  batches ( trainers ( full_name ) )
`;

const COURSE_DETAIL_SELECT = `
  id, course_code, title, description, level, status, duration_hours,
  modules ( id, sequence, title, module_code, description, duration_hours ),
  batches ( trainers ( full_name ) )
`;

type BatchTrainerEmbed = { trainers: { full_name: string } | null }[];

/** Distinct batch trainer names, or the "not assigned" label. */
function trainerLabel(batches: BatchTrainerEmbed): string {
  const names = Array.from(
    new Set(batches.map((b) => b.trainers?.full_name).filter((name): name is string => Boolean(name)))
  ).sort();
  return names.length > 0 ? names.join(", ") : TRAINER_NOT_ASSIGNED;
}

/**
 * Course ids the scope may list (Supabase mode), or null for "no
 * restriction" (admin). Trainers: courses of batches they run.
 * Students: courses of batches they're enrolled in or completed.
 */
async function scopedCourseIds(scope: CourseScope): Promise<string[] | null> {
  if (scope.kind === "all") return null;
  if (scope.kind === "none") return [];

  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new CourseRepositoryError();

  if (scope.kind === "trainer") {
    const { data, error } = await supabase.from("batches").select("course_id").eq("trainer_id", scope.trainerId);
    if (error) throw error;
    return Array.from(new Set((data ?? []).map((row) => row.course_id)));
  }

  const { data, error } = await supabase
    .from("batch_students")
    .select("batches ( course_id )")
    .eq("student_id", scope.studentId)
    .in("enrollment_status", ["enrolled", "completed"]);
  if (error) throw error;
  return Array.from(
    new Set((data ?? []).map((row) => row.batches?.course_id).filter((id): id is string => Boolean(id)))
  );
}

export const coursesRepository = {
  async findAll(scope: CourseScope): Promise<CourseSummary[]> {
    if (authConfig.mode === "demo") {
      return demoCoursesFor(scope);
    }

    try {
      const allowedIds = await scopedCourseIds(scope);
      if (allowedIds && allowedIds.length === 0) return [];

      const supabase = await createSupabaseServerClient();
      if (!supabase) throw new CourseRepositoryError();

      let query = supabase.from("courses").select(COURSE_LIST_SELECT);
      if (allowedIds) query = query.in("id", allowedIds);

      const { data, error } = await query.order("title");
      if (error) throw error;

      return (data ?? []).map((row) => ({
        id: row.id,
        courseCode: row.course_code,
        title: row.title,
        description: row.description,
        status: row.status,
        modules: row.modules.length,
        durationHours: Number(row.duration_hours),
        trainer: trainerLabel(row.batches),
        // topics / progress: no data source yet — left undefined (hidden).
      }));
    } catch (err) {
      if (err instanceof CourseRepositoryError) throw err;
      logDbError("findAll failed", err);
      throw new CourseRepositoryError();
    }
  },

  /** A course the scope may see, or null (unknown, invalid id or out of scope). */
  async findById(id: string, scope: CourseScope): Promise<CourseDetail | null> {
    if (authConfig.mode === "demo") {
      // Same demo behaviour as before (a listed course without its own
      // demo detail shows the default one), limited to the caller's list.
      if (!demoCoursesFor(scope).some((c) => c.id === id)) return null;
      return courseDetails[id] ?? defaultCourseDetail;
    }

    // Malformed ids would make Postgres raise 22P02; treat as not found.
    if (!UUID_PATTERN.test(id)) return null;

    try {
      const allowedIds = await scopedCourseIds(scope);
      if (allowedIds && !allowedIds.includes(id)) return null;

      const supabase = await createSupabaseServerClient();
      if (!supabase) throw new CourseRepositoryError();

      const { data, error } = await supabase.from("courses").select(COURSE_DETAIL_SELECT).eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) return null;

      return {
        id: data.id,
        courseCode: data.course_code,
        level: data.level,
        status: data.status,
        title: data.title,
        description: data.description,
        durationHours: Number(data.duration_hours),
        trainer: trainerLabel(data.batches),
        modules: [...data.modules]
          .sort((a, b) => a.sequence - b.sequence)
          // topics / status (learner progress): no data source yet — hidden.
          .map((m) => ({
            id: m.id,
            sequence: m.sequence,
            title: m.title,
            moduleCode: m.module_code,
            description: m.description,
            durationHours: Number(m.duration_hours),
          })),
        // topics / progress: no data source yet — left undefined (hidden).
      };
    } catch (err) {
      if (err instanceof CourseRepositoryError) throw err;
      logDbError(`findById(${id}) failed`, err);
      throw new CourseRepositoryError();
    }
  },
};
