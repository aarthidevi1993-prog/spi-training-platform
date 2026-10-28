// Integration (Phase G): PDF import through the real Phase D service and real 0013 + RLS —
// admin / trainer / student / anonymous. Uses only questions it creates ("PDF:" texts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHA, USERS, asAction, bytesToArrayBuffer, count, db, ids, importLikeTheBrowser, question, serviceFor, svcCore } from "./harness.mjs";
import { makePdf, pdfOf } from "../question-import/pdf-writer.mjs";

const pdf = await import(`${process.env.QI_BUILD}/lib/question-import/pdf.mjs`);
const byRow = (preview, n) => preview.results.find((r) => r.rowNumber === n);
const parsePdfLines = (lines, options) => pdf.parsePdf(bytesToArrayBuffer(pdfOf(lines, options)));

const THREE = [
  "Course Code: SPI-101",
  "Q1. PDF: which instrument measures flow?", "Type: single_choice", "Marks: 2", "A) Flow transmitter", "B) Pressure gauge", "C) Level switch", "Answer: A", "Explanation: A flow transmitter measures flow.",
  "Q2. PDF: which are temperature sensors?", "Type: multiple_choice", "Marks: 3", "A) RTD", "B) Orifice", "C) Thermocouple", "Answer: A, C",
  "Q3. PDF: a control valve is a final control element.", "Type: true_false", "Marks: 1", "Answer: TRUE",
];
const answersOf = (id) => db.admin(`select json_agg(json_build_array(option_text, is_correct) order by display_order) from public.question_options where question_id = '${id}'`);

test("admin PDF import: single, multiple and true/false created as DRAFTS with the right answers (run source = pdf)", async () => {
  const parsed = await parsePdfLines(THREE, { compress: true });
  assert.deepEqual(parsed.fileErrors, []);
  const { preview, run, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "questions.pdf" });
  assert.deepEqual(preview.summary, { total: 3, create: 3, update: 0, duplicate: 0, error: 0, needsReview: 0 });
  assert.equal(outcome.created, 3);
  assert.equal(run.source, "pdf");
  assert.equal(run.status, "completed");
  const id = (n) => outcome.rows.find((o) => o.rowNumber === n).questionId;
  for (const n of [1, 2, 3]) assert.equal((await question(id(n))).status, "draft");
  assert.deepEqual(await answersOf(id(1)), [["Flow transmitter", true], ["Pressure gauge", false], ["Level switch", false]]);
  assert.deepEqual(await answersOf(id(2)), [["RTD", true], ["Orifice", false], ["Thermocouple", true]]);
  assert.deepEqual(await answersOf(id(3)), [["True", true], ["False", false]]);
});

test("duplicate PDF: re-import creates nothing (preview AND server refuse)", async () => {
  const before = await count("question_text like 'PDF:%'");
  const parsed = await parsePdfLines(THREE);
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "again.pdf" });
  assert.deepEqual(preview.results.map((r) => r.status), ["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
  assert.equal(outcome, null);
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "pdf", fileName: "sneaky.pdf", fileSha256: SHA, plannedCreates: 3, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "pdf", rows: parsed.rows });
  assert.ok(res.rows.every((r) => r.outcome === "skipped" && r.status === "DUPLICATE"));
  await svc.discardImport(run.id);
  assert.equal(await count("question_text like 'PDF:%'"), before);
});

test("invalid / ambiguous / NEEDS REVIEW rows are never written, even when sent to the server directly", async () => {
  const parsed = await parsePdfLines([
    "Course Code: SPI-101",
    "Q1. PDF: invalid answer?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No", "Answer: Yes",
    "Q2. PDF: two answers for single choice?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No", "Answer: A, B",
    "Q3. PDF: missing answer?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No",
  ]);
  const { preview, outcome } = await importLikeTheBrowser("A", parsed, { fileName: "bad.pdf" });
  assert.deepEqual(preview.results.map((r) => r.status), ["ERROR", "ERROR", "NEEDS_REVIEW"]);
  assert.equal(outcome, null);
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "pdf", fileName: "bad-direct.pdf", fileSha256: SHA, plannedCreates: 3, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "pdf", rows: parsed.rows });
  assert.deepEqual(res.rows.map((r) => [r.outcome, r.status]), [["skipped", "ERROR"], ["skipped", "ERROR"], ["skipped", "NEEDS_REVIEW"]]);
  await svc.discardImport(run.id);
  assert.equal(await count("question_text like 'PDF: %?' and question_text in ('PDF: invalid answer?', 'PDF: two answers for single choice?', 'PDF: missing answer?')"), 0);
});

