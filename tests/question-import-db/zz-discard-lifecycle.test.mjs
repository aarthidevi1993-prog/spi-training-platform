// Integration (0014): discard_question_import only discards an UNFINISHED (in_progress) run.
// A completed or discarded run is refused without any change — so a trainer gets no indirect
// way to delete questions, and a super admin cannot discard a finished import either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHA, db, ids, repoFor, serviceFor, svcCore, USERS } from "./harness.mjs";

const raw = (rowNumber, overrides = {}) => ({
  rowNumber, courseCode: "SPI-101", questionType: "single_choice", questionText: `Discard lifecycle ${rowNumber}?`,
  options: ["Alpha", "Beta", "Gamma"], correctAnswer: "A", marks: "1", ...overrides,
});
const plan = (overrides = {}) => ({ source: "xlsx", fileName: "lifecycle.xlsx", fileSha256: SHA, plannedCreates: 5, plannedUpdates: 0, plannedExcluded: 0, ...overrides });
const count = (whereSql) => db.admin(`select count(*) from public.questions where ${whereSql}`);
const runRow = (id) => db.admin(`select to_json(x) from (select status, created_count, updated_count, discarded_count from public.question_import_runs where id = '${id}') x`);
/** Everything a discard could touch, as one fingerprint: questions, options, runs and items. */
const snapshot = () =>
  db.admin(`select md5(concat_ws('|',
    (select string_agg(id || ':' || status || ':' || revision || ':' || question_text, ',' order by id) from public.questions),
    (select string_agg(question_id || ':' || display_order || ':' || option_text || ':' || is_correct, ',' order by question_id, display_order) from public.question_options),
    (select string_agg(id || ':' || status || ':' || created_count || ':' || discarded_count, ',' order by id) from public.question_import_runs),
    (select count(*)::text from public.question_import_items)))`);
const refusedNotInProgress = (e) => e instanceof svcCore.QuestionImportRepositoryError && e.code === "23514" && /Only an unfinished import can be discarded/.test(e.message);
const notFound = (e) => e.code === "42501" && /Import not found/.test(e.message);

/** A finished (completed) run by `key` that created `n` questions. */
async function completedRun(key, n, tag) {
  const svc = serviceFor(key);
  const run = await svc.startImport(plan({ plannedCreates: n }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: Array.from({ length: n }, (_, i) => raw(i + 2, { questionText: `${tag} ${i + 1}?` })) });
  assert.equal(res.created, n);
  await svc.finishImport(run.id);
  return run.id;
}

test("A. a trainer cannot discard another user's run (in progress or completed) — nothing changes", async () => {
  const t1Run = await serviceFor("T1").startImport(plan());
  await serviceFor("T1").importChunk(t1Run.id, { source: "xlsx", rows: [raw(2, { questionText: "Lifecycle A keep?" })] });
  const before = await snapshot();
  await assert.rejects(serviceFor("T2").discardImport(t1Run.id), notFound, "service path");
  await assert.rejects(repoFor(USERS.T2).discardImport(t1Run.id), notFound, "database function directly");
  assert.equal(await snapshot(), before);
  assert.equal((await runRow(t1Run.id)).status, "in_progress");
  assert.equal(await count(`question_text = 'Lifecycle A keep?'`), 1);
  await serviceFor("T1").discardImport(t1Run.id); // tidy up: T1 may have only one unfinished import
});

test("B. a trainer cannot discard their own COMPLETED run — no questions, options, items or run changed", async () => {
  const runId = await completedRun("T1", 2, "Lifecycle B completed");
  const before = await snapshot();
  await assert.rejects(serviceFor("T1").discardImport(runId), refusedNotInProgress, "service path");
  await assert.rejects(repoFor(USERS.T1).discardImport(runId), refusedNotInProgress, "database function directly");
  assert.equal(await snapshot(), before, "a refused discard makes no change at all");
  assert.deepEqual(await runRow(runId), { status: "completed", created_count: 2, updated_count: 0, discarded_count: 0 });
  assert.equal(await count(`question_text like 'Lifecycle B completed %'`), 2, "the imported drafts are still there");
});

