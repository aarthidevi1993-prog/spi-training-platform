/**
 * Bulk import — Question Bank export files and the official import
 * template (Excel .xlsx and CSV). Built in the browser from data the
 * server returned for the caller's own scope; nothing is uploaded.
 *
 * Formula-injection protection: every text cell that starts with
 * = + - or @ gets a leading apostrophe, so spreadsheet software shows it
 * as text and never runs it. The importer removes exactly that
 * apostrophe again (sheet.ts), so an exported file can be re-imported
 * unchanged. No formulas are ever written.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { OPTION_LETTERS, type ExportMode, type ExportQuestion, type SheetTable } from "@/types/question-import";
import { TEMPLATE_HEADERS } from "./headers";

export function escapeSpreadsheetText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

const ALL_HEADERS = TEMPLATE_HEADERS.map((h) => h.header);
/** Update files leave out Status: an import never changes a question's status. */
const UPDATE_HEADERS = ALL_HEADERS.filter((h) => h !== "Status");

export function exportHeaders(mode: ExportMode): string[] {
  return mode === "update" ? [...UPDATE_HEADERS] : [...ALL_HEADERS];
}

/** The Correct Answer cell: option letters ("A,C"), or TRUE/FALSE for true/false questions. */
export function correctAnswerOf(q: Pick<ExportQuestion, "type" | "options">): string {
  if (q.type === "true_false") return q.options[0]?.isCorrect ? "TRUE" : "FALSE";
  return q.options.map((o, i) => (o.isCorrect ? OPTION_LETTERS[i] : null)).filter(Boolean).join(",");
}

/**
 * The export table. "bank": every question given, with Status.
 * "update": draft questions only, without Status — ready to edit and
 * re-import (Question ID + Revision identify the draft; the course
 * cannot change).
 */
export function buildExportTable(questions: ExportQuestion[], mode: ExportMode): SheetTable {
  const headers = exportHeaders(mode);
  const selected = mode === "update" ? questions.filter((q) => q.status === "draft") : questions;
  const rows = selected.map((q) => {
    const options = OPTION_LETTERS.map((_, i) => (q.type === "true_false" ? "" : escapeSpreadsheetText(q.options[i]?.text ?? "")));
    const row: Array<string | number> = [
      q.id,
      escapeSpreadsheetText(q.courseCode),
      escapeSpreadsheetText(q.moduleCode ?? ""),
      escapeSpreadsheetText(q.text),
      q.type,
      q.marks,
      ...options,
      correctAnswerOf(q),
      escapeSpreadsheetText(q.explanation ?? ""),
    ];
    if (mode === "bank") row.push(q.status);
    row.push(q.revision);
    return row;
  });
  return { headers, rows };
}

/** CSV text: UTF-8 BOM (so Excel reads Unicode correctly), every value quoted, CRLF. */
export function toCsvText(table: SheetTable): string {
  return "﻿" + Papa.unparse({ fields: table.headers, data: table.rows }, { quotes: true, newline: "\r\n" });
}

function styleHeader(sheet: ExcelJS.Worksheet, widths: number[]) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
}

function widthsFor(headers: string[]): number[] {
  return headers.map((h) => (h === "Question Text" || h === "Explanation" ? 60 : h === "Question ID" ? 38 : h.startsWith("Option") ? 24 : 16));
}

function addTable(workbook: ExcelJS.Workbook, name: string, table: SheetTable) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(table.headers);
  for (const row of table.rows) sheet.addRow(row);
  styleHeader(sheet, widthsFor(table.headers));
  return sheet;
}

export async function toXlsxBytes(table: SheetTable, sheetName = "Questions"): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ARSÈNE SPI Training Platform";
  addTable(workbook, sheetName, table);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Official import template
// ---------------------------------------------------------------------------

