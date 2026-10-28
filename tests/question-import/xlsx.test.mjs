import { test } from "node:test";
import assert from "node:assert/strict";
import { core, load, ExcelJS, context } from "./helpers.mjs";

const { parseXlsx } = await load("xlsx");
const { validateImport } = core;
const HEADER = ["Question ID", "Course Code", "Module Code", "Question Text", "Type", "Marks", "Option A", "Option B", "Option C", "Option D", "Option E", "Option F", "Option G", "Option H", "Option I", "Option J", "Correct Answer", "Explanation", "Status", "Revision"];
/** A data row by header name. */
const R = (values) => HEADER.map((h) => (h in values ? values[h] : null));

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((row, i) => {
      if (row === null) return; // leave the row empty
      ws.getRow(i + 1).values = [undefined, ...row]; // ExcelJS rows are 1-based
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const SC = { "Course Code": "SPI-101", "Question Text": "Which device measures level?", Type: "single_choice", Marks: 1, "Option A": "LT", "Option B": "PT", "Option C": "TT", "Correct Answer": "A" };
const MC = { "Course Code": "SPI-101", "Question Text": "Which are temperature sensors?", Type: "multiple_choice", Marks: 2.5, "Option A": "RTD", "Option B": "Orifice", "Option C": "Thermocouple", "Correct Answer": "A,C" };
const TF = { "Course Code": "SPI-101", "Question Text": "A control valve is a final element.", Type: "true_false", Marks: 1, "Correct Answer": true };

test("valid single choice, multiple choice and true/false (numbers and booleans as cells)", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R(SC), R(MC), R(TF)] }]));
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.sheetName, "Questions");
  assert.deepEqual(p.rows.map((r) => r.rowNumber), [2, 3, 4], "spreadsheet row numbers");
  assert.equal(p.rows[1].marks, 2.5);
  assert.equal(p.rows[2].correctAnswer, true);
  const { results, summary } = await validateImport(p.rows, context());
  assert.equal(summary.create, 3, JSON.stringify(results.map((r) => r.issues)));
  assert.deepEqual(results[1].question.options.map((o) => o.isCorrect), [true, false, true]);
  assert.deepEqual(results[2].question.options, [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }]);
});

test("Unicode is preserved (text, options, explanation)", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R({ ...SC, "Question Text": "Débit — 流量计 ✓ ≈ ±0.1 %?", "Option A": "Ωmega", Explanation: "Ünïcödé" })] }]));
  assert.equal(p.rows[0].questionText, "Débit — 流量计 ✓ ≈ ±0.1 %?");
  assert.equal(p.rows[0].options[0], "Ωmega");
  assert.equal(p.rows[0].explanation, "Ünïcödé");
});

test("blank rows are skipped (truly empty and all-blank cells), numbering kept", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R(SC), null, R({}), R({ "Course Code": "   " }), R(MC)] }]));
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.rowNumber), [2, 6]);
  // ExcelJS never reports completely empty rows; the whitespace-only row is counted as skipped.
  assert.equal(p.blankRowsSkipped, 1);
});

test("a formula cell makes its row an ERROR and is never evaluated", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R({ ...SC, Marks: { formula: "1+1", result: 2 } }), R(MC)] }]));
  assert.equal(p.rows[0].marks, null, "formula result not used");
  assert.deepEqual(p.rows[0].sourceIssues.map((i) => i.code), ["formula_cell"]);
  assert.match(p.rows[0].sourceIssues[0].message, /Formula cells are not supported\. Replace the formula with its displayed value\./);
  const { results } = await validateImport(p.rows, context());
  assert.equal(results[0].status, "ERROR");
  assert.equal(results[1].status, "CREATE", "other rows unaffected");
});

test("an error-value cell (#N/A) makes its row an ERROR", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R({ ...SC, "Option B": { error: "#N/A" } })] }]));
  assert.deepEqual(p.rows[0].sourceIssues.map((i) => i.code), ["cell_error"]);
});

