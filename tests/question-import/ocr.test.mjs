// Phase H — OCR for scanned PDFs, with a deterministic scripted OCR engine (ocr-fake.mjs):
// real PDFs (image pages) through pdf.js → OCR words → shared line/block reader → Phase C validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { core, load, context, existing, row, C1, C2, M1, Q_DRAFT, Q_ACTIVE } from "./helpers.mjs";
import { makePdf, pdfOf } from "./pdf-writer.mjs";
import { scriptedOcr } from "./ocr-fake.mjs";

const { parsePdf } = await load("pdf");
const ocrLib = await load("pdf-ocr");
const { OCR_KEY_LINE_MIN_CONFIDENCE } = await load("docx");
const { validateImport } = core;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const scannedPdf = (pageCount) => ab(makePdf(Array.from({ length: pageCount }, () => ({ image: true }))));
const ctx = (source, overrides = {}) => context({ source, ...overrides });
const byRow = (v, n) => v.results.find((r) => r.rowNumber === n);
const codesOf = (r) => r.issues.map((i) => i.code);
const confirm = (rows, ...numbers) => rows.map((r) => ({ ...r, reviewConfirmed: numbers.length === 0 || numbers.includes(r.rowNumber) }));

const PAGE1 = [
  "Course Code: SPI-101",
  "Module Code: M1",
  "Q1. Which instrument measures flow?",
  "Type: single_choice",
  "Marks: 2",
  "A) Flow transmitter",
  "B) Pressure gauge",
  "C) Level switch",
  "Answer: A",
  "Explanation: A flow transmitter measures flow.",
  "Q2. A control valve is a final control element.",
  "Type: true_false",
  "Marks: 1",
  "Answer: TRUE",
];

// ---------------------------------------------------------------------------
// Scanned PDFs
// ---------------------------------------------------------------------------
test("scanned PDF with 2 questions: read by OCR (source pdf_ocr), NEEDS REVIEW until confirmed, then CREATE", async () => {
  const { options, calls } = scriptedOcr({ 1: PAGE1 });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.source, "pdf_ocr");
  assert.equal(calls.started, 1);
  assert.deepEqual(calls.recognized, [1]);
  assert.deepEqual(calls.released, [1], "page image memory released");
  assert.equal(calls.terminated, 1, "engine terminated");
  assert.ok(parsed.warnings.some((w) => /Page 1 was scanned and read with OCR/.test(w)));
  assert.deepEqual(parsed.rows.map((r) => r.source), [{ page: 1, uncertain: true, ocrConfidence: 95 }, { page: 1, uncertain: true, ocrConfidence: 95 }]);

  const v = await validateImport(parsed.rows, ctx("pdf_ocr"));
  assert.deepEqual(v.results.map((r) => r.status), ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
  assert.match(byRow(v, 1).issues.find((i) => i.code === "ocr_review").message, /page 1, OCR confidence 95%/);

  const confirmed = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.deepEqual(confirmed.summary, { total: 2, create: 2, update: 0, duplicate: 0, error: 0, needsReview: 0 }, JSON.stringify(confirmed.results.map((r) => r.issues)));
  const [q1, q2] = confirmed.results.map((r) => r.question);
  assert.equal(q1.text, "Which instrument measures flow?");
  assert.deepEqual(q1.options, [{ text: "Flow transmitter", isCorrect: true }, { text: "Pressure gauge", isCorrect: false }, { text: "Level switch", isCorrect: false }]);
  assert.equal(q1.marks, 2);
  assert.equal(q1.explanation, "A flow transmitter measures flow.");
  assert.equal(q1.courseId, C1);
  assert.equal(q1.moduleId, M1);
  assert.deepEqual(q2.options, [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }]);
  assert.equal(q2.marks, 1);
  assert.ok(!("status" in q1), "no status: drafts");
});

