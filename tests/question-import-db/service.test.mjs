// Integration: the real question-import repository + service against 0013
// on a throwaway PostgreSQL (see run.mjs). Users/courses come from fixtures/seed.sql:
//   A, A2 super admins · T1 trainer of C1 (SPI-101, ongoing) · T2 trainer of C2 (SPI-201)
//   T3 trainer without batches · ST1 student · qa1 active, qar archived, qd1/qd2/qx1 drafts (C1), qc2 draft (C2)
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDatabase } from "./pg-client.mjs";

const build = process.env.QI_BUILD;
if (!build) throw new Error("Run through tests/question-import-db/run.mjs");
const repoCore = await import(`${build}/repositories/question-import.repository.core.mjs`);
const svcCore = await import(`${build}/services/question-import.service.core.mjs`);
const core = await import(`${build}/lib/question-import/index.mjs`);

const db = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: process.env.QI_DB });
const ids = await db.admin("select json_object_agg(k, v) from t.ids");
const SHA = "ab".repeat(32);

const user = (key, role) => ({ id: ids[key], email: `${key}@test`, fullName: key, role, isActive: true, createdAt: "2026-01-01" });
const USERS = { A: user("A", "admin"), A2: user("A2", "admin"), T1: user("T1", "trainer"), T2: user("T2", "trainer"), T3: user("T3", "trainer"), ST1: user("ST1", "student") };

const clientFor = (u) => db.client(u ? { role: "authenticated", userId: u.id } : { role: "anon" });
const repoFor = (u) => repoCore.createQuestionImportRepository(async () => clientFor(u));

/** Same scope rule as questionsRepository.listManageableCourses, read under the user's RLS. */
async function manageableCourses(u) {
  const where = u.role === "admin" ? "true" : `c.id in (select b.course_id from public.batches b where b.trainer_id = '${u.id}' and b.status in ('upcoming', 'ongoing'))`;
  const { data, error } = await clientFor(u).sql(`select coalesce(json_agg(json_build_object('id', c.id, 'code', c.course_code, 'modules',
      coalesce((select json_agg(json_build_object('id', m.id, 'code', m.module_code) order by m.sequence) from public.modules m where m.course_id = c.id), '[]'::json))
      order by c.course_code), '[]'::json) from public.courses c where ${where}`);
  if (error) throw new Error(error.message);
  return data;
}
function serviceFor(key) {
  const u = key ? USERS[key] : null;
  return svcCore.createQuestionImportService({
    repository: repoFor(u),
    getCurrentUser: async () => u,
    listManageableCourses: manageableCourses,
    isDemoMode: () => false,
  });
}
/** Mirrors question-import.actions.ts: {ok,data} | {ok:false,error,retryable}. */
async function asAction(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof svcCore.QuestionImportRepositoryError) return { ok: false, error: e.message, retryable: e.retryable };
    if (e instanceof svcCore.QuestionImportValidationError || e instanceof svcCore.QuestionImportAuthorizationError) return { ok: false, error: e.message, retryable: false };
    throw e;
  }
}
const raw = (rowNumber, overrides = {}) => ({
  rowNumber, courseCode: "SPI-101", questionType: "single_choice", questionText: `Question ${rowNumber}?`,
  options: ["Alpha", "Beta", "Gamma"], correctAnswer: "A", marks: "1", ...overrides,
});
const plan = (overrides = {}) => ({ source: "xlsx", fileName: "bank.xlsx", fileSha256: SHA, plannedCreates: 10, plannedUpdates: 0, plannedExcluded: 0, ...overrides });
const count = (whereSql) => db.admin(`select count(*) from public.questions where ${whereSql}`);
const q = (id) => db.admin(`select to_json(x) from (select status, revision, question_text, created_by, course_id from public.questions where id = '${id}') x`);
const outcomeOf = (res, n) => res.rows.find((r) => r.rowNumber === n);
const chunkItem = (row_number, courseId, text, extra = {}) => ({
  row_number, course_id: courseId, module_id: null, question_type: "single_choice", question_text: text, marks: 1, explanation: null,
  options: [{ option_text: "Yes", is_correct: true }, { option_text: "No", is_correct: false }], allow_duplicate: false, ...extra,
});

