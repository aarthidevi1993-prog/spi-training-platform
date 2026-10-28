// Integration (0015): exam integrity foundation — session binding, client-reported events and
// audit throttling — plus proof that the 0009 engine is unchanged: the same scenario is run on a
// second throwaway database with every migration except 0015 and the results must match; the re-created
// functions must equal 0009 once the lines tagged "-- 0015" are removed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { USERS, clientFor, db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const migrationFiles = (re) => fs.readdirSync(MIGRATIONS).filter((f) => re.test(f)).sort().map((f) => path.join(MIGRATIONS, f));
const M0015 = path.join(MIGRATIONS, "0015_exam_integrity_foundation.sql");
/** The baseline: every migration except 0015 (0015 is what these tests isolate). */
// P5.2: `[a-z]?` also picks up 0029a (0030 requires it), in file order 0029 → 0029a → 0030, as run.mjs does.
const migrationsWithout0015 = () => migrationFiles(/^00\d\d[a-z]?_.*\.sql$/).filter((f) => f !== M0015);

const BASE_DB = "qi_exam_base_0014";
const EMPTY_DB = "qi_exam_empty";
const base = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: BASE_DB });
const empty = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: EMPTY_DB });

const CLIENT_KINDS = ["client_hidden", "client_offline", "client_online", "client_copy", "client_paste", "client_print", "client_multiple_tabs", "client_fullscreen_exit"];
const NEW_EVENT_TYPES = ["concurrent_session", ...CLIENT_KINDS];
const Q1 = "EI: What does FT stand for?";
const Q2 = "EI: A PT measures pressure.";
const Q3 = "EI: Fieldbus protocols?";

// ---------------------------------------------------------------- helpers

async function runFile(dbx, file) {
  const r = await dbx.run(read(file));
  if (r.code) throw new Error(`${path.basename(file)}: ${r.stderr}`);
}

/** Students S1–S6 (enrolled in B1), a B1 class and three active C1 questions — in `dbx`. */
async function world(dbx) {
  const I = await dbx.admin("select json_object_agg(k, v) from t.ids");
  await dbx.exec(`
    insert into t.ids (k, v) select 'ei_' || k, gen_random_uuid() from unnest(array['S1','S2','S3','S4','S5','S6','CL']) k;
    insert into auth.users (id) select v from t.ids where k like 'ei_S_';
    update public.profiles set account_status = 'active' where id in (select v from t.ids where k like 'ei_S_');
    insert into public.students (id, student_code, full_name) select v, k, 'Exam ' || k from t.ids where k like 'ei_S_';
    insert into public.batch_students (batch_id, student_id)
      select (select id from public.batches where batch_code = 'B1'), v from t.ids where k like 'ei_S_';
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time)
      values (t.id('ei_CL'), t.id('C1'), (select id from public.batches where batch_code = 'B1'), t.id('T1'), 'Exam integrity class', current_date, '09:00', '10:00');
    insert into t.ids values
      ('ei_q1', public.save_question(t.p(t.id('C1'), 'single_choice', 2, t.opts('Flow transmitter*','Flow totaliser','Flow switch'), '${Q1}'))),
      ('ei_q2', public.save_question(t.p(t.id('C1'), 'true_false', 1, t.opts('True*','False'), '${Q2}'))),
      ('ei_q3', public.save_question(t.p(t.id('C1'), 'multiple_choice', 3, t.opts('HART*','Profibus*','Bluetooth'), '${Q3}')));
    select public.set_question_status(t.id('ei_q1'), 'active');
    select public.set_question_status(t.id('ei_q2'), 'active');
    select public.set_question_status(t.id('ei_q3'), 'active');`, I.A);
  const W = await dbx.admin("select json_object_agg(k, v) from t.ids");
  W.B1 = await dbx.admin("select id from public.batches where batch_code = 'B1'");
  W.db = dbx;
  return W;
}

let testNo = 0;
/** A published (active) test in B1 with the three EI questions (pass mark 50 %). */
async function makeTest(W, { type = "quiz", minutes = 30, attempts = 1 } = {}) {
  const id = randomUUID();
  await W.db.exec(`
    insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
    values ('${id}', t.id('ei_CL'), '${W.B1}', '${type}', 'EI test ${++testNo}', 50, ${minutes}, ${attempts}, now() - interval '1 minute', now() + interval '2 hours', t.id('T1'), t.id('T1'));
    select public.add_test_questions('${id}', array[t.id('ei_q1'), t.id('ei_q2'), t.id('ei_q3')]);
    update public.tests set status = 'active' where id = '${id}';`, W.T1);
  return id;
}

const as = (W, uid, sessionId) => W.db.client(sessionId === undefined ? { role: "authenticated", userId: uid } : { role: "authenticated", userId: uid, sessionId });
async function call(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const rpcError = async (client, fn, args) => (await client.rpc(fn, args)).error;
/** Option ids for the given option texts of the question with this text, from a paper. */
function pick(paper, questionText, texts) {
  const q = paper.questions.find((x) => x.question_text === questionText);
  return { q: q.test_question_id, opts: texts.map((t) => q.options.find((o) => o.text === t).id) };
}
const save = (client, attemptId, sel, seq) => call(client, "save_test_answer", { p_attempt_id: attemptId, p_test_question_id: sel.q, p_option_ids: sel.opts, p_client_seq: seq });
const clientEvent = (client, attemptId, kind, detail) => client.rpc("record_attempt_client_event", detail === undefined ? { p_attempt_id: attemptId, p_kind: kind } : { p_attempt_id: attemptId, p_kind: kind, p_detail: detail });

/** Move an attempt's deadline into the past (test-only: bypasses the attempt guard in the throwaway DB). */
async function setDeadline(dbx, attemptId, secondsAgo) {
  const r = await dbx.run(`begin;
    alter table public.test_attempts disable trigger test_attempts_guard;
    update public.test_attempts set started_at = now() - interval '10 minutes', deadline_at = now() - interval '${secondsAgo} seconds' where id = '${attemptId}';
    alter table public.test_attempts enable trigger test_attempts_guard;
    commit;`);
  if (r.code) throw new Error(r.stderr);
}
const events = (dbx, where) => dbx.admin(`select coalesce(json_agg(json_build_object('type', event_type, 'actor', actor_id, 'attempt', attempt_id, 'student', student_id,
  'test', test_id, 'batch', batch_id, 'detail', detail, 'recent', occurred_at > now() - interval '5 minutes') order by id), '[]') from public.test_security_events where ${where}`);
const countEvents = (dbx, where) => dbx.admin(`select count(*) from public.test_security_events where ${where}`);
/** Result columns only (these exist before 0015 too) — used by the scenario that also runs on the 0014 database. */
const attemptResult = (dbx, id) => dbx.admin(`select to_json(x) from (select status, finalize_reason, score, max_score, percentage, passed from public.test_attempts where id = '${id}') x`);
const attemptRow = async (dbx, id) => ({ ...(await attemptResult(dbx, id)), started_session_id: await dbx.admin(`select started_session_id from public.test_attempts where id = '${id}'`) });

// ---------------------------------------------------------------- the 0009 scenario (run on both databases)

function normPaper(p) {
  if (!p.questions) return { ...strip(p), questions: null };
  const text = (q, id) => q.options.find((o) => o.id === id).text;
  return {
    ...strip({ ...p, questions: undefined }),
    questions: p.questions
      .map((q) => ({ question_text: q.question_text, question_type: q.question_type, marks: q.marks, keys: Object.keys(q).sort(),
        options: q.options.map((o) => o.text).sort(), optionKeys: Object.keys(q.options[0]).sort(), selected: q.selected.map((id) => text(q, id)).sort() }))
      .sort((a, b) => a.question_text.localeCompare(b.question_text)),
  };
}
function normResult(r) {
  const out = strip({ ...r, review: undefined });
  if (r.review) out.review = r.review.map((q) => ({ ...strip({ ...q, options: undefined, position: undefined }),
    options: q.options.map((o) => ({ text: o.text, is_correct: o.is_correct, selected: o.selected })).sort((a, b) => a.text.localeCompare(b.text)) }))
    .sort((a, b) => a.question_text.localeCompare(b.question_text));
  return out;
}
const VOLATILE = new Set(["attempt_id", "test_id", "id", "started_at", "finalized_at", "saved_at", "server_now", "effective_deadline", "deadline_at", "computed_at", "enrolled_on",
  "test_question_id", "best_attempt_id", "batch_id", "student_id", "test_title", "title", "assignment_ids", "missing_ids", "invalid_ids"]);
function strip(o) {
  if (Array.isArray(o)) return o.map(strip);
  if (!o || typeof o !== "object") return o;
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => !VOLATILE.has(k) && v !== undefined).map(([k, v]) => [k, strip(v)]));
}
const eventTrail = (dbx, attemptId) => dbx.admin(`select coalesce(json_agg(event_type || coalesce(':' || (detail ->> 'reason'), '') || coalesce(':' || (detail ->> 'rule'), '') order by id), '[]')
  from public.test_security_events where attempt_id = '${attemptId}'`);

