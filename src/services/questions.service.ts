import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import {
  questionsRepository,
  QuestionRepositoryError,
  type ManageableCourseRecord,
  type QuestionRecord,
  type QuestionScope,
  type SaveQuestionPayload,
} from "@/repositories/questions.repository";
import type { AuthUser } from "@/types/auth";
import {
  QUESTION_LIMITS,
  TRUE_FALSE_OPTION_TEXTS,
  type QuestionBankData,
  type QuestionCourseOption,
  type QuestionDetail,
  type QuestionInput,
  type QuestionStatus,
  type QuestionType,
} from "@/types/question";

/**
 * Questions service — resolves the caller's identity server-side via
 * authService (never from a client-supplied argument), limits the
 * Question Bank to super admins and CURRENT course trainers, and
 * validates every write (mirroring 0007) so users get clear messages.
 * The database (0007 RLS + save_question / set_question_status +
 * triggers) remains the final security boundary.
 */

export class QuestionAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "QuestionAuthorizationError";
  }
}

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

const QUESTION_TYPES: QuestionType[] = ["single_choice", "multiple_choice", "true_false"];
const NOT_FOUND = "Question not found, or you don't have permission to change it.";

/** The caller must be a signed-in super admin or trainer (Supabase mode). */
async function requireManager(): Promise<AuthUser> {
  if (authConfig.mode === "demo") {
    throw new QuestionValidationError("Question Bank requires Supabase mode.");
  }
  const user = await authService.getCurrentUser();
  if (!user) throw new QuestionAuthorizationError("You need to be signed in.");
  if (user.role !== "admin" && user.role !== "trainer") {
    throw new QuestionAuthorizationError("You don't have permission to manage the Question Bank.");
  }
  return user;
}

function scopeFor(user: AuthUser): QuestionScope {
  return user.role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id };
}

function toCourseOption(course: ManageableCourseRecord): QuestionCourseOption {
  return {
    id: course.id,
    code: course.course_code,
    title: course.title,
    modules: course.modules.map((m) => ({ id: m.id, code: m.module_code, title: m.title })),
  };
}