// ===========================================================================
// Admin import, drafts only, progress, finish (and repeated finish)
// ===========================================================================
test("admin: start → chunk → finish; every question a DRAFT stamped with the admin; counts; repeated finish safe", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 3 }));
  assert.equal(run.status, "in_progress");
  assert.equal(run.plannedCreates, 3);
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { status: "Active", questionText: "Admin Q one?" }), raw(3, { questionText: "Admin Q two?", moduleCode: "m1" }), raw(4, { questionText: "Admin Q three?", questionType: "true/false", options: [], correctAnswer: "FALSE" })] });
  assert.equal(res.created, 3);
  assert.deepEqual(res.rows.map((r) => r.outcome), ["created", "created", "created"]);
  assert.equal(res.run.createdCount, 3);
  for (const r of res.rows) {
    const row = await q(r.questionId);
    assert.equal(row.status, "draft", "file said Active: still a draft");
    assert.equal(row.created_by, ids.A);
  }
  const fin = await svc.finishImport(run.id);
  assert.equal(fin.status, "completed");
  const again = await svc.finishImport(run.id);
  assert.equal(again.status, "completed");
  assert.equal(again.createdCount, 3, "repeated finish keeps the counts");
  assert.equal(await svc.getActiveRun(), null);
});

// ===========================================================================
// Trainer scope
// ===========================================================================
test("trainer: imports into own current course; other course rows are skipped (scope), never written", async () => {
  const svc = serviceFor("T1");
  const ctx = await svc.getContext({ source: "csv", courseCodes: ["SPI-101", "SPI-201"], questionIds: [] });
  assert.deepEqual(ctx.courses.map((c) => c.code), ["SPI-101"], "trainer scope = current courses only");
  assert.ok(ctx.existing.length > 0 && ctx.existing.every((e) => e.courseId === ids.C1), "fingerprints only for in-scope courses");
  const run = await svc.startImport(plan({ source: "csv", plannedCreates: 2 }));
  const res = await svc.importChunk(run.id, { source: "csv", rows: [raw(2, { questionText: "Trainer scoped Q?" }), raw(3, { courseCode: "SPI-201", questionText: "Not my course Q?" })] });
  assert.equal(outcomeOf(res, 2).outcome, "created");
  assert.equal(outcomeOf(res, 3).outcome, "skipped");
  assert.equal(outcomeOf(res, 3).status, "ERROR");
  assert.equal(outcomeOf(res, 3).issues[0].code, "course_not_found");
  assert.equal(await count("question_text = 'Not my course Q?'"), 0);
  assert.equal((await q(outcomeOf(res, 2).questionId)).created_by, ids.T1);
  await svc.finishImport(run.id);
});

test("out-of-scope trainer: no courses in scope; the database also refuses a direct write (0013 is the authority)", async () => {
  const svc = serviceFor("T3");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: ["SPI-101"], questionIds: [] });
  assert.deepEqual(ctx.courses, []);
  const run = await svc.startImport(plan({ plannedCreates: 1 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionText: "T3 sneaky Q?" })] });
  assert.equal(outcomeOf(res, 2).outcome, "skipped");
  // Bypass the service: the repository call goes straight to 0013, which refuses it.
  const direct = await repoFor(USERS.T3).importChunk(run.id, [chunkItem(9, ids.C1, "T3 direct Q?")]);
  assert.equal(direct.results[0].outcome, "rejected");
  assert.equal(direct.results[0].reason, "no_permission");
  assert.equal(await count("question_text like 'T3 %'"), 0);
  await svc.discardImport(run.id);
});

test("lost trainer scope mid-import: later chunks are refused (service skips, database rejects)", async () => {
  await db.exec(`insert into public.batches (batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
                 values ('BX', '${ids.C3}', '${ids.T3}', 'BX', '2027-01-01', '2027-06-30', 'upcoming', 10)`, ids.A);
  const svc = serviceFor("T3");
  const run = await svc.startImport(plan({ plannedCreates: 3 }));
  const first = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { courseCode: "SPI-301", questionText: "Scope Q one?" })] });
  assert.equal(outcomeOf(first, 2).outcome, "created");
  await db.exec(`update public.batches set status = 'cancelled' where batch_code = 'BX'`, ids.A);
  const second = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(3, { courseCode: "SPI-301", questionText: "Scope Q two?" })] });
  assert.equal(outcomeOf(second, 3).outcome, "skipped");
  const direct = await repoFor(USERS.T3).importChunk(run.id, [chunkItem(4, ids.C3, "Scope Q three?")]);
  assert.equal(direct.results[0].reason, "no_permission");
  assert.equal(await count("question_text like 'Scope Q %'"), 1);
  await svc.finishImport(run.id);
});