async function scenario(W) {
  const dbx = W.db;
  const out = {};
  const S = randomUUID();
  const s1 = as(W, W.ei_S1, S);
  const s2 = as(W, W.ei_S2, S);
  const X = await makeTest(W, { type: "final_exam", attempts: 3 });
  const Y = await makeTest(W, { attempts: 1 });

  // Attempt 1: answer, validation paths, submit.
  const st1 = await call(s1, "start_test_attempt", { p_test_id: X });
  out.start1 = strip(st1);
  out.resume1 = strip(await call(s1, "start_test_attempt", { p_test_id: X }));
  let paper = await call(s1, "get_attempt_paper", { p_attempt_id: st1.attempt_id });
  out.paper1 = normPaper(paper);
  const a = st1.attempt_id;
  const q1ok = pick(paper, Q1, ["Flow transmitter"]);
  const q1bad = pick(paper, Q1, ["Flow switch"]);
  const q2t = pick(paper, Q2, ["True"]);
  const q2f = pick(paper, Q2, ["False"]);
  const q3ok = pick(paper, Q3, ["HART", "Profibus"]);
  out.saves = [];
  out.saves.push(await save(s1, a, q1ok, 1));
  out.saves.push(await save(s1, a, q1bad, 1)); // stale: ignored
  out.saves.push(await save(s1, a, { q: q1ok.q, opts: q3ok.opts.slice(0, 1) }, 5)); // option of another question
  out.saves.push(await save(s1, a, { q: q1ok.q, opts: [...q1ok.opts, ...q1bad.opts] }, 6)); // two options on single choice
  out.saves.push(await save(s1, a, { q: randomUUID(), opts: [] }, 7)); // not in this attempt
  out.saves.push(await save(s1, a, q2t, 0)); // invalid sequence
  out.saves.push(await save(s1, a, q2t, 1));
  out.saves.push(await save(s1, a, q2f, 2));
  out.saves.push(await save(s1, a, q3ok, 1));
  out.saves = out.saves.map(strip);
  out.paper1b = normPaper(await call(s1, "get_attempt_paper", { p_attempt_id: a }));
  out.wrongStudent = [
    strip(await call(s2, "get_attempt_paper", { p_attempt_id: a })),
    strip(await call(s2, "save_test_answer", { p_attempt_id: a, p_test_question_id: q1ok.q, p_option_ids: q1ok.opts, p_client_seq: 99 })),
    strip(await call(s2, "submit_test_attempt", { p_attempt_id: a })),
    strip(await call(s2, "get_attempt_result", { p_attempt_id: a })),
  ];
  out.submit1 = strip(await call(s1, "submit_test_attempt", { p_attempt_id: a }));
  out.submit1again = strip(await call(s1, "submit_test_attempt", { p_attempt_id: a }));
  out.saveAfter = strip(await save(s1, a, q1ok, 9));
  out.paperAfter = normPaper(await call(s1, "get_attempt_paper", { p_attempt_id: a }));
  out.resultBeforeClose = normResult(await call(s1, "get_attempt_result", { p_attempt_id: a }));

  // Attempt 2: the server deadline (+ 5 s grace).
  const st2 = await call(s1, "start_test_attempt", { p_test_id: X });
  out.start2 = strip(st2);
  paper = await call(s1, "get_attempt_paper", { p_attempt_id: st2.attempt_id });
  await setDeadline(dbx, st2.attempt_id, 2);
  out.saveInGrace = strip(await save(s1, st2.attempt_id, pick(paper, Q1, ["Flow transmitter"]), 1));
  await setDeadline(dbx, st2.attempt_id, 30);
  out.saveAfterDeadline = strip(await save(s1, st2.attempt_id, pick(paper, Q2, ["True"]), 1));
  out.attempt2 = strip(await attemptResult(dbx, st2.attempt_id));

  // Attempt 3: left in progress, finalized when staff close the test (0010 hook).
  const st3 = await call(s1, "start_test_attempt", { p_test_id: X });
  paper = await call(s1, "get_attempt_paper", { p_attempt_id: st3.attempt_id });
  await save(s1, st3.attempt_id, pick(paper, Q2, ["True"]), 1);
  out.limit = strip(await call(s1, "start_test_attempt", { p_test_id: X })); // resumes attempt 3

  // Another student on another test, finalized by closing that test.
  const y1 = await call(s2, "start_test_attempt", { p_test_id: Y });
  paper = await call(s2, "get_attempt_paper", { p_attempt_id: y1.attempt_id });
  await save(s2, y1.attempt_id, pick(paper, Q1, ["Flow transmitter"]), 1);
  out.designate = await call(W.db.client({ role: "authenticated", userId: W.A }), "set_final_assessment", { p_batch_id: W.B1, p_test_id: X });
  await dbx.exec(`update public.tests set status = 'closed' where id in ('${X}', '${Y}');`, W.T1);
  out.attempt3 = strip(await attemptResult(dbx, st3.attempt_id));
  out.y1 = strip(await attemptResult(dbx, y1.attempt_id));
  out.startAfterClose = strip(await call(s1, "start_test_attempt", { p_test_id: X }));

  // Released results, best result, completion eligibility.
  out.result1 = normResult(await call(s1, "get_attempt_result", { p_attempt_id: a }));
  out.result2 = normResult(await call(s1, "get_attempt_result", { p_attempt_id: st2.attempt_id }));
  out.result3 = normResult(await call(s1, "get_attempt_result", { p_attempt_id: st3.attempt_id }));
  out.resultY = normResult(await call(s2, "get_attempt_result", { p_attempt_id: y1.attempt_id }));
  out.best = strip(await dbx.admin(`select to_json(b) from public.test_best_results b where test_id = '${X}' and student_id = '${W.ei_S1}'`));
  const elig = await dbx.admin(`select public.completion_eligibility('${W.B1}', '${W.ei_S1}')`);
  out.eligibility = strip({ eligible: elig.eligible, final_assessment: elig.final_assessment, enrolment: elig.enrolment });

  // The audit trail of every attempt.
  out.trails = [];
  for (const id of [a, st2.attempt_id, st3.attempt_id, y1.attempt_id]) out.trails.push(await eventTrail(dbx, id));
  out.ids = { X, a, a2: st2.attempt_id, a3: st3.attempt_id, y1: y1.attempt_id };
  return out;
}

