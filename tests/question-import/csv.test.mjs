import { test } from "node:test";
import assert from "node:assert/strict";
import { core, load, fixture, arrayBufferOf, context } from "./helpers.mjs";

const { parseCsv, parseCsvText } = await load("csv");
const { validateImport } = core;
const HEADER = "Question ID,Course Code,Module Code,Question Text,Type,Marks,Option A,Option B,Option C,Option D,Option E,Option F,Option G,Option H,Option I,Option J,Correct Answer,Explanation,Status,Revision";
const read = (name) => parseCsv(arrayBufferOf(fixture(`csv/${name}`)));
const codes = (row) => (row.sourceIssues ?? []).map((i) => i.code);

test("UTF-8 BOM + CRLF: BOM removed, three valid rows (single, multiple, true/false)", async () => {
  const p = read("bom-crlf-valid.csv");
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].questionId, null);
  assert.equal(p.rows[0].courseCode, "SPI-101");
  assert.equal(p.rows[1].correctAnswer, "A,C");
  const { summary } = await validateImport(p.rows, context({ source: "csv" }));
  assert.equal(summary.create, 3);
  assert.equal(summary.error, 0);
});

test("CRLF built in code (independent of git line-ending settings)", () => {
  const p = parseCsvText(`﻿${HEADER}\r\n,SPI-101,,Q?,single_choice,1,A,B,,,,,,,,,A,,,\r\n`);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].questionText, "Q?");
});

test("quoted commas, doubled quotes, multiline question, Unicode preserved", async () => {
  const p = read("quoted-multiline-unicode.csv");
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].questionText, 'Choose the range, in mA, used by "smart" transmitters');
  assert.equal(p.rows[0].options[0], "4-20 mA, loop powered");
  assert.equal(p.rows[0].marks, "1.5");
  assert.equal(p.rows[1].questionText, "Line one of the question\nLine two: which is correct?");
  assert.equal(p.rows[1].rowNumber, 3, "record numbers, not physical lines");
  assert.equal(p.rows[2].questionText, "Débit massique — Coriolis ≈ ±0.1 % ; 流量计 ✓");
  assert.equal(p.rows[2].explanation, "Ünïcödé explanation");
  const { summary } = await validateImport(p.rows, context({ source: "csv" }));
  assert.equal(summary.create, 3);
});

test("malformed CSV (unclosed quote) is refused as a whole, never reinterpreted", () => {
  const p = read("malformed-quote.csv");
  assert.equal(p.rows.length, 0);
  assert.match(p.fileErrors[0], /malformed/);
});

test("wrong field count is a row error; blank rows skipped; duplicates detected", async () => {
  const p = read("duplicates-blank-fieldcount.csv");
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.blankRowsSkipped, 2);
  const byText = (t) => p.rows.find((r) => r.questionText?.startsWith(t));
  assert.deepEqual(codes(byText("Too few")), ["row_malformed"]);
  assert.deepEqual(codes(byText("Too many")), ["row_malformed"]);
  const { results } = await validateImport(p.rows, context({ source: "csv" }));
  const status = (t) => results.find((r) => r.rowNumber === byText(t).rowNumber).status;
  assert.equal(status("Duplicate me"), "CREATE");
  assert.equal(status("duplicate   ME"), "DUPLICATE");
  assert.equal(status("Too few"), "ERROR");
  assert.equal(status("Too many"), "ERROR");
});

test("missing required headers are reported, nothing imported", () => {
  const p = read("bad-headers.csv");
  assert.equal(p.rows.length, 0);
  assert.match(p.fileErrors[0], /Missing required columns: Type, Question Text, Option A, Option B, Correct Answer, Marks/);
});

test("non-UTF-8 file refused with a clear message", () => {
  const p = read("latin1.csv");
  assert.match(p.fileErrors[0], /not UTF-8/);
});

test("empty file refused", () => {
  assert.match(parseCsv(new ArrayBuffer(0)).fileErrors[0], /empty/);
  assert.match(parseCsvText("﻿").fileErrors[0], /empty/);
});

test("10,000 rows accepted; 10,001 refused (CSV limit)", () => {
  const line = (i) => `,SPI-101,,Scale question ${i}?,single_choice,1,A,B,,,,,,,,,A,,,`;
  const ok = parseCsvText([HEADER, ...Array.from({ length: 10000 }, (_, i) => line(i))].join("\n"));
  assert.deepEqual(ok.fileErrors, []);
  assert.equal(ok.rows.length, 10000);
  const over = parseCsvText([HEADER, ...Array.from({ length: 10001 }, (_, i) => line(i))].join("\n"));
  assert.equal(over.rows.length, 0);
  assert.match(over.fileErrors[0], /10001 questions; the limit for this file type is 10000/);
});

test("oversized file (> 10 MB) refused before parsing", () => {
  const p = parseCsv(new ArrayBuffer(10 * 1024 * 1024 + 1));
  assert.match(p.fileErrors[0], /limit is 10 MB/);
});

test("Type alias 'Question Type' accepted; Revision + Question ID become an update row", () => {
  const p = parseCsvText(
    "Question ID,Course Code,Question Text,Question Type,Marks,Option A,Option B,Correct Answer,Revision\n" +
      "dddddddd-0000-4000-8000-000000000001,SPI-101,Edited?,single_choice,2,A,B,B,3\n"
  );
  assert.deepEqual(p.fileErrors, []);
  assert.equal(p.rows[0].questionId, "dddddddd-0000-4000-8000-000000000001");
  assert.equal(p.rows[0].expectedRevision, 3);
});

test("exported formula-escaped text is read back without the escape apostrophe", () => {
  const p = parseCsvText(`${HEADER}\n,SPI-101,,"'=1+1 is shown as text?",single_choice,1,"'-5 V",'+5 V,,,,,,,,,A,,,\n`);
  assert.equal(p.rows[0].questionText, "=1+1 is shown as text?");
  assert.equal(p.rows[0].options[0], "-5 V");
  assert.equal(p.rows[0].options[1], "+5 V");
});
