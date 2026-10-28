import { test } from "node:test";
import assert from "node:assert/strict";
import { core, context, row, codes, severityOf, existing, C1, C2, M1, M2, Q_DRAFT, Q_DRAFT2, Q_ACTIVE, Q_ARCHIVED, Q_OTHER_COURSE } from "./helpers.mjs";

const { validateRow, validateImport, summarize, toChunkItems, toChunks, detectRevisionConflicts, checkQuestionCount } = core;
const run = async (rows, ctx = context()) => (await validateImport(rows, ctx)).results;
const byRow = (results, n) => results.find((r) => r.rowNumber === n);

// ---------------------------------------------------------------------------
// Creates
// ---------------------------------------------------------------------------
test("valid single choice → CREATE with a save-ready question", () => {
  const r = validateRow(row(2, { moduleCode: "m2", explanation: "  Because.  " }), context());
  assert.equal(r.status, "CREATE");
  assert.equal(r.action, "create");
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.question, {
    courseId: C1, moduleId: M2, type: "single_choice", text: "Question number 2?", marks: 1, explanation: "Because.",
    options: [{ text: "Alpha", isCorrect: true }, { text: "Beta", isCorrect: false }, { text: "Gamma", isCorrect: false }, { text: "Delta", isCorrect: false }],
  });
});
test("multiple choice with A,C and true/false", () => {
  const mc = validateRow(row(2, { questionType: "Multiple Choice", correctAnswer: "a; c" }), context());
  assert.equal(mc.status, "CREATE");
  assert.deepEqual(mc.question.options.map((o) => o.isCorrect), [true, false, true, false]);
  const tf = validateRow(row(3, { questionType: "true/false", options: [], correctAnswer: "FALSE" }), context());
  assert.equal(tf.status, "CREATE");
  assert.deepEqual(tf.question.options, [{ text: "True", isCorrect: false }, { text: "False", isCorrect: true }]);
});
test("course code matched without case/space; module optional", () => {
  const r = validateRow(row(2, { courseCode: "  spi-201 " }), context());
  assert.equal(r.question.courseId, C2);
  assert.equal(r.question.moduleId, null);
});

