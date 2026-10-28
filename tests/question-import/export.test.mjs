import { test } from "node:test";
import assert from "node:assert/strict";
import { core, load, ExcelJS, context, C1 } from "./helpers.mjs";

const exp = await load("export");
const { parseXlsx } = await load("xlsx");
const { parseCsvText } = await load("csv");
const { validateImport } = core;

const Q = (overrides = {}) => ({
  id: "dddddddd-0000-4000-8000-000000000001", courseCode: "SPI-101", moduleCode: "M1", text: "Which device measures level?", type: "single_choice", marks: 1.5,
  options: [{ text: "LT", isCorrect: true }, { text: "PT", isCorrect: false }, { text: "TT", isCorrect: false }],
  explanation: "Level transmitter.", status: "draft", revision: 3, ...overrides,
});
const MC = Q({ id: "dddddddd-0000-4000-8000-000000000002", type: "multiple_choice", text: "Temperature sensors?", options: [{ text: "RTD", isCorrect: true }, { text: "Orifice", isCorrect: false }, { text: "Thermocouple", isCorrect: true }], status: "active", revision: 2 });
const TF = Q({ id: "dddddddd-0000-4000-8000-000000000003", type: "true_false", text: "A PT measures pressure.", options: [{ text: "True", isCorrect: false }, { text: "False", isCorrect: true }], status: "archived", moduleCode: null, explanation: null });

async function xlsxSheets(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb;
}
async function sheetXml(bytes, index = 1) {
  // ExcelJS ships JSZip; read the raw XML to prove no formulas were written.
  const { default: JSZip } = await import(new URL("../../node_modules/jszip/lib/index.js", import.meta.url).href);
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(`xl/worksheets/sheet${index}.xml`).async("string");
}

// ---- formula injection ----
test("escapeSpreadsheetText: = + - @ get a leading apostrophe; ordinary text untouched", () => {
  assert.equal(exp.escapeSpreadsheetText("=HYPERLINK(\"http://evil\")"), "'=HYPERLINK(\"http://evil\")");
  assert.equal(exp.escapeSpreadsheetText("+1 800"), "'+1 800");
  assert.equal(exp.escapeSpreadsheetText("-5 V"), "'-5 V");
  assert.equal(exp.escapeSpreadsheetText("@SUM(A1)"), "'@SUM(A1)");
  for (const safe of ["Flow transmitter", "4-20 mA", "a = b", "", "'quoted", "Ünïcödé"]) assert.equal(exp.escapeSpreadsheetText(safe), safe);
});

// ---- tables ----
test("bank export table: canonical headers incl. Status + Revision; answer keys for staff", () => {
  const t = exp.buildExportTable([Q(), MC, TF], "bank");
  assert.deepEqual(t.headers, ["Question ID", "Course Code", "Module Code", "Question Text", "Type", "Marks", "Option A", "Option B", "Option C", "Option D", "Option E", "Option F", "Option G", "Option H", "Option I", "Option J", "Correct Answer", "Explanation", "Status", "Revision"]);
  const col = (row, h) => row[t.headers.indexOf(h)];
  assert.equal(col(t.rows[0], "Correct Answer"), "A");
  assert.equal(col(t.rows[1], "Correct Answer"), "A,C");
  assert.equal(col(t.rows[2], "Correct Answer"), "FALSE");
  assert.equal(col(t.rows[2], "Option A"), "", "true/false options left blank");
  assert.equal(col(t.rows[0], "Marks"), 1.5);
  assert.equal(col(t.rows[1], "Status"), "active");
  assert.equal(col(t.rows[0], "Revision"), 3);
  assert.equal(col(t.rows[2], "Module Code"), "");
});

test("update export: drafts only, no Status column, Question ID + Revision kept", () => {
  const t = exp.buildExportTable([Q(), MC, TF], "update");
  assert.equal(t.rows.length, 1);
  assert.ok(!t.headers.includes("Status"));
  assert.equal(t.rows[0][0], Q().id);
  assert.equal(t.rows[0][t.headers.indexOf("Revision")], 3);
});

test("export table escapes formula-like text in every text column", () => {
  const evil = Q({ text: "=cmd|' /C calc'!A0", options: [{ text: "+1", isCorrect: true }, { text: "@x", isCorrect: false }], explanation: "-2", moduleCode: "=M" });
  const [row] = exp.buildExportTable([evil], "bank").rows;
  for (const cell of row) if (typeof cell === "string") assert.doesNotMatch(cell, /^[=+\-@]/, cell);
});

