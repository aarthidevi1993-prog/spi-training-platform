// Phase F — Word (.docx) import: reader, layouts, never-guess rules, limits, XML safety,
// and parity with Excel/CSV (same raw rows → same validation, fingerprints, duplicates).
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { core, load, context, existing, row, C1, C2, M1, M2, Q_DRAFT, Q_ACTIVE } from "./helpers.mjs";

const { parseDocx, parseDocumentXml, rowsFromDocxBody, decodeXmlText, DOCX_XML_MAX_BYTES } = await load("docx");
const { buildDocx, docxFromDocumentXml, templateDocxBytes, DOCX_TEMPLATE_INSTRUCTIONS } = await load("docx-template");
const { listZipEntries, readZipEntry, zipStored, ZipError } = await load("zip");
const { validateImport } = core;

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
/** A .docx from lines (each string = one paragraph; { table } = a table). */
const docx = (...blocks) => ab(buildDocx(blocks.map((b) => (typeof b === "string" ? { text: b } : b))));
const parse = (...blocks) => parseDocx(docx(...blocks));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A .docx from a raw <w:body> inner XML. */
const rawDocx = (bodyXml, extraNs = "") => ab(docxFromDocumentXml(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W} ${extraNs}><w:body>${bodyXml}</w:body></w:document>`));
const p = (text, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const ctx = (overrides = {}) => context({ source: "docx", ...overrides });
const byRow = (v, n) => v.results.find((r) => r.rowNumber === n);
const codesOf = (r) => r.issues.map((i) => i.code);

const SC = ["Q1. Which instrument measures flow?", "Type: single_choice", "Marks: 2", "A) Flow transmitter", "B) Pressure gauge", "C) Level switch", "Answer: A", "Explanation: A flow transmitter measures flow."];
const TF = ["Q2. A control valve is a final control element.", "Type: true_false", "Marks: 1", "Answer: TRUE"];

// ---------------------------------------------------------------------------
// Valid documents
// ---------------------------------------------------------------------------
test("DOCX with 2 valid questions (single choice + true/false): parsed, validated, CREATE as new questions", async () => {
  const parsed = await parse("Course Code: SPI-101", "", ...SC, "", ...TF);
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.source, "docx");
  assert.deepEqual(parsed.rows.map((r) => r.rowNumber), [1, 2], "numbered by Q1, Q2");
  assert.equal(parsed.everyRowHasCourse, true);
  const [sc, tf] = parsed.rows;
  assert.equal(sc.courseCode, "SPI-101");
  assert.equal(sc.questionText, "Which instrument measures flow?");
  assert.equal(sc.questionType, "single_choice");
  assert.equal(sc.marks, "2");
  assert.deepEqual(sc.options.slice(0, 4), ["Flow transmitter", "Pressure gauge", "Level switch", null]);
  assert.equal(sc.correctAnswer, "A");
  assert.equal(sc.explanation, "A flow transmitter measures flow.");
  assert.equal(sc.questionId, null);
  assert.equal(sc.expectedRevision, null);
  assert.ok(sc.source.paragraph > 0);
  assert.equal(tf.correctAnswer, "TRUE");

  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.summary, { total: 2, create: 2, update: 0, duplicate: 0, error: 0, needsReview: 0 }, JSON.stringify(v.results.map((r) => r.issues)));
  assert.deepEqual(byRow(v, 1).question.options, [
    { text: "Flow transmitter", isCorrect: true },
    { text: "Pressure gauge", isCorrect: false },
    { text: "Level switch", isCorrect: false },
  ]);
  assert.equal(byRow(v, 1).question.marks, 2);
  assert.deepEqual(byRow(v, 2).question.options, [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }]);
  assert.equal(byRow(v, 1).action, "create");
  assert.ok(!("status" in byRow(v, 1).question), "no status is carried: the database creates drafts");
});

test("single choice: label styles A) A. (A) a) and “Option A:” all read; multiple choice “A, C”", async () => {
  const parsed = await parse(
    "Course Code: SPI-101",
    "Q1. Label styles?", "Type: Single choice", "Marks: 1", "A. one", "(B) two", "c) three", "Option D: four", "Answer: d",
    "Q2. Which are temperature sensors?", "Type: multiple_choice", "Marks: 2.5", "A) RTD", "B) Orifice", "C) Thermocouple", "Answer: A, C"
  );
  assert.deepEqual(parsed.rows[0].options.slice(0, 4), ["one", "two", "three", "four"]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(v.summary.create, 2, JSON.stringify(v.results.map((r) => r.issues)));
  assert.deepEqual(byRow(v, 1).question.options.map((o) => o.isCorrect), [false, false, false, true]);
  assert.deepEqual(byRow(v, 2).question.options.map((o) => o.isCorrect), [true, false, true]);
  assert.equal(byRow(v, 2).question.marks, 2.5);
});

test("question text over several paragraphs and soft line breaks; explanation continues; Unicode and XML entities preserved", async () => {
  const parsed = await parse("Q1. Débit — 流量计 ✓ ≈ ±0.1 % & <flow>?", "Second line of the question.", "Note: this stays in the text.", "Type: single_choice", "Marks: 1", "A) Ωmega\nB) Beta", "Answer: B", "Explanation: first line", "second line", { text: "", bold: false });
  const r = parsed.rows[0];
  assert.equal(r.questionText, "Débit — 流量计 ✓ ≈ ±0.1 % & <flow>?\nSecond line of the question.\nNote: this stays in the text.");
  assert.deepEqual(r.options.slice(0, 2), ["Ωmega", "Beta"], "a soft line break separates options");
  assert.equal(r.explanation, "first line\nsecond line");
  assert.equal(r.sourceIssues, undefined);
});

test("“e.g.” at the start of a line is not an option; tabs after the label are fine; non-breaking spaces handled", async () => {
  const parsed = await parse("Course Code: SPI-101", "Q1. Which one?", "e.g. pick the transmitter", "Type: single_choice", "Marks: 1", "A)\tFirst", "B) Second", "Answer: A");
  assert.equal(parsed.rows[0].questionText, "Which one?\ne.g. pick the transmitter");
  assert.deepEqual(parsed.rows[0].options.slice(0, 2), ["First", "Second"]);
  assert.equal((await validateImport(parsed.rows, ctx())).summary.create, 1);
});

test("deflate-compressed .docx (as Word writes it) is read", async () => {
  const stored = new Uint8Array(docx("Course Code: SPI-101", ...SC));
  const xml = await readZipEntry(stored, listZipEntries(stored).find((e) => e.name === "word/document.xml"), 1e7);
  // Rebuild the ZIP with a deflated document.xml.
  const deflated = zlib.deflateRawSync(Buffer.from(xml));
  const plain = zipStored([{ name: "word/document.xml", data: xml }]);
  const view = new DataView(plain.buffer);
  const nameLen = view.getUint16(26, true);
  const header = plain.slice(0, 30 + nameLen);
  new DataView(header.buffer).setUint16(8, 8, true);
  new DataView(header.buffer).setUint32(18, deflated.length, true);
  const central = plain.slice(30 + nameLen + xml.length, plain.length - 22);
  const cv = new DataView(central.buffer);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, deflated.length, true);
  const eocd = plain.slice(plain.length - 22);
  new DataView(eocd.buffer).setUint32(16, header.length + deflated.length, true);
  const bytes = new Uint8Array([...header, ...deflated, ...central, ...eocd]);
  const parsed = await parseDocx(ab(bytes));
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.rows[0].questionText, "Which instrument measures flow?");
});

// ---------------------------------------------------------------------------
// Course / module codes from the document
// ---------------------------------------------------------------------------
test("course and module codes: document-level, per-question override (the document's module is not carried to another course)", async () => {
  const parsed = await parse(
    "Course Code: SPI-101", "Module Code: M2",
    "Q1. Uses the document course and module?", "Type: true_false", "Marks: 1", "Answer: FALSE",
    "Q2. Own module?", "Module Code: M1", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q3. Other course?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE"
  );
  assert.deepEqual(parsed.rows.map((r) => [r.courseCode, r.moduleCode]), [["SPI-101", "M2"], ["SPI-101", "M1"], ["SPI-201", null]]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(v.summary.create, 3, JSON.stringify(v.results.map((r) => r.issues)));
  assert.equal(byRow(v, 1).question.moduleId, M2);
  assert.equal(byRow(v, 2).question.moduleId, M1);
  assert.deepEqual([byRow(v, 3).question.courseId, byRow(v, 3).question.moduleId], [C2, null]);
});

test("no course in the document: the course chosen in the UI is used, never guessed; a different code in the file is refused", async () => {
  const parsed = await parse(...SC.slice(0, 7), "Q2. Other course?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE");
  assert.equal(parsed.everyRowHasCourse, false);
  const none = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(none, 1).issues[0].code, "course_missing");
  const chosen = await validateImport(parsed.rows, ctx({ defaultCourseId: C1, defaultModuleId: M1 }));
  assert.equal(byRow(chosen, 1).status, "CREATE");
  assert.equal(byRow(chosen, 1).question.moduleId, M1);
  assert.equal(byRow(chosen, 2).issues[0].code, "course_mismatch");
});

test("a Course Code line after the options/answer is refused (it would silently move the question); unknown codes are errors", async () => {
  const parsed = await parse("Q1. Late course line?", "Type: true_false", "Marks: 1", "Answer: TRUE", "Course Code: SPI-201", "Q2. Unknown code", "Course Code: NOPE-1", "Type: true_false", "Marks: 1", "Answer: TRUE");
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "ERROR");
  assert.ok(codesOf(byRow(v, 1)).includes("row_malformed"));
  assert.equal(byRow(v, 2).issues[0].code, "course_not_found");
});

test("Course Code given twice before the first question is a file error", async () => {
  const parsed = await parse("Course Code: SPI-101", "Course Code: SPI-201", ...SC);
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.fileErrors[0], /more than once before the first question/);
});

// ---------------------------------------------------------------------------
// Never guess: invalid → ERROR, missing/unreadable → NEEDS_REVIEW (marks: ERROR)
// ---------------------------------------------------------------------------
test("invalid answers are ERRORS, never guessed", async () => {
  const q = (n, answer, type = "single_choice") => [`Q${n}. Question ${n}?`, `Type: ${type}`, "Marks: 1", "A) Alpha", "B) Beta", "C) Gamma", `Answer: ${answer}`];
  const parsed = await parse("Course Code: SPI-101", ...q(1, "Alpha"), ...q(2, "AC", "multiple_choice"), ...q(3, "D"), ...q(4, "A, B"), ...q(5, "1"), "Q6. TF?", "Type: true_false", "Marks: 1", "Answer: Yes");
  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.results.map((r) => r.status), ["ERROR", "ERROR", "ERROR", "ERROR", "ERROR", "ERROR"]);
  assert.deepEqual(v.results.map((r) => r.issues[0].code), ["answer_invalid", "answer_invalid", "answer_blank_option", "answer_count", "answer_invalid", "answer_invalid"]);
});

test("missing required data: marks → ERROR; answer, type, text, options → NEEDS REVIEW (same rules as Word/PDF in Phase C)", async () => {
  const parsed = await parse(
    "Course Code: SPI-101",
    "Q1. No marks?", "Type: single_choice", "A) a", "B) b", "Answer: A",
    "Q2. No answer?", "Type: single_choice", "Marks: 1", "A) a", "B) b",
    "Q3. No type?", "Marks: 1", "A) a", "B) b", "Answer: A",
    "Q4.", "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A",
    "Q5. One option only?", "Type: single_choice", "Marks: 1", "A) a", "Answer: A",
    "Q6. Invalid marks?", "Type: single_choice", "Marks: 2 marks", "A) a", "B) b", "Answer: A"
  );
  const v = await validateImport(parsed.rows, ctx());
  const s = (n) => byRow(v, n);
  assert.equal(s(1).status, "ERROR");
  assert.ok(codesOf(s(1)).includes("marks_missing"));
  assert.equal(s(2).status, "NEEDS_REVIEW");
  assert.ok(codesOf(s(2)).includes("answer_missing"));
  assert.equal(s(3).status, "NEEDS_REVIEW");
  assert.ok(codesOf(s(3)).includes("type_missing"));
  assert.equal(s(4).status, "NEEDS_REVIEW");
  assert.ok(codesOf(s(4)).includes("text_missing"));
  assert.equal(s(5).status, "NEEDS_REVIEW");
  assert.ok(codesOf(s(5)).includes("options_too_few"));
  assert.equal(s(6).status, "ERROR");
  assert.ok(codesOf(s(6)).includes("marks_invalid"));
  assert.equal(v.summary.create, 0);
});

test("conflicting lines are ERRORS: two Answer lines, two option Bs, an invalid type", async () => {
  const parsed = await parse(
    "Course Code: SPI-101",
    "Q1. Two answers?", "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A", "Answer: B",
    "Q2. Two Bs?", "Type: single_choice", "Marks: 1", "A) a", "B) b", "B) c", "Answer: A",
    "Q3. Essay?", "Type: essay", "Marks: 1", "Answer: A"
  );
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "ERROR");
  assert.match(byRow(v, 1).issues.find((i) => i.code === "row_malformed").message, /Answer:.*more than once/);
  assert.equal(byRow(v, 2).status, "ERROR");
  assert.match(byRow(v, 2).issues.find((i) => i.code === "row_malformed").message, /Option B appears more than once/);
  assert.equal(byRow(v, 3).issues[0].code, "type_invalid");
});

test("lines that cannot be read with certainty make the question NEEDS REVIEW (never imported, never repaired)", async () => {
  const parsed = await parse(
    "Course Code: SPI-101",
    "Q1. Inline options?", "Type: single_choice", "Marks: 1", "A) Alpha   B) Beta   C) Gamma", "Answer: A",
    "Q2. Option continues?", "Type: single_choice", "Marks: 1", "A) Alpha", "that wraps", "B) Beta", "Answer: A",
    "Q3. Stray line?", "Type: single_choice", "Marks: 1", "A) Alpha", "B) Beta", "Answer: A", "Something unexpected"
  );
  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.results.map((r) => r.status), ["NEEDS_REVIEW", "NEEDS_REVIEW", "NEEDS_REVIEW"]);
  assert.match(byRow(v, 1).issues[0].message, /next option on the same line/);
  assert.match(byRow(v, 2).issues[0].message, /continues on another line/);
  assert.match(byRow(v, 3).issues[0].message, /was not understood/);
  for (const r of v.results) assert.equal(r.action, "create", "fixable in the document; not imported while it needs review");
});

test("pictures, equations, symbol-font characters, hidden text, tables and automatic numbering → NEEDS REVIEW", async () => {
  const q = (n, extra) => `${p(`Q${n}. Question ${n}?`)}${p("Type: single_choice")}${p("Marks: 1")}${extra}${p("A) Alpha")}${p("B) Beta")}${p("Answer: A")}`;
  const bytes = rawDocx(
    p("Course Code: SPI-101") +
      q(1, `<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:p xmlns:a="y"><a:t>chart text</a:t></a:p></wp:inline></w:drawing></w:r></w:p>`) +
      q(2, `<w:p><m:oMath><m:r><m:t>x²</m:t></m:r></m:oMath></w:p>`) +
      q(3, `<w:p><w:r><w:sym w:font="Symbol" w:char="F057"/></w:r></w:p>`) +
      q(4, `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Answer is B</w:t></w:r></w:p>`) +
      q(5, `<w:tbl><w:tr><w:tc>${p("cell")}</w:tc></w:tr></w:tbl>`) +
      `${p("Q6. Auto-numbered options?")}${p("Type: single_choice")}${p("Marks: 1")}${p("Alpha", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>')}${p("Beta", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>')}${p("Answer: A")}`,
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
  );
  const parsed = await parseDocx(bytes);
  assert.deepEqual(parsed.fileErrors, []);
  assert.ok(!parsed.rows[0].questionText.includes("chart text"), "drawing text is never read");
  const v = await validateImport(parsed.rows, ctx());
  // Q6: its options were not read, so "Answer: A" names a missing option — an ERROR under the existing rules.
  assert.deepEqual(v.results.map((r) => r.status), ["NEEDS_REVIEW", "NEEDS_REVIEW", "NEEDS_REVIEW", "NEEDS_REVIEW", "NEEDS_REVIEW", "ERROR"], JSON.stringify(v.results.map((r) => r.issues)));
  const msg = (n) => byRow(v, n).issues.map((i) => i.message).join(" ");
  assert.match(msg(1), /picture/);
  assert.match(msg(2), /equation/);
  assert.match(msg(3), /symbol font/);
  assert.match(msg(4), /hidden text/);
  assert.match(msg(5), /table/);
  assert.match(msg(6), /automatic numbering/);
  assert.ok(codesOf(byRow(v, 6)).includes("options_too_few"), "auto-numbered options are not read as options");
});

test("a question that is only a picture is shown (never silently dropped) and never imported", async () => {
  const parsed = await parseDocx(rawDocx(p("Course Code: SPI-101") + p("Q1.") + `<w:p><w:r><w:drawing/></w:r></w:p>` + p("Q2. Real?") + p("Type: true_false") + p("Marks: 1") + p("Answer: TRUE")));
  assert.deepEqual(parsed.rows.map((r) => r.rowNumber), [1, 2]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "ERROR", "no marks → ERROR (marks are never defaulted)");
  assert.ok(byRow(v, 1).issues.some((i) => /picture/.test(i.message)));
  assert.equal(byRow(v, 2).status, "CREATE");
});

test("Status lines never set a status (warning); new questions have no status to carry", async () => {
  const parsed = await parse("Course Code: SPI-101", ...TF, "Status: active");
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 2).status, "CREATE");
  assert.ok(codesOf(byRow(v, 2)).includes("status_ignored"));
});

// ---------------------------------------------------------------------------
// Duplicates — exactly like Excel/CSV
// ---------------------------------------------------------------------------
test("duplicates: in the file and in the bank are excluded unless included anyway — identical to the same rows from Excel", async () => {
  const parsed = await parse("Course Code: SPI-101", ...SC, "Q2. which instrument measures  FLOW?", "Type: single_choice", "Marks: 1", "A) Flow transmitter", "B) Pressure gauge", "C) Level switch", "Answer: B", ...TF.map((l) => l.replace("Q2.", "Q3.")));
  const bank = [await existing(Q_ACTIVE, C1, "true_false", "A control valve is a final control element.", ["True", "False"])];
  const v = await validateImport(parsed.rows, ctx({ existing: bank }));
  assert.equal(byRow(v, 2).status, "DUPLICATE");
  assert.deepEqual(byRow(v, 2).duplicateOf, { kind: "file", rowNumber: 1 });
  assert.equal(byRow(v, 3).status, "DUPLICATE");
  assert.deepEqual(byRow(v, 3).duplicateOf, { kind: "bank", questionId: Q_ACTIVE });

  // The same questions as Excel-shaped rows give the same statuses and fingerprints.
  const excelRows = parsed.rows.map((r) => row(r.rowNumber, { ...r, source: undefined }));
  const x = await validateImport(excelRows, context({ existing: bank }));
  assert.deepEqual(x.results.map((r) => [r.status, r.fingerprint, r.textFingerprint]), v.results.map((r) => [r.status, r.fingerprint, r.textFingerprint]));

  const included = await validateImport(parsed.rows.map((r) => ({ ...r, includeAnyway: r.rowNumber === 2 })), ctx({ existing: bank }));
  assert.equal(byRow(included, 2).status, "CREATE");
  assert.ok(codesOf(byRow(included, 2)).includes("included_anyway"));
});

// ---------------------------------------------------------------------------
// Updates: DRAFT only, Question ID + Revision protection
// ---------------------------------------------------------------------------
test("draft update: Question ID + Revision → UPDATE; stale revision, missing revision, active question → ERROR", async () => {
  const upd = (n, id, revision) => [`Q${n}. Updated text ${n}?`, `Question ID: ${id}`, ...(revision === undefined ? [] : [`Revision: ${revision}`]), "Type: true_false", "Marks: 1", "Answer: TRUE"];
  const parsed = await parse(...upd(1, Q_DRAFT, 3), ...upd(2, Q_DRAFT, 2).map((l) => l.replace(Q_DRAFT, "DDDDDDDD-0000-4000-8000-000000000002")), ...upd(3, "dddddddd-0000-4000-8000-000000000002"), ...upd(4, Q_ACTIVE, 2), ...upd(5, "not-an-id", 1));
  assert.deepEqual(parsed.rows.map((r) => r.expectedRevision), [3, 2, null, 2, 1]);
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(byRow(v, 1).status, "UPDATE");
  assert.equal(byRow(v, 1).expectedRevision, 3);
  assert.equal(byRow(v, 1).question.courseId, C1, "an update keeps the question's own course");
  assert.equal(byRow(v, 2).issues[0].code, "revision_conflict", "Q_DRAFT2 is at revision 1, the file says 2");
  assert.ok(codesOf(byRow(v, 3)).includes("revision_missing"));
  assert.equal(byRow(v, 4).issues.find((i) => i.severity === "error").code, "question_protected");
  assert.equal(byRow(v, 5).issues[0].code, "question_id_invalid");
});

test("trainer course scope: a course outside the caller's scope is refused even when the code exists", async () => {
  const parsed = await parse("Course Code: SPI-201", ...TF);
  const trainerContext = ctx({ courses: [{ id: C1, code: "SPI-101", modules: [] }] });
  const v = await validateImport(parsed.rows, trainerContext);
  assert.equal(byRow(v, 2).issues[0].code, "course_not_found");
});

// ---------------------------------------------------------------------------
// Table layout
// ---------------------------------------------------------------------------
test("table layout: a table with the template headers is read like Excel rows; the document's course fills blank Course Code", async () => {
  const header = ["Question Text", "Type", "Marks", "Option A", "Option B", "Correct Answer", "Course Code", "Notes"];
  const parsed = await parse("Course Code: SPI-101", { table: [header, ["Which measures level?", "single_choice", "1", "LT", "PT", "A", "", "x"], ["", "", "", "", "", "", "", ""], ["Valve is a final element.", "true_false", "1", "", "", "TRUE", "SPI-201", ""]] });
  assert.deepEqual(parsed.fileErrors, []);
  assert.deepEqual(parsed.rows.map((r) => [r.rowNumber, r.courseCode]), [[1, "SPI-101"], [2, "SPI-201"]]);
  assert.ok(parsed.warnings.some((w) => /Ignored column: Notes/.test(w)));
  assert.ok(parsed.warnings.some((w) => /1 empty question skipped/.test(w)));
  const v = await validateImport(parsed.rows, ctx());
  assert.equal(v.summary.create, 2, JSON.stringify(v.results.map((r) => r.issues)));
});

test("table layout errors: a question table missing required columns; tables mixed with Q-blocks", async () => {
  const bad = await parse({ table: [["Question Text", "Type", "Option A"], ["x", "single_choice", "a"]] });
  assert.match(bad.fileErrors[0], /looks like a question table.*Missing required columns?: .*Option B/);
  const mixed = await parse({ table: [["Question Text", "Type", "Marks", "Option A", "Option B", "Correct Answer"], ["x?", "single_choice", "1", "a", "b", "A"]] }, ...SC);
  assert.match(mixed.fileErrors[0], /both question tables and question paragraphs/);
  const other = await parse({ table: [["Name", "Value"], ["a", "b"]] }, "Course Code: SPI-101", ...TF);
  assert.deepEqual(other.fileErrors, []);
  assert.ok(other.warnings.some((w) => /1 table before the first question was ignored/.test(w)));
});

// ---------------------------------------------------------------------------
// Numbering, empty questions, no questions
// ---------------------------------------------------------------------------
test("question numbers: the document's own when unique (gap warned); by order when repeated; empty questions skipped", async () => {
  const gap = await parse("Course Code: SPI-101", ...TF.map((l) => l.replace("Q2.", "Q4.")), ...TF.map((l) => l.replace("Q2.", "Q6.").replace("final", "FINAL")), "Q7.");
  assert.deepEqual(gap.rows.map((r) => r.rowNumber), [4, 6]);
  assert.ok(gap.warnings.some((w) => /skip from Q4 to Q6/.test(w)));
  assert.ok(gap.warnings.some((w) => /1 empty question skipped/.test(w)));
  const repeated = await parse("Course Code: SPI-101", ...TF, ...TF.map((l) => l.replace("final", "FINAL")));
  assert.deepEqual(repeated.rows.map((r) => r.rowNumber), [1, 2]);
  assert.ok(repeated.warnings.some((w) => /numbered by their order/.test(w)));
});

test("no questions found: clear message (mentions automatic numbering when used)", async () => {
  const plain = await parse("Just a title", "Some text");
  assert.match(plain.fileErrors[0], /No questions were found.*Q1\./);
  const auto = await parseDocx(rawDocx(p("Which one?", '<w:numPr><w:numId w:val="1"/></w:numPr>')));
  assert.match(auto.fileErrors[0], /uses automatic numbering/);
  const empty = await parse("Q1.", "Q2.");
  assert.match(empty.fileErrors[0], /every question in the document is empty/);
});

test("lines before the first question: titles ignored silently; stray field lines warned", async () => {
  const parsed = await parse("Mid-term paper", "Answer: A", "Course Code: SPI-101", ...TF);
  assert.equal(parsed.rows.length, 1);
  assert.ok(parsed.warnings.some((w) => /“Answer: A” before the first question was ignored/.test(w)));
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
test("limits: 15 MB file size (checked before reading) and 1,000 questions per document", async () => {
  const big = await parseDocx(new ArrayBuffer(15 * 1024 * 1024 + 1));
  assert.match(big.fileErrors[0], /limit is 15 MB/);
  const q = (n) => [`Q${n}. Question number ${n}?`, "Type: true_false", "Marks: 1", "Answer: TRUE"];
  const lines = (count) => ["Course Code: SPI-101", ...Array.from({ length: count }, (_, i) => q(i + 1)).flat()];
  const ok = await parse(...lines(1000));
  assert.deepEqual(ok.fileErrors, []);
  assert.equal(ok.rows.length, 1000);
  const tooMany = await parse(...lines(1001));
  assert.equal(tooMany.rows.length, 0);
  assert.match(tooMany.fileErrors[0], /1001 questions; the limit for this file type is 1000/);
});

test("decompression limit: an entry that inflates past the limit stops with an error (zip bomb)", async () => {
  const zeros = zlib.deflateRawSync(Buffer.alloc(2_000_000));
  const entry = { name: "word/document.xml", method: 8, flags: 0, compressedSize: zeros.length, uncompressedSize: 10, localHeaderOffset: 0 };
  const local = new Uint8Array(30 + entry.name.length + zeros.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(26, entry.name.length, true);
  local.set(new TextEncoder().encode(entry.name), 30);
  local.set(zeros, 30 + entry.name.length);
  await assert.rejects(readZipEntry(local, entry, 1_000_000), (e) => e instanceof ZipError && e.message === "entry too large");
  assert.equal(DOCX_XML_MAX_BYTES, 60 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// File safety and clear errors
// ---------------------------------------------------------------------------
test("not a Word file / old .doc or password-protected / Excel renamed / damaged → clear file errors", async () => {
  assert.match((await parseDocx(ab(new TextEncoder().encode("hello, not a zip")))).fileErrors[0], /could not be read as a Word \.docx/);
  const cfb = new Uint8Array(512);
  cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.match((await parseDocx(ab(cfb))).fileErrors[0], /password-protected, or it is an older \.doc/);
  assert.match((await parseDocx(ab(zipStored([{ name: "xl/workbook.xml", data: "<x/>" }])))).fileErrors[0], /Excel workbook renamed/);
  assert.match((await parseDocx(ab(docxFromDocumentXml(`<w:document ${W}><w:body><w:p><w:r><w:t>Q1. x</w:t></w:r></w:body></w:document>`)))).fileErrors[0], /could not be read/, "unbalanced XML");
  const encrypted = zipStored([{ name: "word/document.xml", data: "<x/>" }]);
  new DataView(encrypted.buffer).setUint16(encrypted.length - 22 - 46 - 17 + 8, 1, true); // central directory flags: encrypted
  assert.match((await parseDocx(ab(encrypted))).fileErrors[0], /could not be read/);
});

test("XML safety: DOCTYPE / entity declarations refused; only the five XML entities and character references decoded", async () => {
  const xxe = ab(docxFromDocumentXml(`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document ${W}><w:body>${p("Q1. &x;")}</w:body></w:document>`));
  assert.match((await parseDocx(xxe)).fileErrors[0], /declarations that are not allowed/);
  assert.equal(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#937; &#x3A9; &unknown;"), `a & b <c> "d" 'e' Ω Ω &unknown;`);
});

test("tracked changes: deleted text is not read, inserted text is (with a warning); alternate-content fallback not duplicated; comments ignored", async () => {
  const bytes = rawDocx(
    p("Course Code: SPI-101") +
      `<w:p><w:r><w:t xml:space="preserve">Q1. Which </w:t></w:r><w:del w:id="1"><w:r><w:delText>old </w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t xml:space="preserve">new </w:t></w:r></w:ins><w:r><w:t>text?</w:t></w:r><!-- a comment <w:t>no</w:t> --></w:p>` +
      `<w:p><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>Type: true_false</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>Type: essay</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>` +
      p("Marks: 1") +
      p("Answer: TRUE"),
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
  );
  const parsed = await parseDocx(bytes);
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.rows[0].questionText, "Which new text?");
  assert.equal(parsed.rows[0].questionType, "true_false");
  assert.ok(parsed.warnings.some((w) => /tracked changes/.test(w)));
});

test("text boxes and headers/footers are not read as questions; tab stops in paragraph properties are not text", async () => {
  const body = parseDocumentXml(
    `<w:document ${W}><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Before</w:t></w:r><w:r><w:pict><v:shape xmlns:v="v"><w:txbxContent><w:p><w:r><w:t>Q9. Boxed?</w:t></w:r></w:p></w:txbxContent></v:shape></w:pict></w:r></w:p></w:body></w:document>`
  );
  assert.equal(body.blocks.length, 1);
  assert.equal(body.blocks[0].text, "Before");
  assert.equal(body.blocks[0].flags.image, true);
  assert.equal(rowsFromDocxBody(body).rows.length, 0);
});

test("formula-looking text is plain text, with the same apostrophe rule as Excel/CSV (rows share the Excel reader)", async () => {
  const parsed = await parse("Course Code: SPI-101", "Q1. =SUM(A1) is shown as text?", "Q2. '=SUM(A1) quoted?", "Type: true_false", "Marks: 1", "Answer: TRUE");
  assert.equal(parsed.rows[0].questionText, "=SUM(A1) is shown as text?", "never evaluated");
  assert.equal(parsed.rows[1].questionText, "=SUM(A1) quoted?", "the export apostrophe is removed, exactly as for Excel/CSV cells");
});

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------
test("Word template: a valid .docx; its instructions are never read as questions; its examples are refused (EXAMPLE-COURSE), never imported", async () => {
  const bytes = templateDocxBytes();
  const names = listZipEntries(bytes).map((e) => e.name);
  assert.deepEqual(names, ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const parsed = await parseDocx(ab(bytes));
  assert.deepEqual(parsed.fileErrors, []);
  assert.deepEqual(parsed.warnings, [], "instruction lines produce no warnings");
  assert.deepEqual(parsed.rows.map((r) => r.questionType), ["single_choice", "multiple_choice", "true_false"]);
  assert.ok(parsed.rows.every((r) => r.courseCode === "EXAMPLE-COURSE" && r.sourceIssues === undefined));
  assert.ok(DOCX_TEMPLATE_INSTRUCTIONS.every((l) => l.startsWith("•")));
  const v = await validateImport(parsed.rows, ctx());
  assert.deepEqual(v.results.map((r) => r.status), ["ERROR", "ERROR", "ERROR"]);
  assert.ok(v.results.every((r) => r.issues[0].code === "course_not_found"));
  // With a real course code the same examples are valid questions.
  const fixed = parsed.rows.map((r) => ({ ...r, courseCode: "SPI-101" }));
  assert.equal((await validateImport(fixed, ctx())).summary.create, 3);
});