// ---------------------------------------------------------------------------
// Status is never applied
// ---------------------------------------------------------------------------
test("Status Active / Archived is ignored with a warning; the row still creates a DRAFT", async () => {
  const [a, b, c, d] = await run([row(2, { status: "Active" }), row(3, { status: "archived" }), row(4, { status: "draft" }), row(5, { status: "published" })]);
  for (const r of [a, b]) {
    assert.equal(r.status, "CREATE");
    assert.equal(severityOf(r, "status_ignored"), "warning");
    assert.match(r.issues[0].message, /always created as drafts/);
  }
  assert.deepEqual(c.issues, [], "draft: no warning");
  assert.equal(severityOf(d, "status_ignored"), "warning");
  assert.match(d.issues[0].message, /not recognised/);
  const items = toChunkItems([a, b, c, d]);
  assert.ok(items.every((i) => !("status" in i)), "no chunk item ever carries a status");
});
test("Status on an update row: ignored, import never changes status", () => {
  const r = validateRow(row(2, { questionId: Q_DRAFT, status: "Active" }), context());
  assert.equal(r.status, "UPDATE");
  assert.match(r.issues.find((i) => i.code === "status_ignored").message, /never changes a question's status/);
});

// ---------------------------------------------------------------------------
// Errors (structured files)
// ---------------------------------------------------------------------------
test("missing marks → ERROR (never defaulted)", () => {
  for (const marks of ["", null, undefined, "  "]) {
    const r = validateRow(row(2, { marks }), context());
    assert.equal(r.status, "ERROR", String(marks));
    assert.deepEqual(codes(r), ["marks_missing"]);
    assert.equal(r.question, null);
  }
});
test("invalid marks → ERROR", () => {
  for (const marks of ["0", "-1", "1,5", "1.234", "abc", "10000"]) assert.deepEqual(codes(validateRow(row(2, { marks }), context())), ["marks_invalid"], marks);
});
test("missing / invalid type, text, answer → ERROR in a spreadsheet", () => {
  assert.deepEqual(codes(validateRow(row(2, { questionType: "" }), context())), ["type_missing"]);
  assert.deepEqual(codes(validateRow(row(2, { questionType: "essay" }), context())), ["type_invalid"]);
  assert.deepEqual(codes(validateRow(row(2, { questionText: "   " }), context())), ["text_missing"]);
  assert.deepEqual(codes(validateRow(row(2, { correctAnswer: "" }), context())), ["answer_missing"]);
  assert.equal(validateRow(row(2, { correctAnswer: "" }), context()).status, "ERROR");
});
test("text and explanation length limits (5000)", () => {
  assert.equal(validateRow(row(2, { questionText: "x".repeat(5000) }), context()).status, "CREATE");
  assert.deepEqual(codes(validateRow(row(2, { questionText: "x".repeat(5001) }), context())), ["text_too_long"]);
  assert.deepEqual(codes(validateRow(row(2, { explanation: "e".repeat(5001) }), context())), ["explanation_too_long"]);
});
test("single choice with two answers, bad letters, blank option letters → ERROR", () => {
  assert.deepEqual(codes(validateRow(row(2, { correctAnswer: "A,B" }), context())), ["answer_count"]);
  assert.deepEqual(codes(validateRow(row(2, { correctAnswer: "AB" }), context())), ["answer_invalid"]);
  assert.deepEqual(codes(validateRow(row(2, { options: ["x", "y"], correctAnswer: "C" }), context())), ["answer_blank_option"]);
});
test("option gap / too few / repeated → ERROR", () => {
  assert.ok(codes(validateRow(row(2, { options: ["a", "", "c"] }), context())).includes("option_gap"));
  assert.ok(codes(validateRow(row(2, { options: ["a"] }), context())).includes("options_too_few"));
  assert.deepEqual(codes(validateRow(row(2, { options: ["same", "SAME"] }), context())), ["option_repeated"]);
});
test("A–J: a 10-option question with answer J", () => {
  const r = validateRow(row(2, { questionType: "multiple_choice", options: "ABCDEFGHIJ".split("").map((l) => `Opt ${l}`), correctAnswer: "B,J" }), context());
  assert.equal(r.status, "CREATE");
  assert.equal(r.question.options.length, 10);
  assert.deepEqual(r.question.options.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0), [1, 9]);
});
test("true/false with custom option text → ERROR", () => {
  assert.deepEqual(codes(validateRow(row(2, { questionType: "true_false", options: ["Yes", "No"], correctAnswer: "TRUE" }), context())), ["true_false_options"]);
});
test("course: missing, unknown / out of scope (one message), module of another course", () => {
  assert.deepEqual(codes(validateRow(row(2, { courseCode: "" }), context())), ["course_missing"]);
  const unknown = validateRow(row(2, { courseCode: "SPI-999" }), context());
  assert.deepEqual(codes(unknown), ["course_not_found"]);
  assert.match(unknown.issues[0].message, /not found, or it isn't a course you can manage/);
  assert.deepEqual(codes(validateRow(row(2, { courseCode: "SPI-201", moduleCode: "M2" }), context())), ["module_not_found"]);
});
test("row numbers must be whole numbers 1..1,000,000", () => {
  for (const n of [0, -1, 1.5, 1_000_001]) assert.deepEqual(codes(validateRow(row(n), context())), ["row_number_invalid"], String(n));
  assert.equal(validateRow(row(1_000_000), context()).status, "CREATE");
});

// ---------------------------------------------------------------------------
// Updates: drafts only, same course, revision captured
// ---------------------------------------------------------------------------
test("update of a DRAFT → UPDATE with the preview revision", () => {
  const r = validateRow(row(2, { questionId: Q_DRAFT.toUpperCase() }), context());
  assert.equal(r.status, "UPDATE");
  assert.equal(r.questionId, Q_DRAFT);
  assert.equal(r.expectedRevision, 3);
});
test("update may omit the course code (the question's own course is used)", () => {
  const r = validateRow(row(2, { questionId: Q_DRAFT, courseCode: "" }), context());
  assert.equal(r.status, "UPDATE");
  assert.equal(r.question.courseId, C1);
});
test("ACTIVE and ARCHIVED questions are protected", () => {
  for (const id of [Q_ACTIVE, Q_ARCHIVED]) {
    const r = validateRow(row(2, { questionId: id }), context());
    assert.equal(r.status, "ERROR");
    assert.deepEqual(codes(r), ["question_protected"]);
    assert.equal(r.expectedRevision, null);
  }
});
test("unknown / not-visible Question ID and malformed ID", () => {
  assert.deepEqual(codes(validateRow(row(2, { questionId: "eeeeeeee-0000-4000-8000-000000000001" }), context())), ["question_not_found"]);
  assert.deepEqual(codes(validateRow(row(2, { questionId: "Q-17" }), context())), ["question_id_invalid"]);
});
test("course cannot change during an update", () => {
  assert.deepEqual(codes(validateRow(row(2, { questionId: Q_OTHER_COURSE, courseCode: "SPI-101" }), context())), ["course_change"]);
  assert.equal(validateRow(row(2, { questionId: Q_OTHER_COURSE, courseCode: "SPI-201" }), context()).status, "UPDATE");
});
test("the same Question ID twice → later row is an ERROR", async () => {
  const results = await run([row(2, { questionId: Q_DRAFT }), row(3, { questionId: Q_DRAFT, questionText: "Different" })]);
  assert.equal(byRow(results, 2).status, "UPDATE");
  assert.deepEqual(codes(byRow(results, 3)), ["question_id_repeated"]);
});
test("repeated row number → later row is an ERROR", async () => {
  const results = await run([row(2), row(2, { questionText: "Other" })]);
  assert.equal(results.filter((r) => r.status === "ERROR").length, 1);
});

// ---------------------------------------------------------------------------
// Stale revision conflicts
// ---------------------------------------------------------------------------
test("detectRevisionConflicts: changed, no longer draft, or gone → ERROR; unchanged stays UPDATE", async () => {
  const results = await run([row(2, { questionId: Q_DRAFT }), row(3, { questionId: Q_DRAFT2 }), row(4), row(5, { questionId: Q_OTHER_COURSE, courseCode: "" })]);
  const now = [
    { id: Q_DRAFT, courseId: C1, status: "draft", revision: 4 },   // edited since the preview
    { id: Q_DRAFT2, courseId: C1, status: "draft", revision: 1 },  // unchanged
    // Q_OTHER_COURSE no longer visible
  ];
  const checked = detectRevisionConflicts(results, now);
  assert.deepEqual(codes(byRow(checked, 2)), ["revision_conflict"]);
  assert.match(byRow(checked, 2).issues[0].message, /revision 3 → 4/);
  assert.equal(byRow(checked, 3).status, "UPDATE");
  assert.equal(byRow(checked, 4).status, "CREATE", "creates untouched");
  assert.deepEqual(codes(byRow(checked, 5)), ["question_not_found"]);
  assert.equal(byRow(results, 2).status, "UPDATE", "input results not mutated");
  const activated = detectRevisionConflicts(results, [{ id: Q_DRAFT, courseId: C1, status: "active", revision: 4 }]);
  assert.deepEqual(codes(byRow(activated, 2)), ["question_protected"]);
});

// ---------------------------------------------------------------------------
// Duplicates, include-anyway, similar
// ---------------------------------------------------------------------------
test("duplicate within the file: first wins, later rows DUPLICATE (reordered options, case, spacing)", async () => {
  const results = await run([
    row(2, { questionText: "Which device measures level?", options: ["LT", "PT", "TT"] }),
    row(3, { questionText: "  which DEVICE measures   level? ", options: ["tt", "LT", "pt"], correctAnswer: "B", marks: "5" }),
    row(4, { questionText: "Which device measures level?", options: ["LT", "PT", "TT"] }),
  ]);
  assert.equal(byRow(results, 2).status, "CREATE");
  for (const n of [3, 4]) {
    assert.equal(byRow(results, n).status, "DUPLICATE");
    assert.deepEqual(byRow(results, n).duplicateOf, { kind: "file", rowNumber: 2 });
    assert.equal(severityOf(byRow(results, n), "duplicate_in_file"), "warning");
  }
});
test("duplicate of an existing bank question (any status) → DUPLICATE with a link", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C1, "single_choice", "What does FT stand for?", ["Flow transmitter", "Flow switch"], "archived")] });
  const [r] = await run([row(2, { questionText: "what does ft stand for?", options: ["FLOW SWITCH", "flow transmitter"] })], ctx);
  assert.equal(r.status, "DUPLICATE");
  assert.deepEqual(r.duplicateOf, { kind: "bank", questionId: "99999999-0000-4000-8000-000000000001" });
  assert.deepEqual(codes(r), ["duplicate_in_bank"]);
});
test("same content in ANOTHER course is not a duplicate", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C2, "single_choice", "Question number 2?", ["Alpha", "Beta", "Gamma", "Delta"])] });
  const [r] = await run([row(2)], ctx);
  assert.equal(r.status, "CREATE");
});
test("include anyway: duplicate stays CREATE, warning, allow_duplicate in the chunk item", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C1, "single_choice", "Question number 2?", ["Alpha", "Beta", "Gamma", "Delta"])] });
  const results = await run([row(2, { includeAnyway: true }), row(3, { questionText: "Question number 2?", includeAnyway: false })], ctx);
  assert.equal(byRow(results, 2).status, "CREATE");
  assert.equal(byRow(results, 2).includeAnyway, true);
  assert.equal(severityOf(byRow(results, 2), "included_anyway"), "warning");
  assert.equal(byRow(results, 3).status, "DUPLICATE", "default is exclude");
  const items = toChunkItems(results);
  assert.equal(items.length, 1);
  assert.equal(items[0].allow_duplicate, true);
});
test("include anyway has no effect on a row that is not a duplicate", async () => {
  const [r] = await run([row(2, { includeAnyway: true })]);
  assert.equal(r.includeAnyway, false);
  assert.equal(toChunkItems([r])[0].allow_duplicate, false);
});
test("similar text with different options / type → warning only, still CREATE", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C1, "single_choice", "What does FT stand for?", ["Flow transmitter", "Flow switch"])] });
  const results = await run([
    row(2, { questionText: "What does FT stand for?", options: ["Flow transmitter", "Field terminal"] }),
    row(3, { questionText: "What does FT stand for?", questionType: "multiple_choice", options: ["Flow transmitter", "Field terminal"] }),
  ], ctx);
  for (const n of [2, 3]) {
    assert.equal(byRow(results, n).status, "CREATE");
    assert.equal(severityOf(byRow(results, n), "similar_question"), "warning");
  }
  assert.deepEqual(byRow(results, 3).similarTo.map((s) => s.kind).sort(), ["bank", "file"]);
});
test("an update is never a duplicate of itself", async () => {
  const ctx = context({ existing: [await existing(Q_DRAFT, C1, "single_choice", "Question number 2?", ["Alpha", "Beta", "Gamma", "Delta"], "draft", 3)] });
  const [r] = await run([row(2, { questionId: Q_DRAFT, marks: "2" })], ctx);
  assert.equal(r.status, "UPDATE");
  assert.deepEqual(r.similarTo, []);
});
test("an update that would copy another bank question → DUPLICATE", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C1, "single_choice", "Question number 2?", ["Alpha", "Beta", "Gamma", "Delta"])] });
  const [r] = await run([row(2, { questionId: Q_DRAFT })], ctx);
  assert.equal(r.status, "DUPLICATE");
});
test("row order is database order: an update frees its old content, then a later new row with that old content is fine", async () => {
  const ctx = context({ existing: [await existing(Q_DRAFT, C1, "single_choice", "Old wording?", ["Alpha", "Beta"], "draft", 3)] });
  const results = await run([
    row(5, { questionText: "Old wording?", options: ["Alpha", "Beta"] }),               // after the update below
    row(2, { questionId: Q_DRAFT, questionText: "New wording?", options: ["Alpha", "Beta"] }),
    row(7, { questionText: "New wording?", options: ["Beta", "Alpha"] }),              // copies the updated question
  ], ctx);
  assert.equal(byRow(results, 2).status, "UPDATE");
  assert.equal(byRow(results, 5).status, "CREATE");
  assert.equal(byRow(results, 7).status, "DUPLICATE");
  assert.deepEqual(byRow(results, 7).duplicateOf, { kind: "bank", questionId: Q_DRAFT });
  assert.deepEqual(results.map((r) => r.rowNumber), [2, 5, 7], "results in row order");
});
test("ERROR / NEEDS_REVIEW rows never claim a fingerprint", async () => {
  const results = await run([row(2, { marks: "" }), row(3)]);
  assert.equal(byRow(results, 2).status, "ERROR");
  assert.equal(byRow(results, 3).status, "CREATE");
});

