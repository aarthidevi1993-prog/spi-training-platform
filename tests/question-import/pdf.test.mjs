// Phase G — PDF import: real PDFs (pdf-writer.mjs) through pdf.js and the shared block reader,
// validated with the same core as Excel/CSV/Word. No OCR: scanned PDFs are refused/flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { core, load, context, existing, row, C1, C2, M1, M2, Q_DRAFT, Q_ACTIVE } from "./helpers.mjs";
import { makePdf, pdfOf } from "./pdf-writer.mjs";

const { parsePdf, rowsFromPdfPages, pageLines, PDF_MAX_PAGES } = await load("pdf");
const { scanPdf, PDF_INFLATE_TOTAL_MAX } = await load("pdf-scan");
const { validateImport } = core;

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const parse = (lines, options) => parsePdf(ab(pdfOf(lines, options)));
const ctx = (overrides = {}) => context({ source: "pdf", ...overrides });
const byRow = (v, n) => v.results.find((r) => r.rowNumber === n);
const codesOf = (r) => r.issues.map((i) => i.code);

const SC = ["Q1. Which instrument measures flow?", "Type: single_choice", "Marks: 2", "A) Flow transmitter", "B) Pressure gauge", "C) Level switch", "Answer: A", "Explanation: A flow transmitter measures flow."];
const MC = ["Q2. Which of these are temperature sensors?", "Type: multiple_choice", "Marks: 2.5", "A) RTD", "B) Orifice plate", "C) Thermocouple", "Answer: A, C"];
const TF = ["Q3. A control valve is a final control element.", "Type: true_false", "Marks: 1", "Answer: TRUE"];

// ---------------------------------------------------------------------------
// Valid PDFs
// ---------------------------------------------------------------------------
test("valid PDF: single choice, multiple choice and true/false → CREATE; marks, explanation, page recorded", async () => {
  const parsed = await parse(["Course Code: SPI-101", ...SC, "", ...MC, ...TF], { compress: true });
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.source, "pdf");
  assert.deepEqual(parsed.rows.map((r) => r.rowNumber), [1, 2, 3]);
  assert.deepEqual(parsed.rows.map((r) => r.source), [{ page: 1 }, { page: 1 }, { page: 1 }]);
  const [sc, mc, tf] = parsed.rows;
  assert.equal(sc.questionText, "Which instrument measures flow?");
  assert.deepEqual(sc.options.slice(0, 4), ["Flow transmitter", "Pressure gauge", "Level switch", null]);
  assert.equal(sc.explanation, "A flow transmitter measures flow.");
  assert.equal(mc.marks, "2.5");
  assert.equal(tf.correctAnswer, "TRUE");
  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.summary, { total: 3, create: 3, update: 0, duplicate: 0, error: 0, needsReview: 0 }, JSON.stringify(v.results.map((r) => r.issues)));
  assert.deepEqual(byRow(v, 1).question.options.map((o) => o.isCorrect), [true, false, false]);
  assert.equal(byRow(v, 1).question.marks, 2);
  assert.equal(byRow(v, 1).question.explanation, "A flow transmitter measures flow.");
  assert.deepEqual(byRow(v, 2).question.options.map((o) => o.isCorrect), [true, false, true]);
  assert.equal(byRow(v, 2).question.marks, 2.5);
  assert.deepEqual(byRow(v, 3).question.options, [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }]);
  assert.ok(!("status" in byRow(v, 1).question), "no status carried: the database creates drafts");
});

test("text wrapped at the page edge is joined (question, option, explanation); hyphenated wraps keep the hyphen; Unicode (WinAnsi) kept", async () => {
  const parsed = await parse([
    "Course Code: SPI-101",
    "Q1. Which signal range is the standard analog",
    "current loop used by field transmitters — 4-",
    "20 mA or something else?",
    "Type: single_choice",
    "Marks: 1",
    "A) The 4-20 mA current loop used by most",
    "field transmitters",
    "B) 0-5 V",
    "Answer: A",
    "Explanation: The live zero at 4 mA lets the",
    "receiver detect a broken wire.",
  ]);
  const r = parsed.rows[0];
  assert.equal(r.questionText, "Which signal range is the standard analog current loop used by field transmitters — 4-20 mA or something else?");
  assert.deepEqual(r.options.slice(0, 2), ["The 4-20 mA current loop used by most field transmitters", "0-5 V"]);
  assert.equal(r.explanation, "The live zero at 4 mA lets the receiver detect a broken wire.");
  assert.equal(r.sourceIssues, undefined);
  assert.equal((await validateImport(parsed.rows, ctx())).summary.create, 1);
});

