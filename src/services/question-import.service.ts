import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { questionImportRepository } from "@/repositories/question-import.repository";
import { questionsRepository } from "@/repositories/questions.repository";
import { createQuestionImportService } from "./question-import.service.core";

/**
 * The bulk question import service bound to the real session and
 * repositories. Course scope is the Question Bank's own
 * (listManageableCourses: super admin — all courses; trainer — courses of
 * their upcoming/ongoing batches), matching 0013's is_course_trainer.
 */
export const questionImportService = createQuestionImportService({
  repository: questionImportRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  isDemoMode: () => authConfig.mode === "demo",
  listManageableCourses: async (user) =>
    (await questionsRepository.listManageableCourses(user.role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id })).map(
      (c) => ({ id: c.id, code: c.course_code, title: c.title, modules: c.modules.map((m) => ({ id: m.id, code: m.module_code, title: m.title })) })
    ),
});

export {
  QuestionImportAuthorizationError,
  QuestionImportValidationError,
  QuestionImportRepositoryError,
} from "./question-import.service.core";