// ---------------------------------------------------------------- catalog snapshot (drift check)

const catalog = (dbx) => dbx.admin(`select json_build_object(
  'functions', (select json_object_agg(p.oid::regprocedure::text,
       coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || '=' || a.privilege_type, ',' order by case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type) from aclexplode(p.proacl) a), 'default')
       || '|definer=' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || p.provolatile::text)
     from pg_proc p where p.pronamespace = 'public'::regnamespace),
  'tables', (select json_object_agg(c.relname, coalesce((select string_agg(a.grantee::regrole::text || '=' || a.privilege_type, ',' order by a.grantee::regrole::text, a.privilege_type) from aclexplode(c.relacl) a), 'default') || '|rls=' || c.relrowsecurity)
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')),
  'policies', (select json_agg(tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ';') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') order by tablename, policyname) from pg_policies where schemaname = 'public'),
  'triggers', (select json_agg(c.relname || '.' || tg.tgname || ':' || tg.tgfoid::regproc::text || ':' || tg.tgtype::text || ':' || tg.tgenabled::text order by c.relname, tg.tgname)
     from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relnamespace = 'public'::regnamespace and not tg.tgisinternal),
  'indexes', (select json_agg(indexname order by indexname) from pg_indexes where schemaname = 'public'),
  'attempt_columns', (select json_agg(column_name || ':' || data_type || ':' || is_nullable order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'test_attempts'),
  'event_types', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = 'public.test_security_event_type'::regtype))`);

// ---------------------------------------------------------------- setup

let W; // main database (0001–0015)
let B; // baseline database (every migration except 0015)
let baseCatalog;
let baseRun;

before(async () => {
  for (const name of [BASE_DB, EMPTY_DB]) {
    const r = await db.run(`drop database if exists ${name} with (force);\ncreate database ${name};`);
    if (r.code) throw new Error(r.stderr);
  }
  for (const file of [path.join(here, "fixtures/bootstrap.sql"), ...migrationsWithout0015(), path.join(here, "fixtures/seed.sql")]) await runFile(base, file);
  baseCatalog = await catalog(base);
  W = await world(db);
  B = await world(base);
});

after(async () => {
  await db.run(`drop database if exists ${BASE_DB} with (force);\ndrop database if exists ${EMPTY_DB} with (force);`);
});

// ---------------------------------------------------------------- 0. harness

test("0. harness: without sessionId the request claims are exactly as before ({sub} only; anon empty)", async () => {
  const claims = async (client) => (await client.sql("current_setting('request.jwt.claims', true)")).data;
  assert.equal(await claims(clientFor(USERS.ST1)), JSON.stringify({ sub: ids.ST1 }));
  assert.equal(await claims(db.client({ role: "authenticated", userId: ids.ST1 })), JSON.stringify({ sub: ids.ST1 }));
  assert.equal(await claims(clientFor(null)), "");
  const sid = randomUUID();
  assert.equal(await claims(db.client({ role: "authenticated", userId: ids.ST1, sessionId: sid })), JSON.stringify({ sub: ids.ST1, session_id: sid }));
  assert.equal((await db.client({ role: "authenticated", userId: ids.ST1 }).sql("auth.uid()")).data, ids.ST1);
});

// ---------------------------------------------------------------- A. session binding

test("A1. start stores the session; the same session never produces a concurrent_session event", async () => {
  const T = await makeTest(W, { attempts: 3 });
  const S = randomUUID();
  const c = as(W, W.ei_S2, S);
  const st = await call(c, "start_test_attempt", { p_test_id: T });
  assert.equal(st.ok, true);
  assert.equal((await attemptRow(db, st.attempt_id)).started_session_id, S);
  const paper = await call(c, "get_attempt_paper", { p_attempt_id: st.attempt_id });
  assert.equal((await save(c, st.attempt_id, pick(paper, Q1, ["Flow transmitter"]), 1)).ok, true);
  assert.equal((await call(c, "start_test_attempt", { p_test_id: T })).resumed, true);
  assert.equal((await clientEvent(c, st.attempt_id, "client_hidden")).data.recorded, true);
  assert.equal((await call(c, "submit_test_attempt", { p_attempt_id: st.attempt_id })).status, "submitted");
  assert.equal(await countEvents(db, `attempt_id = '${st.attempt_id}' and event_type = 'concurrent_session'`), 0);
});

test("A2. a different session: ONE concurrent_session per new session, nothing blocked, binding unchanged", async () => {
  const T = await makeTest(W, { attempts: 3 });
  const [S1, S2, S3, S4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const c1 = as(W, W.ei_S2, S1);
  const c2 = as(W, W.ei_S2, S2);
  const c3 = as(W, W.ei_S2, S3);
  const st = await call(c1, "start_test_attempt", { p_test_id: T });
  const a = st.attempt_id;
  const paper = await call(c2, "get_attempt_paper", { p_attempt_id: a });
  assert.equal(paper.ok, true);
  assert.equal(paper.questions.length, 3, "the paper is still served to the other session");
  let ev = await events(db, `attempt_id = '${a}' and event_type = 'concurrent_session'`);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].detail, { operation: "paper", session_id: S2, started_session_id: S1 });
  assert.equal(ev[0].actor, W.ei_S2);
  assert.equal(ev[0].student, W.ei_S2);

  await call(c2, "get_attempt_paper", { p_attempt_id: a });
  const r2 = await save(c2, a, pick(paper, Q1, ["Flow transmitter"]), 1);
  assert.equal(r2.ok, true);
  assert.equal(r2.ignored, false);
  assert.equal((await call(c2, "start_test_attempt", { p_test_id: T })).resumed, true, "resuming from another session still works");
  assert.equal(await countEvents(db, `attempt_id = '${a}' and event_type = 'concurrent_session'`), 1, "S2 is noted once");

  assert.equal((await save(c3, a, pick(paper, Q3, ["HART", "Profibus"]), 1)).ok, true);
  assert.equal((await clientEvent(as(W, W.ei_S2, S4), a, "client_copy")).data.recorded, true);
  ev = await events(db, `attempt_id = '${a}' and event_type = 'concurrent_session'`);
  assert.deepEqual(ev.map((e) => [e.detail.operation, e.detail.session_id]), [["paper", S2], ["save", S3], ["client_event", S4]]);

  const sub = await call(c2, "submit_test_attempt", { p_attempt_id: a });
  assert.equal(sub.status, "submitted");
  assert.equal(sub.finalize_reason, "student_submit");
  const row = await attemptRow(db, a);
  assert.equal(row.started_session_id, S1, "the binding never moves");
  assert.equal(Number(row.score), 5, "answers saved from other sessions count normally");
  assert.equal(await countEvents(db, `attempt_id = '${a}' and event_type = 'concurrent_session'`), 3);
});