test("text split into several pieces on one line is rebuilt in reading order; a question can continue on the next page", async () => {
  const bytes = makePdf([
    { lines: ["Course Code: SPI-101", [[72, "Q1."], [95, "Which"], [132, "one?"]], "Type: single_choice", "Marks: 1", [[72, "A)"], [90, "Alpha"]]] },
    { lines: ["B) Beta", "Answer: B"] },
  ]);
  const parsed = await parsePdf(ab(bytes));
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.rows[0].questionText, "Which one?");
  assert.deepEqual(parsed.rows[0].options.slice(0, 2), ["Alpha", "Beta"]);
  assert.deepEqual(parsed.rows[0].source, { page: 1 });
  assert.equal((await validateImport(parsed.rows, ctx())).summary.create, 1);
});

test("page numbers and repeated headers/footers are ignored (never lines of the question format)", async () => {
  const header = "SPI Mid-term paper — Instrumentation";
  const bytes = makePdf([
    { lines: [header, "Course Code: SPI-101", ...TF.map((l) => l.replace("Q3.", "Q1.")), "Page 1 of 3"] },
    { lines: [header, "Q2. Second question?", "Type: true_false", "Marks: 1", "Answer: FALSE", "Page 2 of 3"] },
    { lines: [header, "Q3. Third question?", "Type: true_false", "Marks: 1", "Answer: TRUE", "3"] },
  ]);
  const parsed = await parsePdf(ab(bytes));
  assert.deepEqual(parsed.fileErrors, []);
  assert.ok(parsed.warnings.some((w) => /Page numbers and repeated page headers\/footers were ignored/.test(w)));
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(v.summary.create, 3, JSON.stringify(v.results.map((r) => r.issues)));
});

// ---------------------------------------------------------------------------
// Course / module mapping
// ---------------------------------------------------------------------------
test("course/module mapping: document-level codes, per-question override, UI-chosen course, mismatch refused, unknown code refused", async () => {
  const parsed = await parse([
    "Course Code: SPI-101", "Module Code: M2",
    "Q1. Document course and module?", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q2. Own module?", "Module Code: M1", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q3. Other course?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q4. Unknown course?", "Course Code: NOPE-9", "Type: true_false", "Marks: 1", "Answer: TRUE",
  ]);
  assert.deepEqual(parsed.rows.map((r) => [r.courseCode, r.moduleCode]), [["SPI-101", "M2"], ["SPI-101", "M1"], ["SPI-201", null], ["NOPE-9", null]]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).question.moduleId, M2);
  assert.equal(byRow(v, 2).question.moduleId, M1);
  assert.equal(byRow(v, 3).question.courseId, C2);
  assert.equal(byRow(v, 4).issues[0].code, "course_not_found");

  const noCodes = await parse([...SC.slice(0, 7)]);
  assert.equal(noCodes.everyRowHasCourse, false);
  assert.equal(byRow(await validateImport(noCodes.rows, ctx()), 1).issues[0].code, "course_missing");
  assert.equal(byRow(await validateImport(noCodes.rows, ctx({ defaultCourseId: C1 })), 1).status, "CREATE");
  const mismatch = await validateImport(parsed.rows, ctx({ defaultCourseId: C1 }));
  assert.equal(byRow(mismatch, 3).issues[0].code, "course_mismatch", "a PDF's codes must match the course chosen for it");
});

// ---------------------------------------------------------------------------
// Never guess
// ---------------------------------------------------------------------------
test("invalid answers are ERRORS (option text, numbers, letters of missing options, words)", async () => {
  const q = (n, answer, type = "single_choice") => [`Q${n}. Question ${n}?`, `Type: ${type}`, "Marks: 1", "A) Alpha", "B) Beta", "C) Gamma", `Answer: ${answer}`];
  const parsed = await parse(["Course Code: SPI-101", ...q(1, "Alpha"), ...q(2, "2"), ...q(3, "D"), ...q(4, "A and C", "multiple_choice"), "Q5. TF?", "Type: true_false", "Marks: 1", "Answer: Correct"]);
  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.results.map((r) => r.status), ["ERROR", "ERROR", "ERROR", "ERROR", "ERROR"]);
  assert.deepEqual(v.results.map((r) => r.issues[0].code), ["answer_invalid", "answer_invalid", "answer_blank_option", "answer_invalid", "answer_invalid"]);
});