test("OCR option extraction: wrapped option lines joined; multiple choice; words laid out as the engine found them", async () => {
  const { options } = scriptedOcr({
    1: ["Course Code: SPI-101", "Q7. Which of these are fieldbus protocols used", "in process plants?", "Type: multiple_choice", "Marks: 3", "A) HART, the highway addressable remote", "transducer protocol", "B) Bluetooth", "C) Profibus", "Answer: A, C"],
  });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const r = parsed.rows[0];
  assert.equal(r.rowNumber, 7);
  assert.equal(r.questionText, "Which of these are fieldbus protocols used in process plants?");
  assert.deepEqual(r.options.slice(0, 3), ["HART, the highway addressable remote transducer protocol", "Bluetooth", "Profibus"]);
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.deepEqual(byRow(v, 7).question.options.map((o) => o.isCorrect), [true, false, true]);
  assert.equal(byRow(v, 7).question.marks, 3);
});

test("mixed scanned/text PDF: text pages read as text (CREATE), only OCR rows need review; source stays pdf", async () => {
  const bytes = ab(makePdf([
    { lines: ["Course Code: SPI-101", "Q1. Text question?", "Type: true_false", "Marks: 1", "Answer: TRUE"] },
    { image: true },
  ]));
  const { options, calls } = scriptedOcr({ 2: ["Q2. Scanned question?", "Type: true_false", "Marks: 1", "Answer: FALSE"] });
  const parsed = await parsePdf(bytes, { ocr: options });
  assert.equal(parsed.source, "pdf");
  assert.deepEqual(calls.recognized, [2], "only the scanned page is OCR'd");
  assert.deepEqual(parsed.rows.map((r) => r.source), [{ page: 1 }, { page: 2, uncertain: true, ocrConfidence: 95 }]);
  const v = await validateImport(parsed.rows, ctx("pdf"));
  assert.equal(byRow(v, 1).status, "CREATE");
  assert.equal(byRow(v, 2).status, "NEEDS_REVIEW");
  assert.ok(codesOf(byRow(v, 2)).includes("ocr_review"));
  assert.equal(byRow(await validateImport(confirm(parsed.rows, 2), ctx("pdf")), 2).status, "CREATE");
});

test("OCR course/module mapping: codes from the scanned page; unknown or other-course codes refused", async () => {
  const { options } = scriptedOcr({ 1: ["Course Code: SPI-201", "Module Code: M1", "Q1. Other course question?", "Type: true_false", "Marks: 1", "Answer: TRUE", "Q2. Unknown course?", "Course Code: SPI-1O1", "Type: true_false", "Marks: 1", "Answer: TRUE"] });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.equal(byRow(v, 1).question.courseId, C2);
  assert.equal(byRow(v, 2).issues[0].code, "course_not_found", "OCR's letter O for zero is never 'corrected'");
  const trainer = await validateImport(confirm(parsed.rows), ctx("pdf_ocr", { courses: [{ id: C1, code: "SPI-101", modules: [] }] }));
  assert.equal(byRow(trainer, 1).issues[0].code, "course_not_found", "trainer scope: a course outside it is refused");
});

// ---------------------------------------------------------------------------
// Never guess: invalid/ambiguous answers and uncertainty
// ---------------------------------------------------------------------------
test("OCR invalid/ambiguous answers are ERRORS, never corrected (e.g. '4' read for 'A', 'A B' for single choice)", async () => {
  const q = (n, answer, type = "single_choice") => [`Q${n}. Question ${n}?`, `Type: ${type}`, "Marks: 1", "A) Alpha", "B) Beta", `Answer: ${answer}`];
  const { options } = scriptedOcr({ 1: ["Course Code: SPI-101", ...q(1, "4"), ...q(2, "A B"), ...q(3, "Alpha"), "Q4. TF?", "Type: true_false", "Marks: 1", "Answer: TRUF"] });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.deepEqual(v.results.map((r) => r.status), ["ERROR", "ERROR", "ERROR", "ERROR"]);
  assert.deepEqual(v.results.map((r) => r.issues[0].code), ["answer_invalid", "answer_count", "answer_invalid", "answer_invalid"]);
});

