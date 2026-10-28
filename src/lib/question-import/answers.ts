/**
 * Bulk import — options (A–J) and the correct answer. Pure. Nothing is
 * guessed: gaps, repeats, unknown letters and ambiguous answers are
 * reported, never repaired.
 */
import { QUESTION_LIMITS, TRUE_FALSE_OPTION_TEXTS } from "@/types/question";
import type { QuestionType } from "@/types/question";
import { OPTION_LETTERS, type ImportIssue, type OptionLetter } from "@/types/question-import";
import { cleanText, fingerprintNormalize } from "./normalize";

function issue(code: ImportIssue["code"], field: ImportIssue["field"], message: string): ImportIssue {
  return { code, severity: "error", field, message };
}

export interface OptionsParse {
  /** Non-blank option texts in A→ order (for true/false: the fixed True, False). */
  texts: string[];
  issues: ImportIssue[];
}

/**
 * Options A–J. Choice questions need 2–10 options filled from A with no
 * gaps (a blank B with a filled C is an error, not a reordering). True/
 * false questions always use the fixed options True, False: Option A/B
 * may be blank or exactly "True"/"False" (any case); anything else is an
 * error.
 */
export function parseOptions(raw: ReadonlyArray<unknown> | undefined, type: QuestionType): OptionsParse {
  const cells = OPTION_LETTERS.map((_, i) => cleanText(raw?.[i]));
  const issues: ImportIssue[] = [];

  if (type === "true_false") {
    const a = cells[0] ?? "";
    const b = cells[1] ?? "";
    const rest = cells.slice(2);
    const fixedOk = (a === "" && b === "") || (a.toLowerCase() === "true" && b.toLowerCase() === "false");
    if (!fixedOk || rest.some((c) => c !== "")) {
      issues.push(issue("true_false_options", "options", 'True/false questions use the fixed options "True" and "False": leave Option A/B blank or write True and False, and leave Options C–J blank.'));
    }
    return { texts: [...TRUE_FALSE_OPTION_TEXTS], issues };
  }

  const lastFilled = cells.reduce((last, c, i) => (c !== "" ? i : last), -1);
  const texts = cells.slice(0, lastFilled + 1);
  const gaps = texts.map((t, i) => (t === "" ? OPTION_LETTERS[i] : null)).filter((l): l is OptionLetter => l !== null);
  if (gaps.length > 0) {
    issues.push(issue("option_gap", "options", `Option ${gaps.join(", ")} is blank but a later option is filled. Fill options from A without gaps.`));
  }
  const filled = texts.filter((t) => t !== "");
  if (filled.length < QUESTION_LIMITS.optionsMin) {
    issues.push(issue("options_too_few", "options", "A choice question needs at least 2 options (A and B)."));
  }
  texts.forEach((t, i) => {
    if (t.length > QUESTION_LIMITS.optionTextMax) {
      issues.push(issue("option_too_long", "options", `Option ${OPTION_LETTERS[i]} must be ${QUESTION_LIMITS.optionTextMax} characters or fewer.`));
    }
  });
  const seen = new Map<string, OptionLetter>();
  texts.forEach((t, i) => {
    if (!t) return;
    const key = fingerprintNormalize(t);
    const letter = OPTION_LETTERS[i] as OptionLetter;
    const first = seen.get(key);
    if (first) issues.push(issue("option_repeated", "options", `Options ${first} and ${letter} are the same.`));
    else seen.set(key, letter);
  });
  return { texts: gaps.length > 0 ? filled : texts, issues };
}

export interface AnswerParse {
  /** Index of each correct option (0 = A). */
  correct: number[];
  issues: ImportIssue[];
  missing: boolean;
}

/**
 * The correct answer.
 *  - true/false: TRUE or FALSE (any case), or a spreadsheet boolean.
 *  - single choice: exactly one letter A–J.
 *  - multiple choice: one or more letters A–J separated by commas,
 *    semicolons or spaces ("A,C", "a; c", "A C").
 * Refused, never guessed: run-together letters ("AC"), option numbers,
 * option text, words ("A and C"), repeated letters, and letters whose
 * option is blank.
 */
export function parseCorrectAnswer(value: unknown, type: QuestionType, optionCount: number): AnswerParse {
  const missing = (): AnswerParse => ({
    correct: [],
    missing: true,
    issues: [issue("answer_missing", "correctAnswer", "The correct answer is required.")],
  });

  if (type === "true_false") {
    if (typeof value === "boolean") return { correct: [value ? 0 : 1], issues: [], missing: false };
    const text = cleanText(value).toLowerCase();
    if (!text) return missing();
    if (text === "true") return { correct: [0], issues: [], missing: false };
    if (text === "false") return { correct: [1], issues: [], missing: false };
    return { correct: [], missing: false, issues: [issue("answer_invalid", "correctAnswer", `A true/false answer must be TRUE or FALSE (got "${cleanText(value)}").`)] };
  }

  const text = cleanText(value);
  if (!text) return missing();
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const invalid = tokens.filter((t) => !/^[A-Ja-j]$/.test(t));
  if (invalid.length > 0) {
    return {
      correct: [],
      missing: false,
      issues: [issue("answer_invalid", "correctAnswer", `The correct answer must be option letters A–J separated by commas (got "${text}").`)],
    };
  }
  const letters = tokens.map((t) => t.toUpperCase() as OptionLetter);
  const issues: ImportIssue[] = [];
  const repeated = letters.filter((l, i) => letters.indexOf(l) !== i);
  if (repeated.length > 0) {
    issues.push(issue("answer_repeated", "correctAnswer", `Option ${Array.from(new Set(repeated)).join(", ")} is listed more than once in the correct answer.`));
  }
  const correct = Array.from(new Set(letters.map((l) => OPTION_LETTERS.indexOf(l)))).sort((a, b) => a - b);
  const beyond = correct.filter((i) => i >= optionCount).map((i) => OPTION_LETTERS[i]);
  if (beyond.length > 0) {
    issues.push(issue("answer_blank_option", "correctAnswer", `The correct answer names option ${beyond.join(", ")}, which is blank.`));
  }
  if (type === "single_choice" && correct.length !== 1) {
    issues.push(issue("answer_count", "correctAnswer", "A single-choice question needs exactly one correct option."));
  }
  if (type === "multiple_choice" && correct.length < 1) {
    issues.push(issue("answer_count", "correctAnswer", "A multiple-choice question needs at least one correct option."));
  }
  return { correct, issues, missing: false };
}
