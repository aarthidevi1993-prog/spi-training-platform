/**
 * Question import repository — the only module that talks to the 0013
 * import database: the five import functions plus RLS-scoped reads of
 * questions and import history. Always the caller's own session (never
 * the service role); 0013 proves identity from auth.uid(), checks role and
 * course scope, forces drafts and owns every chunk's transaction.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; question-import.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  Json,
  QuestionImportFingerprintsRow,
  QuestionImportItemsRow,
  QuestionImportRunsRow,
  QuestionStatusColumn,
  QuestionTypeColumn,
} from "@/lib/supabase/types";
import { readAllByKeyset } from "@/lib/supabase/paging";
import type { ImportChunkItem, ImportPlan, ImportRejectReason } from "@/types/question-import";

type Client = SupabaseClient<Database, "public">;

const GENERIC_DB_ERROR = "We couldn't reach the import service. Please try again.";
const BUSY_DB_ERROR = "The database is busy. Please try again in a moment.";

export class QuestionImportRepositoryError extends Error {
  /** Postgres/PostgREST error code, when there was one. */
  readonly code: string;
  /** Transient failure (network, timeout, busy database): the same request may be retried. */
  readonly retryable: boolean;
  constructor(message: string = GENERIC_DB_ERROR, code = "", retryable = false) {
    super(message);
    this.name = "QuestionImportRepositoryError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Codes whose 0013 messages are written for users (raw Postgres text is still replaced). */
const USER_FACING_FALLBACK: Record<string, string> = {
  "42501": "You don't have permission to do that.",
  "22023": "Some import details are invalid. Please check them and try again.",
  "23514": "That import step isn't allowed right now.",
  "23503": "That course or module no longer exists.",
};
/** Transient: statement timeout, serialization/deadlock, too many connections, connection failures. */
const RETRYABLE_CODES = new Set(["57014", "40001", "40P01", "53300", "57P01", "08000", "08003", "08006", "08001", "08004"]);
export const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax|function .*does not exist|duplicate key/i;

export function toRepositoryError(error: unknown): QuestionImportRepositoryError {
  if (error instanceof QuestionImportRepositoryError) return error;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  if (RETRYABLE_CODES.has(code) || code.startsWith("08")) return new QuestionImportRepositoryError(BUSY_DB_ERROR, code, true);
  if (code === "23505") return new QuestionImportRepositoryError("Another import was started at the same time. Reload and try again.", code);
  const fallback = USER_FACING_FALLBACK[code];
  if (fallback) return new QuestionImportRepositoryError(message && !RAW_POSTGRES_MESSAGE.test(message) ? message : fallback, code);
  // No code at all: the request never reached the database (network) — safe to retry.
  if (!code && (error instanceof TypeError || /fetch|network|ECONN|ETIMEDOUT|socket/i.test(message))) {
    return new QuestionImportRepositoryError(GENERIC_DB_ERROR, "", true);
  }
  return new QuestionImportRepositoryError(GENERIC_DB_ERROR, code);
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[question-import] ${context}:`, detail);
}

async function call<T>(context: string, fn: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  let result: { data: T | null; error: unknown };
  try {
    result = await fn();
  } catch (err) {
    logDbError(context, err);
    throw toRepositoryError(err);
  }
  if (result.error) {
    logDbError(context, result.error);
    throw toRepositoryError(result.error);
  }
  return result.data;
}

/** One row result of import_question_chunk (0013). */
export interface ChunkRowResult {
  row_number: number;
  outcome: "created" | "updated" | "unchanged" | "already_done" | "rejected";
  question_id?: string;
  revision?: number;
  action?: "create" | "update";
  reason?: ImportRejectReason;
  message?: string;
  duplicate_of?: string;
}
export interface ChunkResult {
  ok: boolean;
  run_id: string;
  created: number;
  updated: number;
  results: ChunkRowResult[];
}

export interface UpdateTargetRecord {
  id: string;
  course_id: string;
  status: QuestionStatusColumn;
  revision: number;
}

export type RunItemRecord = Pick<QuestionImportItemsRow, "row_number" | "action" | "question_id">;

export interface ExportQuestionRecord {
  id: string;
  course_id: string;
  module_id: string | null;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  explanation: string | null;
  status: QuestionStatusColumn;
  revision: number;
  updated_at: string;
  options: { option_text: string; display_order: number; is_correct: boolean }[];
}

const OPTIONS_PER_QUESTION_MAX = 10;
/** Options of this many questions fit in one response (≤ 1000 rows). */
const EXPORT_OPTION_BATCH = Math.floor(900 / OPTIONS_PER_QUESTION_MAX);

const FINGERPRINT_COURSES_PER_CALL = 50; // 0013 limit
const IN_CHUNK = 100; // keep `.in(...)` URLs short
const RUN_SELECT =
  "id, created_by, source, file_name, file_sha256, planned_creates, planned_updates, planned_excluded, status, created_count, updated_count, discarded_count, created_at, updated_at, completed_at, discarded_at";

function split<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createQuestionImportRepository(getClient: () => Promise<Client | null>) {
  async function client(): Promise<Client> {
    const supabase = await getClient();
    if (!supabase) throw new QuestionImportRepositoryError();
    return supabase;
  }

  return {
    /** Existing-question fingerprints of courses the caller manages (0013 refuses others). Every page is read. */
    async listFingerprints(courseIds: string[]): Promise<QuestionImportFingerprintsRow[]> {
      const unique = Array.from(new Set(courseIds.map((c) => c.toLowerCase())));
      if (unique.length === 0) return [];
      const supabase = await client();
      const out: QuestionImportFingerprintsRow[] = [];
      for (const group of split(unique, FINGERPRINT_COURSES_PER_CALL)) {
        const rows = await readAllByKeyset(async (afterId, limit) => {
          const data = await call("listFingerprints", () => {
            let query = supabase.rpc("question_import_fingerprints", { p_course_ids: group }).order("question_id", { ascending: true }).limit(limit);
            if (afterId) query = query.gt("question_id", afterId);
            return query;
          });
          return { data: (data ?? []).map((r) => ({ ...r, id: r.question_id })), error: null };
        });
        out.push(...rows.map(({ id: _id, ...r }) => r));
      }
      return out;
    },

    /** Questions named by Question ID that the caller can see (RLS: super admin, or current course trainer). */
    async listUpdateTargets(questionIds: string[]): Promise<UpdateTargetRecord[]> {
      const unique = Array.from(new Set(questionIds.map((q) => q.toLowerCase())));
      if (unique.length === 0) return [];
      const supabase = await client();
      const out: UpdateTargetRecord[] = [];
      for (const ids of split(unique, IN_CHUNK)) {
        const data = await call("listUpdateTargets", () => supabase.from("questions").select("id, course_id, status, revision").in("id", ids));
        out.push(...(data ?? []));
      }
      return out;
    },

    /**
     * Questions with their options for an export, read under the caller's
     * RLS (super admin: all; trainer: current courses). courseIds limits to
     * those courses (null = everything visible); draftOnly for update files.
     * Every page is read.
     */
    async listQuestionsForExport(courseIds: string[] | null, draftOnly: boolean): Promise<ExportQuestionRecord[]> {
      const supabase = await client();
      const groups = courseIds === null ? [null] : split(Array.from(new Set(courseIds)), IN_CHUNK);
      const questions: Omit<ExportQuestionRecord, "options">[] = [];
      for (const group of groups) {
        if (group && group.length === 0) continue;
        const rows = await readAllByKeyset(async (afterId, limit) => {
          const data = await call("listQuestionsForExport", () => {
            let query = supabase
              .from("questions")
              .select("id, course_id, module_id, question_text, question_type, marks, explanation, status, revision, updated_at")
              .order("id", { ascending: true })
              .limit(limit);
            if (group) query = query.in("course_id", group);
            if (draftOnly) query = query.eq("status", "draft");
            if (afterId) query = query.gt("id", afterId);
            return query;
          });
          return { data: data ?? [], error: null };
        });
        questions.push(...rows);
      }

      const optionsById = new Map<string, ExportQuestionRecord["options"]>();
      for (const ids of split(questions.map((q) => q.id), EXPORT_OPTION_BATCH)) {
        const data = await call("listQuestionsForExport.options", () =>
          supabase.from("question_options").select("question_id, option_text, display_order, is_correct").in("question_id", ids)
        );
        for (const o of data ?? []) {
          const list = optionsById.get(o.question_id) ?? [];
          list.push({ option_text: o.option_text, display_order: o.display_order, is_correct: o.is_correct });
          optionsById.set(o.question_id, list);
        }
      }
      return questions.map((q) => ({
        ...q,
        marks: Number(q.marks),
        options: (optionsById.get(q.id) ?? []).sort((a, b) => a.display_order - b.display_order),
      }));
    },

    /** start_question_import → the new run id. */
    async startImport(plan: ImportPlan): Promise<string> {
      const supabase = await client();
      const id = await call("startImport", () =>
        supabase.rpc("start_question_import", {
          p_source: plan.source,
          p_file_name: plan.fileName,
          p_file_sha256: plan.fileSha256,
          p_planned_creates: plan.plannedCreates,
          p_planned_updates: plan.plannedUpdates,
          p_planned_excluded: plan.plannedExcluded,
        })
      );
      if (typeof id !== "string") throw new QuestionImportRepositoryError();
      return id;
    },

    /** import_question_chunk: ≤ 100 rows in one database transaction. */
    async importChunk(runId: string, items: ImportChunkItem[]): Promise<ChunkResult> {
      const supabase = await client();
      const data = await call("importChunk", () => supabase.rpc("import_question_chunk", { p_run_id: runId, p_items: items as unknown as Json }));
      const result = data as unknown as ChunkResult | null;
      if (!result || !Array.isArray(result.results)) throw new QuestionImportRepositoryError();
      return result;
    },

    async finishImport(runId: string): Promise<void> {
      const supabase = await client();
      await call("finishImport", () => supabase.rpc("finish_question_import", { p_run_id: runId }));
    },

    async discardImport(runId: string): Promise<{ deleted: number; kept: number; alreadyDiscarded: boolean }> {
      const supabase = await client();
      const data = (await call("discardImport", () => supabase.rpc("discard_question_import", { p_run_id: runId }))) as unknown as {
        deleted?: number;
        kept?: number;
        already_discarded?: boolean;
      } | null;
      return { deleted: Number(data?.deleted ?? 0), kept: Number(data?.kept ?? 0), alreadyDiscarded: Boolean(data?.already_discarded) };
    },

    /** One run (RLS: its creator or a super admin), or null. */
    async getRun(runId: string): Promise<QuestionImportRunsRow | null> {
      const supabase = await client();
      return call("getRun", () => supabase.from("question_import_runs").select(RUN_SELECT).eq("id", runId).maybeSingle());
    },

    /** The user's in-progress run, if any (at most one — 0013). */
    async getActiveRun(userId: string): Promise<QuestionImportRunsRow | null> {
      const supabase = await client();
      const data = await call("getActiveRun", () =>
        supabase.from("question_import_runs").select(RUN_SELECT).eq("created_by", userId).eq("status", "in_progress").limit(1)
      );
      return data?.[0] ?? null;
    },

    /** Rows already written in a run: the given row numbers, or all of them (resume). */
    async listRunItems(runId: string, rowNumbers?: number[]): Promise<RunItemRecord[]> {
      const supabase = await client();
      if (rowNumbers) {
        if (rowNumbers.length === 0) return [];
        const out: RunItemRecord[] = [];
        for (const rows of split(Array.from(new Set(rowNumbers)), IN_CHUNK)) {
          const data = await call("listRunItems", () =>
            supabase.from("question_import_items").select("row_number, action, question_id").eq("run_id", runId).in("row_number", rows)
          );
          out.push(...(data ?? []));
        }
        return out;
      }
      // All items, keyset on row_number (append-only table).
      const out: RunItemRecord[] = [];
      let after = 0;
      for (;;) {
        const data = await call("listRunItems", () =>
          supabase
            .from("question_import_items")
            .select("row_number, action, question_id")
            .eq("run_id", runId)
            .gt("row_number", after)
            .order("row_number", { ascending: true })
            .limit(1000)
        );
        const batch = data ?? [];
        if (batch.length === 0) return out;
        for (const item of batch) {
          if (item.row_number <= after) throw new QuestionImportRepositoryError();
          out.push(item);
          after = item.row_number;
        }
      }
    },
  };
}

export type QuestionImportRepository = ReturnType<typeof createQuestionImportRepository>;