export const TEMPLATE_INSTRUCTIONS: string[] = [
  "ARSÈNE SPI — Question Bank import template",
  "",
  'Fill in the "Questions" sheet only: one question per row, starting in row 2. Row 1 must stay as it is.',
  'The "Examples" sheet shows filled-in examples. It is never imported.',
  "",
  "REQUIRED",
  "• Type: single_choice, multiple_choice or true_false.",
  "• Question Text: up to 5,000 characters.",
  "• Marks: a number greater than 0 with at most 2 decimals (e.g. 1 or 1.5). Missing marks are an error — they are never defaulted.",
  "• Correct Answer (see below).",
  "• Course Code: your course's code (e.g. SPI-101). If the column is left blank, you choose the course during import.",
  "",
  "OPTIONAL",
  "• Module Code: must belong to the row's course.",
  "• Explanation: shown only when a test releases correct answers.",
  "",
  "OPTIONS",
  "• Single and multiple choice: 2 to 10 options, filled from Option A with no gaps (Options A–J).",
  "• Options must all be different.",
  "• True/false: leave Option A and B blank (or write True and False); the options are always True and False.",
  "",
  "CORRECT ANSWER",
  "• Single choice: one letter, e.g. B",
  "• Multiple choice: letters separated by commas, e.g. A,C",
  "• True/false: TRUE or FALSE",
  "• Answers are never guessed: “AC”, option text, numbers or letters of blank options are errors.",
  "",
  "STATUS",
  "• Every imported question is created as a DRAFT. A Status column is ignored (a warning is shown).",
  "• Questions become active only after the normal review in the Question Bank.",
  "",
  "UPDATING EXISTING QUESTIONS",
  "• Leave Question ID and Revision blank for new questions.",
  "• To update, use “Export draft questions for update”, edit that file and import it. Keep its Question ID and Revision.",
  "• Only DRAFT questions can be updated. Active and archived questions are protected.",
  "• The course of a question cannot be changed.",
  "• If a question was changed after the export (a different Revision), the update is refused — export again.",
  "",
  "DUPLICATES",
  "• A question identical to one in the file or already in the course is excluded, unless you choose “Include anyway” in the preview.",
  "",
  "Do not use formulas — formula cells are refused. Limits: 5,000 questions per Excel file, 10,000 per CSV file, 10 MB.",
];

const EXAMPLE_ROWS: Array<Record<string, string | number>> = [
  { "Course Code": "EXAMPLE-COURSE", "Module Code": "", "Question Text": "EXAMPLE — Which instrument measures flow?", Type: "single_choice", Marks: 1, "Option A": "Flow transmitter", "Option B": "Pressure gauge", "Option C": "Level switch", "Correct Answer": "A", Explanation: "A flow transmitter measures flow." },
  { "Course Code": "EXAMPLE-COURSE", "Module Code": "", "Question Text": "EXAMPLE — Which of these are fieldbus protocols?", Type: "multiple_choice", Marks: 2, "Option A": "HART", "Option B": "Bluetooth", "Option C": "Profibus", "Correct Answer": "A,C", Explanation: "" },
  { "Course Code": "EXAMPLE-COURSE", "Module Code": "", "Question Text": "EXAMPLE — A control valve is a final control element.", Type: "true_false", Marks: 1, "Correct Answer": "TRUE", Explanation: "" },
];

export function templateTable(): SheetTable {
  return { headers: [...ALL_HEADERS], rows: [] };
}

/** Excel template: "Questions" (headers only — the only sheet imported), "Instructions", "Examples". */
export async function templateXlsxBytes(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ARSÈNE SPI Training Platform";
  addTable(workbook, "Questions", templateTable());
  const instructions = workbook.addWorksheet("Instructions");
  for (const line of TEMPLATE_INSTRUCTIONS) instructions.addRow([escapeSpreadsheetText(line)]);
  instructions.getColumn(1).width = 120;
  instructions.getRow(1).font = { bold: true, size: 13 };
  const examples = addTable(workbook, "Examples", {
    headers: [...ALL_HEADERS],
    rows: EXAMPLE_ROWS.map((ex) => ALL_HEADERS.map((h) => ex[h] ?? "")),
  });
  examples.getRow(1).font = { bold: true, italic: true };
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** CSV template: the header row only (CSV has no second sheet for examples). */
export function templateCsvText(): string {
  return toCsvText(templateTable());
}

export function exportFileName(mode: ExportMode | "template", format: "xlsx" | "csv", date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const base = mode === "template" ? "question-import-template" : mode === "update" ? `draft-questions-for-update-${day}` : `question-bank-export-${day}`;
  return `${base}.${format}`;
}