test("PDF course/module mapping: document module code applied; UI-chosen course for a PDF without codes", async () => {
  const withModule = await parsePdfLines(["Course Code: SPI-101", "Module Code: M1", "Q1. PDF: module mapped?", "Type: true_false", "Marks: 1", "Answer: FALSE"]);
  const a = await importLikeTheBrowser("A", withModule, { fileName: "module.pdf" });
  const id = a.outcome.rows[0].questionId;
  assert.equal(await db.admin(`select m.module_code from public.questions q join public.modules m on m.id = q.module_id where q.id = '${id}'`), "M1");
  const noCodes = await parsePdfLines(["Q1. PDF: chosen course?", "Type: true_false", "Marks: 1", "Answer: TRUE"]);
  const b = await importLikeTheBrowser("A", noCodes, { fileName: "no-codes.pdf", defaultCourseId: ids.C2 });
  assert.equal((await question(b.outcome.rows[0].questionId)).course_id, ids.C2);
});

test("draft update from a PDF: UPDATE (revision +1, still draft); stale revision refused; ACTIVE protected", async () => {
  const created = await importLikeTheBrowser("T1", await parsePdfLines(["Course Code: SPI-101", "Q1. PDF: draft to update?", "Type: true_false", "Marks: 1", "Answer: TRUE"]), { fileName: "t1-create.pdf" });
  const id = created.outcome.rows[0].questionId;
  const before = await question(id);
  const edit = (text, rev) => parsePdfLines([`Q1. ${text}`, `Question ID: ${id}`, `Revision: ${rev}`, "Type: true_false", "Marks: 1", "Answer: FALSE"]);
  const { preview, outcome } = await importLikeTheBrowser("T1", await edit("PDF: draft updated from a PDF.", before.revision), { fileName: "t1-update.pdf" });
  assert.equal(byRow(preview, 1).status, "UPDATE");
  assert.equal(outcome.updated, 1);
  const after = await question(id);
  assert.equal(after.question_text, "PDF: draft updated from a PDF.");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.status, "draft");
  const stale = await importLikeTheBrowser("T1", await edit("PDF: stale overwrite?", before.revision), { fileName: "t1-stale.pdf" });
  assert.equal(byRow(stale.preview, 1).issues[0].code, "revision_conflict");
  assert.equal((await question(id)).question_text, "PDF: draft updated from a PDF.");
  const activeRev = (await question(ids.qa1)).revision;
  const active = await importLikeTheBrowser("A", await parsePdlinesActive(activeRev), { fileName: "active.pdf" });
  assert.equal(byRow(active.preview, 1).issues[0].code, "question_protected");
  assert.equal(active.outcome, null);
  assert.equal((await question(ids.qa1)).question_text, "What does FT stand for?");
});
const parsePdlinesActive = (rev) => parsePdfLines(["Q1. PDF: overwrite active?", `Question ID: ${ids.qa1}`, `Revision: ${rev}`, "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A"]);

test("trainer scope: own course imported; another course refused in preview AND by the server; no-course trainer imports nothing", async () => {
  const parsed = await parsePdfLines([
    "Q1. PDF: T1 own course?", "Course Code: SPI-101", "Type: true_false", "Marks: 1", "Answer: TRUE",
    "Q2. PDF: T1 other course?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE",
  ]);
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "t1.pdf" });
  assert.equal(byRow(preview, 1).status, "CREATE");
  assert.equal(byRow(preview, 2).issues[0].code, "course_not_found");
  assert.equal(outcome.created, 1);
  const svc = serviceFor("T1");
  const run = await svc.startImport({ source: "pdf", fileName: "t1-sneaky.pdf", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 });
  assert.equal((await svc.importChunk(run.id, { source: "pdf", rows: [parsed.rows[1]] })).rows[0].outcome, "skipped");
  assert.equal((await svc.importChunk(run.id, { source: "pdf", defaultCourseId: ids.C2, rows: [{ ...parsed.rows[1], rowNumber: 9, courseCode: null }] })).rows[0].outcome, "skipped");
  await svc.discardImport(run.id);
  assert.equal(await count("question_text = 'PDF: T1 other course?'"), 0);
  const t3 = await importLikeTheBrowser("T3", await parsePdfLines(["Course Code: SPI-101", "Q1. PDF: T3?", "Type: true_false", "Marks: 1", "Answer: TRUE"]), { fileName: "t3.pdf" });
  assert.equal(t3.outcome, null);
});

test("student and anonymous: no PDF import context, no run, nothing written; encrypted/scanned PDFs never reach the server", async () => {
  for (const key of ["ST1", null]) {
    const svc = serviceFor(key);
    await assert.rejects(svc.getContext({ source: "pdf", courseCodes: ["SPI-101"], questionIds: [] }), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    assert.equal((await asAction(() => svc.startImport({ source: "pdf", fileName: "x.pdf", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 }))).ok, false);
  }
  const st = db.client({ role: "authenticated", userId: USERS.ST1.id });
  const direct = await st.rpc("start_question_import", { p_source: "pdf", p_file_name: "x.pdf", p_file_sha256: SHA, p_planned_creates: 1, p_planned_updates: 0, p_planned_excluded: 0 });
  assert.ok(direct.error, "0013 refuses a student");
  const locked = await parsePdfLines(THREE, { encrypt: { user: "pw", owner: "o" } });
  const scanned = await pdf.parsePdf(bytesToArrayBuffer(makePdf([{ image: true }])));
  assert.equal(locked.rows.length + scanned.rows.length, 0, "nothing to send");
});