// ===========================================================================
// Students and anonymous users
// ===========================================================================
test("student: every service action refused; the database refuses the functions and hides the answer key", async () => {
  const svc = serviceFor("ST1");
  for (const call of [() => svc.getContext({ source: "xlsx", courseCodes: ["SPI-101"], questionIds: [] }), () => svc.startImport(plan()), () => svc.getActiveRun(), () => svc.importChunk(ids.A, { source: "xlsx", rows: [raw(2)] })]) {
    await assert.rejects(call(), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
  }
  const repo = repoFor(USERS.ST1);
  await assert.rejects(repo.startImport(plan()), (e) => e.code === "42501");
  await assert.rejects(repo.listFingerprints([ids.C1]), (e) => e.code === "42501");
  const c = clientFor(USERS.ST1);
  assert.deepEqual((await c.from("questions").select("id").limit(5)).data, []);
  assert.deepEqual((await c.from("question_options").select("is_correct").limit(5)).data, [], "no answer key");
  assert.deepEqual((await c.from("question_import_runs").select("id")).data, []);
});

test("anonymous: service refused (sign in); database refuses every function and table", async () => {
  const svc = serviceFor(null);
  await assert.rejects(svc.startImport(plan()), (e) => e instanceof svcCore.QuestionImportAuthorizationError && /signed in/.test(e.message));
  const repo = repoFor(null);
  await assert.rejects(repo.startImport(plan()), (e) => e.code === "42501");
  await assert.rejects(repo.importChunk(ids.A, [chunkItem(2, ids.C1, "x")]), (e) => e.code === "42501");
  await assert.rejects(repo.listUpdateTargets([ids.qd1]), (e) => e.code === "42501");
});

// ===========================================================================
// Chunk size, multiple chunks, resume, retry policy
// ===========================================================================
test("chunk size: more than 100 rows refused by the service and by 0013", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 200 }));
  const rows = Array.from({ length: 101 }, (_, i) => raw(i + 2, { questionText: `Size Q ${i}?` }));
  await assert.rejects(svc.importChunk(run.id, { source: "xlsx", rows }), (e) => e instanceof svcCore.QuestionImportValidationError);
  const items = rows.map((r, i) => chunkItem(r.rowNumber, ids.C1, `Size Q ${i}?`));
  await assert.rejects(repoFor(USERS.A).importChunk(run.id, items), (e) => e.code === "22023" && e.retryable === false);
  await svc.discardImport(run.id);
});

test("multiple chunks (250 rows → 100/100/50) with progress; counts match", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 250 }));
  const rows = Array.from({ length: 250 }, (_, i) => raw(i + 2, { questionText: `Multi Q ${i}?` }));
  const progress = [];
  const result = await core.runChunks({
    chunks: core.planChunks(rows),
    send: (chunk) => asAction(() => svc.importChunk(run.id, { source: "xlsx", rows: chunk })),
    onProgress: (p) => progress.push(p.outcome.run.createdCount),
    delay: async () => {},
  });
  assert.equal(result.stopped, null);
  assert.equal(result.chunksSent, 3);
  assert.deepEqual(progress, [100, 200, 250], "progress after each chunk");
  assert.equal(await count("question_text like 'Multi Q %'"), 250);
  const fin = await svc.finishImport(run.id);
  assert.equal(fin.createdCount, 250);
});

test("resume after an interruption: done rows are never written twice; a retried chunk reports already_done", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 150 }));
  const rows = Array.from({ length: 150 }, (_, i) => raw(i + 2, { questionText: `Resume Q ${i}?` }));
  const chunks = core.planChunks(rows);
  // First session: only the first chunk gets through, then the browser closes.
  await svc.importChunk(run.id, { source: "xlsx", rows: chunks[0] });
  assert.equal((await svc.getActiveRun()).id, run.id, "the in-progress run can be found again");
  const state = await svc.getResumeState(run.id);
  assert.equal(state.doneRowNumbers.length, 100);
  // A blind retry of chunk 1: nothing written, all already_done.
  const retry = await svc.importChunk(run.id, { source: "xlsx", rows: chunks[0] });
  assert.equal(retry.created, 0);
  assert.ok(retry.rows.every((r) => r.outcome === "already_done"));
  // Resume with the saved state.
  const resumed = await core.runChunks({ chunks, doneRowNumbers: state.doneRowNumbers, send: (c) => asAction(() => svc.importChunk(run.id, { source: "xlsx", rows: c })), delay: async () => {} });
  assert.equal(resumed.chunksSkipped, 1);
  assert.equal(resumed.created, 50);
  assert.equal(await count("question_text like 'Resume Q %'"), 150, "exactly once each");
  assert.equal((await svc.finishImport(run.id)).createdCount, 150);
});

