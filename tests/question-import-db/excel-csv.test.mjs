// Integration (Phase E): Excel/CSV import through the real Phase D service and
// real 0013, and Question Bank exports — admin / trainer / student / anonymous.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEADER, R, SHA, USERS, asAction, bytesToArrayBuffer, core, count, csv, db, exporter, ids, importLikeTheBrowser, question, serviceFor, svcCore, workbookBytes, xlsx,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const byRow = (preview, n) => preview.results.find((r) => r.rowNumber === n);

// ===========================================================================
// Imports
// ===========================================================================
test("admin XLSX import: new rows created as DRAFTS; bank duplicate, formula row and Status=Active handled", async () => {
  const bytes = await workbookBytes([
    HEADER,
    R({ "Course Code": "SPI-101", "Module Code": "m1", "Question Text": "XLSX: which device measures level?", Type: "single_choice", Marks: 1, "Option A": "LT", "Option B": "PT", "Correct Answer": "A", Status: "Active" }),
    R({ "Course Code": "SPI-101", "Question Text": "XLSX: temperature sensors?", Type: "Multiple Choice", Marks: 2.5, "Option A": "RTD", "Option B": "Orifice", "Option C": "Thermocouple", "Correct Answer": "A,C" }),
    R({ "Course Code": "SPI-101", "Question Text": "XLSX: a valve is a final element.", Type: "true_false", Marks: 1, "Correct Answer": true }),
    R({ "Course Code": "SPI-101", "Question Text": "what does FT stand for?", Type: "single_choice", Marks: 1, "Option A": "Flow switch", "Option B": "Flow transmitter", "Option C": "Flow totaliser", "Correct Answer": "B" }),
    R({ "Course Code": "SPI-101", "Question Text": "XLSX: formula marks?", Type: "single_choice", Marks: { formula: "1+1", result: 2 }, "Option A": "A", "Option B": "B", "Correct Answer": "A" }),
  ]);
  const parsed = await xlsx.parseXlsx(bytes);
  const { preview, run, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "questions.xlsx" });
  assert.deepEqual(preview.summary, { total: 5, create: 3, update: 0, duplicate: 1, error: 1, needsReview: 0 });
  assert.equal(byRow(preview, 5).duplicateOf.questionId, ids.qa1, "bank duplicate of the seeded active question");
  assert.equal(byRow(preview, 6).issues[0].code, "formula_cell");
  assert.equal(outcome.created, 3);
  assert.equal(run.status, "completed");
  assert.equal(run.fileName, "questions.xlsx");
  assert.equal(run.fileSha256, SHA);
  for (const o of outcome.rows) assert.equal((await question(o.questionId)).status, "draft", "Status=Active ignored: DRAFT");
  assert.equal(await count("question_text like 'XLSX:%'"), 3);
  assert.equal(await count("question_text = 'XLSX: formula marks?'"), 0);
});

test("admin CSV import (BOM, quoted commas, multiline, Unicode fixture) creates drafts", async () => {
  const parsed = csv.parseCsv(bytesToArrayBuffer(fs.readFileSync(path.join(here, "../question-import/fixtures/csv/quoted-multiline-unicode.csv"))));
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "unicode.csv" });
  assert.equal(preview.summary.create, 3);
  assert.equal(outcome.created, 3);
  assert.equal(await count(`question_text = 'Line one of the question' || chr(10) || 'Line two: which is correct?'`), 1);
  assert.equal(await count(`question_text = 'Débit massique — Coriolis ≈ ±0.1 % ; 流量计 ✓'`), 1, "Unicode preserved end to end");
});

test("CSV without Course Code: the course chosen in the UI is used (never guessed); in-file duplicate excluded unless included anyway", async () => {
  const text = [
    "Question Text,Type,Marks,Option A,Option B,Correct Answer",
    "Chosen-course question?,single_choice,1,Yes,No,A",
    "Chosen-course question?,single_choice,1,No,Yes,B",
    "Chosen-course question?,single_choice,1,Yes,No,A",
  ].join("\n");
  const parsed = csv.parseCsvText(text);
  assert.equal(parsed.everyRowHasCourse, false);
  const noCourse = await core.validateImport(parsed.rows, await serviceFor("A").getContext({ source: "csv", courseCodes: [], questionIds: [] }));
  assert.equal(noCourse.summary.error, 3, "no course chosen → every row is an error");
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "no-course.csv", defaultCourseId: ids.C2, include: [4] });
  assert.equal(byRow(preview, 3).status, "DUPLICATE");
  assert.equal(byRow(preview, 4).includeAnyway, true);
  assert.equal(outcome.created, 2);
  assert.equal(await count(`question_text = 'Chosen-course question?' and course_id = '${ids.C2}'`), 2);
});

test("trainer CSV import: own course only — another trainer's course is refused in preview AND by the server", async () => {
  const text = [
    "Course Code,Question Text,Type,Marks,Option A,Option B,Correct Answer",
    "SPI-101,T1 own course question?,single_choice,1,Yes,No,A",
    "SPI-201,T1 other course question?,single_choice,1,Yes,No,A",
  ].join("\n");
  const parsed = csv.parseCsvText(text);
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "t1.csv" });
  assert.equal(byRow(preview, 2).status, "CREATE");
  assert.equal(byRow(preview, 3).issues[0].code, "course_not_found");
  assert.equal(outcome.created, 1);
  // Bypass the preview: send the other-course row straight to the server.
  const svc = serviceFor("T1");
  const run = await svc.startImport({ source: "csv", fileName: "sneaky.csv", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "csv", rows: [parsed.rows[1]] });
  assert.equal(res.rows[0].outcome, "skipped");
  await svc.discardImport(run.id);
  assert.equal(await count("question_text = 'T1 other course question?'"), 0);
});

