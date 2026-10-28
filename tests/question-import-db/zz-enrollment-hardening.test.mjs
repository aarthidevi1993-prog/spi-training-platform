// Phase 7 P3.8 — enrolment hardening (0023) against the real database.
// G1: no direct client writes to batch_students (every role), SELECT unchanged, the SECURITY
// DEFINER paths (admin_set_enrollment, trainer_enroll_student, accept_user_invitation) and
// privileged writers still work, capacity / exit hook / history intact. G2: only an available
// student (active record, student role, active account) may be enrolled or re-enrolled; withdraw /
// complete stay possible; no information for an out-of-scope trainer; concurrency on the last
// seat; hardening; 0023 on a 0022 database (report only, no data change, re-run refused).
// Own fixtures only (eh_*, own course / batches / trainers); leaves no invited account behind.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { bindInvitation, clientFor, db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0023 = path.join(MIGRATIONS, "0023_enrollment_hardening.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const UPGRADE_DB = "qi_eh_upgrade";

let U = {};
const as = (key, sessionId) => db.client(sessionId ? { role: "authenticated", userId: U[key] ?? ids[key], sessionId } : { role: "authenticated", userId: U[key] ?? ids[key] });
const sa = () => as("A");
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const err = async (client, fn, args = {}) => (await client.rpc(fn, args)).error;
const enrol = (b, s, status = "enrolled") => call(sa(), "admin_set_enrollment", { p_batch_id: U[b], p_student_id: U[s], p_status: status });
const statusOf = (b, s) => db.admin(`select enrollment_status from public.batch_students where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const history = (b, s) => db.admin(`select coalesce(json_agg(json_build_object('prev', previous_status, 'new', new_status, 'source', source) order by id), '[]')
  from public.enrollment_events where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const audits = (s) => db.admin(`select count(*) from public.user_admin_events where event_type = 'enrollment_changed' and target_user_id = '${U[s]}'`);
const rows = async (client, query) => {
  const { data, error } = await client.sql(`(select coalesce(json_agg(x), '[]'::json) from (${query}) x)`);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
};

const STUDENTS = ["OK", "OK2", "OK3", "SUSP", "INV", "INACT", "TRROLE", "NOREC", "WD", "RACE1", "RACE2", "EXIT"];

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'eh_' || k, gen_random_uuid()
      from unnest(array['TR','TR2','ADM','C','B1','B2','BR','BX','BC','CL',
                        'OK','OK2','OK3','SUSP','INV','INACT','TRROLE','NOREC','WD','RACE1','RACE2','EXIT']) k;
    insert into auth.users (id, email) select v, lower(k) || '@eh.test' from t.ids
     where k in ('eh_TR','eh_TR2','eh_ADM','eh_OK','eh_OK2','eh_OK3','eh_SUSP','eh_INV','eh_INACT','eh_TRROLE','eh_NOREC','eh_WD','eh_RACE1','eh_RACE2','eh_EXIT');
    -- Everyone active first (records need an active-capable profile), states adjusted below.
    update public.profiles set account_status = 'active'
     where id in (select v from t.ids where k in ('eh_TR','eh_TR2','eh_ADM','eh_OK','eh_OK2','eh_OK3','eh_SUSP','eh_INV','eh_INACT','eh_TRROLE','eh_NOREC','eh_WD','eh_RACE1','eh_RACE2','eh_EXIT'));
    update public.profiles set role = 'trainer' where id in (t.id('eh_TR'), t.id('eh_TR2'));
    update public.profiles set role = 'super_admin' where id = t.id('eh_ADM');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('eh_TR'), 'EH-TR', 'EH Trainer'), (t.id('eh_TR2'), 'EH-TR2', 'EH Other Trainer');
    insert into public.students (id, student_code, full_name)
      select v, upper(k), 'EH ' || k from t.ids where k in ('eh_OK','eh_OK2','eh_OK3','eh_SUSP','eh_INV','eh_INACT','eh_TRROLE','eh_WD','eh_RACE1','eh_RACE2','eh_EXIT');
    insert into public.courses (id, course_code, title, level) values (t.id('eh_C'), 'EH-101', 'Enrolment Hardening', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('eh_B1'), 'EH-B1', t.id('eh_C'), t.id('eh_TR'),  'EH one',       '2026-01-01', '2026-12-31', 'ongoing',   20),
      (t.id('eh_B2'), 'EH-B2', t.id('eh_C'), t.id('eh_TR'),  'EH two',       '2026-01-01', '2026-12-31', 'ongoing',   20),
      (t.id('eh_BR'), 'EH-BR', t.id('eh_C'), t.id('eh_TR'),  'EH last seat', '2026-01-01', '2026-12-31', 'ongoing',   1),
      (t.id('eh_BX'), 'EH-BX', t.id('eh_C'), t.id('eh_TR2'), 'EH other',     '2026-01-01', '2026-12-31', 'ongoing',   20),
      (t.id('eh_BC'), 'EH-BC', t.id('eh_C'), t.id('eh_TR'),  'EH completed', '2025-01-01', '2025-06-30', 'completed', 20);
    -- Trainer scope: these students are already enrolled in the trainer's current batch B1.
    insert into public.batch_students (batch_id, student_id)
      select t.id('eh_B1'), v from t.ids where k in ('eh_OK','eh_OK2','eh_SUSP','eh_INV','eh_INACT','eh_TRROLE','eh_WD');
    -- States (privileged, like an operator): suspended, invited, inactive record, trainer role.
    update public.profiles set account_status = 'suspended' where id = t.id('eh_SUSP');
    update public.profiles set account_status = 'invited'   where id = t.id('eh_INV');
    update public.students set status = 'inactive' where id in (t.id('eh_INACT'), t.id('eh_TRROLE'));
    update public.profiles set role = 'trainer' where id = t.id('eh_TRROLE');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