test("OCR uncertainty → NEEDS REVIEW: low-confidence answer/marks/option/course lines cannot be confirmed away; low-confidence question text can", async () => {
  const low = OCR_KEY_LINE_MIN_CONFIDENCE - 20;
  const { options } = scriptedOcr({
    1: [
      "Course Code: SPI-101",
      "Q1. Low confidence answer?", "Type: single_choice", "Marks: 1", "A) Alpha", "B) Beta", { words: [["Answer:", 96], ["B", low]] },
      "Q2. Low confidence marks?", "Type: true_false", { words: [["Marks:", 96], ["1", low]] }, "Answer: TRUE",
      "Q3. Low confidence option?", "Type: single_choice", "Marks: 1", { words: [["A)", 95], ["Aipha", low]] }, "B) Beta", "Answer: A",
      "Q4.", { words: [["Course", 95], ["Code:", 95], ["SPI-101", low]] }, "Type: true_false", "Marks: 1", "Answer: TRUE",
      { words: [["Q5.", 96], ["Blurry", low], ["question", 90], ["text?", 91]] }, "Type: true_false", "Marks: 1", "Answer: FALSE",
    ],
  });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  assert.equal(parsed.rows.find((r) => r.rowNumber === 5).source.ocrConfidence, low);
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  const message = (n) => byRow(v, n).issues.map((i) => i.message).join(" ");
  for (const n of [1, 2, 3]) {
    assert.equal(byRow(v, n).status, "NEEDS_REVIEW", `Q${n} stays in review even when confirmed`);
    assert.match(message(n), new RegExp(`OCR is not sure it read .*${low}% confidence`));
  }
  assert.match(message(1), /“Answer:” line/);
  assert.match(message(2), /“Marks:” line/);
  assert.match(message(3), /option A/);
  assert.equal(byRow(v, 4).status, "NEEDS_REVIEW");
  assert.match(message(4), /“Course Code:” line/);
  assert.ok(codesOf(byRow(v, 4)).includes("text_missing"));
  assert.equal(byRow(v, 5).status, "CREATE", "question text is checked by the reviewer's confirmation");
  const unconfirmed = await validateImport(parsed.rows, ctx("pdf_ocr"));
  assert.match(byRow(unconfirmed, 5).issues.find((i) => i.code === "ocr_review").message, new RegExp(`OCR confidence ${low}%`));
});

test("OCR structure problems → NEEDS REVIEW or ERROR as for text PDFs (misread labels, missing marks, columns)", async () => {
  const { options } = scriptedOcr({
    1: [
      "Course Code: SPI-101",
      "Q1. Misread option label?", "Type: single_choice", "Marks: 1", "A) Alpha", "8) Beta", "Answer: A",
      "Q2. No marks read?", "Type: true_false", "Answer: TRUE",
      { text: "Q3. Left column?", x: 150 }, "Type: true_false", "Marks: 1", "Answer: TRUE",
    ],
  });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.equal(byRow(v, 1).status, "NEEDS_REVIEW");
  assert.match(byRow(v, 1).issues.map((i) => i.message).join(" "), /“8\) Beta” looks like an option, but its letter could not be read/);
  assert.deepEqual(parsed.rows[0].options.slice(0, 2), ["Alpha", null], "never merged into option A");
  assert.equal(byRow(v, 2).status, "ERROR");
  assert.ok(codesOf(byRow(v, 2)).includes("marks_missing"));

  // Two columns on a scanned page: words far apart on one baseline.
  const cols = scriptedOcr({}, {
    onRecognize: () => ({
      width: 2480, height: 3508,
      lines: [
        { baseline: 200, words: [{ text: "Course", confidence: 95, x0: 150, y0: 160, x1: 290, y1: 208 }, { text: "Code:", confidence: 95, x0: 310, y0: 160, x1: 420, y1: 208 }, { text: "SPI-101", confidence: 95, x0: 440, y0: 160, x1: 600, y1: 208 }] },
        { baseline: 260, words: [{ text: "Q1.", confidence: 95, x0: 150, y0: 220, x1: 210, y1: 268 }, { text: "Left?", confidence: 95, x0: 230, y0: 220, x1: 330, y1: 268 }, { text: "Q2.", confidence: 95, x0: 1400, y0: 220, x1: 1460, y1: 268 }, { text: "Right?", confidence: 95, x0: 1480, y0: 220, x1: 1600, y1: 268 }] },
        { baseline: 320, words: [{ text: "Type:", confidence: 95, x0: 150, y0: 280, x1: 260, y1: 328 }, { text: "true_false", confidence: 95, x0: 280, y0: 280, x1: 480, y1: 328 }] },
        { baseline: 380, words: [{ text: "Marks:", confidence: 95, x0: 150, y0: 340, x1: 280, y1: 388 }, { text: "1", confidence: 95, x0: 300, y0: 340, x1: 320, y1: 388 }] },
        { baseline: 440, words: [{ text: "Answer:", confidence: 95, x0: 150, y0: 400, x1: 300, y1: 448 }, { text: "TRUE", confidence: 95, x0: 320, y0: 400, x1: 420, y1: 448 }] },
      ],
    }),
  });
  const colParsed = await parsePdf(scannedPdf(1), { ocr: cols.options });
  const cv = await validateImport(confirm(colParsed.rows), ctx("pdf_ocr"));
  assert.equal(cv.summary.create, 0);
  assert.match(cv.results[0].issues.map((i) => i.message).join(" "), /columns or a table/);
});

