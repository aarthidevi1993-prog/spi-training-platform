/**
 * Bulk import — Excel (.xlsx) reader, in the browser (the file is never
 * uploaded). Reads the worksheet named "Questions" when there is one,
 * otherwise the first worksheet. Cells are read as values — formulas are
 * never evaluated or trusted (a formula cell makes its row an error).
 */
import ExcelJS from "exceljs";
import type { ParsedImportFile } from "@/types/question-import";
import { checkFileSize, rowsFromSheet, type SheetCell, type SheetRow } from "./sheet";

function toCell(value: ExcelJS.CellValue): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) return { formula: true };
    if ("error" in value) return { error: String((value as ExcelJS.CellErrorValue).error) };
    if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
    if ("text" in value) {
      const text = (value as ExcelJS.CellHyperlinkValue).text as unknown;
      if (typeof text === "string") return text;
      if (text && typeof text === "object" && "richText" in text) return (text as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
    }
  }
  return String(value);
}

export async function parseXlsx(data: ArrayBuffer): Promise<ParsedImportFile> {
  const empty = (error: string): ParsedImportFile => ({ source: "xlsx", rows: [], fileErrors: [error], warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });
  const tooBig = checkFileSize("xlsx", data.byteLength);
  if (tooBig) return empty(tooBig);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data);
  } catch {
    return empty("This file could not be read as an Excel .xlsx workbook. It may be damaged, password-protected, or an older .xls file — save it as .xlsx and try again.");
  }
  const sheet = workbook.worksheets.find((ws) => ws.name.trim().toLowerCase() === "questions") ?? workbook.worksheets[0];
  if (!sheet) return empty("This workbook has no worksheets.");

  let header: SheetCell[] = [];
  const data_: SheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: SheetCell[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = toCell(cell.value);
    });
    if (rowNumber === 1) header = cells;
    else data_.push({ rowNumber, cells });
  });
  if (header.length === 0) return empty(`The worksheet "${sheet.name}" has no header row in row 1.`);
  return rowsFromSheet("xlsx", header, data_, { sheetName: sheet.name });
}
