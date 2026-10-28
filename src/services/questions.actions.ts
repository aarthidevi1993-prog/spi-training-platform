"use server";

/**
 * Server Actions — the RPC boundary the Question Bank page calls. Each
 * action delegates to questionsService (which resolves the caller's
 * identity and scope server-side) and returns a plain, serializable
 * result. Internal error details are logged, never returned to the
 * browser. Audit fields are never accepted from the client.
 */

import { revalidatePath } from "next/cache";
import {
  questionsService,
  QuestionAuthorizationError,
  QuestionRepositoryError,
  QuestionValidationError,
} from "./questions.service";
import type { QuestionInput } from "@/types/question";

export interface QuestionActionResult {
  ok: boolean;
  error?: string;
}

async function run(context: string, fn: () => Promise<unknown>): Promise<QuestionActionResult> {
  try {
    await fn();
    revalidatePath("/admin/questions");
    revalidatePath("/trainer/questions");
    return { ok: true };
  } catch (err) {
    if (
      err instanceof QuestionValidationError ||
      err instanceof QuestionAuthorizationError ||
      err instanceof QuestionRepositoryError
    ) {
      // These carry messages written to be shown to users.
      return { ok: false, error: err.message };
    }
    console.error(`[questions.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function createQuestion(input: QuestionInput): Promise<QuestionActionResult> {
  return run("createQuestion", () => questionsService.createQuestion(input));
}

export async function updateQuestion(questionId: string, input: QuestionInput): Promise<QuestionActionResult> {
  return run("updateQuestion", () => questionsService.updateQuestion(questionId, input));
}

export async function activateQuestion(questionId: string): Promise<QuestionActionResult> {
  return run("activateQuestion", () => questionsService.changeStatus(questionId, "activate"));
}

export async function archiveQuestion(questionId: string): Promise<QuestionActionResult> {
  return run("archiveQuestion", () => questionsService.changeStatus(questionId, "archive"));
}

export async function restoreQuestion(questionId: string): Promise<QuestionActionResult> {
  return run("restoreQuestion", () => questionsService.changeStatus(questionId, "restore"));
}

export async function deleteDraftQuestion(questionId: string): Promise<QuestionActionResult> {
  return run("deleteDraftQuestion", () => questionsService.deleteDraftQuestion(questionId));
}