// ---------------------------------------------------------------------------
// Word / PDF / OCR
// ---------------------------------------------------------------------------
test("extracted items: missing answer / options / type / text → NEEDS_REVIEW (not invented)", async () => {
  const ctx = context({ source: "docx", defaultCourseId: C1 });
  const results = await run([
    row(1, { courseCode: "", correctAnswer: "" }),
    row(2, { courseCode: "", options: ["Only one"] }),
    row(3, { courseCode: "", questionType: "" }),
    row(4, { courseCode: "", questionText: "" }),
  ], ctx);
  for (const r of results) assert.equal(r.status, "NEEDS_REVIEW", String(r.rowNumber));
  assert.equal(toChunkItems(results).length, 0, "nothing needing review is imported");
});
test("extracted items: missing marks is still an ERROR (locked rule)", async () => {
  const [r] = await run([row(1, { courseCode: "", marks: "" })], context({ source: "pdf", defaultCourseId: C1 }));
  assert.equal(r.status, "ERROR");
  assert.deepEqual(codes(r), ["marks_missing"]);
});
test("extracted items: malformed values stay ERRORs", async () => {
  const [r] = await run([row(1, { courseCode: "", correctAnswer: "AC" })], context({ source: "docx", defaultCourseId: C1 }));
  assert.equal(r.status, "ERROR");
});
test("extractor-reported missing fields → NEEDS_REVIEW", async () => {
  const [r] = await run([row(1, { courseCode: "", source: { page: 3, missing: ["explanation"] } })], context({ source: "pdf", defaultCourseId: C1 }));
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.deepEqual(codes(r), ["extraction_incomplete"]);
});
test("course chosen in the UI; a conflicting code in the document is an ERROR; module default applied", async () => {
  const ctx = context({ source: "docx", defaultCourseId: C1, defaultModuleId: M1 });
  const [ok, clash] = await run([row(1, { courseCode: "" }), row(2, { courseCode: "SPI-201" })], ctx);
  assert.equal(ok.status, "CREATE");
  assert.equal(ok.question.moduleId, M1);
  assert.deepEqual(codes(clash), ["course_mismatch"]);
});
test("OCR: every scanned item is NEEDS_REVIEW with page + confidence, until the reviewer confirms it", async () => {
  const ctx = context({ source: "pdf_ocr", defaultCourseId: C1 });
  const [a] = await run([row(1, { courseCode: "", source: { page: 4, ocrConfidence: 91.6 } })], ctx);
  assert.equal(a.status, "NEEDS_REVIEW");
  assert.match(a.issues.find((i) => i.code === "ocr_review").message, /page 4, OCR confidence 92%/);
  const [b] = await run([row(1, { courseCode: "", source: { page: 4, ocrConfidence: 99 }, reviewConfirmed: true })], ctx);
  assert.equal(b.status, "CREATE");
});
test("OCR confirmation cannot hide missing information", async () => {
  const [r] = await run([row(1, { courseCode: "", correctAnswer: "", reviewConfirmed: true })], context({ source: "pdf_ocr", defaultCourseId: C1 }));
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.deepEqual(codes(r), ["answer_missing"]);
});
test("uncertain text-PDF item (flagged by the extractor) → NEEDS_REVIEW", async () => {
  const [r] = await run([row(1, { courseCode: "", source: { uncertain: true, page: 2 } })], context({ source: "pdf", defaultCourseId: C1 }));
  assert.equal(r.status, "NEEDS_REVIEW");
});