test("ambiguous answers are never guessed: two answers for single choice, run-together letters, two Answer lines", async () => {
  const parsed = await parse([
    "Course Code: SPI-101",
    "Q1. Two answers for single choice?", "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A, B",
    "Q2. Run-together letters?", "Type: multiple_choice", "Marks: 1", "A) a", "B) b", "Answer: AB",
    "Q3. Two answer lines?", "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A", "Answer: B",
    "Q4. Missing answer?", "Type: single_choice", "Marks: 1", "A) a", "B) b",
  ]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).issues[0].code, "answer_count");
  assert.equal(byRow(v, 2).issues[0].code, "answer_invalid");
  assert.equal(byRow(v, 3).status, "ERROR");
  assert.ok(codesOf(byRow(v, 3)).includes("row_malformed"));
  assert.equal(byRow(v, 4).status, "NEEDS_REVIEW");
  assert.ok(codesOf(byRow(v, 4)).includes("answer_missing"));
  assert.equal(v.summary.create, 0);
});

test("malformed questions: missing marks → ERROR; missing type/text/options → NEEDS REVIEW; stray lines, inline options, columns → NEEDS REVIEW", async () => {
  const parsed = await parse([
    "Course Code: SPI-101",
    "Q1. No marks?", "Type: true_false", "Answer: TRUE",
    "Q2. No type?", "Marks: 1", "A) a", "B) b", "Answer: A",
    "Q3.", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q4. One option?", "Type: single_choice", "Marks: 1", "A) a", "Answer: A",
    "Q5. Stray line?", "Type: true_false", "Marks: 1", "Answer: TRUE", "Something unexpected here",
    "Q6. Inline options?", "Type: single_choice", "Marks: 1", "A) Alpha   B) Beta", "Answer: A",
    "Q7. Invalid marks?", "Type: true_false", "Marks: one", "Answer: TRUE",
  ]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "ERROR");
  assert.ok(codesOf(byRow(v, 1)).includes("marks_missing"));
  assert.ok(codesOf(byRow(v, 2)).includes("type_missing"));
  assert.equal(byRow(v, 2).status, "NEEDS_REVIEW");
  assert.ok(codesOf(byRow(v, 3)).includes("text_missing"));
  assert.equal(byRow(v, 3).status, "NEEDS_REVIEW");
  assert.ok(codesOf(byRow(v, 4)).includes("options_too_few"));
  assert.equal(byRow(v, 4).status, "NEEDS_REVIEW");
  assert.match(byRow(v, 5).issues.map((i) => i.message).join(" "), /was not understood/);
  assert.equal(byRow(v, 5).status, "NEEDS_REVIEW");
  assert.match(byRow(v, 6).issues.map((i) => i.message).join(" "), /next option on the same line/);
  assert.equal(byRow(v, 7).status, "ERROR");
  assert.ok(codesOf(byRow(v, 7)).includes("marks_invalid"));

  const columns = await parsePdf(ab(makePdf([{ lines: ["Course Code: SPI-101", "Q1. Two columns?", "Type: single_choice", "Marks: 1", [[72, "A) Alpha"], [330, "B) Beta"]], "Answer: A"] }])));
  const cv = await validateImport(columns.rows, ctx());
  assert.equal(byRow(cv, 1).status, "NEEDS_REVIEW");
  assert.match(byRow(cv, 1).issues.map((i) => i.message).join(" "), /columns or a table/);
});

test("two-column question paper: questions side by side are never silently merged — NEEDS REVIEW", async () => {
  const bytes = makePdf([{ lines: ["Course Code: SPI-101", [[72, "Q1. Left column question?"], [320, "Q2. Right column question?"]], [[72, "Type: true_false"], [320, "Type: true_false"]], [[72, "Marks: 1"], [320, "Marks: 1"]], [[72, "Answer: TRUE"], [320, "Answer: FALSE"]]] }]);
  const parsed = await parsePdf(ab(bytes));
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(v.summary.create, 0, "nothing importable");
  assert.ok(v.results.every((r) => r.status !== "CREATE"));
  assert.match(v.results[0].issues.map((i) => i.message).join(" "), /columns or a table/);
});

test("Status lines never set a status; questions are created without one (drafts)", async () => {
  const parsed = await parse(["Course Code: SPI-101", ...TF, "Status: active"]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 3).status, "CREATE");
  assert.ok(codesOf(byRow(v, 3)).includes("status_ignored"));
});

