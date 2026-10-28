// Integration (Phase F): Word (.docx) import through the real Phase D service and real
// 0013 + RLS — admin / trainer / student / anonymous. Uses only questions it creates
// (texts start with "DOCX:"), plus read-only checks against the seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHA, USERS, asAction, bytesToArrayBuffer, count, db, ids, importLikeTheBrowser, question, serviceFor, svcCore } from "./harness.mjs";

const build = process.env.QI_BUILD;
const docx = await import(`${build}/lib/question-import/docx.mjs`);
const writer = await import(`${build}/lib/question-import/docx-template.mjs`);

const byRow = (preview, n) => preview.results.find((r) => r.rowNumber === n);
const wordFile = (...lines) => bytesToArrayBuffer(writer.buildDocx(lines.map((text) => ({ text }))));
const parseWord = (...lines) => docx.parseDocx(wordFile(...lines));

const TWO = [
  "Course Code: SPI-101",
  "Q1. DOCX: which instrument measures flow?",
  "Type: single_choice",
  "Marks: 2",
  "A) Flow transmitter",
  "B) Pressure gauge",
  "C) Level switch",
  "Answer: A",
  "Explanation: A flow transmitter measures flow.",
  "Q2. DOCX: a control valve is a final control element.",
  "Type: true_false",
  "Marks: 1",
  "Answer: TRUE",
];

test("admin DOCX import: 2 valid questions (single choice + true/false) created as DRAFTS with the right answers", async () => {
  const parsed = await parseWord(...TWO);
  assert.deepEqual(parsed.fileErrors, []);
  const { preview, run, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "questions.docx" });
  assert.deepEqual(preview.summary, { total: 2, create: 2, update: 0, duplicate: 0, error: 0, needsReview: 0 });
  assert.equal(outcome.created, 2);
  assert.equal(run.status, "completed");
  assert.equal(run.source, "docx");
  assert.equal(run.fileName, "questions.docx");
  for (const o of outcome.rows) {
    const q = await question(o.questionId);
    assert.equal(q.status, "draft");
    assert.equal(q.course_id, ids.C1);
    assert.equal(q.created_by, USERS.A.id);
  }
  const sc = outcome.rows.find((o) => o.rowNumber === 1).questionId;
  const answers = await db.admin(`select json_agg(json_build_array(option_text, is_correct) order by display_order) from public.question_options where question_id = '${sc}'`);
  assert.deepEqual(answers, [["Flow transmitter", true], ["Pressure gauge", false], ["Level switch", false]]);
  const tf = outcome.rows.find((o) => o.rowNumber === 2).questionId;
  assert.deepEqual(await db.admin(`select json_agg(json_build_array(option_text, is_correct) order by display_order) from public.question_options where question_id = '${tf}'`), [["True", true], ["False", false]]);
  assert.equal(await db.admin(`select marks::float8 from public.questions where id = '${sc}'`), 2);
});

test("duplicate DOCX: re-importing the same document creates nothing (preview AND server refuse)", async () => {
  const before = await count("question_text like 'DOCX:%'");
  const parsed = await parseWord(...TWO);
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "questions-again.docx" });
  assert.deepEqual(preview.results.map((r) => r.status), ["DUPLICATE", "DUPLICATE"]);
  assert.equal(outcome, null, "nothing importable");
  // Bypass the preview: send the rows straight to the server.
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "docx", fileName: "sneaky.docx", fileSha256: SHA, plannedCreates: 2, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "docx", rows: parsed.rows });
  assert.deepEqual(res.rows.map((r) => [r.outcome, r.status]), [["skipped", "DUPLICATE"], ["skipped", "DUPLICATE"]]);
  await svc.discardImport(run.id);
  assert.equal(await count("question_text like 'DOCX:%'"), before);
});

test("invalid answer and missing data: nothing is imported, even when sent to the server directly", async () => {
  const parsed = await parseWord(
    "Course Code: SPI-101",
    "Q1. DOCX: invalid answer?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No", "Answer: Yes",
    "Q2. DOCX: missing marks?", "Type: true_false", "Answer: TRUE",
    "Q3. DOCX: missing answer?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No"
  );
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "bad.docx" });
  assert.deepEqual(preview.results.map((r) => r.status), ["ERROR", "ERROR", "NEEDS_REVIEW"]);
  assert.equal(outcome, null);
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "docx", fileName: "bad-direct.docx", fileSha256: SHA, plannedCreates: 3, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "docx", rows: parsed.rows });
  assert.deepEqual(res.rows.map((r) => r.status), ["ERROR", "ERROR", "NEEDS_REVIEW"]);
  assert.ok(res.rows.every((r) => r.outcome === "skipped"));
  await svc.discardImport(run.id);
  assert.equal(await count("question_text in ('DOCX: invalid answer?', 'DOCX: missing marks?', 'DOCX: missing answer?')"), 0);
});

test("DOCX without course codes: the course chosen in the UI is used; the document's own module code works", async () => {
  const parsed = await parseWord("Q1. DOCX: chosen-course question?", "Module Code: M1", "Type: true_false", "Marks: 1", "Answer: FALSE");
  assert.equal(parsed.everyRowHasCourse, false);
  const { outcome } = await importLikeTheBrowser("A", parsed, { fileName: "no-course.docx", defaultCourseId: ids.C1 });
  assert.equal(outcome.created, 1);
  const id = outcome.rows[0].questionId;
  assert.equal((await question(id)).course_id, ids.C1);
  assert.equal(await db.admin(`select m.module_code from public.questions q join public.modules m on m.id = q.module_id where q.id = '${id}'`), "M1");
});

