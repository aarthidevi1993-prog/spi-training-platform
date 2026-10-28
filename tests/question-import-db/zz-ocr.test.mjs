// Integration (Phase H): scanned-PDF OCR rows (deterministic scripted OCR) through the real
// Phase D service and real 0013 + RLS. Uses only questions it creates ("OCR:" texts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHA, USERS, asAction, bytesToArrayBuffer, count, db, ids, importLikeTheBrowser, question, serviceFor, svcCore } from "./harness.mjs";
import { makePdf } from "../question-import/pdf-writer.mjs";
import { scriptedOcr } from "../question-import/ocr-fake.mjs";

const pdf = await import(`${process.env.QI_BUILD}/lib/question-import/pdf.mjs`);
const byRow = (preview, n) => preview.results.find((r) => r.rowNumber === n);
const scanned = (pages) => bytesToArrayBuffer(makePdf(Array.from({ length: pages }, () => ({ image: true }))));
const ocrParse = (pagesByNumber, pageCount = 1) => pdf.parsePdf(scanned(pageCount), { ocr: scriptedOcr(pagesByNumber).options });
const confirmAll = (parsed) => ({ ...parsed, rows: parsed.rows.map((r) => ({ ...r, reviewConfirmed: true })) });

const TWO = [
  "Course Code: SPI-101",
  "Module Code: M1",
  "Q1. OCR: which instrument measures flow?", "Type: single_choice", "Marks: 2", "A) Flow transmitter", "B) Pressure gauge", "Answer: A", "Explanation: It measures flow.",
  "Q2. OCR: a control valve is a final control element.", "Type: true_false", "Marks: 1", "Answer: TRUE",
];

test("scanned PDF: unconfirmed OCR rows are never written (preview AND server); confirmed rows become DRAFTS (run source pdf_ocr)", async () => {
  const parsed = await ocrParse({ 1: TWO });
  assert.equal(parsed.source, "pdf_ocr");
  const unconfirmed = await importLikeTheBrowser("A", parsed, { fileName: "scan.pdf" });
  assert.deepEqual(unconfirmed.preview.results.map((r) => r.status), ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
  assert.equal(unconfirmed.outcome, null);
  // Straight to the server without the reviewer's confirmation: skipped.
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "pdf_ocr", fileName: "scan-direct.pdf", fileSha256: SHA, plannedCreates: 2, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "pdf_ocr", rows: parsed.rows });
  assert.deepEqual(res.rows.map((r) => [r.outcome, r.status]), [["skipped", "NEEDS_REVIEW"], ["skipped", "NEEDS_REVIEW"]]);
  await svc.discardImport(run.id);
  assert.equal(await count("question_text like 'OCR:%'"), 0);

  const { preview, run: done, outcome } = await importLikeTheBrowser("A", confirmAll(parsed), { fileName: "scan.pdf" });
  assert.deepEqual(preview.summary, { total: 2, create: 2, update: 0, duplicate: 0, error: 0, needsReview: 0 });
  assert.equal(outcome.created, 2);
  assert.equal(done.source, "pdf_ocr");
  for (const o of outcome.rows) {
    const q = await question(o.questionId);
    assert.equal(q.status, "draft");
    assert.equal(q.course_id, ids.C1);
  }
  const id1 = outcome.rows.find((o) => o.rowNumber === 1).questionId;
  assert.deepEqual(await db.admin(`select json_agg(json_build_array(option_text, is_correct) order by display_order) from public.question_options where question_id = '${id1}'`), [["Flow transmitter", true], ["Pressure gauge", false]]);
  assert.equal(await db.admin(`select m.module_code from public.questions q join public.modules m on m.id = q.module_id where q.id = '${id1}'`), "M1");
});

test("duplicate scanned PDF: re-import is DUPLICATE (preview AND server); low-confidence key lines are refused by the server even when 'confirmed'", async () => {
  const again = confirmAll(await ocrParse({ 1: TWO }));
  const { preview, outcome } = await importLikeTheBrowser("A", again, { fileName: "scan-again.pdf" });
  assert.deepEqual(preview.results.map((r) => r.status), ["DUPLICATE", "DUPLICATE"]);
  assert.equal(outcome, null);

  const low = confirmAll(await pdf.parsePdf(scanned(1), {
    ocr: scriptedOcr({ 1: ["Course Code: SPI-101", "Q1. OCR: blurry answer?", "Type: single_choice", "Marks: 1", "A) Yes", "B) No", { words: [["Answer:", 95], ["B", 40]] }] }).options,
  }));
  const svc = serviceFor("A");
  const run = await svc.startImport({ source: "pdf_ocr", fileName: "blurry.pdf", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 });
  const res = await svc.importChunk(run.id, { source: "pdf_ocr", rows: low.rows });
  assert.deepEqual([res.rows[0].outcome, res.rows[0].status], ["skipped", "NEEDS_REVIEW"]);
  await svc.discardImport(run.id);
  assert.equal(await count("question_text = 'OCR: blurry answer?'"), 0);
});

