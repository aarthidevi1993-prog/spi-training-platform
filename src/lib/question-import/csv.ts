/**
 * Bulk import — CSV reader, in the browser (the file is never uploaded).
 * UTF-8 (with or without BOM), comma-separated, RFC 4180 quoting (quoted
 * commas, doubled quotes, line breaks inside quotes), CRLF or LF.
 * Malformed input is reported, never reinterpreted: an unclosed quote
 * stops the file; a record with the wrong number of fields is an error
 * row.
 */
import Papa from "papaparse";
import type { ImportIssue, ParsedImportFile } from "@/types/question-import";
import { checkFileSize, rowsFromSheet, type SheetRow } from "./sheet";

const empty = (error: string): ParsedImportFile => ({ source: "csv", rows: [], fileErrors: [error], warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });

export function parseCsv(data: ArrayBuffer): ParsedImportFile {
  const tooBig = checkFileSize("csv", data.byteLength);
  if (tooBig) return empty(tooBig);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return empty("This CSV file is not UTF-8 text. Save it as “CSV UTF-8” and try again.");
  }
  return parseCsvText(text);
}

export function parseCsvText(input: string): ParsedImportFile {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!text.trim()) return empty("This CSV file is empty.");
  const parsed = Papa.parse<string[]>(text, { delimiter: ",", quoteChar: '"', escapeChar: '"', header: false, skipEmptyLines: false });

  const quoteErrors = parsed.errors.filter((e) => e.type === "Quotes");
  if (quoteErrors.length > 0) {
    const where = quoteErrors.slice(0, 3).map((e) => (typeof e.row === "number" ? `record ${e.row + 1}` : "the file")).join(", ");
    return empty(`This CSV file is malformed: a quoted value is not closed or is followed by extra text (${where}). Fix the quotes and try again.`);
  }
  const records = parsed.data;
  // A final line break produces one empty record: not a row.
  if (records.length > 1 && records[records.length - 1]!.length === 1 && records[records.length - 1]![0] === "") records.pop();
  const [header = [], ...rest] = records;
  const width = header.length;
  const rows: SheetRow[] = rest.map((cells, i) => {
    const blank = cells.every((c) => c.trim() === "");
    const issues: ImportIssue[] =
      !blank && cells.length !== width
        ? [{ code: "row_malformed", severity: "error", field: "row", message: `This record has ${cells.length} values but the header has ${width} columns. Check for a missing or extra comma or quote.` }]
        : [];
    return { rowNumber: i + 2, cells, issues: issues.length ? issues : undefined };
  });
  return rowsFromSheet("csv", header, rows);
}
