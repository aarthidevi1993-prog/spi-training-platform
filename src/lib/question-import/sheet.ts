/**
 * Bulk import — turn a header row + data rows (from Excel or CSV) into
 * raw import rows. Pure; shared by the Excel and CSV readers so both use
 * the same header mapping (headers.ts) and the same cell rules.
 */
import {
  IMPORT_FILE_SIZE_LIMITS,
  OPTION_LETTERS,
  type ImportIssue,
  type ImportSource,
  type ParsedImportFile,
  type RawImportRow,
} from "@/types/question-import";
import { mapHeaders, type TemplateColumn } from "./headers";
import { cleanText } from "./normalize";
import { checkQuestionCount } from "./validate";

/** One cell as read from a file. Formulas and error values are never evaluated or trusted. */
export type SheetCell = string | number | boolean | null | undefined | { formula: true } | { error: string };

export interface SheetRow {
  /** The row's number in the source (spreadsheet row / CSV record), header = 1. */
  rowNumber: number;
  cells: SheetCell[];
  /** Problems the reader found in this record (e.g. a CSV record with the wrong number of fields). */
  issues?: ImportIssue[];
}

const FORMULA_MESSAGE = "Formula cells are not supported. Replace the formula with its displayed value.";

/**
 * Exports escape text that starts with = + - @ with a leading apostrophe
 * so spreadsheet software never runs it as a formula; reading it back
 * removes exactly that apostrophe (round trip). Other text is untouched.
 */
export function unescapeSpreadsheetText(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/** A file larger than the limit for its type is refused before it is read. */
export function checkFileSize(source: ImportSource, bytes: number): string | null {
  const limit = IMPORT_FILE_SIZE_LIMITS[source];
  return bytes > limit ? `This file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${limit / 1024 / 1024} MB.` : null;
}

const isFormula = (c: SheetCell): c is { formula: true } => typeof c === "object" && c !== null && "formula" in c;
const isError = (c: SheetCell): c is { error: string } => typeof c === "object" && c !== null && "error" in c;

function cellValue(c: SheetCell): string | number | boolean | null {
  if (c === undefined || c === null || isFormula(c) || isError(c)) return null;
  if (typeof c === "string") return unescapeSpreadsheetText(c);
  return c;
}

function isBlank(c: SheetCell): boolean {
  if (isFormula(c) || isError(c)) return false;
  return cleanText(c) === "";
}

export function rowsFromSheet(source: ImportSource, header: SheetCell[], data: SheetRow[], extra: { sheetName?: string } = {}): ParsedImportFile {
  const result: ParsedImportFile = { source, rows: [], fileErrors: [], warnings: [], blankRowsSkipped: 0, sheetName: extra.sheetName, everyRowHasCourse: false };
  const headerText = header.map((c) => (isFormula(c) || isError(c) ? "" : cleanText(cellValue(c))));
  const map = mapHeaders(headerText, { courseChosenInUi: true });
  if (map.errors.length > 0) {
    result.fileErrors.push(...map.errors);
    return result;
  }
  if (map.ignored.length > 0) result.warnings.push(`Ignored column${map.ignored.length === 1 ? "" : "s"}: ${map.ignored.join(", ")}.`);

  const mapped = Object.values(map.columns) as number[];
  const at = (cells: SheetCell[], column: TemplateColumn): SheetCell => {
    const index = map.columns[column];
    return index === undefined ? undefined : cells[index];
  };

  const nonBlank = data.filter((r) => !mapped.every((i) => isBlank(r.cells[i])));
  result.blankRowsSkipped = data.length - nonBlank.length;
  if (result.blankRowsSkipped > 0) result.warnings.push(`${result.blankRowsSkipped} blank row${result.blankRowsSkipped === 1 ? "" : "s"} skipped.`);
  const tooMany = checkQuestionCount(source, nonBlank.length);
  if (tooMany) {
    result.fileErrors.push(tooMany);
    return result;
  }

  for (const { rowNumber, cells, issues: readerIssues } of nonBlank) {
    const issues: ImportIssue[] = [...(readerIssues ?? [])];
    // Formula / error cells in any column we read: the row is an error (never evaluated).
    for (const [column, index] of Object.entries(map.columns) as [TemplateColumn, number][]) {
      const c = cells[index];
      if (isFormula(c)) issues.push({ code: "formula_cell", severity: "error", field: fieldOf(column), message: `${headerLabel(column)}: ${FORMULA_MESSAGE}` });
      else if (isError(c)) issues.push({ code: "cell_error", severity: "error", field: fieldOf(column), message: `${headerLabel(column)}: the cell shows an error value (${c.error}).` });
    }

    const questionId = cleanText(cellValue(at(cells, "questionId")));
    const revisionCell = cellValue(at(cells, "revision"));
    let expectedRevision: number | null = null;
    const revisionText = cleanText(revisionCell);
    if (revisionText) {
      if (/^\d{1,9}$/.test(revisionText) && Number(revisionText) >= 1) expectedRevision = Number(revisionText);
      else if (questionId) issues.push({ code: "revision_invalid", severity: "error", field: "questionId", message: `Revision must be the whole number from the export (got "${revisionText}").` });
    }
    if (questionId && expectedRevision === null && !issues.some((i) => i.code === "revision_invalid")) {
      issues.push({ code: "revision_missing", severity: "error", field: "questionId", message: 'Revision is required when a Question ID is given. Use "Export draft questions for update" to get it.' });
    }

    result.rows.push({
      rowNumber,
      questionId: questionId || null,
      courseCode: textOf(at(cells, "courseCode")),
      moduleCode: textOf(at(cells, "moduleCode")),
      questionType: textOf(at(cells, "questionType")),
      questionText: textOf(at(cells, "questionText")),
      options: OPTION_LETTERS.map((l) => {
        const v = cellValue(at(cells, `option${l}` as TemplateColumn));
        return typeof v === "boolean" ? String(v).toUpperCase() : v;
      }),
      correctAnswer: cellValue(at(cells, "correctAnswer")) as string | number | boolean | null,
      marks: numberOrText(cellValue(at(cells, "marks"))),
      explanation: textOf(at(cells, "explanation")),
      status: textOf(at(cells, "status")),
      expectedRevision: questionId ? expectedRevision : null,
      sourceIssues: issues.length > 0 ? issues : undefined,
    });
  }
  result.everyRowHasCourse = map.columns.courseCode !== undefined && result.rows.every((r) => cleanText(r.courseCode) !== "");
  return result;
}

function textOf(c: SheetCell): string | null {
  const v = cellValue(c);
  return v === null ? null : cleanText(v);
}

function numberOrText(v: string | number | boolean | null): string | number | null {
  if (v === null) return null;
  return typeof v === "number" ? v : cleanText(v);
}

function headerLabel(column: TemplateColumn): string {
  if (column.startsWith("option")) return `Option ${column.slice(6)}`;
  return ({ questionId: "Question ID", courseCode: "Course Code", moduleCode: "Module Code", questionText: "Question Text", questionType: "Type", marks: "Marks", correctAnswer: "Correct Answer", explanation: "Explanation", status: "Status", revision: "Revision" } as Record<string, string>)[column] ?? column;
}

function fieldOf(column: TemplateColumn): ImportIssue["field"] {
  if (column.startsWith("option")) return "options";
  if (column === "revision") return "questionId";
  return column as ImportIssue["field"];
}
