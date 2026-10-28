/**
 * Question import service — the server-side bulk import engine on top of
 * 0013 and the shared Phase C core.
 *
 * Nothing from the browser is trusted: every chunk is re-validated here
 * with the same normalization/validation/fingerprint code the preview
 * used, against the caller's CURRENT course scope, the CURRENT bank
 * fingerprints (0013) and the CURRENT update targets (RLS). Only rows
 * that are still valid are sent to the database, which re-checks them
 * again and owns the transaction. Identity always comes from the session.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; question-import.service.ts wires the real dependencies.
 */
import type { AuthUser } from "@/types/auth";
import {
  IMPORT_CHUNK_SIZE,
  IMPORT_QUESTION_LIMITS,
  type ExistingQuestionFingerprint,
  type ExportMode,
  type ExportQuestion,
  type QuestionExport,
  type ImportChunkOutcome,
  type ImportChunkRequest,
  type ImportContext,
  type ImportContextRequest,
  type ImportCourse,
  type ImportDiscardOutcome,
  type ImportPlan,
  type ImportResumeState,
  type ImportRowOutcome,
  type ImportRunProgress,
  type ImportSource,
  type RawImportRow,
  type UpdateTarget,
} from "@/types/question-import";
import type { QuestionImportRunsRow } from "@/lib/supabase/types";
import { checkQuestionCount, toChunkItems, validateImport } from "@/lib/question-import/validate";
import { cleanText, normalizeCode, parseUuid } from "@/lib/question-import/normalize";
import { newestFirst } from "@/lib/supabase/paging";
import { QuestionImportRepositoryError, RAW_POSTGRES_MESSAGE, type QuestionImportRepository } from "@/repositories/question-import.repository.core";

export class QuestionImportAuthorizationError extends Error {
  constructor(message = "You don't have permission to import questions.") {
    super(message);
    this.name = "QuestionImportAuthorizationError";
  }
}

export class QuestionImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionImportValidationError";
  }
}

export interface QuestionImportServiceDeps {
  repository: QuestionImportRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** Courses (with modules) the user may manage: all (super admin) or their current courses (trainer). */
  listManageableCourses: (user: AuthUser) => Promise<ImportCourse[]>;
  isDemoMode: () => boolean;
}

const SOURCES: readonly ImportSource[] = ["xlsx", "csv", "docx", "pdf", "pdf_ocr"];
const MAX_CONTEXT_CODES = 500;
const MAX_CONTEXT_IDS = IMPORT_QUESTION_LIMITS.csv;

function toProgress(run: QuestionImportRunsRow): ImportRunProgress {
  return {
    id: run.id,
    status: run.status,
    source: run.source,
    fileName: run.file_name,
    fileSha256: run.file_sha256,
    plannedCreates: run.planned_creates,
    plannedUpdates: run.planned_updates,
    plannedExcluded: run.planned_excluded,
    createdCount: run.created_count,
    updatedCount: run.updated_count,
    discardedCount: run.discarded_count,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    discardedAt: run.discarded_at,
  };
}

function requireSource(source: unknown): ImportSource {
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
    throw new QuestionImportValidationError("Choose a supported file type (Excel, CSV, Word or PDF).");
  }
  return source as ImportSource;
}

function requireRunId(runId: unknown): string {
  const id = parseUuid(runId);
  if (!id) throw new QuestionImportValidationError("Import not found.");
  return id;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A database message is shown only when it is written for users. */
function safeMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return RAW_POSTGRES_MESSAGE.test(message) ? "The database refused this question." : message;
}