after(async () => {
  await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
  const left = await db.admin(`select count(*) from public.profiles p join t.ids i on i.v = p.id where i.k like 'eh\\_%' and p.account_status = 'invited' and i.k <> 'eh_INV'`);
  assert.equal(left, 0, "no invited accounts left behind by this file (eh_INV is a deliberate fixture with a student record)");
});

// ---------------------------------------------------------------- G1

test("G1: direct INSERT / UPDATE / DELETE on batch_students are refused for Super Admin, trainer, student and anonymous", async () => {
  const before = await db.admin(`select md5(string_agg(batch_id::text || student_id::text || enrollment_status::text || coalesce(completed_at::text, ''), ',' order by batch_id, student_id)) from public.batch_students`);
  const eventsBefore = await db.admin("select count(*) from public.enrollment_events");
  const writes = [
    ["insert", `insert into public.batch_students (batch_id, student_id) values ('${U.eh_B2}', '${U.eh_OK3}')`],
    ["update status", `update public.batch_students set enrollment_status = 'withdrawn' where batch_id = '${U.eh_B1}' and student_id = '${U.eh_OK}'`],
    ["update other column", `update public.batch_students set enrolled_by = null, completed_at = now() where batch_id = '${U.eh_B1}' and student_id = '${U.eh_OK}'`],
    ["delete", `delete from public.batch_students where batch_id = '${U.eh_B1}' and student_id = '${U.eh_OK}'`],
  ];
  for (const [who, client] of [["Super Admin", sa()], ["trainer", as("eh_TR")], ["student", as("eh_OK")], ["anonymous", clientFor(null)]]) {
    for (const [label, sql] of writes) {
      const r = await client.execute(sql);
      assert.equal(r.error?.code, "42501", `${who} ${label}`);
      assert.match(r.error.message, /permission denied for table batch_students/, `${who} ${label}`);
    }
  }
  assert.equal(await db.admin(`select md5(string_agg(batch_id::text || student_id::text || enrollment_status::text || coalesce(completed_at::text, ''), ',' order by batch_id, student_id)) from public.batch_students`), before, "nothing changed");
  assert.equal(await db.admin("select count(*) from public.enrollment_events"), eventsBefore, "no history row");
});