test("retry policy: validation/permission failures are non-retryable; transient database errors are retryable", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 1 }));
  await svc.finishImport(run.id);
  const res = await asAction(() => svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionText: "Late Q?" })] }));
  assert.deepEqual(res, { ok: false, error: "This import is no longer in progress.", retryable: false });
  const stopped = await core.runChunks({ chunks: [[raw(2, { questionText: "Late Q?" })]], send: (c) => asAction(() => svc.importChunk(run.id, { source: "xlsx", rows: c })), delay: async () => {} });
  assert.equal(stopped.stopped.retryable, false);
  for (const [code, retryable] of [["57014", true], ["40P01", true], ["08006", true], ["42501", false], ["22023", false], ["23505", false]]) {
    assert.equal(repoCore.toRepositoryError({ code, message: "x" }).retryable, retryable, code);
  }
  assert.equal(repoCore.toRepositoryError(new TypeError("fetch failed")).retryable, true);
  assert.match(repoCore.toRepositoryError({ code: "42501", message: 'permission denied for table questions' }).message, /don't have permission/, "raw Postgres text replaced");
});

// ===========================================================================
// Duplicates, include-anyway, race
// ===========================================================================
test("duplicates: in-file, across chunks, and bank duplicates are skipped; include-anyway imports", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 10 }));
  const same = { questionText: "Dup check question?", options: ["One", "Two"] };
  const c1 = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, same), raw(3, { ...same, options: ["two", "ONE"] }), raw(4, { questionText: "What does FT stand for?", options: ["Flow switch", "Flow transmitter", "Flow totaliser"], correctAnswer: "B" })] });
  assert.equal(outcomeOf(c1, 2).outcome, "created");
  assert.equal(outcomeOf(c1, 3).status, "DUPLICATE", "in-file duplicate");
  assert.equal(outcomeOf(c1, 4).status, "DUPLICATE", "bank duplicate (seeded active question)");
  assert.equal(outcomeOf(c1, 4).duplicateOf, ids.qa1);
  const c2 = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(150, same)] });
  assert.equal(outcomeOf(c2, 150).status, "DUPLICATE", "duplicate of a row imported by an earlier chunk");
  assert.equal(outcomeOf(c2, 150).duplicateOf, outcomeOf(c1, 2).questionId);
  const c3 = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(151, { ...same, includeAnyway: true })] });
  assert.equal(outcomeOf(c3, 151).outcome, "created", "include anyway");
  assert.equal(await count("question_text = 'Dup check question?'"), 2);
  await svc.finishImport(run.id);
});

test("race: two imports of the same new question at the same time → exactly one created, the other rejected as a duplicate", async () => {
  const [ra, rb] = await Promise.all([serviceFor("A").startImport(plan({ plannedCreates: 1 })), serviceFor("A2").startImport(plan({ plannedCreates: 1 }))]);
  const item = chunkItem(2, ids.C2, "Race condition question?");
  const [a, b] = await Promise.all([repoFor(USERS.A).importChunk(ra.id, [item]), repoFor(USERS.A2).importChunk(rb.id, [item])]);
  const outcomes = [a.results[0], b.results[0]].map((r) => r.outcome === "rejected" ? `rejected:${r.reason}` : r.outcome).sort();
  assert.deepEqual(outcomes, ["created", "rejected:duplicate"]);
  assert.equal(await count("question_text = 'Race condition question?'"), 1);
  await serviceFor("A").finishImport(ra.id);
  await serviceFor("A2").finishImport(rb.id);
});

test("database refusal propagates through the service (planned-create limit → rejected: limit)", async () => {
  const svc = serviceFor("A");
  const run = await svc.startImport(plan({ plannedCreates: 1 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionText: "Limit Q one?" }), raw(3, { questionText: "Limit Q two?" })] });
  assert.equal(outcomeOf(res, 2).outcome, "created");
  assert.equal(outcomeOf(res, 3).outcome, "rejected");
  assert.equal(outcomeOf(res, 3).reason, "limit");
  assert.equal(res.run.createdCount, 1);
  await svc.finishImport(run.id);
});