test("duplicate rows detected (in-file)", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R(SC), R({ ...SC, "Option A": "TT", "Option C": "LT", "Correct Answer": "C" }), R(SC)] }]));
  const { summary } = await validateImport(p.rows, context());
  assert.equal(summary.create, 1);
  assert.equal(summary.duplicate, 2);
});

test("malformed headers: missing required columns and a repeated column", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [["Question", "Answer", "Points"], ["What?", "A", 1]] }]));
  assert.equal(p.rows.length, 0);
  assert.match(p.fileErrors[0], /Missing required columns/);
  const dup = await parseXlsx(await workbook([{ name: "Questions", rows: [[...HEADER, "Question Type"], R(SC)] }]));
  assert.match(dup.fileErrors[0], /appears more than once/);
});

test('the "Questions" worksheet is read (any case); otherwise the first worksheet', async () => {
  const withQuestions = await parseXlsx(await workbook([{ name: "Instructions", rows: [["Read me"]] }, { name: "questions", rows: [HEADER, R(SC)] }, { name: "Examples", rows: [HEADER, R(MC)] }]));
  assert.equal(withQuestions.sheetName, "questions");
  assert.equal(withQuestions.rows.length, 1);
  const first = await parseXlsx(await workbook([{ name: "Sheet1", rows: [HEADER, R(MC)] }, { name: "Other", rows: [HEADER, R(SC)] }]));
  assert.equal(first.sheetName, "Sheet1");
  assert.equal(first.rows[0].questionText, MC["Question Text"]);
});

test("rich text and hyperlink cells are read as their text", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R({ ...SC, "Question Text": { richText: [{ text: "Bold " }, { text: "question?" }] }, Explanation: { text: "See spec", hyperlink: "https://example.com" } })] }]));
  assert.equal(p.rows[0].questionText, "Bold question?");
  assert.equal(p.rows[0].explanation, "See spec");
});

test("update rows: Question ID + Revision → expectedRevision; missing or bad Revision is an error", async () => {
  const id = "dddddddd-0000-4000-8000-000000000001";
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [HEADER, R({ ...SC, "Question ID": id, Revision: 3 }), R({ ...SC, "Question ID": id, "Question Text": "x" }), R({ ...SC, "Question ID": id, Revision: "three" })] }]));
  assert.equal(p.rows[0].expectedRevision, 3);
  assert.deepEqual(p.rows[1].sourceIssues.map((i) => i.code), ["revision_missing"]);
  assert.deepEqual(p.rows[2].sourceIssues.map((i) => i.code), ["revision_invalid"]);
  const { results } = await validateImport(p.rows, context());
  assert.equal(results[0].status, "UPDATE");
  assert.equal(results[0].expectedRevision, 3);
  assert.equal(results[1].status, "ERROR");
});

test("5,000 rows accepted; 5,001 refused (XLSX limit)", async () => {
  const rows = (n) => [HEADER, ...Array.from({ length: n }, (_, i) => R({ ...SC, "Question Text": `Scale question ${i}?` }))];
  const ok = await parseXlsx(await workbook([{ name: "Questions", rows: rows(5000) }]));
  assert.deepEqual(ok.fileErrors, []);
  assert.equal(ok.rows.length, 5000);
  const over = await parseXlsx(await workbook([{ name: "Questions", rows: rows(5001) }]));
  assert.equal(over.rows.length, 0);
  assert.match(over.fileErrors[0], /5001 questions; the limit for this file type is 5000/);
});

test("oversized file (> 10 MB) refused before parsing", async () => {
  const p = await parseXlsx(new ArrayBuffer(10 * 1024 * 1024 + 1));
  assert.match(p.fileErrors[0], /limit is 10 MB/);
});

test("a damaged / non-xlsx file is refused with a clear message", async () => {
  const p = await parseXlsx(new TextEncoder().encode("this is not a zip file").buffer);
  assert.match(p.fileErrors[0], /could not be read as an Excel \.xlsx workbook/);
});

test("header row missing → clear error", async () => {
  const p = await parseXlsx(await workbook([{ name: "Questions", rows: [null, R(SC)] }]));
  assert.ok(p.fileErrors.length > 0);
});