test("draft update via Question ID + Revision: updated (revision +1, still draft); a stale revision is refused; ACTIVE is protected", async () => {
  const created = await importLikeTheBrowser("T1", await parseWord("Course Code: SPI-101", "Q1. DOCX: draft to update?", "Type: true_false", "Marks: 1", "Answer: TRUE"), { fileName: "t1-create.docx" });
  const id = created.outcome.rows[0].questionId;
  const before = await question(id);
  assert.equal(before.status, "draft");

  const edit = (text, revision) => parseWord(`Q1. ${text}`, `Question ID: ${id}`, `Revision: ${revision}`, "Type: true_false", "Marks: 1", "Answer: FALSE");
  const { preview, outcome } = await importLikeTheBrowser("T1", await edit("DOCX: draft updated from Word.", before.revision), { fileName: "t1-update.docx" });
  assert.equal(byRow(preview, 1).status, "UPDATE");
  assert.equal(outcome.updated, 1);
  const after = await question(id);
  assert.equal(after.question_text, "DOCX: draft updated from Word.");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.status, "draft");
  assert.equal(await db.admin(`select option_text from public.question_options where question_id = '${id}' and is_correct`), "False");

  // The same (now stale) revision: a conflict in the preview and at the server, never an overwrite.
  const stale = await edit("DOCX: stale overwrite attempt.", before.revision);
  const again = await importLikeTheBrowser("T1", stale, { fileName: "t1-stale.docx" });
  assert.equal(byRow(again.preview, 1).issues[0].code, "revision_conflict");
  const svc = serviceFor("T1");
  const run = await svc.startImport({ source: "docx", fileName: "t1-stale-direct.docx", fileSha256: SHA, plannedCreates: 0, plannedUpdates: 1, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "docx", rows: stale.rows });
  assert.notEqual(res.rows[0].outcome, "updated");
  await svc.discardImport(run.id);
  assert.equal((await question(id)).question_text, "DOCX: draft updated from Word.");

  // An ACTIVE question cannot be updated from a Word file.
  const activeRev = (await question(ids.qa1)).revision;
  const active = await parseWord("Q1. DOCX: overwrite active?", `Question ID: ${ids.qa1}`, `Revision: ${activeRev}`, "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A");
  const blocked = await importLikeTheBrowser("A", active, { fileName: "active.docx" });
  assert.equal(byRow(blocked.preview, 1).issues[0].code, "question_protected");
  assert.equal(blocked.outcome, null);
  assert.equal((await question(ids.qa1)).question_text, "What does FT stand for?");
});

test("trainer course scope: own course imported; another trainer's course refused in preview AND by the server", async () => {
  const parsed = await parseWord(
    "Q1. DOCX: T1 own course?", "Course Code: SPI-101", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q2. DOCX: T1 other course?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE"
  );
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "t1.docx" });
  assert.equal(byRow(preview, 1).status, "CREATE");
  assert.equal(byRow(preview, 2).issues[0].code, "course_not_found");
  assert.equal(outcome.created, 1);
  const svc = serviceFor("T1");
  const run = await svc.startImport({ source: "docx", fileName: "t1-sneaky.docx", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "docx", rows: [parsed.rows[1]] });
  assert.equal(res.rows[0].outcome, "skipped");
  // Even choosing the other course as the import's course is refused.
  const res2 = await svc.importChunk(run.id, { source: "docx", defaultCourseId: ids.C2, rows: [{ ...parsed.rows[1], rowNumber: 9, courseCode: null }] });
  assert.equal(res2.rows[0].outcome, "skipped");
  await svc.discardImport(run.id);
  assert.equal(await count("question_text = 'DOCX: T1 other course?'"), 0);
  // A trainer without a current course can import nothing.
  const t3 = await importLikeTheBrowser("T3", await parseWord("Course Code: SPI-101", "Q1. DOCX: T3 question?", "Type: true_false", "Marks: 1", "Answer: TRUE"), { fileName: "t3.docx" });
  assert.equal(t3.outcome, null);
  assert.equal(byRow(t3.preview, 1).issues[0].code, "course_not_found");
});

test("student and anonymous users: no DOCX import context, no run, nothing written", async () => {
  for (const key of ["ST1", null]) {
    const svc = serviceFor(key);
    await assert.rejects(svc.getContext({ source: "docx", courseCodes: ["SPI-101"], questionIds: [] }), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    const started = await asAction(() => svc.startImport({ source: "docx", fileName: "x.docx", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 }));
    assert.equal(started.ok, false);
    const chunk = await asAction(() => svc.importChunk("00000000-0000-4000-8000-000000000000", { source: "docx", rows: [{ rowNumber: 1, courseCode: "SPI-101", questionText: "DOCX: student?", questionType: "true_false", marks: 1, correctAnswer: "TRUE" }] }));
    assert.equal(chunk.ok, false);
  }
  // Directly against the database: a student cannot start an import run.
  const st = db.client({ role: "authenticated", userId: USERS.ST1.id });
  const direct = await st.rpc("start_question_import", { p_source: "docx", p_file_name: "x.docx", p_file_sha256: SHA, p_planned_creates: 1, p_planned_updates: 0, p_planned_excluded: 0 });
  assert.ok(direct.error, "0013 refuses a student");
  assert.equal(await count("question_text = 'DOCX: student?'"), 0);
});