// ===========================================================================
// Updates: drafts only, stale revisions, never silently changed
// ===========================================================================
test("update of a draft with the preview revision → updated; counts; unchanged content → unchanged", async () => {
  const svc = serviceFor("A");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: [], questionIds: [ids.qd2] });
  const target = ctx.updateTargets.find((t) => t.id === ids.qd2);
  const run = await svc.startImport(plan({ plannedCreates: 0, plannedUpdates: 2 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionId: ids.qd2, expectedRevision: target.revision, questionType: "true_false", options: [], correctAnswer: "TRUE", questionText: "A PT measures pressure (bulk edit)." })] });
  assert.equal(outcomeOf(res, 2).outcome, "updated");
  const after = await q(ids.qd2);
  assert.equal(after.status, "draft");
  assert.equal(after.revision, target.revision + 1);
  const same = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(3, { questionId: ids.qd2, expectedRevision: after.revision, questionType: "true_false", options: [], correctAnswer: "TRUE", questionText: "A PT measures pressure (bulk edit).", explanation: "Because A PT measures pressure." })] });
  assert.ok(["updated", "unchanged"].includes(outcomeOf(same, 3).outcome));
  const fin = await svc.finishImport(run.id);
  assert.ok(fin.updatedCount >= 1 && fin.createdCount === 0);
});

test("stale revision: the question changed after the preview → refused (service and database), never overwritten", async () => {
  const svc = serviceFor("A");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: [], questionIds: [ids.qx1] });
  const previewRevision = ctx.updateTargets[0].revision;
  // Someone edits the question in the Question Bank after the preview.
  await db.exec(`select public.save_question(jsonb_build_object('id', '${ids.qx1}', 'course_id', '${ids.C1}', 'question_text', 'Fieldbus protocols (edited in the bank)?', 'question_type', 'multiple_choice', 'marks', 3,
    'options', '[{"option_text":"HART","is_correct":true},{"option_text":"Profibus","is_correct":true},{"option_text":"Bluetooth","is_correct":false}]'::jsonb))`, ids.A);
  const run = await svc.startImport(plan({ plannedCreates: 0, plannedUpdates: 2 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionId: ids.qx1, expectedRevision: previewRevision, questionText: "Import overwrite attempt?" }), raw(3, { questionId: ids.qx1, questionText: "No revision given?" })] });
  assert.equal(outcomeOf(res, 2).outcome, "skipped");
  assert.equal(outcomeOf(res, 2).issues[0].code, "revision_conflict");
  assert.equal(outcomeOf(res, 3).issues[0].code, "revision_conflict", "an update without the preview revision is refused");
  assert.equal((await q(ids.qx1)).question_text, "Fieldbus protocols (edited in the bank)?");
  const direct = await repoFor(USERS.A).importChunk(run.id, [chunkItem(4, ids.C1, "Direct stale write?", { question_id: ids.qx1, expected_revision: previewRevision, question_type: "single_choice" })]);
  assert.equal(direct.results[0].reason, "conflict");
  await svc.discardImport(run.id);
});

test("ACTIVE and ARCHIVED questions are protected from bulk update (service and database)", async () => {
  const svc = serviceFor("A");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: [], questionIds: [ids.qa1, ids.qar] });
  const rev = Object.fromEntries(ctx.updateTargets.map((t) => [t.id, t.revision]));
  const run = await svc.startImport(plan({ plannedCreates: 0, plannedUpdates: 2 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [raw(2, { questionId: ids.qa1, expectedRevision: rev[ids.qa1] }), raw(3, { questionId: ids.qar, expectedRevision: rev[ids.qar] })] });
  for (const n of [2, 3]) assert.equal(outcomeOf(res, n).issues[0].code, "question_protected");
  const direct = await repoFor(USERS.A).importChunk(run.id, [chunkItem(4, ids.C1, "Overwrite active?", { question_id: ids.qa1, expected_revision: rev[ids.qa1] })]);
  assert.equal(direct.results[0].reason, "protected");
  assert.equal((await q(ids.qa1)).status, "active");
  assert.equal((await q(ids.qa1)).question_text, "What does FT stand for?");
  await svc.discardImport(run.id);
});

