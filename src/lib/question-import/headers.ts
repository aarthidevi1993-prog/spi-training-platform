/**
 * Bulk import — column headers of the structured template (Excel/CSV).
 * Pure. Headers are matched without case, spaces, underscores or
 * hyphens ("Question Text", "question_text", "QUESTION-TEXT"), and each
 * column also accepts its listed aliases ("Question Type" for "Type").
 */
import { OPTION_LETTERS } from "@/types/question-import";

export type TemplateColumn =
  | "questionId"
  | "courseCode"
  | "moduleCode"
  | "questionText"
  | "questionType"
  | "marks"
  | `option${(typeof OPTION_LETTERS)[number]}`
  | "correctAnswer"
  | "explanation"
  | "status"
  | "revision";

/** Canonical template headers, in template order. */
export const TEMPLATE_HEADERS: ReadonlyArray<{ column: TemplateColumn; header: string; aliases?: string[] }> = [
  { column: "questionId", header: "Question ID" },
  { column: "courseCode", header: "Course Code" },
  { column: "moduleCode", header: "Module Code" },
  { column: "questionText", header: "Question Text" },
  { column: "questionType", header: "Type", aliases: ["Question Type"] },
  { column: "marks", header: "Marks" },
  ...OPTION_LETTERS.map((l) => ({ column: `option${l}` as TemplateColumn, header: `Option ${l}` })),
  { column: "correctAnswer", header: "Correct Answer" },
  { column: "explanation", header: "Explanation" },
  { column: "status", header: "Status" },
  { column: "revision", header: "Revision" },
];

const key = (text: string) => text.toLowerCase().replace(/[\s_\-]+/g, "");
const BY_KEY = new Map<string, TemplateColumn>();
for (const h of TEMPLATE_HEADERS) {
  BY_KEY.set(key(h.header), h.column);
  for (const alias of h.aliases ?? []) BY_KEY.set(key(alias), h.column);
}

export const headerFor = (column: TemplateColumn): string => TEMPLATE_HEADERS.find((h) => h.column === column)!.header;

export interface HeaderMap {
  /** Column name → index in the source row. */
  columns: Partial<Record<TemplateColumn, number>>;
  /** Blocking header problems. */
  errors: string[];
  /** Unknown headers (ignored). */
  ignored: string[];
}

/**
 * Map a header row. Required: Type, Question Text, Option A, Option B,
 * Correct Answer, Marks — and Course Code unless the course may be chosen
 * in the import screen. A column given twice (even under an alias) is an
 * error.
 */
export function mapHeaders(headers: ReadonlyArray<unknown>, options: { courseChosenInUi?: boolean } = {}): HeaderMap {
  const columns: HeaderMap["columns"] = {};
  const errors: string[] = [];
  const ignored: string[] = [];
  headers.forEach((raw, index) => {
    const text = typeof raw === "string" ? raw.trim() : raw === null || raw === undefined ? "" : String(raw).trim();
    if (!text) return;
    const column = BY_KEY.get(key(text));
    if (!column) {
      ignored.push(text);
      return;
    }
    if (columns[column] !== undefined) {
      errors.push(`The column "${text}" appears more than once.`);
      return;
    }
    columns[column] = index;
  });
  const required: TemplateColumn[] = ["questionType", "questionText", "optionA", "optionB", "correctAnswer", "marks"];
  if (!options.courseChosenInUi) required.unshift("courseCode");
  const missing = required.filter((c) => columns[c] === undefined).map(headerFor);
  if (missing.length > 0) errors.push(`Missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  return { columns, errors, ignored };
}