test("A3. no session claim, or a malformed one: started_session_id stays NULL and the attempt is never checked", async () => {
  for (const sessionId of [undefined, "not-a-uuid"]) {
    const T = await makeTest(W);
    const c = as(W, W.ei_S2, sessionId);
    const st = await call(c, "start_test_attempt", { p_test_id: T });
    assert.equal((await attemptRow(db, st.attempt_id)).started_session_id, null);
    for (const S of [randomUUID(), randomUUID()]) {
      const other = as(W, W.ei_S2, S);
      const paper = await call(other, "get_attempt_paper", { p_attempt_id: st.attempt_id });
      assert.equal((await save(other, st.attempt_id, pick(paper, Q2, ["True"]), 1 + (paper.questions ? 0 : 0))).ok, true);
    }
    assert.equal((await call(as(W, W.ei_S2, randomUUID()), "submit_test_attempt", { p_attempt_id: st.attempt_id })).status, "submitted");
    assert.equal(await countEvents(db, `attempt_id = '${st.attempt_id}' and event_type = 'concurrent_session'`), 0);
  }
  // A malformed claim on a bound attempt is ignored (never flagged, never blocked).
  const T = await makeTest(W);
  const st = await call(as(W, W.ei_S2, randomUUID()), "start_test_attempt", { p_test_id: T });
  const bad = as(W, W.ei_S2, "not-a-uuid");
  const paper = await call(bad, "get_attempt_paper", { p_attempt_id: st.attempt_id });
  assert.equal((await save(bad, st.attempt_id, pick(paper, Q2, ["True"]), 1)).ok, true);
  assert.equal(await countEvents(db, `attempt_id = '${st.attempt_id}' and event_type = 'concurrent_session'`), 0);
  await call(bad, "submit_test_attempt", { p_attempt_id: st.attempt_id });
});

test("A4. finished attempts are never flagged for a different session", async () => {
  const T = await makeTest(W);
  const c1 = as(W, W.ei_S2, randomUUID());
  const st = await call(c1, "start_test_attempt", { p_test_id: T });
  const paper = await call(c1, "get_attempt_paper", { p_attempt_id: st.attempt_id });
  await call(c1, "submit_test_attempt", { p_attempt_id: st.attempt_id });
  const c2 = as(W, W.ei_S2, randomUUID());
  assert.equal((await call(c2, "get_attempt_paper", { p_attempt_id: st.attempt_id })).questions, null);
  assert.equal((await save(c2, st.attempt_id, pick(paper, Q1, ["Flow transmitter"]), 5)).reason, "attempt_finished");
  assert.equal((await call(c2, "submit_test_attempt", { p_attempt_id: st.attempt_id })).already_finished, true);
  assert.equal((await clientEvent(c2, st.attempt_id, "client_hidden")).data.reason, "attempt_finished");
  assert.equal(await countEvents(db, `attempt_id = '${st.attempt_id}' and event_type = 'concurrent_session'`), 0);
});

// ---------------------------------------------------------------- B. client-reported events

let clientAttempt; // S3's in-progress attempt
const clientRows = (attemptId) => events(db, `attempt_id = '${attemptId}' and event_type::text like 'client\\_%'`);

test("B1. every allow-listed kind is recorded for the student's own in-progress attempt, with server actor and context", async () => {
  const T = await makeTest(W, { attempts: 2 });
  const c = as(W, W.ei_S3, randomUUID());
  clientAttempt = (await call(c, "start_test_attempt", { p_test_id: T })).attempt_id;
  for (const kind of CLIENT_KINDS) {
    const { data, error } = await clientEvent(c, clientAttempt, kind, { visible: false });
    assert.equal(error, null, kind);
    assert.deepEqual(data, { ok: true, recorded: true }, kind);
  }
  const rows = await clientRows(clientAttempt);
  assert.deepEqual(rows.map((r) => r.type), CLIENT_KINDS);
  for (const r of rows) {
    assert.equal(r.actor, W.ei_S3);
    assert.equal(r.student, W.ei_S3);
    assert.equal(r.attempt, clientAttempt);
    assert.equal(r.test, T);
    assert.equal(r.batch, W.B1);
    assert.deepEqual(r.detail, { source: "client", client: { visible: false } });
  }
  // Detail is optional; null counts as {}.
  assert.equal((await clientEvent(c, clientAttempt, "client_online")).data.recorded, true);
  assert.equal((await clientEvent(c, clientAttempt, "client_online", null)).data.recorded, true);
  const last = (await clientRows(clientAttempt)).at(-1);
  assert.deepEqual(last.detail, { source: "client", client: {} });
});

test("B2. the client cannot set the time, actor, type or attempt of the stored event", async () => {
  const c = as(W, W.ei_S3, randomUUID());
  const fake = { occurred_at: "2000-01-01T00:00:00Z", actor_id: W.A, student_id: W.ei_S1, event_type: "submit", attempt_id: randomUUID() };
  assert.equal((await clientEvent(c, clientAttempt, "client_paste", fake)).data.recorded, true);
  const row = await db.admin(`select to_json(x) from (select event_type, actor_id, student_id, attempt_id, detail,
      occurred_at between now() - interval '5 minutes' and now() + interval '1 second' as server_time
      from public.test_security_events where attempt_id = '${clientAttempt}' order by id desc limit 1) x`);
  assert.equal(row.event_type, "client_paste");
  assert.equal(row.actor_id, W.ei_S3);
  assert.equal(row.student_id, W.ei_S3);
  assert.equal(row.attempt_id, clientAttempt);
  assert.equal(row.server_time, true);
  assert.deepEqual(row.detail, { source: "client", client: fake }, "client values are only kept as quoted detail");
  const args = await db.admin("select proargnames from pg_proc where oid = 'public.record_attempt_client_event(uuid, text, jsonb)'::regprocedure");
  assert.deepEqual(args, ["p_attempt_id", "p_kind", "p_detail"], "no timestamp or actor parameter exists");
});

test("B3. another student's attempt, an unknown attempt, and non-students are refused without a client event", async () => {
  const before = (await clientRows(clientAttempt)).length;
  const other = as(W, W.ei_S6, randomUUID());
  assert.deepEqual((await clientEvent(other, clientAttempt, "client_hidden")).data, { ok: false, reason: "not_found" });
  assert.deepEqual((await clientEvent(other, randomUUID(), "client_hidden")).data, { ok: false, reason: "not_found" });
  assert.deepEqual((await clientEvent(as(W, W.ei_S3, randomUUID()), randomUUID(), "client_hidden")).data, { ok: false, reason: "not_found" });
  assert.equal((await clientRows(clientAttempt)).length, before);
  assert.equal(await countEvents(db, `event_type::text like 'client\\_%' and actor_id = '${W.ei_S6}'`), 0);
  assert.equal(await countEvents(db, `event_type = 'invalid_attempt_access' and actor_id = '${W.ei_S6}' and detail ->> 'operation' = 'client_event'`), 2, "the probe is audited like other invalid access");
  for (const who of [W.T1, W.A]) {
    const error = (await clientEvent(db.client({ role: "authenticated", userId: who }), clientAttempt, "client_hidden")).error;
    assert.equal(error?.code, "42501");
    assert.match(error.message, /Only students can take tests/);
  }
  assert.equal((await clientRows(clientAttempt)).length, before);
});