// ---------------------------------------------------------------------------
// Duplicates and updates
// ---------------------------------------------------------------------------
test("duplicate detection: an OCR question already in the bank is DUPLICATE once confirmed; fingerprints equal Excel's", async () => {
  const bank = [await existing(Q_ACTIVE, C1, "true_false", "A control valve is a final control element.", ["True", "False"])];
  const { options } = scriptedOcr({ 1: PAGE1 });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const unconfirmed = await validateImport(parsed.rows, ctx("pdf_ocr", { existing: bank }));
  assert.equal(byRow(unconfirmed, 2).status, "NEEDS_REVIEW", "review first (NEEDS_REVIEW outranks DUPLICATE)");
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr", { existing: bank }));
  assert.equal(byRow(v, 2).status, "DUPLICATE");
  assert.deepEqual(byRow(v, 2).duplicateOf, { kind: "bank", questionId: Q_ACTIVE });
  const excel = await validateImport(parsed.rows.map((r) => row(r.rowNumber, { ...r, source: undefined, reviewConfirmed: undefined })), context({ existing: bank }));
  assert.deepEqual(excel.results.map((r) => r.fingerprint), v.results.map((r) => r.fingerprint));
});

test("OCR draft update: Question ID + Revision read by OCR → UPDATE once confirmed; a misread ID is never guessed", async () => {
  const { options } = scriptedOcr({ 1: ["Q1. Updated by scan?", `Question ID: ${Q_DRAFT}`, "Revision: 3", "Type: true_false", "Marks: 1", "Answer: FALSE", "Q2. Misread id?", "Question ID: dddddddd-0000-4000-8000-00000000000l", "Revision: 1", "Type: true_false", "Marks: 1", "Answer: TRUE"] });
  const parsed = await parsePdf(scannedPdf(1), { ocr: options });
  const v = await validateImport(confirm(parsed.rows), ctx("pdf_ocr"));
  assert.equal(byRow(v, 1).status, "UPDATE");
  assert.equal(byRow(v, 2).issues[0].code, "question_id_invalid");
});

// ---------------------------------------------------------------------------
// Limits and safeguards
// ---------------------------------------------------------------------------
test("100-page OCR limit: 100 scanned pages are read; 101 are refused before OCR starts", async () => {
  const pages = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 1, [`Q${i + 1}. Scanned question ${i + 1}?`, "Course Code: SPI-101", "Type: true_false", "Marks: 1", "Answer: TRUE"]]));
  const ok = scriptedOcr(pages);
  const parsed = await parsePdf(scannedPdf(100), { ocr: ok.options });
  assert.deepEqual(parsed.fileErrors, []);
  assert.equal(parsed.rows.length, 100);
  assert.equal(ok.calls.recognized.length, 100);
  const tooMany = scriptedOcr({});
  const refused = await parsePdf(scannedPdf(101), { ocr: tooMany.options });
  assert.match(refused.fileErrors[0], /101 scanned pages; OCR can read at most 100/);
  assert.equal(tooMany.calls.started, 0, "the engine is never started");
  assert.equal(ocrLib.OCR_MAX_PAGES, 100);
});