test("G1: SELECT is unchanged — Super Admin all, trainer their non-withdrawn rows, student their own, anonymous nothing", async () => {
  const total = await db.admin("select count(*) from public.batch_students");
  assert.equal((await rows(sa(), "select 1 from public.batch_students")).length, total);
  const tr = await rows(as("eh_TR"), "select batch_id from public.batch_students");
  assert.ok(tr.length > 0 && tr.every((r) => [U.eh_B1, U.eh_B2, U.eh_BR, U.eh_BC].includes(r.batch_id)), "trainer: own batches only");
  const st = await rows(as("eh_OK"), "select student_id from public.batch_students");
  assert.ok(st.length > 0 && st.every((r) => r.student_id === U.eh_OK), "student: own rows only");
  const anon = await clientFor(null).sql("(select count(*) from public.batch_students)");
  assert.equal(anon.error?.code, "42501", "anonymous: no access");
});

test("G1: the functions still write — admin enrol / withdraw / re-enrol / complete, trainer in-scope enrolment — with history and audit", async () => {
  assert.deepEqual(await enrol("eh_B2", "eh_OK"), { ok: true, previous: null, status: "enrolled" });
  assert.deepEqual(await enrol("eh_B2", "eh_OK", "withdrawn"), { ok: true, previous: "enrolled", status: "withdrawn" });
  assert.deepEqual(await enrol("eh_B2", "eh_OK"), { ok: true, previous: "withdrawn", status: "enrolled" });
  assert.deepEqual(await enrol("eh_B2", "eh_OK", "completed"), { ok: true, previous: "enrolled", status: "completed" });
  assert.deepEqual((await history("eh_B2", "eh_OK")).map((h) => [h.prev, h.new, h.source]),
    [[null, "enrolled", "admin"], ["enrolled", "withdrawn", "admin"], ["withdrawn", "enrolled", "admin"], ["enrolled", "completed", "admin"]]);
  assert.deepEqual(await call(as("eh_TR"), "trainer_enroll_student", { p_batch_id: U.eh_B2, p_student_id: U.eh_OK2 }), { ok: true, status: "enrolled" });
  assert.deepEqual((await history("eh_B2", "eh_OK2")).at(-1), { prev: null, new: "enrolled", source: "trainer" });
  assert.ok((await audits("eh_OK2")) >= 1, "enrollment_changed audited");
});

test("G1: invitation acceptance still enrols (source invitation)", async () => {
  const inv = await call(sa(), "create_user_invitation", { p: { email: "eh.invitee@eh.test", role: "student", full_name: "EH Invitee", batch_id: U.eh_B1 } });
  await db.exec(`insert into t.ids values ('eh_ACC', gen_random_uuid()); insert into auth.users (id, email) values (t.id('eh_ACC'), 'eh.invitee@eh.test');`);
  U.eh_ACC = await db.admin("select v from t.ids where k = 'eh_ACC'");
  await bindInvitation(inv.invitation_id, U.eh_ACC); // 0029a: only the bound account accepts
  assert.deepEqual(await call(as("eh_ACC"), "accept_user_invitation"), { ok: true, role: "student", enrolled: true });
  assert.equal(await statusOf("eh_B1", "eh_ACC"), "enrolled");
  assert.deepEqual((await history("eh_B1", "eh_ACC")).at(-1), { prev: null, new: "enrolled", source: "invitation" });
  assert.ok(inv.code);
});