// ---- files ----
test("CSV export: BOM, quoted, CRLF, escaped; parses back to the same questions (round trip)", async () => {
  const evil = Q({ id: "dddddddd-0000-4000-8000-000000000009", text: "=1+1 as text?", options: [{ text: "-5 V", isCorrect: true }, { text: "+5 V, loop", isCorrect: false }] });
  const csv = exp.toCsvText(exp.buildExportTable([Q(), MC, TF, evil], "bank"));
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes('"\'=1+1 as text?"'), "escaped with an apostrophe inside quotes");
  const back = parseCsvText(csv);
  assert.deepEqual(back.fileErrors, []);
  assert.equal(back.rows.length, 4);
  assert.equal(back.rows[3].questionText, "=1+1 as text?", "escape removed on import");
  assert.equal(back.rows[3].options[0], "-5 V");
  assert.equal(back.rows[1].correctAnswer, "A,C");
  assert.equal(back.rows[0].expectedRevision, 3);
});

test("XLSX export: string cells only (no formulas in the file), escaped, round trip through the importer", async () => {
  const evil = Q({ id: "dddddddd-0000-4000-8000-000000000009", text: "=HYPERLINK(\"http://x\")", options: [{ text: "@SUM(1)", isCorrect: true }, { text: "B", isCorrect: false }] });
  const bytes = await exp.toXlsxBytes(exp.buildExportTable([Q(), MC, TF, evil], "bank"));
  const xml = await sheetXml(bytes);
  assert.equal((xml.match(/<f>|<f /g) ?? []).length, 0, "no formula elements");
  const wb = await xlsxSheets(bytes);
  const cell = wb.getWorksheet("Questions").getRow(5).getCell(4);
  assert.equal(cell.type, ExcelJS.ValueType.String);
  assert.equal(cell.value, "'=HYPERLINK(\"http://x\")");
  const back = await parseXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(back.rows.length, 4);
  assert.equal(back.rows[3].questionText, "=HYPERLINK(\"http://x\")");
  assert.equal(back.rows[3].options[0], "@SUM(1)");
});

test("draft update export → edit → re-import validates as UPDATE with the exported revision", async () => {
  const bytes = await exp.toXlsxBytes(exp.buildExportTable([Q({ id: "dddddddd-0000-4000-8000-000000000001" })], "update"));
  const back = await parseXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  back.rows[0].questionText = "Which device measures level? (edited)";
  const { results } = await validateImport(back.rows, context());
  assert.equal(results[0].status, "UPDATE");
  assert.equal(results[0].expectedRevision, 3);
  assert.equal(results[0].question.courseId, C1);
});

// ---- template ----
test("XLSX template: Questions (headers only — the only sheet imported), Instructions, Examples; no formulas, no IDs", async () => {
  const bytes = await exp.templateXlsxBytes();
  const wb = await xlsxSheets(bytes);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Questions", "Instructions", "Examples"]);
  const q = wb.getWorksheet("Questions");
  assert.equal(q.actualRowCount, 1, "no example rows in the imported sheet");
  const instructions = wb.getWorksheet("Instructions").getColumn(1).values.filter(Boolean).join("\n");
  for (const topic of [/Type: single_choice, multiple_choice or true_false/, /Options A–J/, /Correct Answer|CORRECT ANSWER/, /Marks: a number greater than 0/, /created as a DRAFT/i, /Only DRAFT questions can be updated/, /Question ID and Revision/, /course of a question cannot be changed/]) {
    assert.match(instructions, topic);
  }
  for (let i = 1; i <= 3; i++) assert.equal(((await sheetXml(bytes, i)).match(/<f>|<f /g) ?? []).length, 0);
  const examples = wb.getWorksheet("Examples");
  const idCol = examples.getColumn(1).values.slice(2).filter((v) => v !== null && v !== undefined && v !== "");
  assert.deepEqual(idCol, [], "examples carry no Question IDs");
  // Importing the template as-is yields nothing to import (examples are never read).
  const parsed = await parseXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(parsed.rows.length, 0);
});

test("CSV template: header row only (no example rows that could be imported)", () => {
  const csv = exp.templateCsvText();
  const parsed = parseCsvText(csv);
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.rows.length, 0);
  assert.equal(csv.trim().split(/\r?\n/).length, 1);
});

test("file names", () => {
  const d = new Date("2026-09-29T10:00:00Z");
  assert.equal(exp.exportFileName("bank", "xlsx", d), "question-bank-export-2026-09-29.xlsx");
  assert.equal(exp.exportFileName("update", "csv", d), "draft-questions-for-update-2026-09-29.csv");
  assert.equal(exp.exportFileName("template", "xlsx", d), "question-import-template.xlsx");
});