// ---------------------------------------------------------------------------
// Duplicates and updates — exactly like Excel/CSV/Word
// ---------------------------------------------------------------------------
test("duplicates: in the file and in the bank, excluded unless included anyway — identical to Excel rows", async () => {
  const parsed = await parse(["Course Code: SPI-101", ...SC, "Q2. which instrument measures FLOW?", "Type: single_choice", "Marks: 1", "A) Flow transmitter", "B) Pressure gauge", "C) Level switch", "Answer: B", ...TF]);
  const bank = [await existing(Q_ACTIVE, C1, "true_false", "A control valve is a final control element.", ["True", "False"])];
  const v = await validateImport(parsed.rows, ctx({ existing: bank }));
  assert.deepEqual(byRow(v, 2).duplicateOf, { kind: "file", rowNumber: 1 });
  assert.deepEqual(byRow(v, 3).duplicateOf, { kind: "bank", questionId: Q_ACTIVE });
  const excel = await validateImport(parsed.rows.map((r) => row(r.rowNumber, { ...r, source: undefined })), context({ existing: bank }));
  assert.deepEqual(excel.results.map((r) => [r.status, r.fingerprint, r.textFingerprint]), v.results.map((r) => [r.status, r.fingerprint, r.textFingerprint]));
  const included = await validateImport(parsed.rows.map((r) => ({ ...r, includeAnyway: r.rowNumber === 2 })), ctx({ existing: bank }));
  assert.equal(byRow(included, 2).status, "CREATE");
});

test("draft update rules: Question ID + Revision → UPDATE; stale revision, missing revision, ACTIVE question → ERROR", async () => {
  const upd = (n, id, rev) => [`Q${n}. Updated ${n}?`, `Question ID: ${id}`, ...(rev === undefined ? [] : [`Revision: ${rev}`]), "Type: true_false", "Marks: 1", "Answer: FALSE"];
  const parsed = await parse([...upd(1, Q_DRAFT, 3), ...upd(2, Q_DRAFT, 2).map((l) => l.replace("Q2.", "Q2.").replace(Q_DRAFT, "dddddddd-0000-4000-8000-000000000002")), ...upd(4, Q_ACTIVE, 2), ...upd(5, "dddddddd-0000-4000-8000-00000000000c")]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "UPDATE");
  assert.equal(byRow(v, 1).expectedRevision, 3);
  assert.equal(byRow(v, 2).issues[0].code, "revision_conflict");
  assert.equal(byRow(v, 4).issues.find((i) => i.severity === "error").code, "question_protected");
  assert.ok(codesOf(byRow(v, 5)).includes("revision_missing"));
});