test("G1: privileged writers (SQL Editor / migrations) still write and are recorded as direct; capacity still enforced at the trigger", async () => {
  await db.run(`insert into public.batch_students (batch_id, student_id) values ('${U.eh_B2}', '${U.eh_OK3}');`);
  assert.equal(await statusOf("eh_B2", "eh_OK3"), "enrolled");
  assert.deepEqual((await history("eh_B2", "eh_OK3")).at(-1), { prev: null, new: "enrolled", source: "direct" });
  // Fill the 1-seat batch through the function, then a privileged over-capacity insert hits the 0003 trigger.
  assert.equal((await enrol("eh_BR", "eh_OK3")).ok, true);
  const over = await db.run(`insert into public.batch_students (batch_id, student_id) values ('${U.eh_BR}', '${U.eh_OK2}');`);
  assert.notEqual(over.code, 0);
  assert.match(over.stderr, /is full/);
  assert.deepEqual(await enrol("eh_BR", "eh_OK2"), { ok: false, reason: "batch_full" }, "function check");
  assert.deepEqual(await enrol("eh_BR", "eh_OK3", "withdrawn"), { ok: true, previous: "enrolled", status: "withdrawn" }, "free the seat again");
});

test("G1: the exit hook still finalises an in-progress attempt when a student is withdrawn through the function", async () => {
  assert.deepEqual(await enrol("eh_B1", "eh_EXIT"), { ok: true, previous: null, status: "enrolled" });
  const testId = randomUUID();
  await db.exec(`
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time)
      values (t.id('eh_CL'), t.id('eh_C'), t.id('eh_B1'), t.id('eh_TR'), 'EH class', current_date, '09:00', '10:00');
    insert into t.ids values ('eh_q1', public.save_question(t.p(t.id('eh_C'), 'true_false', 1, t.opts('True*','False'), 'EH: valves can fail open.')));
    select public.set_question_status(t.id('eh_q1'), 'active');`, ids.A);
  await db.exec(`
    insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
    values ('${testId}', t.id('eh_CL'), t.id('eh_B1'), 'quiz', 'EH exit test', 50, 30, 1, now() - interval '1 minute', now() + interval '2 hours', t.id('eh_TR'), t.id('eh_TR'));
    select public.add_test_questions('${testId}', array[t.id('eh_q1')]);
    update public.tests set status = 'active' where id = '${testId}';`, U.eh_TR);
  const started = await call(as("eh_EXIT", randomUUID()), "start_test_attempt", { p_test_id: testId });
  const attemptId = started.attempt_id;
  assert.equal(await db.admin(`select status from public.test_attempts where id = '${attemptId}'`), "in_progress");
  assert.deepEqual(await enrol("eh_B1", "eh_EXIT", "withdrawn"), { ok: true, previous: "enrolled", status: "withdrawn" });
  assert.equal(await db.admin(`select finalize_reason from public.test_attempts where id = '${attemptId}'`), "withdrawn");
  assert.notEqual(await db.admin(`select status from public.test_attempts where id = '${attemptId}'`), "in_progress");
});

// ---------------------------------------------------------------- G2

test("G2: the availability matrix — admin_set_enrollment refuses every unavailable student and writes nothing", async () => {
  const eventsBefore = await db.admin("select count(*) from public.enrollment_events");
  const auditBefore = await db.admin("select count(*) from public.user_admin_events where event_type = 'enrollment_changed'");
  for (const [key, reason] of [["SUSP", "student_not_available"], ["INV", "student_not_available"], ["INACT", "student_not_available"], ["TRROLE", "student_not_available"], ["NOREC", "not_found"], ["ADM", "not_found"]]) {
    assert.deepEqual(await call(sa(), "admin_set_enrollment", { p_batch_id: U.eh_B2, p_student_id: U[`eh_${key}`], p_status: "enrolled" }), { ok: false, reason }, key);
    assert.equal(await statusOf("eh_B2", `eh_${key}`), null, `${key}: not enrolled`);
  }
  assert.deepEqual(await enrol("eh_B2", "eh_WD"), { ok: true, previous: null, status: "enrolled" }, "active student + active account: allowed");
  assert.equal(await db.admin("select count(*) from public.enrollment_events"), eventsBefore + 1, "only the allowed enrolment wrote history");
  assert.equal(await db.admin("select count(*) from public.user_admin_events where event_type = 'enrollment_changed'"), auditBefore + 1);
});