test("OCR output limits: a page with far too much text is not read (reported); too much text overall refuses the file", async () => {
  const flood = Array.from({ length: ocrLib.OCR_MAX_WORDS_PER_PAGE / 10 + 1 }, () => "word ".repeat(10).trim());
  const { options } = scriptedOcr({ 1: ["Course Code: SPI-101", "Q1. Fine?", "Type: true_false", "Marks: 1", "Answer: TRUE"], 2: flood });
  const parsed = await parsePdf(scannedPdf(2), { ocr: options });
  assert.deepEqual(parsed.fileErrors, []);
  assert.ok(parsed.warnings.some((w) => /Page 2 could not be read by OCR \(far more text than a question page\)/.test(w)));
  assert.equal(parsed.rows.length, 1);
  assert.equal((await validateImport(parsed.rows, ctx("pdf_ocr"))).results[0].status, "NEEDS_REVIEW", "followed by an unreadable page");

  const big = "x".repeat(50_000);
  const total = scriptedOcr(Object.fromEntries(Array.from({ length: 41 }, (_, i) => [i + 1, [big]])));
  const refused = await parsePdf(scannedPdf(41), { ocr: total.options });
  assert.match(refused.fileErrors[0], /OCR produced too much text/);
  assert.equal(total.calls.terminated, 1, "engine still terminated");
});

test("OCR time/resource safeguards: a stuck page stops OCR (reported); engine start failure; a page that cannot be drawn", async () => {
  const stuck = scriptedOcr({ 1: PAGE1 }, { onRecognize: (n) => (n === 2 ? new Promise(() => {}) : undefined) });
  const parsed = await parsePdf(scannedPdf(3), { ocr: stuck.options, ocrPageTimeoutMs: 200 });
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.warnings.some((w) => /Page 2 could not be read by OCR \(it took too long\)/.test(w)));
  assert.ok(parsed.warnings.some((w) => /Page 3 could not be read by OCR \(OCR stopped after a page took too long\)/.test(w)));
  assert.equal(stuck.calls.terminated, 1);

  const noEngine = scriptedOcr({}, { engine: () => Promise.reject(new Error("wasm blocked")) });
  const failed = await parsePdf(scannedPdf(1), { ocr: noEngine.options });
  assert.match(failed.fileErrors[0], /OCR could not be started in this browser/);
  const mixedNoEngine = await parsePdf(ab(makePdf([{ lines: ["Course Code: SPI-101", "Q1. Text?", "Type: true_false", "Marks: 1", "Answer: TRUE"] }, { image: true }])), { ocr: noEngine.options });
  assert.equal(mixedNoEngine.rows.length, 1, "text pages still read");
  assert.ok(mixedNoEngine.warnings.some((w) => /Page 2 could not be read by OCR \(the OCR engine could not be started\)/.test(w)));

  const badRender = scriptedOcr({ 2: ["Course Code: SPI-101", "Q1. Page two?", "Type: true_false", "Marks: 1", "Answer: TRUE"] }, {
    render: (page, calls) => {
      if (page.pageNumber === 1) throw new Error("image too large");
      return { width: 2480, height: 3508, image: page.pageNumber, release: () => calls.released.push(page.pageNumber) };
    },
  });
  const partial = await parsePdf(scannedPdf(2), { ocr: badRender.options });
  assert.ok(partial.warnings.some((w) => /Page 1 could not be read by OCR \(the page image could not be read\)/.test(w)));
  assert.equal(partial.rows.length, 1);

  const total = scriptedOcr({ 1: PAGE1, 2: PAGE1 });
  const late = await parsePdf(scannedPdf(2), { ocr: total.options, ocrTotalTimeoutMs: -1 });
  assert.match(late.fileErrors[0], /the OCR time limit for one file was reached/);
});