test("B4. strict allow-list: unknown or non-client kinds are rejected", async () => {
  const c = as(W, W.ei_S3, randomUUID());
  const before = await countEvents(db, `attempt_id = '${clientAttempt}'`);
  for (const kind of ["client_evil", "answer_saved", "submit", "concurrent_session", "suspicious_repeated_access", "attempt_started", "CLIENT_HIDDEN", " client_hidden", "", null]) {
    const error = (await clientEvent(c, clientAttempt, kind)).error;
    assert.equal(error?.code, "22023", String(kind));
    assert.match(error.message, /Unknown client event/);
  }
  assert.equal(await countEvents(db, `attempt_id = '${clientAttempt}'`), before);
});

test("B5. detail must be a JSON object of at most 1 KB (bytes)", async () => {
  const c = as(W, W.ei_S3, randomUUID());
  const before = (await clientRows(clientAttempt)).length;
  const fits = { x: "a".repeat(1024 - JSON.stringify({ x: "" }).length - 1) }; // jsonb text adds one space after ':'
  assert.equal((await clientEvent(c, clientAttempt, "client_print", fits)).data.recorded, true, "at the limit");
  for (const detail of [{ x: "a".repeat(1100) }, { x: "é".repeat(600) }, [1, 2], JSON.stringify("text")]) {
    const error = (await clientEvent(c, clientAttempt, "client_print", detail)).error;
    assert.equal(error?.code, "22023");
    assert.match(error.message, /at most 1 KB/);
  }
  assert.equal((await clientRows(clientAttempt)).length, before + 1);
});

test("B6. finished or past-deadline attempts accept no client events (and are not finalized by them)", async () => {
  const T = await makeTest(W);
  const c = as(W, W.ei_S3, randomUUID());
  const st = await call(c, "start_test_attempt", { p_test_id: T });
  await setDeadline(db, st.attempt_id, 30);
  assert.deepEqual((await clientEvent(c, st.attempt_id, "client_hidden")).data, { ok: false, reason: "attempt_finished" });
  assert.equal((await attemptRow(db, st.attempt_id)).status, "in_progress", "the client event path never finalizes");
  await call(c, "submit_test_attempt", { p_attempt_id: st.attempt_id });
  assert.equal((await attemptRow(db, st.attempt_id)).finalize_reason, "deadline");
  assert.deepEqual((await clientEvent(c, st.attempt_id, "client_hidden")).data, { ok: false, reason: "attempt_finished" });
  assert.equal((await clientRows(st.attempt_id)).length, 0);
});

test("B7. anonymous callers cannot execute it; nobody can write security events or the session binding directly", async () => {
  const anon = clientFor(null);
  const e1 = (await clientEvent(anon, clientAttempt, "client_hidden")).error;
  assert.equal(e1?.code, "42501");
  assert.match(e1.message, /permission denied for function record_attempt_client_event/);
  const student = as(W, W.ei_S3, randomUUID());
  const direct = [
    `insert into public.test_security_events (event_type, actor_id, attempt_id, detail) values ('client_hidden', '${W.ei_S3}', '${clientAttempt}', '{}')`,
    `update public.test_security_events set detail = '{}' where attempt_id = '${clientAttempt}'`,
    `delete from public.test_security_events where attempt_id = '${clientAttempt}'`,
    `update public.test_attempts set started_session_id = null where id = '${clientAttempt}'`,
  ];
  for (const who of [student, anon]) {
    for (const sql of direct) {
      const { error } = await who.execute(sql);
      assert.equal(error?.code, "42501", sql);
      assert.match(error.message, /permission denied/);
    }
  }
});

// ---------------------------------------------------------------- C. audit throttling

const doLoop = (client, from, to, body) => client.execute(`do $d$ declare r jsonb; begin for i in ${from}..${to} loop ${body} end loop; end $d$`);
const outs = (prefix) => db.admin(`select coalesce(json_agg(v order by (substring(k from '[0-9]+$'))::int), '[]') from t.out where k like '${prefix}%'`);

test("C1. answer_saved: capped at 121 rows per minute, 0009's 121-save rule still fires, ONE throttle summary — every save is kept", async () => {
  const T = await makeTest(W, { attempts: 2 });
  const c = as(W, W.ei_S4, randomUUID());
  const st = await call(c, "start_test_attempt", { p_test_id: T });
  const a = st.attempt_id;
  const sel = pick(await call(c, "get_attempt_paper", { p_attempt_id: a }), Q1, ["Flow transmitter"]);
  const body = `r := public.save_test_answer('${a}', '${sel.q}', array['${sel.opts[0]}']::uuid[], i); insert into t.out (k, v) values ('ei_c1_' || i, r);`;
  let r = await doLoop(c, 1, 130, body);
  assert.equal(r.error, null);
  let res = await outs("ei_c1_");
  assert.equal(res.length, 130);
  assert.ok(res.every((x) => x.ok === true && x.ignored === false), "all 130 saves accepted");
  const count = (w) => countEvents(db, `attempt_id = '${a}' and ${w}`);
  assert.equal(await count(`event_type = 'answer_saved'`), 121);
  assert.equal(await count(`event_type = 'suspicious_repeated_access' and detail ->> 'rule' = 'answer_saves_per_minute'`), 1, "the 0009 rule is unchanged");
  const summary = await events(db, `attempt_id = '${a}' and detail ->> 'rule' = 'audit_throttle'`);
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].detail, { rule: "audit_throttle", throttled_event: "answer_saved", limit_per_minute: 121 });
  assert.equal(summary[0].actor, W.ei_S4);

  r = await doLoop(c, 131, 180, body);
  assert.equal(r.error, null);
  res = await outs("ei_c1_");
  assert.equal(res.length, 180);
  assert.ok(res.every((x) => x.ok === true && x.ignored === false));
  assert.equal(await count(`event_type = 'answer_saved'`), 121);
  assert.equal(await count(`detail ->> 'rule' = 'audit_throttle'`), 1, "summaries are bounded: one per window");
  assert.deepEqual(await db.admin(`select to_json(x) from (select client_seq, save_count from public.test_attempt_answers where attempt_id = '${a}' and test_question_id = '${sel.q}') x`), { client_seq: 180, save_count: 180 });

  const sub = await call(c, "submit_test_attempt", { p_attempt_id: a });
  assert.equal(sub.status, "submitted");
  assert.equal(await count(`event_type = 'submit'`), 1, "lifecycle events are never throttled");
  assert.equal(Number((await attemptRow(db, a)).score), 2);
});