// ===========================================================================
// Discard, ownership, limits
// ===========================================================================
test("discard: deletes the run's unchanged new drafts, keeps edited ones, never reverts updates; a repeat is refused (0014)", async () => {
  const svc = serviceFor("T1");
  const ctx = await svc.getContext({ source: "xlsx", courseCodes: [], questionIds: [ids.qd1] });
  const run = await svc.startImport(plan({ plannedCreates: 3, plannedUpdates: 1 }));
  const res = await svc.importChunk(run.id, { source: "xlsx", rows: [
    raw(2, { questionText: "Discard me one?" }), raw(3, { questionText: "Discard me two?" }), raw(4, { questionText: "Keep me (edited)?" }),
    raw(5, { questionId: ids.qd1, expectedRevision: ctx.updateTargets[0].revision, questionText: "Standard analog signal (bulk)?", options: ["4-20 mA", "0-5 V"] }),
  ] });
  assert.equal(res.created, 3);
  assert.equal(res.updated, 1);
  const kept = outcomeOf(res, 4).questionId;
  await db.exec(`select public.save_question(jsonb_build_object('id', '${kept}', 'course_id', '${ids.C1}', 'question_text', 'Keep me (edited by hand)?', 'question_type', 'single_choice', 'marks', 1,
    'options', '[{"option_text":"Alpha","is_correct":true},{"option_text":"Beta","is_correct":false}]'::jsonb))`, ids.T1);
  const discarded = await svc.discardImport(run.id);
  assert.equal(discarded.deleted, 2);
  assert.equal(discarded.kept, 1);
  assert.equal(discarded.run.status, "discarded");
  assert.equal(await count("question_text like 'Discard me %'"), 0);
  assert.equal(await count(`id = '${kept}'`), 1);
  assert.equal((await q(ids.qd1)).question_text, "Standard analog signal (bulk)?", "the update is not reverted");
  // 0014: only an unfinished import can be discarded — a repeat is refused and changes nothing.
  await assert.rejects(svc.discardImport(run.id), (e) => e.code === "23514" && /Only an unfinished import can be discarded/.test(e.message));
  assert.equal(await count(`id = '${kept}'`), 1);
});

test("ownership: another admin cannot import into or finish my run, but a super admin may discard it (0013 rule)", async () => {
  const mine = await serviceFor("A").startImport(plan({ plannedCreates: 1 }));
  await assert.rejects(serviceFor("A2").importChunk(mine.id, { source: "xlsx", rows: [raw(2, { questionText: "Hijack?" })] }), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
  await assert.rejects(serviceFor("A2").finishImport(mine.id), (e) => e instanceof svcCore.QuestionImportAuthorizationError);
  await assert.rejects(serviceFor("T2").discardImport(mine.id), (e) => e.code === "42501", "a trainer cannot discard someone else's run");
  const d = await serviceFor("A2").discardImport(mine.id);
  assert.equal(d.run.status, "discarded");
});

test("one import in progress per user; the second start is refused clearly", async () => {
  const svc = serviceFor("T2");
  const first = await svc.startImport(plan({ plannedCreates: 1 }));
  await assert.rejects(svc.startImport(plan({ plannedCreates: 1 })), (e) => e instanceof svcCore.QuestionImportRepositoryError && /already have an import in progress/.test(e.message) && !e.retryable);
  await svc.discardImport(first.id);
});

test("per-file limits match Phase C / 0013 exactly: XLSX 5,000 · CSV 10,000 · DOCX/PDF/OCR 1,000", async () => {
  const svc = serviceFor("T2");
  for (const [source, limit] of [["xlsx", 5000], ["csv", 10000], ["docx", 1000], ["pdf", 1000], ["pdf_ocr", 1000]]) {
    await assert.rejects(svc.startImport(plan({ source, plannedCreates: limit, plannedExcluded: 1 })), (e) => e instanceof svcCore.QuestionImportValidationError, `${source} over`);
    await assert.rejects(repoFor(USERS.T2).startImport(plan({ source, plannedCreates: limit + 1 })), (e) => e.code === "22023", `${source} over (database)`);
    const run = await svc.startImport(plan({ source, plannedCreates: limit }));
    assert.equal(run.plannedCreates, limit, `${source} at the limit`);
    await svc.discardImport(run.id);
  }
});

test("start: invalid plans are refused before reaching the database", async () => {
  const svc = serviceFor("A");
  for (const bad of [{ source: "txt" }, { fileName: "   " }, { fileSha256: "xyz" }, { plannedCreates: -1 }, { plannedCreates: 0, plannedUpdates: 0 }, { plannedCreates: 1.5 }]) {
    await assert.rejects(svc.startImport(plan(bad)), (e) => e instanceof svcCore.QuestionImportValidationError, JSON.stringify(bad));
  }
});