function toDetail(record: QuestionRecord, courses: Map<string, QuestionCourseOption>): QuestionDetail {
  const course = courses.get(record.course_id);
  const courseModule = record.module_id ? course?.modules.find((m) => m.id === record.module_id) : undefined;
  const options = [...record.question_options]
    .sort((a, b) => a.display_order - b.display_order)
    .map((o) => ({ text: o.option_text, isCorrect: o.is_correct }));
  return {
    id: record.id,
    courseId: record.course_id,
    courseCode: course?.code ?? "",
    courseTitle: course?.title ?? "Unknown course",
    moduleId: record.module_id,
    moduleTitle: courseModule?.title ?? (record.module_id ? "Unknown module" : null),
    text: record.question_text,
    type: record.question_type,
    marks: Number(record.marks),
    status: record.status,
    optionCount: options.length,
    updatedAt: record.updated_at,
    explanation: record.explanation,
    revision: record.revision,
    options,
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate an editor submission against the caller's manageable course
 * and build the save_question payload. Mirrors question_content_error()
 * (0007) — the database re-checks everything.
 */
function buildPayload(input: QuestionInput, course: QuestionCourseOption, id?: string): SaveQuestionPayload {
  if (input.moduleId !== null && !course.modules.some((m) => m.id === input.moduleId)) {
    throw new QuestionValidationError("That module does not belong to this course.");
  }
  if (!QUESTION_TYPES.includes(input.type)) {
    throw new QuestionValidationError("Question type must be single choice, multiple choice or true/false.");
  }

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new QuestionValidationError("Question text is required.");
  if (text.length > QUESTION_LIMITS.textMax) {
    throw new QuestionValidationError(`Question text must be ${QUESTION_LIMITS.textMax} characters or fewer.`);
  }

  const marks = input.marks;
  if (typeof marks !== "number" || !Number.isFinite(marks) || marks <= 0) {
    throw new QuestionValidationError("Marks must be a number greater than 0.");
  }
  if (marks > QUESTION_LIMITS.marksMax || Math.abs(Math.round(marks * 100) - marks * 100) > 1e-6) {
    throw new QuestionValidationError("Marks must be at most 9999.99, with up to 2 decimal places.");
  }

  const explanation = typeof input.explanation === "string" && input.explanation.trim() ? input.explanation.trim() : null;
  if (explanation && explanation.length > QUESTION_LIMITS.explanationMax) {
    throw new QuestionValidationError(`Explanation must be ${QUESTION_LIMITS.explanationMax} characters or fewer.`);
  }

  if (!Array.isArray(input.options) || input.options.some((o) => !o || typeof o.isCorrect !== "boolean")) {
    throw new QuestionValidationError("Each option needs its text and whether it is correct.");
  }

  let options: SaveQuestionPayload["options"];
  if (input.type === "true_false") {
    // Fixed True/False options; only the correct flag comes from the editor.
    if (input.options.length !== 2) throw new QuestionValidationError("A true/false question needs exactly 2 options.");
    options = TRUE_FALSE_OPTION_TEXTS.map((optionText, i) => ({ option_text: optionText, is_correct: input.options[i]?.isCorrect === true }));
  } else {
    if (input.options.length < QUESTION_LIMITS.optionsMin || input.options.length > QUESTION_LIMITS.optionsMax) {
      throw new QuestionValidationError("A question needs between 2 and 10 options.");
    }
    options = input.options.map((o) => ({ option_text: typeof o.text === "string" ? o.text.trim() : "", is_correct: o.isCorrect }));
    if (options.some((o) => !o.option_text)) throw new QuestionValidationError("Options cannot be blank.");
    if (options.some((o) => o.option_text.length > QUESTION_LIMITS.optionTextMax)) {
      throw new QuestionValidationError(`Each option must be ${QUESTION_LIMITS.optionTextMax} characters or fewer.`);
    }
  }

  const correct = options.filter((o) => o.is_correct).length;
  if (input.type === "true_false" && correct !== 1) {
    throw new QuestionValidationError("A true/false question needs exactly 1 correct option.");
  }
  if (input.type === "single_choice" && correct !== 1) {
    throw new QuestionValidationError("A single-choice question needs exactly 1 correct option.");
  }
  if (input.type === "multiple_choice" && correct < 1) {
    throw new QuestionValidationError("A multiple-choice question needs at least 1 correct option.");
  }

  return {
    ...(id ? { id } : {}),
    course_id: course.id,
    module_id: input.moduleId,
    question_text: text,
    question_type: input.type,
    marks: Math.round(marks * 100) / 100,
    explanation,
    options,
  };
}

/** A course the caller may manage (the UX check; the database re-checks). */
async function requireManageableCourse(user: AuthUser, courseId: unknown): Promise<QuestionCourseOption> {
  if (!isId(courseId)) throw new QuestionValidationError("Choose a course.");
  const courses = await questionsRepository.listManageableCourses(scopeFor(user));
  const course = courses.find((c) => c.id === courseId);
  if (!course) {
    throw new QuestionAuthorizationError(
      user.role === "admin" ? "Course not found." : "You can only add questions to courses you currently teach."
    );
  }
  return toCourseOption(course);
}

async function requireQuestion(questionId: unknown): Promise<QuestionRecord> {
  if (!isId(questionId)) throw new QuestionAuthorizationError(NOT_FOUND);
  const question = await questionsRepository.getQuestion(questionId);
  if (!question) throw new QuestionAuthorizationError(NOT_FOUND);
  return question;
}

/** Semantic lifecycle moves offered by the UI (the database also refuses draft ← active/archived). */
const STATUS_MOVES: Record<"activate" | "archive" | "restore", { from: QuestionStatus; to: QuestionStatus; error: string }> = {
  activate: { from: "draft", to: "active", error: "Only draft questions can be activated." },
  archive: { from: "active", to: "archived", error: "Only active questions can be archived." },
  restore: { from: "archived", to: "active", error: "Only archived questions can be restored." },
};

export const questionsService = {
  /** Page data: manageable courses (+ modules) and the questions the caller may see. */
  async getBankData(): Promise<QuestionBankData> {
    if (authConfig.mode === "demo") {
      return { enabled: false, canDelete: false, courses: [], questions: [] };
    }
    const user = await requireManager();
    const courses = (await questionsRepository.listManageableCourses(scopeFor(user))).map(toCourseOption);
    const records = await questionsRepository.listQuestions(user.role === "admin" ? null : courses.map((c) => c.id));
    const byId = new Map(courses.map((c) => [c.id, c]));
    return {
      enabled: true,
      canDelete: user.role === "admin",
      courses,
      questions: records.map((r) => toDetail(r, byId)),
    };
  },

  async createQuestion(input: QuestionInput): Promise<string> {
    const user = await requireManager();
    const course = await requireManageableCourse(user, input?.courseId);
    return questionsRepository.saveQuestion(buildPayload(input, course));
  },

  async updateQuestion(questionId: string, input: QuestionInput): Promise<string> {
    const user = await requireManager();
    const existing = await requireQuestion(questionId);
    if (existing.status === "archived") {
      throw new QuestionValidationError("Restore this question before editing it.");
    }
    if (input?.courseId !== existing.course_id) {
      throw new QuestionValidationError("A question's course cannot be changed.");
    }
    const course = await requireManageableCourse(user, existing.course_id);
    return questionsRepository.saveQuestion(buildPayload(input, course, existing.id));
  },

  async changeStatus(questionId: string, move: keyof typeof STATUS_MOVES): Promise<void> {
    await requireManager();
    const rule = STATUS_MOVES[move];
    const existing = await requireQuestion(questionId);
    if (existing.status !== rule.from) throw new QuestionValidationError(rule.error);
    await questionsRepository.setQuestionStatus(existing.id, rule.to);
  },

  /** Super admin only; never-activated drafts only (the database enforces both). */
  async deleteDraftQuestion(questionId: string): Promise<void> {
    const user = await requireManager();
    if (user.role !== "admin") throw new QuestionAuthorizationError("Only a Super Admin can delete questions.");
    const existing = await requireQuestion(questionId);
    if (existing.status !== "draft") {
      throw new QuestionValidationError("Only draft questions can be deleted. Archive this question instead.");
    }
    const deleted = await questionsRepository.deleteDraftQuestion(existing.id);
    if (!deleted) throw new QuestionValidationError("Only draft questions can be deleted. Archive this question instead.");
  },
};

export { QuestionRepositoryError };
