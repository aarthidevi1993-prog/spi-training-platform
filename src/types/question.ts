/**
 * Question Bank types (0007_question_bank.sql). Staff-only: these carry
 * the answer key (QuestionOption.isCorrect) and must only ever be used
 * by the /admin/questions and /trainer/questions pages — never by a
 * student-facing page or data structure.
 */

/** Phase 1 question types (no short answer). */
export type QuestionType = "single_choice" | "multiple_choice" | "true_false";

export type QuestionStatus = "draft" | "active" | "archived";

/** Mirrors the 0007 constraints / question_content_error(). */
export const QUESTION_LIMITS = {
  textMax: 5000,
  explanationMax: 5000,
  optionTextMax: 1000,
  optionsMin: 2,
  optionsMax: 10,
  marksMax: 9999.99,
} as const;

/** True/false questions always use these two options, in this order. */
export const TRUE_FALSE_OPTION_TEXTS = ["True", "False"] as const;

/** One answer option; its position in the array is its display order. */
export interface QuestionOption {
  text: string;
  isCorrect: boolean;
}

export interface QuestionSummary {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  moduleId: string | null;
  moduleTitle: string | null;
  text: string;
  type: QuestionType;
  marks: number;
  status: QuestionStatus;
  optionCount: number;
  updatedAt: string;
}

export interface QuestionDetail extends QuestionSummary {
  explanation: string | null;
  revision: number;
  options: QuestionOption[];
}

/** What the editor sends. Audit fields/revision/status are never part of it. */
export interface QuestionInput {
  courseId: string;
  moduleId: string | null;
  type: QuestionType;
  text: string;
  marks: number;
  explanation: string | null;
  options: QuestionOption[];
}

/** Course/module picker entries (courses the caller may manage). */
export interface QuestionModuleOption {
  id: string;
  code: string;
  title: string;
}

export interface QuestionCourseOption {
  id: string;
  code: string;
  title: string;
  modules: QuestionModuleOption[];
}

/** Everything the Question Bank page needs. */
export interface QuestionBankData {
  /** False in demo mode (no real data; the page shows an empty state). */
  enabled: boolean;
  /** Super admin only: may hard-delete never-activated drafts. */
  canDelete: boolean;
  courses: QuestionCourseOption[];
  questions: QuestionDetail[];
}