test("C2. other routine events: 20 per minute per type, one summary per window, responses unchanged", async () => {
  const T = await makeTest(W, { attempts: 2 });
  const c = as(W, W.ei_S4, randomUUID());
  const a = (await call(c, "start_test_attempt", { p_test_id: T })).attempt_id;
  const paper = await call(c, "get_attempt_paper", { p_attempt_id: a });
  const q1 = pick(paper, Q1, ["Flow transmitter", "Flow switch"]);
  const count = (w) => countEvents(db, `actor_id = '${W.ei_S4}' and ${w}`);

  await doLoop(c, 1, 30, `r := public.record_attempt_client_event('${a}', 'client_hidden', '{}'); insert into t.out (k, v) values ('ei_c2h_' || i, r);`);
  const hidden = await outs("ei_c2h_");
  assert.deepEqual(hidden.slice(0, 20), Array(20).fill({ ok: true, recorded: true }));
  assert.deepEqual(hidden.slice(20), Array(10).fill({ ok: true, recorded: false, reason: "rate_limited" }));
  assert.equal(await count(`attempt_id = '${a}' and event_type = 'client_hidden'`), 20);
  const summary = await events(db, `attempt_id = '${a}' and detail ->> 'rule' = 'audit_throttle'`);
  assert.deepEqual(summary.map((s) => s.detail), [{ rule: "audit_throttle", throttled_event: "client_hidden", limit_per_minute: 20 }]);
  assert.equal((await clientEvent(c, a, "client_copy")).data.recorded, true, "limits are per event type");

  await doLoop(c, 1, 25, `r := public.save_test_answer('${a}', '${q1.q}', array['${q1.opts[0]}', '${q1.opts[1]}']::uuid[], i); insert into t.out (k, v) values ('ei_c2b_' || i, r);`);
  assert.deepEqual(await outs("ei_c2b_"), Array(25).fill({ ok: false, reason: "invalid_options" }), "every invalid save still gets its answer");
  assert.equal(await count(`attempt_id = '${a}' and event_type = 'blocked_answer_save'`), 20);

  await doLoop(c, 1, 25, `r := public.start_test_attempt('${T}'); insert into t.out (k, v) values ('ei_c2s_' || i, r);`);
  assert.ok((await outs("ei_c2s_")).every((x) => x.ok === true && x.resumed === true && x.attempt_id === a));
  assert.equal(await count(`attempt_id = '${a}' and event_type = 'repeated_start'`), 20);
  assert.equal(await count(`attempt_id = '${a}' and detail ->> 'rule' = 'repeated_start'`), 1, "the 0009 repeated-start rule (10 per minute) is unchanged");

  const probes = Array.from({ length: 25 }, () => `'${randomUUID()}'`).join(",");
  await c.execute(`do $d$ declare x uuid; r jsonb; n int := 0; begin foreach x in array array[${probes}]::uuid[] loop n := n + 1; r := public.get_attempt_paper(x); insert into t.out (k, v) values ('ei_c2p_' || n, r); end loop; end $d$`);
  assert.deepEqual(await outs("ei_c2p_"), Array(25).fill({ ok: false, reason: "not_found" }));
  assert.equal(await count(`attempt_id is null and event_type = 'invalid_attempt_access'`), 20);

  assert.deepEqual((await events(db, `actor_id = '${W.ei_S4}' and attempt_id is not distinct from ${`'${a}'`} and detail ->> 'rule' = 'audit_throttle'`)).map((s) => s.detail.throttled_event),
    ["client_hidden", "blocked_answer_save", "repeated_start"]);
  assert.equal(await count(`attempt_id is null and detail ->> 'rule' = 'audit_throttle'`), 1);

  // The window moves on: once events are older than a minute, recording resumes (test-only backdating).
  const r = await db.run(`begin; alter table public.test_security_events disable trigger test_security_events_guard;
    update public.test_security_events set occurred_at = occurred_at - interval '2 minutes' where actor_id = '${W.ei_S4}' and attempt_id = '${a}';
    alter table public.test_security_events enable trigger test_security_events_guard; commit;`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual((await clientEvent(c, a, "client_hidden")).data, { ok: true, recorded: true });
});

test("C3. hourly cap (600 routine events per actor): saves still succeed, one hourly summary, non-routine events still written", async () => {
  const T = await makeTest(W);
  const S1 = randomUUID();
  const c = as(W, W.ei_S5, S1);
  const a = (await call(c, "start_test_attempt", { p_test_id: T })).attempt_id;
  const paper = await call(c, "get_attempt_paper", { p_attempt_id: a });
  // 600 earlier routine events by this student (the guard stamps actor and time).
  await db.exec(`insert into public.test_security_events (event_type, actor_id, detail) select 'client_online', t.id('ei_S5'), '{}' from generate_series(1, 600);`, W.ei_S5);
  const count = (w) => countEvents(db, `actor_id = '${W.ei_S5}' and ${w}`);

  for (const [i, sel] of [[1, pick(paper, Q1, ["Flow transmitter"])], [2, pick(paper, Q2, ["True"])]]) {
    const r = await save(c, a, sel, i);
    assert.equal(r.ok, true);
    assert.equal(r.ignored, false);
  }
  assert.equal(await db.admin(`select count(*) from public.test_attempt_answer_options where attempt_id = '${a}'`), 2, "both answers stored");
  assert.equal(await count(`event_type = 'answer_saved'`), 0);
  assert.deepEqual((await clientEvent(c, a, "client_hidden")).data, { ok: true, recorded: false, reason: "rate_limited" });
  const hourly = await events(db, `actor_id = '${W.ei_S5}' and detail ->> 'rule' = 'audit_throttle_hourly'`);
  assert.equal(hourly.length, 1);
  assert.deepEqual(hourly[0].detail, { rule: "audit_throttle_hourly", throttled_event: "answer_saved", limit_per_hour: 600 });

  await call(as(W, W.ei_S5, randomUUID()), "get_attempt_paper", { p_attempt_id: a });
  assert.equal(await count(`event_type = 'concurrent_session'`), 1, "concurrent_session is never throttled");
  assert.equal((await call(c, "submit_test_attempt", { p_attempt_id: a })).status, "submitted");
  assert.equal(await count(`event_type = 'submit' and attempt_id = '${a}'`), 1);
  assert.equal(await count(`event_type = 'attempt_started' and attempt_id = '${a}'`), 1);
  assert.equal(Number((await attemptRow(db, a)).score), 3);
  assert.equal(await count(`detail ->> 'rule' = 'audit_throttle_hourly'`), 1, "still one hourly summary");
  // Another student is unaffected.
  const other = as(W, W.ei_S6, randomUUID());
  const T2 = await makeTest(W);
  const b = (await call(other, "start_test_attempt", { p_test_id: T2 })).attempt_id;
  await save(other, b, pick(await call(other, "get_attempt_paper", { p_attempt_id: b }), Q1, ["Flow transmitter"]), 1);
  assert.equal(await countEvents(db, `attempt_id = '${b}' and event_type = 'answer_saved'`), 1);
  await call(other, "submit_test_attempt", { p_attempt_id: b });
});

// ---------------------------------------------------------------- D. regression

test("D1. the full 0009/0010/0011 scenario gives identical results on 0001–0014 and on 0001–0015", async () => {
  baseRun = await scenario(B);
  const mainRun = await scenario(W);
  const { ids: _b, ...baseOut } = baseRun;
  const { ids: _m, ...mainOut } = mainRun;
  for (const key of Object.keys(baseOut)) assert.deepEqual(mainOut[key], baseOut[key], key);
  assert.deepEqual(Object.keys(mainOut), Object.keys(baseOut));

  // And the values are the expected ones (not merely equal).
  assert.deepEqual(mainOut.start1, { ok: true, resumed: false });
  assert.deepEqual(mainOut.resume1, { ok: true, resumed: true });
  assert.deepEqual(mainOut.saves.map((s) => s.reason ?? (s.ignored ? "ignored" : "saved")),
    ["saved", "ignored", "invalid_options", "invalid_options", "invalid_question", "invalid_request", "saved", "saved", "saved"]);
  for (const q of mainOut.paper1.questions) {
    assert.deepEqual(q.keys, ["marks", "options", "position", "question_text", "question_type", "selected", "test_question_id"], "no answer key or explanation");
    assert.deepEqual(q.optionKeys, ["id", "text"]);
  }
  assert.deepEqual(mainOut.paper1b.questions.map((q) => [q.question_text, q.selected]), [[Q2, ["False"]], [Q3, ["HART", "Profibus"]], [Q1, ["Flow transmitter"]]]);
  assert.deepEqual(mainOut.wrongStudent, Array(4).fill({ ok: false, reason: "not_found" }));
  assert.deepEqual(mainOut.submit1, { ok: true, already_finished: false, status: "submitted", finalize_reason: "student_submit" });
  assert.equal(mainOut.submit1again.already_finished, true);
  assert.equal(mainOut.saveAfter.reason, "attempt_finished");
  assert.equal(mainOut.resultBeforeClose.results_available, false);
  assert.equal(mainOut.resultBeforeClose.score, undefined, "no score before release");
  assert.equal(mainOut.saveInGrace.ok, true, "5-second grace");
  assert.deepEqual(mainOut.saveAfterDeadline, { ok: false, reason: "deadline" });
  assert.equal(mainOut.attempt2.finalize_reason, "deadline");
  assert.equal(mainOut.attempt2.status, "finalized");
  assert.equal(mainOut.limit.resumed, true);
  assert.deepEqual(mainOut.designate, { ok: true, changed: true });
  assert.deepEqual([mainOut.attempt3.status, mainOut.attempt3.finalize_reason], ["finalized", "test_closed"]);
  assert.deepEqual([mainOut.y1.finalize_reason, Number(mainOut.y1.score)], ["test_closed", 2]);
  assert.deepEqual(mainOut.startAfterClose, { ok: false, reason: "test_closed" });
  assert.deepEqual([mainOut.result1.results_available, Number(mainOut.result1.score), Number(mainOut.result1.max_score), Number(mainOut.result1.percentage), mainOut.result1.passed, mainOut.result1.is_best_attempt],
    [true, 5, 6, 83.33, true, true]);
  assert.deepEqual(mainOut.result1.review.map((q) => [q.question_text, q.is_correct, Number(q.marks_awarded)]), [[Q2, false, 0], [Q3, true, 3], [Q1, true, 2]]);
  assert.deepEqual([Number(mainOut.result2.score), mainOut.result2.passed, mainOut.result2.is_best_attempt], [2, false, false]);
  assert.deepEqual([Number(mainOut.result3.score), mainOut.result3.finalize_reason], [1, "test_closed"]);
  assert.deepEqual([Number(mainOut.best.percentage), mainOut.best.passed, mainOut.best.finished_attempts], [83.33, true, 3]);
  assert.deepEqual(mainOut.eligibility.final_assessment, { ok: true, state: "passed", best_percentage: 83.33 });
  assert.equal(mainOut.eligibility.eligible, false, "batch not completed / attendance");
  assert.deepEqual(mainOut.trails[0], ["attempt_started", "repeated_start", "answer_saved", "blocked_answer_save:invalid_options", "blocked_answer_save:invalid_options",
    "blocked_answer_save:invalid_question", "blocked_answer_save:invalid_request", "answer_saved", "answer_saved", "answer_saved",
    "invalid_attempt_access", "invalid_attempt_access", "invalid_attempt_access", "invalid_attempt_access", "submit:student_submit",
    "blocked_submission:attempt_finished", "blocked_answer_save:attempt_finished"]);
  assert.deepEqual(mainOut.trails[1].slice(-3), ["deadline_reached", "blocked_answer_save:deadline", "auto_submit:deadline"]);
  assert.equal(mainOut.trails[2].at(-1), "test_closed_finalization:test_closed");
  assert.equal(await countEvents(db, `attempt_id in ('${_m.a}', '${_m.a2}', '${_m.a3}') and event_type = 'concurrent_session'`), 0);
});

test("A5. attempts that existed before 0015 keep started_session_id NULL and keep working (0015 applied onto the 0014 database)", async () => {
  // An attempt started on the 0014 database, still in progress, and the baseline scenario's finished attempts.
  const T = await makeTest(B, { attempts: 2 });
  const pre = as(B, B.ei_S3, randomUUID());
  const st = await call(pre, "start_test_attempt", { p_test_id: T });
  const paper = await call(pre, "get_attempt_paper", { p_attempt_id: st.attempt_id });
  await save(pre, st.attempt_id, pick(paper, Q1, ["Flow transmitter"]), 1);
  assert.ok(baseRun, "the baseline scenario ran first (D1)");
  const resultsBefore = [];
  for (const id of [baseRun.ids.a, baseRun.ids.a2, baseRun.ids.a3]) resultsBefore.push(await call(as(B, B.ei_S1), "get_attempt_result", { p_attempt_id: id }));
  const bestBefore = await base.admin(`select to_json(b) from public.test_best_results b where test_id = '${baseRun.ids.X}' and student_id = '${B.ei_S1}'`);

  await runFile(base, M0015);
  await runFile(base, M0015); // safe to re-run

  assert.equal(await base.admin("select count(*) from public.test_attempts where started_session_id is not null"), 0, "no backfill");
  for (const S of [randomUUID(), randomUUID()]) {
    const c = as(B, B.ei_S3, S);
    const p = await call(c, "get_attempt_paper", { p_attempt_id: st.attempt_id });
    assert.equal(p.ok, true);
    assert.equal((await save(c, st.attempt_id, pick(p, Q3, ["HART", "Profibus"]), 1)).ok, true);
    assert.equal((await clientEvent(c, st.attempt_id, "client_online")).data.recorded, true);
  }
  const sub = await call(as(B, B.ei_S3, randomUUID()), "submit_test_attempt", { p_attempt_id: st.attempt_id });
  assert.equal(sub.status, "submitted");
  assert.equal(Number((await attemptRow(base, st.attempt_id)).score), 5);
  assert.equal(await base.admin(`select count(*) from public.test_security_events where event_type = 'concurrent_session'`), 0);

  const resultsAfter = [];
  for (const id of [baseRun.ids.a, baseRun.ids.a2, baseRun.ids.a3]) resultsAfter.push(await call(as(B, B.ei_S1), "get_attempt_result", { p_attempt_id: id }));
  assert.deepEqual(resultsAfter, resultsBefore, "finished pre-0015 results are byte-for-byte the same after 0015");
  assert.deepEqual(await base.admin(`select to_json(b) from public.test_best_results b where test_id = '${baseRun.ids.X}' and student_id = '${B.ei_S1}'`), bestBefore);
});

test("D2. exact 0009 proof: re-created functions minus lines tagged '-- 0015' equal the 0009 source; every other function is untouched", async () => {
  // Function bodies as last defined by every migration except 0015 (later ones, e.g. 0016, re-create some).
  const defined = new Map();
  for (const file of migrationsWithout0015()) {
    const src = read(file);
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(src))) {
      const asRe = /\bas\s+(\$\w*\$)/g;
      asRe.lastIndex = m.index;
      const a = asRe.exec(src);
      const start = a.index + a[0].length;
      defined.set(m[1], src.slice(start, src.indexOf(a[1], start)));
    }
  }
  const live = await db.admin("select json_agg(json_build_object('name', proname, 'src', prosrc)) from pg_proc where pronamespace = 'public'::regnamespace");
  const liveBy = new Map();
  for (const f of live) liveBy.set(f.name, [...(liveBy.get(f.name) ?? []), f.src.replace(/\r/g, "")]);

  const TAGGED = { start_test_attempt: 2, get_attempt_paper: 4, save_test_answer: 2, submit_test_attempt: 2 };
  const src0009 = read(path.join(MIGRATIONS, "0009_test_attempts.sql"));
  for (const [name, n] of Object.entries(TAGGED)) {
    const [src] = liveBy.get(name);
    const lines = src.split("\n");
    const tagged = lines.filter((l) => /(^|\s)-- 0015$/.test(l));
    assert.equal(tagged.length, n, `${name}: tagged line count`);
    const stripped = lines.filter((l) => !/(^|\s)-- 0015$/.test(l)).join("\n");
    assert.equal(stripped, defined.get(name), `${name}: body minus tagged lines == 0009`);
    assert.ok(src0009.includes(`create function public.${name}(`) && src0009.includes(stripped), `${name}: found verbatim in 0009_test_attempts.sql`);
  }
  // The logger keeps 0009's insert verbatim; the only addition is the throttle check.
  const logger = liveBy.get("log_test_security_event")[0];
  assert.ok(logger.includes("  insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)\n  values (p_type, auth.uid(), p_attempt_id, p_test_id, p_batch_id, p_student_id, coalesce(p_detail, '{}'::jsonb));"));
  assert.ok(defined.get("log_test_security_event").includes("values (p_type, auth.uid(), p_attempt_id, p_test_id, p_batch_id, p_student_id, coalesce(p_detail, '{}'::jsonb))"));

  const changed = [];
  let checked = 0;
  for (const [name, body] of defined) {
    if (!liveBy.has(name) || name in TAGGED || name === "log_test_security_event") continue;
    checked++;
    if (!liveBy.get(name).includes(body)) changed.push(name);
  }
  assert.deepEqual(changed, [], "no other function changed");
  assert.ok(checked > 80, `checked ${checked} functions`);
  for (const name of ["finalize_test_attempt", "get_attempt_result", "test_attempt_stop_reason", "staff_finalize_due_attempts", "student_available_tests",
    "finalize_lifecycle_attempts", "completion_eligibility", "issue_certificate", "revoke_certificate", "decide_completion", "recommend_completion"]) {
    assert.ok(defined.has(name) && liveBy.get(name)?.includes(defined.get(name)), `${name} unchanged`);
  }
});