// ---------------------------------------------------------------------------
// Encrypted, scanned, limits, malformed/malicious
// ---------------------------------------------------------------------------
test("encrypted PDFs are refused with a clear message: password to open, and restrictions-only", async () => {
  const locked = await parse(["Course Code: SPI-101", ...TF], { encrypt: { user: "open-me", owner: "owner" } });
  assert.equal(locked.rows.length, 0);
  assert.match(locked.fileErrors[0], /password-protected/);
  const restricted = await parse(["Course Code: SPI-101", ...TF], { encrypt: { user: "", owner: "owner" } });
  assert.equal(restricted.rows.length, 0);
  assert.match(restricted.fileErrors[0], /encrypted \(it has a password or restrictions/);
});

test("scanned / image-only PDF: refused with an OCR-not-supported message; a scanned page inside a text PDF → warning + NEEDS REVIEW", async () => {
  const scanned = await parsePdf(ab(makePdf([{ image: true }, { image: true }], { compress: true })));
  assert.equal(scanned.rows.length, 0);
  assert.match(scanned.fileErrors[0], /no selectable text.*OCR/);

  const mixed = await parsePdf(ab(makePdf([
    { lines: ["Course Code: SPI-101", "Q1. Continues on a scanned page?", "Type: single_choice", "Marks: 1", "A) a"] },
    { image: true },
    { lines: ["Q2. Fine?", "Type: true_false", "Marks: 1", "Answer: TRUE"] },
  ])));
  assert.deepEqual(mixed.fileErrors, []);
  assert.ok(mixed.warnings.some((w) => /Page 2 has no selectable text.*OCR is not supported yet/.test(w)));
  const v = await validateImport(mixed.rows, ctx());
  assert.equal(byRow(v, 1).status, "NEEDS_REVIEW");
  assert.match(byRow(v, 1).issues.map((i) => i.message).join(" "), /no selectable text/);
  assert.equal(byRow(v, 2).status, "CREATE");
});

test("limits: 25 MB file size (checked before reading), 1,000 questions, page limit", async () => {
  assert.match((await parsePdf(new ArrayBuffer(25 * 1024 * 1024 + 1))).fileErrors[0], /limit is 25 MB/);
  const q = (n) => [`Q${n}. Question number ${n}?`, "Type: true_false", "Marks: 1", "Answer: TRUE"];
  const pages = (count) => {
    const lines = ["Course Code: SPI-101", ...Array.from({ length: count }, (_, i) => q(i + 1)).flat()];
    return Array.from({ length: Math.ceil(lines.length / 50) }, (_, i) => ({ lines: lines.slice(i * 50, i * 50 + 50) }));
  };
  const ok = await parsePdf(ab(makePdf(pages(1000), { compress: true })));
  assert.deepEqual(ok.fileErrors, []);
  assert.equal(ok.rows.length, 1000);
  const tooMany = await parsePdf(ab(makePdf(pages(1001), { compress: true })));
  assert.match(tooMany.fileErrors[0], /1001 questions; the limit for this file type is 1000/);
  assert.equal(PDF_MAX_PAGES, 1000);
  const manyPages = await parsePdf(ab(makePdf(Array.from({ length: 1001 }, () => ({ lines: ["x"] })))));
  assert.match(manyPages.fileErrors[0], /1001 pages; the limit is 1000/);
});

test("malformed and malicious PDFs are handled safely with clear messages", async () => {
  const unreadable = /could not be read as a PDF/;
  assert.match((await parsePdf(ab(new TextEncoder().encode("this is not a pdf")))).fileErrors[0], unreadable);
  assert.match((await parsePdf(ab(pdfOf(["Q1. x"]).slice(0, 300)))).fileErrors[0], unreadable, "truncated");
  assert.match((await parsePdf(ab(new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF")))).fileErrors[0], unreadable, "no pages / broken structure");
  // A document with JavaScript actions: never executed; text is still read.
  const js = new TextDecoder("latin1").decode(pdfOf(["Course Code: SPI-101", ...TF])).replace("/Type /Catalog", "/Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>");
  const withJs = await parsePdf(ab(Buffer.from(js, "latin1")));
  assert.equal(withJs.rows.length, 1);
});

test("decompression safeguard: a Flate 'bomb' is refused before pdf.js decodes it; images are not counted", async () => {
  const bomb = zlib.deflateSync(Buffer.alloc(PDF_INFLATE_TOTAL_MAX + 1024 * 1024));
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length " + bomb.length + " >>\nstream\n", "latin1"),
    bomb,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
  assert.ok(bytes.length < 25 * 1024 * 1024);
  const scan = await scanPdf(new Uint8Array(bytes));
  assert.deepEqual(scan, { ok: false, reason: "too_large_inflated" });
  const parsed = await parsePdf(ab(new Uint8Array(bytes)));
  assert.match(parsed.fileErrors[0], /safety limit/);
  // Junk after the compressed data (browsers discard a failing chunk's output): still counted and refused.
  const junk = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"), bomb, Buffer.from("JUNKJUNK garbage\nendstream\nendobj\n", "latin1")]);
  assert.deepEqual(await scanPdf(new Uint8Array(junk)), { ok: false, reason: "too_large_inflated" });

  const image = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /FlateDecode >>\nstream\n", "latin1"), bomb, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  assert.equal((await scanPdf(new Uint8Array(image))).ok, true, "image data is never decoded for text, so it is not counted");
  assert.deepEqual(await scanPdf(new TextEncoder().encode("GIF89a")), { ok: false, reason: "not_pdf" });
});

test("line rebuilding (pure): same baseline joined left→right, gaps become spaces, rotated text skipped, wide gaps flagged", () => {
  const { lines, rotatedSkipped } = pageLines({
    width: 595,
    items: [
      { str: "B) Beta", x: 330, y: 700, width: 40, size: 11 },
      { str: "Q1.", x: 72, y: 720, width: 15, size: 11 },
      { str: "Which", x: 92, y: 720.5, width: 30, size: 11 },
      { str: "A) Alpha", x: 72, y: 700, width: 40, size: 11 },
      { str: "DRAFT", x: 200, y: 400, width: 100, size: 60, rotated: true },
    ],
  });
  assert.deepEqual(lines, [{ text: "Q1. Which", layout: false }, { text: "A) Alpha B) Beta", layout: true }]);
  assert.equal(rotatedSkipped, 1);
  const none = rowsFromPdfPages([{ width: 595, items: [{ str: "Just a title", x: 72, y: 700, width: 50, size: 11 }] }]);
  assert.match(none.fileErrors[0], /No questions were found in the PDF's text/);
});
