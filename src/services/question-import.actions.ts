"use server";

/**
 * Server Actions — the RPC boundary for bulk question import. Each action
 * delegates to questionImportService, which resolves the caller from the
 * session and re-validates everything; the 0013 database functions are the
 * final authority. Results are plain objects: {ok, data} or
 * {ok:false, error, retryable} — `retryable` is true only for transient
 * failures, so callers never retry validation or permission errors.
 * Internal error details are logged, never returned.
 */

import { revalidatePath } from "next/cache";
import {
  questionImportService,
  QuestionImportAuthorizationError,
  QuestionImportRepositoryError,
  QuestionImportValidationError,
} from "./question-import.service";
import type {
  ExportMode,
  QuestionExport,
  ImportActionResult,
  ImportChunkOutcome,
  ImportChunkRequest,
  ImportContext,
  ImportContextRequest,
  ImportDiscardOutcome,
  ImportPlan,
  ImportResumeState,
  ImportRunProgress,
} from "@/types/question-import";

function revalidateQuestionPages() {
  revalidatePath("/admin/questions");
  revalidatePath("/trainer/questions");
}

async function run<T>(context: string, fn: () => Promise<T>, onSuccess?: () => void): Promise<ImportActionResult<T>> {
  try {
    const data = await fn();
    onSuccess?.();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof QuestionImportRepositoryError) return { ok: false, error: err.message, retryable: err.retryable };
    if (err instanceof QuestionImportValidationError || err instanceof QuestionImportAuthorizationError) {
      return { ok: false, error: err.message, retryable: false };
    }
    console.error(`[question-import.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again.", retryable: false };
  }
}

export async function getQuestionImportContextAction(request: ImportContextRequest): Promise<ImportActionResult<ImportContext>> {
  return run("getContext", () => questionImportService.getContext(request));
}

export async function startQuestionImportAction(plan: ImportPlan): Promise<ImportActionResult<ImportRunProgress>> {
  return run("startImport", () => questionImportService.startImport(plan));
}

export async function importQuestionChunkAction(runId: string, request: ImportChunkRequest): Promise<ImportActionResult<ImportChunkOutcome>> {
  return run("importChunk", () => questionImportService.importChunk(runId, request));
}

export async function finishQuestionImportAction(runId: string): Promise<ImportActionResult<ImportRunProgress>> {
  return run("finishImport", () => questionImportService.finishImport(runId), revalidateQuestionPages);
}

export async function discardQuestionImportAction(runId: string): Promise<ImportActionResult<ImportDiscardOutcome>> {
  return run("discardImport", () => questionImportService.discardImport(runId), revalidateQuestionPages);
}

export async function getQuestionImportResumeStateAction(runId: string): Promise<ImportActionResult<ImportResumeState>> {
  return run("getResumeState", () => questionImportService.getResumeState(runId));
}

export async function getActiveQuestionImportAction(): Promise<ImportActionResult<ImportRunProgress | null>> {
  return run("getActiveRun", () => questionImportService.getActiveRun());
}

/** Staff-only Question Bank export data for the caller's scope; the browser builds the XLSX/CSV file. */
export async function exportQuestionBankAction(mode: ExportMode): Promise<ImportActionResult<QuestionExport>> {
  return run("exportQuestions", () => questionImportService.exportQuestions(mode));
}