// ---------------------------------------------------------------------------
// Excel/CSV: the chosen course fills only rows without a Course Code
// ---------------------------------------------------------------------------
test("xlsx/csv: rows with a Course Code keep it; rows without use the chosen course and module", async () => {
  for (const source of ["xlsx", "csv"]) {
    const ctx = context({ source, defaultCourseId: C1, defaultModuleId: M1 });
    const [withCode, blank] = await run([row(2, { courseCode: "SPI-201" }), row(3, { courseCode: "" })], ctx);
    assert.equal(withCode.status, "CREATE", `${source}: a different code is not a mismatch for structured files`);
    assert.equal(withCode.question.courseId, C2);
    assert.equal(withCode.question.moduleId, null, "default module only for rows that used the chosen course");
    assert.equal(blank.question.courseId, C1);
    assert.equal(blank.question.moduleId, M1);
  }
});
test("xlsx/csv: no chosen course and no Course Code → course_missing (never guessed)", () => {
  assert.deepEqual(codes(validateRow(row(2, { courseCode: "" }), context({ source: "csv" }))), ["course_missing"]);
});
test("parser-reported row issues (e.g. formula cell) are always part of the result", () => {
  const r = validateRow(row(2, { sourceIssues: [{ code: "formula_cell", severity: "error", field: "marks", message: "Marks: formula" }] }), context());
  assert.equal(r.status, "ERROR");
  assert.deepEqual(codes(r), ["formula_cell"]);
});
test("update row with no course code uses the question's own course even when a course is chosen", () => {
  const r = validateRow(row(2, { questionId: Q_OTHER_COURSE, courseCode: "" }), context({ source: "xlsx", defaultCourseId: C1 }));
  assert.equal(r.status, "UPDATE");
  assert.equal(r.question.courseId, C2);
});

