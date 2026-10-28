import "server-only";
import { authConfig } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ClassesInsert, ClassesRow, ClassesUpdate } from "@/lib/supabase/types";
import { mockClasses } from "@/lib/mock/classes.mock";
import type {
  ClassFilters,
  ClassWithRelations,
  CreateClassInput,
  TrainingClass,
  UpdateClassInput,
} from "@/types/class";

/**
 * Classes repository — the only module that knows where class data
 * lives. Two isolated implementations behind one interface, matching
 * the pattern already used by auth.repository.ts:
 *
 *   - Demo mode  (authConfig.mode === "demo"): in-memory array, so
 *     the app stays fully usable with no Supabase project.
 *   - Supabase mode: real queries against the `classes` table created
 *     by supabase/migrations/0001_classes.sql.
 *
 * Services call this; UI components never do. Row Level Security is
 * the authoritative access boundary in Supabase mode — the scoping
 * arguments below are a defence-in-depth second layer, not the only
 * one.
 */

const GENERIC_DB_ERROR = "We couldn't reach the database. Please try again.";

export class ClassRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "ClassRepositoryError";
  }
}

function logDbError(context: string, error: unknown) {
  console.error(`[classes] ${context}:`, error instanceof Error ? error.message : error);
}

/**
 * A `classes` row plus the embedded related rows requested by
 * SELECT_WITH_RELATIONS. Extends the schema Row type so the column
 * list can never drift from src/lib/supabase/types.ts.
 */
interface ClassRow extends ClassesRow {
  courses?: { title: string | null } | null;
  modules?: { title: string | null } | null;
  batches?: { name: string | null } | null;
  trainers?: { full_name: string | null } | null;
}

/** Narrow the free-text DB columns back to the domain unions (CHECK constraints guarantee validity). */
function toStatus(value: string): TrainingClass["status"] {
  return value === "live" || value === "completed" || value === "cancelled" ? value : "scheduled";
}

function toClassType(value: string): TrainingClass["classType"] {
  return value === "offline" || value === "hybrid" ? value : "online";
}

function mapRow(row: ClassRow): ClassWithRelations {
  return {
    id: row.id,
    courseId: row.course_id,
    moduleId: row.module_id,
    batchId: row.batch_id,
    trainerId: row.trainer_id,
    title: row.title,
    description: row.description,
    classDate: row.class_date,
    // Postgres `time` comes back as HH:mm:ss — the UI works in HH:mm.
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    teamsMeetingUrl: row.teams_meeting_url,
    status: toStatus(row.status),
    classType: toClassType(row.class_type),
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    courseTitle: row.courses?.title ?? "Unknown course",
    moduleTitle: row.modules?.title ?? null,
    batchName: row.batches?.name ?? "Unknown batch",
    trainerName: row.trainers?.full_name ?? "Unassigned",
  };
}

function toInsertRow(input: CreateClassInput, createdBy: string | null): ClassesInsert {
  return {
    course_id: input.courseId,
    module_id: input.moduleId,
    batch_id: input.batchId,
    trainer_id: input.trainerId,
    title: input.title,
    description: input.description,
    class_date: input.classDate,
    start_time: input.startTime,
    end_time: input.endTime,
    teams_meeting_url: input.teamsMeetingUrl,
    status: input.status,
    class_type: input.classType,
    notes: input.notes,
    created_by: createdBy,
  };
}

/**
 * Builds a partial update payload. Only keys explicitly present on
 * the patch are included, so an omitted field is left untouched in
 * the database rather than being overwritten with undefined/null.
 */
function toUpdateRow(patch: UpdateClassInput): ClassesUpdate {
  const row: ClassesUpdate = {};
  if (patch.courseId !== undefined) row.course_id = patch.courseId;
  if (patch.moduleId !== undefined) row.module_id = patch.moduleId;
  if (patch.batchId !== undefined) row.batch_id = patch.batchId;
  if (patch.trainerId !== undefined) row.trainer_id = patch.trainerId;
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.classDate !== undefined) row.class_date = patch.classDate;
  if (patch.startTime !== undefined) row.start_time = patch.startTime;
  if (patch.endTime !== undefined) row.end_time = patch.endTime;
  if (patch.teamsMeetingUrl !== undefined) row.teams_meeting_url = patch.teamsMeetingUrl;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.classType !== undefined) row.class_type = patch.classType;
  if (patch.notes !== undefined) row.notes = patch.notes;
  return row;
}

/**
 * Single joined select — one round trip per list query, never one
 * lookup per class. Each embed follows a foreign key added in
 * 0003_core_training_model.sql. An embedded row the caller may not
 * read under RLS comes back as null, and mapRow() falls back to a
 * placeholder label for it.
 */