test("G2: trainer_enroll_student refuses unavailable in-scope students; an out-of-scope trainer gets 42501 whatever the student's state", async () => {
  for (const key of ["SUSP", "INV", "INACT", "TRROLE"]) {
    assert.deepEqual(await call(as("eh_TR"), "trainer_enroll_student", { p_batch_id: U.eh_B2, p_student_id: U[`eh_${key}`] }), { ok: false, reason: "student_not_available" }, key);
    assert.equal(await statusOf("eh_B2", `eh_${key}`), null);
  }
  // eh_TR2 teaches BX only; none of these students are in TR2's scope → the same 42501 for available and unavailable.
  for (const key of ["OK", "SUSP", "INACT"]) {
    const e = await err(as("eh_TR2"), "trainer_enroll_student", { p_batch_id: U.eh_BX, p_student_id: U[`eh_${key}`] });
    assert.equal(e?.code, "42501", key);
    assert.match(e.message, /You can only enrol your current students/, key);
  }
});

test("G2: withdrawal and completion stay possible for a student who became unavailable; re-enrolment is refused", async () => {
  // eh_WD: enrolled in B1 (fixture) and B2 (above); now suspended.
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('eh_WD');`);
  assert.deepEqual(await enrol("eh_B1", "eh_WD", "withdrawn"), { ok: true, previous: "enrolled", status: "withdrawn" });
  assert.deepEqual(await enrol("eh_B2", "eh_WD", "completed"), { ok: true, previous: "enrolled", status: "completed" });
  assert.deepEqual(await enrol("eh_B1", "eh_WD"), { ok: false, reason: "student_not_available" }, "withdrawn → enrolled refused while unavailable");
  assert.equal(await statusOf("eh_B1", "eh_WD"), "withdrawn");
  await db.exec(`update public.profiles set account_status = 'active' where id = t.id('eh_WD');`);
  assert.deepEqual(await enrol("eh_B1", "eh_WD"), { ok: true, previous: "withdrawn", status: "enrolled" }, "allowed again once available");
});

test("G2 unchanged rules: batch status, transitions, cancelled/completed batches and capacity behave exactly as before", async () => {
  assert.deepEqual(await enrol("eh_BC", "eh_OK3"), { ok: false, reason: "batch_not_current" });
  assert.deepEqual(await enrol("eh_B2", "eh_OK"), { ok: false, reason: "transition_not_allowed" }, "completed is final");
  assert.deepEqual(await enrol("eh_B1", "eh_OK"), { ok: false, reason: "unchanged" });
  assert.equal((await err(as("eh_OK"), "admin_set_enrollment", { p_batch_id: U.eh_B2, p_student_id: U.eh_OK3, p_status: "enrolled" }))?.code, "42501", "students cannot call it");
  assert.equal((await err(as("eh_TR"), "admin_set_enrollment", { p_batch_id: U.eh_B2, p_student_id: U.eh_OK3, p_status: "enrolled" }))?.code, "42501", "trainers cannot call it");
  assert.equal((await err(clientFor(null), "admin_set_enrollment", { p_batch_id: U.eh_B2, p_student_id: U.eh_OK3, p_status: "enrolled" }))?.code, "42501");
});

test("concurrency: two simultaneous enrolments into the last free seat → exactly one ok and one batch_full", async () => {
  assert.equal(await db.admin(`select count(*) from public.batch_students where batch_id = '${U.eh_BR}' and enrollment_status <> 'withdrawn'`), 0, "one free seat");
  const results = await Promise.all(["eh_RACE1", "eh_RACE2"].map((s) => enrol("eh_BR", s)));
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["batch_full", "ok"]);
  assert.equal(await db.admin(`select count(*) from public.batch_students where batch_id = '${U.eh_BR}' and enrollment_status <> 'withdrawn'`), 1, "never over max_seats");
});

// ---------------------------------------------------------------- 0023 itself

test("hardening: both replaced functions keep SECURITY DEFINER, search_path = '' and grants; authenticated has SELECT only on batch_students", async () => {
  const fns = await db.admin(`select json_agg(json_build_object('name', p.proname, 'definer', p.prosecdef, 'config', p.proconfig,
      'auth', has_function_privilege('authenticated', p.oid, 'execute'), 'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_set_enrollment', 'trainer_enroll_student')`);
  assert.deepEqual(fns, [
    { name: "admin_set_enrollment", definer: true, config: ["search_path=\"\""], auth: true, anon: false },
    { name: "trainer_enroll_student", definer: true, config: ["search_path=\"\""], auth: true, anon: false },
  ]);
  assert.deepEqual(await db.admin(`select json_build_object(
      'select', has_table_privilege('authenticated', 'public.batch_students', 'SELECT'),
      'insert', has_table_privilege('authenticated', 'public.batch_students', 'INSERT'),
      'update', has_table_privilege('authenticated', 'public.batch_students', 'UPDATE'),
      'delete', has_table_privilege('authenticated', 'public.batch_students', 'DELETE'),
      'anon_select', has_table_privilege('anon', 'public.batch_students', 'SELECT'),
      'service_insert', has_table_privilege('service_role', 'public.batch_students', 'INSERT'))`),
    { select: true, insert: false, update: false, delete: false, anon_select: false, service_insert: true });
  assert.deepEqual(await db.admin(`select json_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.batch_students'::regclass and not tgisinternal`),
    ["batch_students_enforce_capacity", "batch_students_finalize_attempts_on_exit", "batch_students_record_event", "batch_students_set_updated_at"], "existing triggers kept, none added");
});