export function createQuestionImportService(deps: QuestionImportServiceDeps) {
  const { repository } = deps;

  /** Signed-in super admin or trainer, in Supabase mode. Students and anonymous users are refused. */
  async function requireImporter(): Promise<AuthUser> {
    if (deps.isDemoMode()) throw new QuestionImportValidationError("Question import requires Supabase mode.");
    const user = await deps.getCurrentUser();
    if (!user) throw new QuestionImportAuthorizationError("You need to be signed in.");
    if (user.role !== "admin" && user.role !== "trainer") throw new QuestionImportAuthorizationError();
    return user;
  }

  /** The caller's own run (0013 lets super admins READ others' runs, but only the creator imports into one). */
  async function requireOwnRun(user: AuthUser, runId: string): Promise<QuestionImportRunsRow> {
    const run = await repository.getRun(runId);
    if (!run || run.created_by !== user.id) throw new QuestionImportAuthorizationError("Import not found.");
    return run;
  }

  /**
   * Scope + current bank state for the given rows: manageable courses,
   * fingerprints of the courses the rows touch (0013), and the update
   * targets the caller can see (RLS).
   */
  async function buildContext(
    user: AuthUser,
    source: ImportSource,
    courseCodes: string[],
    questionIds: string[],
    defaultCourseId?: string | null,
    defaultModuleId?: string | null
  ): Promise<ImportContext> {
    const courses = await deps.listManageableCourses(user);
    const inScope = new Map(courses.map((c) => [c.id.toLowerCase(), c]));

    const ids = Array.from(new Set(questionIds.map(parseUuid).filter((id): id is string => id !== null)));
    const targets: UpdateTarget[] = (await repository.listUpdateTargets(ids)).map((t) => ({
      id: t.id.toLowerCase(),
      courseId: t.course_id.toLowerCase(),
      status: t.status,
      revision: t.revision,
    }));

    const wanted = new Set<string>();
    const codes = new Set(courseCodes.map(normalizeCode).filter(Boolean));
    for (const c of courses) if (codes.has(normalizeCode(c.code))) wanted.add(c.id.toLowerCase());
    const chosen = parseUuid(defaultCourseId);
    if (chosen && inScope.has(chosen)) wanted.add(chosen);
    for (const t of targets) if (inScope.has(t.courseId)) wanted.add(t.courseId);

    const existing: ExistingQuestionFingerprint[] = (await repository.listFingerprints(Array.from(wanted))).map((f) => ({
      questionId: f.question_id.toLowerCase(),
      courseId: f.course_id.toLowerCase(),
      status: f.status,
      revision: f.revision,
      fingerprint: f.fingerprint,
      textFingerprint: f.text_fingerprint,
    }));

    return {
      source,
      courses,
      existing,
      updateTargets: targets,
      defaultCourseId: chosen,
      defaultModuleId: parseUuid(defaultModuleId),
    };
  }

  return {
    /**
     * Preview context for the browser (same data the server re-checks
     * with at import time). Staff only; answer keys are never part of it.
     */
    async getContext(request: ImportContextRequest): Promise<ImportContext> {
      const user = await requireImporter();
      const source = requireSource(request?.source);
      const codes = Array.isArray(request?.courseCodes) ? request.courseCodes.map(cleanText).filter(Boolean) : [];
      const ids = Array.isArray(request?.questionIds) ? request.questionIds.map(cleanText).filter(Boolean) : [];
      if (codes.length > MAX_CONTEXT_CODES) throw new QuestionImportValidationError("This file names too many courses.");
      if (ids.length > MAX_CONTEXT_IDS) throw new QuestionImportValidationError("This file names too many Question IDs.");
      return buildContext(user, source, codes, ids, request.defaultCourseId, request.defaultModuleId);
    },

    /** Create the import run (0013 enforces the per-file limits and one in-progress run per user). */
    async startImport(plan: ImportPlan): Promise<ImportRunProgress> {
      const user = await requireImporter();
      const source = requireSource(plan?.source);
      const fileName = cleanText(plan.fileName).replace(/\n/g, " ");
      if (fileName.length < 1 || fileName.length > 255) throw new QuestionImportValidationError("The file name is not valid.");
      const sha = typeof plan.fileSha256 === "string" ? plan.fileSha256.trim().toLowerCase() : "";
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new QuestionImportValidationError("The file checksum is not valid.");
      if (!isCount(plan.plannedCreates) || !isCount(plan.plannedUpdates) || !isCount(plan.plannedExcluded)) {
        throw new QuestionImportValidationError("The import plan is not valid.");
      }
      if (plan.plannedCreates + plan.plannedUpdates < 1) throw new QuestionImportValidationError("There is nothing to import.");
      const tooMany = checkQuestionCount(source, plan.plannedCreates + plan.plannedUpdates + plan.plannedExcluded);
      if (tooMany) throw new QuestionImportValidationError(tooMany);

      const runId = await repository.startImport({ ...plan, source, fileName, fileSha256: sha });
      const run = await repository.getRun(runId);
      if (!run || run.created_by !== user.id) throw new QuestionImportRepositoryError();
      return toProgress(run);
    },

    /**
     * Import one chunk (≤ 100 rows) of the caller's in-progress run.
     * Rows already written in this run are reported as already_done
     * (safe retry/resume); every other row is re-validated server-side;
     * only CREATE/UPDATE rows are sent; the database's per-row outcome is
     * returned for each row, in row order.
     */
    async importChunk(runIdInput: string, request: ImportChunkRequest): Promise<ImportChunkOutcome> {
      const user = await requireImporter();
      const runId = requireRunId(runIdInput);
      const source = requireSource(request?.source);
      const rows = Array.isArray(request?.rows) ? request.rows : [];
      if (rows.length < 1 || rows.length > IMPORT_CHUNK_SIZE) {
        throw new QuestionImportValidationError(`Send between 1 and ${IMPORT_CHUNK_SIZE} questions at a time.`);
      }
      const rowNumbers = rows.map((r) => r?.rowNumber);
      if (rowNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > 1_000_000) || new Set(rowNumbers).size !== rows.length) {
        throw new QuestionImportValidationError("Each question needs its own row number.");
      }

      const run = await requireOwnRun(user, runId);
      if (run.status !== "in_progress") throw new QuestionImportValidationError("This import is no longer in progress.");
      if (run.source !== source) throw new QuestionImportValidationError("This chunk does not belong to this import.");

      // Already written in this run (a retried or resumed chunk).
      const done = new Map((await repository.listRunItems(runId, rowNumbers as number[])).map((i) => [i.row_number, i]));
      const outcomes = new Map<number, ImportRowOutcome>();
      for (const [rowNumber, item] of done) outcomes.set(rowNumber, { rowNumber, outcome: "already_done", questionId: item.question_id });

      const pending: RawImportRow[] = rows.filter((r) => !done.has(r.rowNumber));
      let created = 0;
      let updated = 0;

      if (pending.length > 0) {
        // An update must say which revision the preview showed.
        const needsRevision = pending.filter((r) => cleanText(r.questionId) && (r.expectedRevision === undefined || r.expectedRevision === null));
        for (const r of needsRevision) {
          outcomes.set(r.rowNumber, {
            rowNumber: r.rowNumber,
            outcome: "skipped",
            questionId: parseUuid(r.questionId),
            status: "ERROR",
            issues: [{ code: "revision_conflict", severity: "error", field: "questionId", message: "Reload the preview before updating this question." }],
          });
        }
        const toValidate = pending.filter((r) => !needsRevision.includes(r));

        const context = await buildContext(
          user,
          source,
          toValidate.map((r) => cleanText(r.courseCode)).filter(Boolean),
          toValidate.map((r) => cleanText(r.questionId)).filter(Boolean),
          request.defaultCourseId,
          request.defaultModuleId
        );
        const { results } = await validateImport(toValidate, context);

        for (const r of results) {
          if (r.status !== "CREATE" && r.status !== "UPDATE") {
            outcomes.set(r.rowNumber, {
              rowNumber: r.rowNumber,
              outcome: "skipped",
              questionId: r.questionId,
              status: r.status,
              issues: r.issues,
              duplicateOf: r.duplicateOf?.kind === "bank" ? r.duplicateOf.questionId : null,
            });
          }
        }

        const items = toChunkItems(results);
        if (items.length > 0) {
          const db = await repository.importChunk(runId, items);
          for (const res of db.results) {
            const base = { rowNumber: res.row_number, questionId: res.question_id ?? null };
            if (res.outcome === "rejected") {
              outcomes.set(res.row_number, { ...base, outcome: "rejected", reason: res.reason, message: safeMessage(res.message), duplicateOf: res.duplicate_of ?? null });
            } else {
              outcomes.set(res.row_number, { ...base, outcome: res.outcome });
            }
          }
          created = Number(db.created) || 0;
          updated = Number(db.updated) || 0;
        }
      }

      const after = await repository.getRun(runId);
      if (!after) throw new QuestionImportRepositoryError();
      return {
        runId,
        rows: rows
          .map((r) => outcomes.get(r.rowNumber) ?? { rowNumber: r.rowNumber, outcome: "skipped" as const, questionId: null, status: "ERROR" as const })
          .sort((a, b) => a.rowNumber - b.rowNumber),
        created,
        updated,
        run: toProgress(after),
      };
    },

    /** Mark the caller's run completed. Safe to repeat. */
    async finishImport(runIdInput: string): Promise<ImportRunProgress> {
      const user = await requireImporter();
      const runId = requireRunId(runIdInput);
      await requireOwnRun(user, runId);
      await repository.finishImport(runId);
      const run = await repository.getRun(runId);
      if (!run) throw new QuestionImportRepositoryError();
      return toProgress(run);
    },

    /**
     * Discard an UNFINISHED run (its creator or a super admin — the
     * database decides): delete the drafts it created that are still
     * unchanged and unused. Updates are never reverted. A completed or
     * already-discarded run is refused without any change (0014).
     */
    async discardImport(runIdInput: string): Promise<ImportDiscardOutcome> {
      await requireImporter();
      const runId = requireRunId(runIdInput);
      const result = await repository.discardImport(runId);
      const run = await repository.getRun(runId);
      if (!run) throw new QuestionImportRepositoryError();
      return { run: toProgress(run), deleted: result.deleted, kept: result.kept };
    },

    /** Resume state of the caller's run: progress + the rows already written. */
    async getResumeState(runIdInput: string): Promise<ImportResumeState> {
      const user = await requireImporter();
      const runId = requireRunId(runIdInput);
      const run = await requireOwnRun(user, runId);
      const items = await repository.listRunItems(runId);
      return { run: toProgress(run), doneRowNumbers: items.map((i) => i.row_number) };
    },

    /**
     * Question Bank export for the caller's own scope (staff only — the
     * rows include the answer key, which super admins and course trainers
     * can already see). "bank": every question in scope; "update": draft
     * questions only, for editing and re-importing. Scope = the caller's
     * manageable courses; RLS applies to every read as well.
     */
    async exportQuestions(mode: ExportMode): Promise<QuestionExport> {
      const user = await requireImporter();
      if (mode !== "bank" && mode !== "update") throw new QuestionImportValidationError("Choose what to export.");
      const courses = await deps.listManageableCourses(user);
      const generatedAt = new Date().toISOString();
      if (courses.length === 0) return { mode, generatedAt, questions: [] };
      const byId = new Map(courses.map((c) => [c.id.toLowerCase(), c]));
      const courseIds = user.role === "admin" ? null : courses.map((c) => c.id);
      const records = await repository.listQuestionsForExport(courseIds, mode === "update");
      const questions: (ExportQuestion & { updated_at: string })[] = [];
      for (const r of records) {
        const course = byId.get(r.course_id.toLowerCase());
        if (!course) continue; // outside the caller's scope
        const courseModule = r.module_id ? course.modules.find((m) => m.id.toLowerCase() === r.module_id!.toLowerCase()) : undefined;
        questions.push({
          id: r.id,
          courseCode: course.code,
          moduleCode: courseModule?.code ?? null,
          text: r.question_text,
          type: r.question_type,
          marks: Number(r.marks),
          options: r.options.map((o) => ({ text: o.option_text, isCorrect: o.is_correct })),
          explanation: r.explanation,
          status: r.status,
          revision: r.revision,
          updated_at: r.updated_at,
        });
      }
      questions.sort((a, b) => (a.courseCode < b.courseCode ? -1 : a.courseCode > b.courseCode ? 1 : newestFirst(a, b)));
      return { mode, generatedAt, questions: questions.map(({ updated_at: _u, ...q }) => q) };
    },

    /** The caller's in-progress run (to resume or discard after an interruption), or null. */
    async getActiveRun(): Promise<ImportRunProgress | null> {
      const user = await requireImporter();
      const run = await repository.getActiveRun(user.id);
      return run ? toProgress(run) : null;
    },
  };
}

export type QuestionImportService = ReturnType<typeof createQuestionImportService>;
export { QuestionImportRepositoryError };