const SELECT_WITH_RELATIONS = `
  *,
  courses ( title ),
  modules ( title ),
  batches ( name ),
  trainers ( full_name )
`;

function applyFiltersInMemory(rows: ClassWithRelations[], filters: ClassFilters): ClassWithRelations[] {
  let out = [...rows];

  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    out = out.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.courseTitle.toLowerCase().includes(q) ||
        c.batchName.toLowerCase().includes(q) ||
        c.trainerName.toLowerCase().includes(q)
    );
  }
  if (filters.courseId) out = out.filter((c) => c.courseId === filters.courseId);
  if (filters.moduleId) out = out.filter((c) => c.moduleId === filters.moduleId);
  if (filters.batchId) out = out.filter((c) => c.batchId === filters.batchId);
  if (filters.trainerId) out = out.filter((c) => c.trainerId === filters.trainerId);
  if (filters.status && filters.status !== "all") out = out.filter((c) => c.status === filters.status);
  if (filters.classType && filters.classType !== "all") out = out.filter((c) => c.classType === filters.classType);

  const today = new Date().toISOString().slice(0, 10);
  const from = filters.dateFrom;
  const to = filters.dateTo;

  switch (filters.dateRange) {
    case "today":
      out = out.filter((c) => c.classDate === today);
      break;
    case "upcoming":
      out = out.filter((c) => c.classDate >= today && c.status !== "cancelled");
      break;
    case "this_week": {
      const end = new Date();
      end.setDate(end.getDate() + 7);
      const endStr = end.toISOString().slice(0, 10);
      out = out.filter((c) => c.classDate >= today && c.classDate <= endStr);
      break;
    }
    case "completed":
      out = out.filter((c) => c.status === "completed");
      break;
    case "custom":
      if (from) out = out.filter((c) => c.classDate >= from);
      if (to) out = out.filter((c) => c.classDate <= to);
      break;
    default:
      break;
  }

  return out.sort((a, b) =>
    a.classDate === b.classDate ? a.startTime.localeCompare(b.startTime) : b.classDate.localeCompare(a.classDate)
  );
}

/** In-memory store for demo mode so creates/updates persist for the server's lifetime. */
let demoRecords: ClassWithRelations[] = [...mockClasses];

function nowIso() {
  return new Date().toISOString();
}

export interface ClassScope {
  /** Restrict to one trainer's classes (trainer portal). */
  trainerId?: string;
  /**
   * Restrict to these batches' classes (student portal: the student's
   * enrolled batches). An empty array matches nothing.
   */
  batchIds?: string[];
}