test("0023 on a 0022 database: report only (unavailable enrolments kept), no data change, re-run refused", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [path.join(here, "fixtures/bootstrap.sql"), ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2[0-2])_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)), path.join(here, "fixtures/seed.sql")]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  // A current enrolment of a student who is suspended afterwards (legitimate: suspension keeps enrolments).
  await up.exec(`
    insert into t.ids values ('up_S', gen_random_uuid());
    insert into auth.users (id) values (t.id('up_S'));
    update public.profiles set account_status = 'active' where id = t.id('up_S');
    insert into public.students (id, student_code, full_name) values (t.id('up_S'), 'UP-S', 'Up Student');
    insert into public.batch_students (batch_id, student_id) select id, t.id('up_S') from public.batches where batch_code = 'B1';
    update public.profiles set account_status = 'suspended' where id = t.id('up_S');`);
  const snapshot = () => up.admin(`select json_build_object(
      'bs', (select md5(string_agg(batch_id::text || student_id::text || enrollment_status::text || updated_at::text, ',' order by batch_id, student_id)) from public.batch_students),
      'ev', (select count(*) from public.enrollment_events), 'ua', (select count(*) from public.user_admin_events),
      'profiles', (select md5(string_agg(id::text || role::text || account_status::text, ',' order by id)) from public.profiles),
      'students', (select md5(string_agg(id::text || status::text, ',' order by id)) from public.students))`);
  const before = await snapshot();
  r = await up.run(read(M0023));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /0023: 1 current enrolment\(s\) belong to a suspended\/invited account/);
  assert.deepEqual(await snapshot(), before, "no row changed, nothing logged");
  assert.equal(await up.admin("select has_table_privilege('authenticated', 'public.batch_students', 'INSERT')"), false);
  r = await up.run(read(M0023));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0023 already applied/);
});