test("malformed / encrypted PDFs are refused before any OCR", async () => {
  const { options, calls } = scriptedOcr({});
  assert.match((await parsePdf(ab(new TextEncoder().encode("not a pdf")), { ocr: options })).fileErrors[0], /could not be read as a PDF/);
  assert.match((await parsePdf(ab(pdfOf(["Q1. x"]).slice(0, 300)), { ocr: options })).fileErrors[0], /could not be read as a PDF/);
  assert.match((await parsePdf(ab(makePdf([{ image: true }], { encrypt: { user: "", owner: "o" } })), { ocr: options })).fileErrors[0], /encrypted/);
  assert.equal(calls.started, 0);
});

test("normal text-PDF regression: OCR is never started for text pages; results identical to Phase G", async () => {
  const lines = ["Course Code: SPI-101", "Q1. Text only?", "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: B"];
  const { options, calls } = scriptedOcr({});
  const withOcr = await parsePdf(ab(pdfOf(lines, { compress: true })), { ocr: options });
  const without = await parsePdf(ab(pdfOf(lines, { compress: true })), { ocr: null });
  assert.equal(calls.started, 0);
  assert.deepEqual(withOcr, without);
  assert.equal(withOcr.source, "pdf");
  assert.equal((await validateImport(withOcr.rows, ctx("pdf"))).summary.create, 1);
  // No OCR available (e.g. outside a browser): the Phase G message for scanned PDFs.
  assert.match((await parsePdf(scannedPdf(1))).fileErrors[0], /OCR is planned/);
});

// ---------------------------------------------------------------------------
// Conversion and self-hosting
// ---------------------------------------------------------------------------
test("tesseract output → OCR lines → positioned items (pure)", () => {
  const page = ocrLib.fromTesseract(
    { blocks: [{ paragraphs: [{ lines: [{ baseline: { y0: 208, y1: 210 }, words: [{ text: "Answer:", confidence: 91.5, bbox: { x0: 100, y0: 170, x1: 250, y1: 212 } }, { text: "A", confidence: 64, bbox: { x0: 270, y0: 172, x1: 295, y1: 210 } }] }] }] }] },
    2480,
    3508
  );
  assert.deepEqual(page.lines[0].baseline, 210);
  const text = ocrLib.pageTextFromOcr(page);
  assert.equal(text.ocr, true);
  assert.deepEqual(text.items.map((i) => [i.str, i.y, i.confidence]), [["Answer:", 3298, 91.5], ["A", 3298, 64]]);
  assert.deepEqual(ocrLib.fromTesseract({ blocks: null }, 1, 1).lines, []);
});

test("self-hosted OCR files: present, identical to the approved packages, and the engine is pointed only at /ocr/ (no CDN)", () => {
  const check = spawnSync(process.execPath, [path.join(root, "scripts/copy-ocr-assets.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/ocr/manifest.json"), "utf8"));
  assert.deepEqual(manifest.packages, { "tesseract.js": "7.0.0", "tesseract.js-core": "7.0.0", "@tesseract.js-data/eng": "1.0.0", "pdfjs-dist": "6.3.289" });
  const source = fs.readFileSync(path.join(root, "src/lib/question-import/pdf-ocr.ts"), "utf8");
  for (const key of ['workerPath: abs("/ocr/worker.min.js")', 'corePath: abs("/ocr/core/")', 'langPath: abs("/ocr/lang")', 'cacheMethod: "none"', 'pdfjsWasmUrl: abs("/ocr/pdfjs/")']) {
    assert.ok(source.includes(key), key);
  }
  assert.ok(!/https?:\/\//.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "no absolute URLs in the OCR code");
  assert.equal(ocrLib.browserOcr(), null, "no OCR outside a browser");
});