test("OCR draft update: confirmed row with Question ID + Revision updates the draft (still draft); ACTIVE protected", async () => {
  const created = await importLikeTheBrowser("T1", confirmAll(await ocrParse({ 1: ["Course Code: SPI-101", "Q1. OCR: draft to update?", "Type: true_false", "Marks: 1", "Answer: TRUE"] })), { fileName: "t1-scan.pdf" });
  const id = created.outcome.rows[0].questionId;
  const before = await question(id);
  const edit = confirmAll(await ocrParse({ 1: ["Q1. OCR: draft updated from a scan.", `Question ID: ${id}`, `Revision: ${before.revision}`, "Type: true_false", "Marks: 1", "Answer: FALSE"] }));
  const { outcome } = await importLikeTheBrowser("T1", edit, { fileName: "t1-scan-update.pdf" });
  assert.equal(outcome.updated, 1);
  const after = await question(id);
  assert.equal(after.question_text, "OCR: draft updated from a scan.");
  assert.equal(after.status, "draft");
  assert.equal(after.revision, before.revision + 1);
  const activeRev = (await question(ids.qa1)).revision;
  const active = confirmAll(await ocrParse({ 1: ["Q1. OCR: overwrite active?", `Question ID: ${ids.qa1}`, `Revision: ${activeRev}`, "Type: single_choice", "Marks: 1", "A) a", "B) b", "Answer: A"] }));
  const blocked = await importLikeTheBrowser("A", active, { fileName: "active-scan.pdf" });
  assert.equal(byRow(blocked.preview, 1).issues[0].code, "question_protected");
  assert.equal((await question(ids.qa1)).question_text, "What does FT stand for?");
});

test("trainer scope with OCR: own course only — another course refused in preview AND by the server", async () => {
  const parsed = confirmAll(await ocrParse({
    1: ["Q1. OCR: T1 own?", "Course Code: SPI-101", "Type: true_false", "Marks: 1", "Answer: TRUE", "Q2. OCR: T1 other?", "Course Code: SPI-201", "Type: true_false", "Marks: 1", "Answer: TRUE"],
  }));
  const { preview, outcome } = await importLikeTheBrowser("T1", parsed, { fileName: "t1-scope.pdf" });
  assert.equal(byRow(preview, 1).status, "CREATE");
  assert.equal(byRow(preview, 2).issues[0].code, "course_not_found");
  assert.equal(outcome.created, 1);
  const svc = serviceFor("T1");
  const run = await svc.startImport({ source: "pdf_ocr", fileName: "t1-sneaky-scan.pdf", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 });
  assert.equal((await svc.importChunk(run.id, { source: "pdf_ocr", rows: [parsed.rows[1]] })).rows[0].outcome, "skipped");
  await svc.discardImport(run.id);
  assert.equal(await count("question_text = 'OCR: T1 other?'"), 0);
});

test("student and anonymous: no OCR import context or run; the database refuses a student too", async () => {
  for (const key of ["ST1", null]) {
    const svc = serviceFor(key);
    await assert.rejects(svc.getContext({ source: "pdf_ocr", courseCodes: ["SPI-101"], questionIds: [] }), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
    assert.equal((await asAction(() => svc.startImport({ source: "pdf_ocr", fileName: "x.pdf", fileSha256: SHA, plannedCreates: 1, plannedUpdates: 0, plannedExcluded: 0 }))).ok, false);
  }
  const st = db.client({ role: "authenticated", userId: USERS.ST1.id });
  const direct = await st.rpc("start_question_import", { p_source: "pdf_ocr", p_file_name: "x.pdf", p_file_sha256: SHA, p_planned_creates: 1, p_planned_updates: 0, p_planned_excluded: 0 });
  assert.ok(direct.error);
});