test("C + E. an own IN-PROGRESS run can still be discarded: unchanged new drafts deleted, edited kept, updates never reverted", async () => {
  const svc = serviceFor("T1");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: [], questionIds: [ids.qx1] });
  const target = ctx.updateTargets[0];
  const beforeUpdate = await db.admin(`select to_json(x) from (select question_text, revision from public.questions where id = '${ids.qx1}') x`);
  const run = await svc.startImport(plan({ plannedCreates: 3, plannedUpdates: 1 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [
    raw(2, { questionText: "Lifecycle E drop one?" }), raw(3, { questionText: "Lifecycle E drop two?" }), raw(4, { questionText: "Lifecycle E keep edited?" }),
    raw(5, { questionId: ids.qx1, expectedRevision: target.revision, questionType: "multiple_choice", questionText: "Fieldbus protocols (lifecycle update)?", options: ["HART", "Profibus", "Bluetooth"], correctAnswer: "A,B", marks: "3" }),
  ] });
  assert.equal(res.created, 3);
  assert.equal(res.updated, 1);
  const kept = res.rows.find((r) => r.rowNumber === 4).questionId;
  await db.exec(`select public.save_question(jsonb_build_object('id', '${kept}', 'course_id', '${ids.C1}', 'question_text', 'Lifecycle E edited by hand?', 'question_type', 'single_choice', 'marks', 1,
    'options', '[{"option_text":"Alpha","is_correct":true},{"option_text":"Beta","is_correct":false}]'::jsonb))`, ids.T1);
  const itemsBefore = await db.admin(`select count(*) from public.question_import_items where run_id = '${run.id}'`);
  const unrelatedBefore = await db.admin(`select md5(string_agg(id || ':' || revision || ':' || question_text, ',' order by id)) from public.questions where question_text not like 'Lifecycle E %' and id <> '${ids.qx1}' and id <> '${kept}'`);

  const out = await svc.discardImport(run.id);
  assert.equal(out.deleted, 2);
  assert.equal(out.kept, 1);
  assert.equal(out.run.status, "discarded");
  assert.deepEqual(await runRow(run.id), { status: "discarded", created_count: 3, updated_count: 1, discarded_count: 2 });
  assert.equal(await count(`question_text like 'Lifecycle E drop %'`), 0, "unchanged new drafts deleted");
  assert.equal(await db.admin(`select count(*) from public.question_options o where not exists (select 1 from public.questions q where q.id = o.question_id)`), 0, "no orphaned options");
  assert.equal(await count(`id = '${kept}'`), 1, "the edited draft is kept");
  const afterUpdate = await db.admin(`select to_json(x) from (select question_text, revision from public.questions where id = '${ids.qx1}') x`);
  assert.equal(afterUpdate.question_text, "Fieldbus protocols (lifecycle update)?", "the update is not reverted");
  assert.equal(afterUpdate.revision, beforeUpdate.revision + 1);
  assert.equal(await db.admin(`select count(*) from public.question_import_items where run_id = '${run.id}'`), itemsBefore, "import items are history — kept");
  assert.equal(await db.admin(`select md5(string_agg(id || ':' || revision || ':' || question_text, ',' order by id)) from public.questions where question_text not like 'Lifecycle E %' and id <> '${ids.qx1}' and id <> '${kept}'`), unrelatedBefore, "F: no unrelated question touched");
});

test("D. a super admin cannot discard a COMPLETED run — theirs or a trainer's — and a DISCARDED run is not re-processed", async () => {
  const adminRun = await completedRun("A", 1, "Lifecycle D admin");
  const trainerRun = await completedRun("T1", 1, "Lifecycle D trainer");
  const before = await snapshot();
  await assert.rejects(serviceFor("A").discardImport(adminRun), refusedNotInProgress, "own completed run");
  await assert.rejects(serviceFor("A2").discardImport(trainerRun), refusedNotInProgress, "another user's completed run");
  await assert.rejects(repoFor(USERS.A).discardImport(trainerRun), refusedNotInProgress, "database function directly");
  assert.equal(await snapshot(), before);
  assert.equal(await count(`question_text like 'Lifecycle D %'`), 2);

  // A discarded run: a second discard is refused and changes nothing.
  const run = await serviceFor("T1").startImport(plan({ plannedCreates: 1 }));
  await serviceFor("T1").importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionText: "Lifecycle D twice?" })] });
  await serviceFor("T1").discardImport(run.id);
  const afterFirst = await snapshot();
  await assert.rejects(serviceFor("T1").discardImport(run.id), refusedNotInProgress, "discarded run, same user");
  await assert.rejects(serviceFor("A").discardImport(run.id), refusedNotInProgress, "discarded run, super admin");
  assert.equal(await snapshot(), afterFirst);
});

test("D2. a super admin keeps the 0013 management right to discard ANOTHER user's UNFINISHED run", async () => {
  const run = await serviceFor("T2").startImport(plan({ plannedCreates: 1 }));
  const out = await serviceFor("A").discardImport(run.id);
  assert.equal(out.run.status, "discarded");
});

test("F. unknown run ids and non-importers are refused before anything happens", async () => {
  const before = await snapshot();
  await assert.rejects(serviceFor("T1").discardImport("00000000-0000-4000-8000-00000000abcd"), notFound);
  await assert.rejects(serviceFor("ST1").discardImport("00000000-0000-4000-8000-00000000abcd"), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
  assert.equal(await snapshot(), before);
  assert.equal(await db.admin(`select count(*) from public.question_import_runs where status = 'in_progress'`), 0, "no unfinished runs left behind by these tests");
});