test("trainer cannot update another trainer's draft or an ACTIVE/ARCHIVED question through a file", async () => {
  const rev = async (id) => (await question(id)).revision;
  const text = [
    "Question ID,Course Code,Question Text,Type,Marks,Option A,Option B,Correct Answer,Revision",
    `${ids.qc2},SPI-201,Hijack other trainer draft?,single_choice,1,PID,PLC,A,${await rev(ids.qc2)}`,
    `${ids.qa1},SPI-101,Overwrite active?,single_choice,1,A,B,A,${await rev(ids.qa1)}`,
    `${ids.qar},SPI-101,Overwrite archived?,single_choice,1,A,B,A,${await rev(ids.qar)}`,
  ].join("\n");
  const parsed = csv.parseCsvText(text);
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "hijack.csv" });
  assert.equal(outcome, null, "nothing importable");
  assert.equal(byRow(preview, 2).issues.some((i) => i.code === "question_not_found" || i.code === "course_not_found"), true);
  assert.equal(byRow(preview, 3).issues[0].code, "question_protected");
  assert.equal(byRow(preview, 4).issues[0].code, "question_protected");
  assert.equal((await question(ids.qa1)).question_text, "What does FT stand for?");
  assert.equal((await question(ids.qc2)).question_text, "Which is a control algorithm?");
});

// ===========================================================================
// Exports
// ===========================================================================
test("admin export: every question of every course, with answer keys; XLSX and CSV files round-trip", async () => {
  const exp = await serviceFor("A").exportQuestions("bank");
  assert.equal(exp.questions.length, await count("true"));
  assert.ok(exp.questions.some((q) => q.courseCode === "SPI-201") && exp.questions.some((q) => q.courseCode === "SPI-101"));
  const qa1 = exp.questions.find((q) => q.id === ids.qa1);
  assert.equal(exporter.correctAnswerOf(qa1), "A", "answer key present for staff");
  const table = exporter.buildExportTable(exp.questions, "bank");
  const fromXlsx = await xlsx.parseXlsx(bytesToArrayBuffer(await exporter.toXlsxBytes(table)));
  const fromCsv = csv.parseCsvText(exporter.toCsvText(table));
  assert.equal(fromXlsx.rows.length, exp.questions.length);
  assert.equal(fromCsv.rows.length, exp.questions.length);
  assert.deepEqual(fromXlsx.fileErrors, []);
});

test("trainer export: only their current course; other trainers' questions never included", async () => {
  const t1 = await serviceFor("T1").exportQuestions("bank");
  assert.ok(t1.questions.length > 0);
  assert.ok(t1.questions.every((q) => q.courseCode === "SPI-101"));
  assert.equal(t1.questions.length, await count(`course_id = '${ids.C1}'`));
  const t2 = await serviceFor("T2").exportQuestions("bank");
  assert.ok(t2.questions.every((q) => q.courseCode === "SPI-201"));
  assert.ok(!t2.questions.some((q) => q.id === ids.qa1));
  assert.deepEqual((await serviceFor("T3").exportQuestions("bank")).questions, [], "no current course → nothing");
});

test("draft update export → edit → import: the draft is updated (revision +1), still a draft; active questions are not in the file", async () => {
  const svc = serviceFor("T1");
  const exp = await svc.exportQuestions("update");
  assert.ok(exp.questions.every((q) => q.status === "draft" && q.courseCode === "SPI-101"));
  assert.ok(!exp.questions.some((q) => q.id === ids.qa1), "active question not offered for update");
  const target = exp.questions.find((q) => q.id === ids.qd2);
  const table = exporter.buildExportTable([target], "update");
  assert.ok(!table.headers.includes("Status"));
  const before = await question(ids.qd2);
  const parsed = csv.parseCsvText(exporter.toCsvText(table));
  parsed.rows[0].questionText = "A PT measures pressure (edited via export file).";
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "update.csv" });
  assert.equal(byRow(preview, 2).status, "UPDATE");
  assert.equal(outcome.updated, 1);
  const after = await question(ids.qd2);
  assert.equal(after.question_text, "A PT measures pressure (edited via export file).");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.status, "draft");
  // Re-importing the same (now stale) export row is a revision conflict, never an overwrite.
  const stale = csv.parseCsvText(exporter.toCsvText(table));
  const again = await importLikeTheBrowser("T1", stale, { fileName: "stale.csv" });
  assert.equal(byRow(again.preview, 2).issues[0].code, "revision_conflict");
  assert.equal((await question(ids.qd2)).question_text, "A PT measures pressure (edited via export file).");
});

test("student and anonymous users: no context, no export (no answer keys), no import", async () => {
  for (const key of ["ST1", null]) {
    const svc = serviceFor(key);
    await assert.rejects(svc.exportQuestions("bank"), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    await assert.rejects(svc.exportQuestions("update"), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    await assert.rejects(svc.getContext({ source: "csv", courseCodes: ["SPI-101"], questionIds: [] }), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    const res = await asAction(() => svc.startImport({ source: "csv", fileName: "x.csv", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 }));
    assert.equal(res.ok, false);
  }
  // Even bypassing the service, the database gives a student no questions and no answer key.
  const st = db.client({ role: "authenticated", userId: USERS.ST1.id });
  assert.deepEqual((await st.from("question_options").select("is_correct").limit(1)).data, []);
});

test("export mode is validated", async () => {
  await assert.rejects(serviceFor("A").exportQuestions("everything"), (e) => e instanceof svcCore.QuestionImportValidationError);
});
