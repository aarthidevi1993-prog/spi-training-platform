import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mockClassFilterOptions } from "@/lib/mock/classes.mock";
import { isCourseOpenForScheduling, isCurrentBatchStatus } from "@/lib/courses/course-availability";
import type { ClassFilterOptions } from "@/types/class";

const EMPTY_OPTIONS: ClassFilterOptions = { courses: [], modules: [], batches: [], trainers: [] };

/**
 * Option lists for the Classes filter bar and the create/edit form.
 *
 * - Demo mode: the demo dataset (no Supabase needed).
 * - Supabase mode: real courses / modules / batches / trainers, read
 *   with the caller's own session, so RLS scopes every list to what
 *   that user may see (admin: everything; trainer: their batches and
 *   courses; student: their enrolled batches).
 *
 * Fails closed: on any error the lists are empty (nothing selectable)
 * rather than throwing, so the Classes pages still render and show
 * their own load error if the database is unreachable.
 */
export async function getClassFilterOptions(): Promise<ClassFilterOptions> {
  if (authConfig.mode === "demo") {
    return mockClassFilterOptions;
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return EMPTY_OPTIONS;

  try {
    const [courses, modules, batches, trainers] = await Promise.all([
      supabase.from("courses").select("id, title, status").order("title"),
      supabase.from("modules").select("id, title, course_id").order("course_id").order("sequence"),
      supabase.from("batches").select("id, name, course_id, trainer_id, status").order("name"),
      supabase.from("trainers").select("id, full_name, status").order("full_name"),
    ]);

    const error = courses.error ?? modules.error ?? batches.error ?? trainers.error;
    if (error) throw error;

    // Validity rules for scheduling (UX; the security boundary is RLS
    // plus the class/batch-trainer trigger in the database). An archived
    // course stays schedulable while it has an upcoming/ongoing batch, so
    // archiving never interrupts training already under way (Option A).
    const coursesWithCurrentBatch = new Set((batches.data ?? []).filter((b) => isCurrentBatchStatus(b.status)).map((b) => b.course_id));
    return {
      courses: (courses.data ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        selectable: isCourseOpenForScheduling(c.status, coursesWithCurrentBatch.has(c.id)),
      })),
      modules: (modules.data ?? []).map((m) => ({ id: m.id, title: m.title, courseId: m.course_id })),
      batches: (batches.data ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        courseId: b.course_id,
        trainerId: b.trainer_id,
        selectable: b.status === "upcoming" || b.status === "ongoing",
      })),
      trainers: (trainers.data ?? []).map((t) => ({
        id: t.id,
        name: t.full_name,
        selectable: t.status === "active",
      })),
    };
  } catch (err) {
    console.error("[classes] filter options failed:", err instanceof Error ? err.message : err);
    return EMPTY_OPTIONS;
  }
}