export const classesRepository = {
  async findAll(filters: ClassFilters = {}, scope: ClassScope = {}): Promise<ClassWithRelations[]> {
    if (authConfig.mode === "demo") {
      let rows = demoRecords;
      if (scope.trainerId) rows = rows.filter((c) => c.trainerId === scope.trainerId);
      if (scope.batchIds) {
        const allowed = scope.batchIds;
        rows = rows.filter((c) => allowed.includes(c.batchId));
      }
      return applyFiltersInMemory(rows, filters);
    }

    // Enrolled in nothing -> nothing to show; skip the round trip.
    if (scope.batchIds && scope.batchIds.length === 0) return [];

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      let query = supabase.from("classes").select(SELECT_WITH_RELATIONS);

      if (scope.trainerId) query = query.eq("trainer_id", scope.trainerId);
      if (scope.batchIds) query = query.in("batch_id", scope.batchIds);

      if (filters.courseId) query = query.eq("course_id", filters.courseId);
      if (filters.moduleId) query = query.eq("module_id", filters.moduleId);
      if (filters.batchId) query = query.eq("batch_id", filters.batchId);
      if (filters.trainerId) query = query.eq("trainer_id", filters.trainerId);
      if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
      if (filters.classType && filters.classType !== "all") query = query.eq("class_type", filters.classType);
      if (filters.search?.trim()) query = query.ilike("title", `%${filters.search.trim()}%`);

      const today = new Date().toISOString().slice(0, 10);
      if (filters.dateRange === "today") {
        query = query.eq("class_date", today);
      } else if (filters.dateRange === "upcoming") {
        query = query.gte("class_date", today).neq("status", "cancelled");
      } else if (filters.dateRange === "this_week") {
        const end = new Date();
        end.setDate(end.getDate() + 7);
        query = query.gte("class_date", today).lte("class_date", end.toISOString().slice(0, 10));
      } else if (filters.dateRange === "completed") {
        query = query.eq("status", "completed");
      } else if (filters.dateRange === "custom") {
        if (filters.dateFrom) query = query.gte("class_date", filters.dateFrom);
        if (filters.dateTo) query = query.lte("class_date", filters.dateTo);
      }

      const { data, error } = await query.order("class_date", { ascending: false }).order("start_time");
      if (error) throw error;

      return data.map(mapRow);
    } catch (err) {
      logDbError("findAll failed", err);
      throw new ClassRepositoryError();
    }
  },

  async findById(id: string, scope: ClassScope = {}): Promise<ClassWithRelations | null> {
    if (authConfig.mode === "demo") {
      const found = demoRecords.find((c) => c.id === id) ?? null;
      if (!found) return null;
      // Apply the same scoping the DB would, so demo mode can't leak
      // another trainer's / batch's class either.
      if (scope.trainerId && found.trainerId !== scope.trainerId) return null;
      if (scope.batchIds && !scope.batchIds.includes(found.batchId)) return null;
      return found;
    }

    if (scope.batchIds && scope.batchIds.length === 0) return null;

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      let query = supabase.from("classes").select(SELECT_WITH_RELATIONS).eq("id", id);
      if (scope.trainerId) query = query.eq("trainer_id", scope.trainerId);
      if (scope.batchIds) query = query.in("batch_id", scope.batchIds);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data ? mapRow(data) : null;
    } catch (err) {
      logDbError(`findById(${id}) failed`, err);
      throw new ClassRepositoryError();
    }
  },

  async create(input: CreateClassInput, createdBy: string | null): Promise<ClassWithRelations> {
    if (authConfig.mode === "demo") {
      const created: ClassWithRelations = {
        ...input,
        id: crypto.randomUUID(),
        createdBy,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        courseTitle: "Demo course",
        moduleTitle: input.moduleId ? "Demo module" : null,
        batchName: "Demo batch",
        trainerName: "Demo trainer",
      };
      demoRecords = [created, ...demoRecords];
      return created;
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      const { data, error } = await supabase
        .from("classes")
        .insert(toInsertRow(input, createdBy))
        .select(SELECT_WITH_RELATIONS)
        .single();
      if (error) throw error;
      return mapRow(data);
    } catch (err) {
      logDbError("create failed", err);
      throw new ClassRepositoryError("We couldn't create the class. Please try again.");
    }
  },

  async update(id: string, patch: UpdateClassInput, scope: ClassScope = {}): Promise<ClassWithRelations> {
    if (authConfig.mode === "demo") {
      const existing = demoRecords.find((c) => c.id === id);
      if (!existing) throw new ClassRepositoryError("That class no longer exists.");
      if (scope.trainerId && existing.trainerId !== scope.trainerId) {
        throw new ClassRepositoryError("You don't have permission to edit this class.");
      }
      const updated: ClassWithRelations = { ...existing, ...patch, updatedAt: nowIso() };
      demoRecords = demoRecords.map((c) => (c.id === id ? updated : c));
      return updated;
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      let query = supabase.from("classes").update(toUpdateRow(patch)).eq("id", id);
      if (scope.trainerId) query = query.eq("trainer_id", scope.trainerId);

      const { data, error } = await query.select(SELECT_WITH_RELATIONS).single();
      if (error) throw error;
      return mapRow(data);
    } catch (err) {
      logDbError(`update(${id}) failed`, err);
      throw new ClassRepositoryError("We couldn't update the class. Please try again.");
    }
  },

  async remove(id: string): Promise<void> {
    if (authConfig.mode === "demo") {
      demoRecords = demoRecords.filter((c) => c.id !== id);
      return;
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      const { error } = await supabase.from("classes").delete().eq("id", id);
      if (error) throw error;
    } catch (err) {
      logDbError(`remove(${id}) failed`, err);
      throw new ClassRepositoryError("We couldn't delete the class. Please try again.");
    }
  },

  /**
   * Batches the student is currently enrolled in or has completed
   * (withdrawn enrolments grant nothing). Supabase mode only — demo
   * mode maps the demo student to a fixed batch in the service.
   * RLS (batch_students_select) also limits this to the caller's own
   * rows, so it cannot reveal another student's enrolments.
   */
  async findEnrolledBatchIds(studentId: string): Promise<string[]> {
    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new ClassRepositoryError();

    try {
      const { data, error } = await supabase
        .from("batch_students")
        .select("batch_id")
        .eq("student_id", studentId)
        .in("enrollment_status", ["enrolled", "completed"]);
      if (error) throw error;
      return (data ?? []).map((row) => row.batch_id);
    } catch (err) {
      logDbError("findEnrolledBatchIds failed", err);
      throw new ClassRepositoryError();
    }
  },
};
