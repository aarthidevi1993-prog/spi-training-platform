import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createQuestionImportRepository } from "./question-import.repository.core";

/**
 * The question import repository bound to the caller's own Supabase
 * session (cookies; RLS applies). Never the service-role client.
 */
export const questionImportRepository = createQuestionImportRepository(createSupabaseServerClient);

export { QuestionImportRepositoryError } from "./question-import.repository.core";
export type { QuestionImportRepository } from "./question-import.repository.core";