// ---------------------------------------------------------------------------
// Plan: summary, chunk items, chunks, limits
// ---------------------------------------------------------------------------
test("summary counts every status", async () => {
  const ctx = context({ existing: [await existing("99999999-0000-4000-8000-000000000001", C1, "single_choice", "Dup?", ["Alpha", "Beta", "Gamma", "Delta"])] });
  const { summary } = await validateImport([row(2), row(3, { questionId: Q_DRAFT }), row(4, { questionText: "Dup?" }), row(5, { marks: "" })], ctx);
  assert.deepEqual(summary, { total: 4, create: 1, update: 1, duplicate: 1, error: 1, needsReview: 0 });
  assert.deepEqual(summarize([]), { total: 0, create: 0, update: 0, duplicate: 0, error: 0, needsReview: 0 });
});
test("chunk items: 0013 keys only; updates carry id + expected revision; creates don't", async () => {
  const results = await run([row(2, { moduleCode: "M1" }), row(3, { questionId: Q_DRAFT })]);
  const [create, update] = toChunkItems(results);
  assert.deepEqual(Object.keys(create).sort(), ["allow_duplicate", "course_id", "explanation", "marks", "module_id", "options", "question_text", "question_type", "row_number"]);
  assert.equal(create.module_id, M1);
  assert.deepEqual(create.options[0], { option_text: "Alpha", is_correct: true });
  assert.equal(update.question_id, Q_DRAFT);
  assert.equal(update.expected_revision, 3);
});
test("chunks of at most 100 rows", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  assert.deepEqual(toChunks(items).map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(toChunks([]), []);
});
test("per-file limits (XLSX 5,000 · CSV 10,000 · DOCX/PDF/OCR 1,000)", () => {
  assert.equal(checkQuestionCount("xlsx", 5000), null);
  assert.match(checkQuestionCount("xlsx", 5001), /limit for this file type is 5000/);
  assert.equal(checkQuestionCount("csv", 10000), null);
  assert.ok(checkQuestionCount("csv", 10001));
  for (const s of ["docx", "pdf", "pdf_ocr"]) {
    assert.equal(checkQuestionCount(s, 1000), null);
    assert.ok(checkQuestionCount(s, 1001));
  }
});
test("scale: 5,000 rows validate with in-file duplicates detected", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => row(i + 2, { questionText: `Scale question ${i % 4000}` }));
  const { summary } = await validateImport(rows, context());
  assert.equal(summary.total, 5000);
  assert.equal(summary.create, 4000);
  assert.equal(summary.duplicate, 1000);
});