test("D3. catalog drift vs 0014: only the new column, index, enum values and four new functions; grants, RLS, policies and triggers identical", async () => {
  const now = await catalog(db);
  const baseFns = baseCatalog.functions;
  const added = Object.keys(now.functions).filter((k) => !(k in baseFns)).sort();
  assert.deepEqual(added, [
    "record_attempt_client_event(uuid,text,jsonb)",
    "test_attempt_note_session(uuid,text)",
    "test_attempt_session_id()",
    "test_security_event_throttled(test_security_event_type,uuid,uuid,uuid,uuid)",
  ]);
  const drift = Object.keys(baseFns).filter((k) => now.functions[k] !== baseFns[k]);
  assert.deepEqual(drift, [], "every pre-existing function keeps its privileges, security mode, config and volatility");
  assert.deepEqual(now.tables, baseCatalog.tables);
  assert.deepEqual(now.policies, baseCatalog.policies);
  assert.deepEqual(now.triggers, baseCatalog.triggers);
  assert.deepEqual(now.indexes.filter((i) => !baseCatalog.indexes.includes(i)), ["test_security_events_actor_type_idx"]);
  assert.deepEqual(now.attempt_columns, [...baseCatalog.attempt_columns, "started_session_id:uuid:YES"]);
  assert.deepEqual(now.event_types, [...baseCatalog.event_types, ...NEW_EVENT_TYPES]);
});

