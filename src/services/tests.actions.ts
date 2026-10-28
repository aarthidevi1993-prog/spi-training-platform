"use server";

/**
 * Server Actions — the RPC boundary the Admin/Trainer test management
 * pages call. Each action delegates to testsService (which resolves the
 * caller's identity and scope server-side) and returns a plain,
 * serializable result. Internal error details are logged, never
 * returned to the browser. Status and audit fields are never accepted
 * from the client.
 */

import { revalidatePath } from "next/cache";
import {
  testsService,
  TestAuthorizationError,
  TestRepositoryError,
  TestValidationError,
} from "./tests.service";
import type { TestInput } from "@/types/test";

export interface TestActionResult {
  ok: boolean;
  error?: string;
  /** The affected test (e.g. the new draft's id after create). */
  id?: string;
}

async function run(context: string, fn: () => Promise<string>): Promise<TestActionResult> {
  try {
    const id = await fn();
    // List + detail pages for both portals.
    revalidatePath("/admin/tests", "layout");
    revalidatePath("/trainer/tests", "layout");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof TestValidationError || err instanceof TestAuthorizationError || err instanceof TestRepositoryError) {
      // These carry messages written to be shown to users.
      return { ok: false, error: err.message };
    }
    console.error(`[tests.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function createTestAction(input: TestInput): Promise<TestActionResult> {
  return run("createTest", () => testsService.createTest(input));
}

export async function updateTestAction(testId: string, input: TestInput): Promise<TestActionResult> {
  return run("updateTest", () => testsService.updateTest(testId, input));
}

export async function publishTestAction(testId: string): Promise<TestActionResult> {
  return run("publishTest", () => testsService.publishTest(testId));
}

export async function closeTestAction(testId: string): Promise<TestActionResult> {
  return run("closeTest", () => testsService.closeTest(testId));
}

export async function reopenTestAction(testId: string): Promise<TestActionResult> {
  return run("reopenTest", () => testsService.reopenTest(testId));
}

export async function deleteDraftTestAction(testId: string): Promise<TestActionResult> {
  return run("deleteDraftTest", () => testsService.deleteDraftTest(testId));
}

export async function addTestQuestionsAction(testId: string, questionIds: string[]): Promise<TestActionResult> {
  return run("addQuestions", () => testsService.addQuestions(testId, questionIds));
}

export async function removeTestQuestionAction(testId: string, testQuestionId: string): Promise<TestActionResult> {
  return run("removeQuestion", () => testsService.removeQuestion(testId, testQuestionId));
}