// ---------------------------------------------------------------- E. hardening

test("E1. security definer, fixed search_path and execute privileges of every new or re-created function", async () => {
  const info = await db.admin(`select json_object_agg(p.proname, json_build_object('definer', p.prosecdef, 'config', p.proconfig,
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'public', p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('test_attempt_session_id', 'test_attempt_note_session', 'test_security_event_throttled',
      'log_test_security_event', 'start_test_attempt', 'get_attempt_paper', 'save_test_answer', 'submit_test_attempt', 'record_attempt_client_event')`);
  const cfg = ['search_path=""'];
  const expect = (definer, authenticated, service_role) => ({ definer, config: cfg, anon: false, authenticated, service_role, public: false });
  assert.deepEqual(info, {
    test_attempt_session_id: expect(false, false, true),
    test_attempt_note_session: expect(true, false, true),
    test_security_event_throttled: expect(true, false, true),
    log_test_security_event: expect(true, false, true),
    start_test_attempt: expect(true, true, true),
    get_attempt_paper: expect(true, true, true),
    save_test_answer: expect(true, true, true),
    submit_test_attempt: expect(true, true, true),
    record_attempt_client_event: expect(true, true, false),
  });
});

test("E2. clients cannot call the internal helpers or the logger", async () => {
  const student = as(W, W.ei_S3, randomUUID());
  const calls = [
    "select public.test_attempt_session_id()",
    `select public.test_attempt_note_session('${clientAttempt}', 'x')`,
    `select public.test_security_event_throttled('answer_saved', '${clientAttempt}', null, null, null)`,
    `select public.log_test_security_event('submit', '${clientAttempt}', null, null, null, '{}')`,
  ];
  for (const who of [student, clientFor(null), db.client({ role: "authenticated", userId: W.A })]) {
    for (const sql of calls) {
      const { error } = await who.execute(sql);
      assert.equal(error?.code, "42501", sql);
      assert.match(error.message, /permission denied for function/);
    }
  }
});

test("E3. preflight: 0015 refuses a database without 0009 and changes nothing there", async () => {
  const r = await empty.run(read(M0015));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Preflight failed: 0009 \(secure student test engine\) is not applied/);
  assert.equal(await empty.admin("select count(*) from pg_type where typname = 'test_security_event_type'"), 0);
});
