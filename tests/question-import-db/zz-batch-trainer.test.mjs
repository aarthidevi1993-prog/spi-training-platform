// Phase 7 P3.6 — batch trainer assignment: 0021 guard + the unchanged 0017 admin_assign_batch_trainer(),
// against the real database. Direct client writes of batches.trainer_id, creation with a trainer,
// the assignment function (refusals, audit, row lock), RLS for the old and new trainer, class sync,
// and 0021 on a 0020 database (read-only preflight report, re-run refused).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { clientFor, db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0021 = path.join(MIGRATIONS, "0021_batch_trainer_assignment_guard.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const UPGRADE_DB = "qi_bt_upgrade";

let P = {};
const as = (key) => db.client({ role: "authenticated", userId: P[key] ?? ids[key] });
const sa = () => as("A");
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const err = async (client, fn, args = {}) => (await client.rpc(fn, args)).error;
const trainerOf = (key) => db.admin(`select trainer_id from public.batches where id = '${P[key]}'`);
const assignEvents = (batchKey) =>
  db.admin(`select coalesce(json_agg(json_build_object('actor', actor_id, 'target', target_user_id, 'detail', detail) order by id), '[]')
              from public.user_admin_events where event_type = 'trainer_assignment_changed' and batch_id = '${P[batchKey]}'`);
let n = 0;
const code = () => `BT-${++n}-${Date.now().toString(36)}`;
/** A direct PostgREST-style INSERT of a batch by a client (Add Batch). */
function insertBatch(client, { id = randomUUID(), trainer = null, status = "upcoming" } = {}) {
  return client
    .execute(`insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
              values ('${id}', '${code()}', '${ids.C1}', ${trainer ? `'${trainer}'` : "null"}, 'BT batch', '2027-01-01', '2027-03-31', '${status}', 10)`)
    .then((r) => ({ ...r, id }));
}

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'bt_' || k, gen_random_uuid()
      from unnest(array['TA','TB','TC','TSUS','TINV','TINACT','STU','B1','B2','B3','BCOMP','BCANC','BRLS','BRACE','BRACE2']) k;
    insert into auth.users (id, email) select v, lower(k) || '@bt.test' from t.ids where k in ('bt_TA','bt_TB','bt_TC','bt_TSUS','bt_TINV','bt_TINACT','bt_STU');
    update public.profiles set role = 'trainer' where id in (select v from t.ids where k in ('bt_TA','bt_TB','bt_TC','bt_TSUS','bt_TINV','bt_TINACT'));
    update public.profiles set account_status = 'active' where id in (select v from t.ids where k in ('bt_TA','bt_TB','bt_TC','bt_TSUS','bt_TINACT','bt_STU'));
    insert into public.trainers (id, trainer_code, full_name) values
      (t.id('bt_TA'), 'BT-TA', 'BT Trainer A'), (t.id('bt_TB'), 'BT-TB', 'BT Trainer B'), (t.id('bt_TC'), 'BT-TC', 'BT Trainer C'),
      (t.id('bt_TSUS'), 'BT-TSUS', 'BT Suspended'), (t.id('bt_TINV'), 'BT-TINV', 'BT Invited'), (t.id('bt_TINACT'), 'BT-TINACT', 'BT Inactive');
    update public.trainers set status = 'inactive' where id = t.id('bt_TINACT');
    update public.profiles set account_status = 'suspended' where id = t.id('bt_TSUS');
    insert into public.students (id, student_code, full_name) values (t.id('bt_STU'), 'BT-STU', 'BT Student');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('bt_B1'),    'BT-B1',    t.id('C1'), null,          'BT unassigned', '2027-01-01', '2027-03-31', 'upcoming',  10),
      (t.id('bt_B2'),    'BT-B2',    t.id('C1'), t.id('bt_TA'), 'BT assigned',   '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('bt_B3'),    'BT-B3',    t.id('C1'), t.id('bt_TA'), 'BT update',     '2027-01-01', '2027-03-31', 'upcoming',  10),
      (t.id('bt_BCOMP'), 'BT-BCOMP', t.id('C1'), t.id('bt_TA'), 'BT completed',  '2025-01-01', '2025-06-30', 'completed', 10),
      (t.id('bt_BCANC'), 'BT-BCANC', t.id('C1'), t.id('bt_TA'), 'BT cancelled',  '2025-01-01', '2025-06-30', 'cancelled', 10),
      (t.id('bt_BRLS'),  'BT-BRLS',  t.id('C1'), t.id('bt_TA'), 'BT rls',        '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('bt_BRACE'), 'BT-BRACE', t.id('C1'), t.id('bt_TA'), 'BT race',       '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('bt_BRACE2'),'BT-BRACE2',t.id('C1'), t.id('bt_TA'), 'BT race 2',     '2026-01-01', '2026-12-31', 'ongoing',   10);`, ids.A);
  P = await db.admin("select json_object_agg(k, v) from t.ids");
});

after(async () => {
  await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
});

// ---------------------------------------------------------------- 0021: direct client writes

test("direct UPDATE of trainer_id by a client is refused — even for a Super Admin, even to null; other columns stay editable", async () => {
  for (const value of [`'${P.bt_TB}'`, "null"]) {
    const r = await sa().execute(`update public.batches set trainer_id = ${value} where id = '${P.bt_B3}'`);
    assert.equal(r.error?.code, "42501", value);
    assert.match(r.error.message, /admin_assign_batch_trainer/);
  }
  assert.equal(await trainerOf("bt_B3"), P.bt_TA, "unchanged");
  assert.equal((await sa().execute(`update public.batches set trainer_id = '${P.bt_B1}' where id = '${P.bt_B1}'`)).error?.code, "42501", "assigning on an unassigned batch too");
  assert.equal((await sa().execute(`update public.batches set name = 'BT renamed', trainer_id = trainer_id where id = '${P.bt_B3}'`)).error, null, "same trainer + other column: allowed");
  assert.equal(await db.admin(`select name from public.batches where id = '${P.bt_B3}'`), "BT renamed");
  // A trainer cannot change it either (RLS: not a writer; the row is simply not updated).
  await as("bt_TA").execute(`update public.batches set trainer_id = '${P.bt_TB}' where id = '${P.bt_B3}'`);
  assert.equal(await trainerOf("bt_B3"), P.bt_TA);
  // Privileged writers (SQL Editor / seed) are not affected.
  await db.exec(`update public.batches set trainer_id = t.id('bt_TB') where id = t.id('bt_B3'); update public.batches set trainer_id = t.id('bt_TA') where id = t.id('bt_B3');`);
  assert.equal(await trainerOf("bt_B3"), P.bt_TA);
});

test("client INSERT with a trainer: only an available trainer (active record, trainer role, active account); creation is audited", async () => {
  const before = await db.admin("select count(*) from public.user_admin_events where event_type = 'trainer_assignment_changed'");
  for (const key of ["bt_TINV", "bt_TSUS", "bt_TINACT", "bt_STU"]) {
    const r = await insertBatch(sa(), { trainer: P[key] });
    assert.equal(r.error?.code, "23514", key);
    assert.match(r.error.message, /not available/);
    assert.equal(await db.admin(`select count(*) from public.batches where id = '${r.id}'`), 0, `${key}: nothing inserted`);
    const hint = await db.run(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${ids.A}"}', false);
      insert into public.batches (batch_code, course_id, trainer_id, name, start_date, end_date, max_seats) values ('${code()}', '${ids.C1}', '${P[key]}', 'x', '2027-01-01', '2027-01-02', 1);`);
    assert.match(hint.stderr, /HINT:\s+trainer_not_available/, `${key}: the refusal carries the hint the app maps`);
  }
  assert.equal((await insertBatch(sa(), { trainer: randomUUID() })).error?.code, "23514", "unknown trainer");
  assert.equal(await db.admin("select count(*) from public.user_admin_events where event_type = 'trainer_assignment_changed'"), before, "refusals leave no audit");

  const ok = await insertBatch(sa(), { trainer: P.bt_TB });
  assert.equal(ok.error, null);
  assert.equal(await db.admin(`select trainer_id from public.batches where id = '${ok.id}'`), P.bt_TB);
  assert.deepEqual(await db.admin(`select json_agg(json_build_object('actor', actor_id, 'target', target_user_id, 'detail', detail)) from public.user_admin_events
                                     where event_type = 'trainer_assignment_changed' and batch_id = '${ok.id}'`),
    [{ actor: ids.A, target: P.bt_TB, detail: { from: null, to: P.bt_TB, source: "batch_created" } }]);

  const none = await insertBatch(sa(), {});
  assert.equal(none.error, null, "a batch without a trainer is still allowed");
  assert.equal(await db.admin(`select count(*) from public.user_admin_events where batch_id = '${none.id}'`), 0, "nothing to audit");

  // Non-admin clients still cannot insert batches at all (RLS), with or without a trainer.
  for (const key of ["bt_TA", "bt_STU"]) assert.equal((await insertBatch(as(key), { trainer: P.bt_TA })).error?.code, "42501", key);
  assert.equal((await insertBatch(clientFor(null), {})).error?.code, "42501", "anon");
});

// ---------------------------------------------------------------- the 0017 function (unchanged)

test("admin_assign_batch_trainer: assign, reassign, unchanged; completed/cancelled and unavailable trainers refused; audited", async () => {
  assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_B1, p_trainer_id: P.bt_TA }), { ok: true, previous: null, trainer_id: P.bt_TA });
  assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_B1, p_trainer_id: P.bt_TB }), { ok: true, previous: P.bt_TA, trainer_id: P.bt_TB });
  assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_B1, p_trainer_id: P.bt_TB }), { ok: false, reason: "unchanged" });
  assert.deepEqual((await assignEvents("bt_B1")).map((e) => e.detail), [{ from: null, to: P.bt_TA }, { from: P.bt_TA, to: P.bt_TB }]);
  assert.ok((await assignEvents("bt_B1")).every((e) => e.actor === ids.A));

  for (const key of ["bt_BCOMP", "bt_BCANC"]) {
    assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P[key], p_trainer_id: P.bt_TB }), { ok: false, reason: "batch_not_current" }, key);
    assert.equal(await trainerOf(key), P.bt_TA);
  }
  for (const key of ["bt_TINV", "bt_TSUS", "bt_TINACT", "bt_STU"]) {
    assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_B2, p_trainer_id: P[key] }), { ok: false, reason: "trainer_not_available" }, key);
  }
  assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_B2, p_trainer_id: null }), { ok: false, reason: "trainer_not_available" }, "no removal");
  assert.deepEqual(await call(sa(), "admin_assign_batch_trainer", { p_batch_id: randomUUID(), p_trainer_id: P.bt_TB }), { ok: false, reason: "not_found" });
  assert.equal(await trainerOf("bt_B2"), P.bt_TA, "refusals change nothing");
});

test("only a Super Admin may call it: trainers, students, invited/suspended accounts and anonymous callers are refused", async () => {
  for (const key of ["bt_TA", "bt_STU", "bt_TINV", "bt_TSUS"]) {
    assert.equal((await err(as(key), "admin_assign_batch_trainer", { p_batch_id: P.bt_B2, p_trainer_id: P.bt_TB }))?.code, "42501", key);
  }
  const anon = await err(clientFor(null), "admin_assign_batch_trainer", { p_batch_id: P.bt_B2, p_trainer_id: P.bt_TB });
  assert.equal(anon?.code, "42501");
  assert.match(anon.message, /permission denied for function/);
  assert.equal(await trainerOf("bt_B2"), P.bt_TA);
});

test("concurrent assignments are serialised by the row lock: same target → one ok + one unchanged; different targets → a consistent audit chain", async () => {
  const same = await Promise.all([0, 1].map(() => call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_BRACE, p_trainer_id: P.bt_TB })));
  assert.deepEqual(same.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["ok", "unchanged"]);
  assert.equal((await assignEvents("bt_BRACE")).length, 1, "audited exactly once");

  const diff = await Promise.all([P.bt_TB, P.bt_TC].map((tr) => call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_BRACE2, p_trainer_id: tr })));
  assert.ok(diff.every((r) => r.ok), JSON.stringify(diff));
  const chain = (await assignEvents("bt_BRACE2")).map((e) => e.detail);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].from, P.bt_TA);
  assert.equal(chain[1].from, chain[0].to, "the second saw the first's result (no lost update)");
  assert.equal(await trainerOf("bt_BRACE2"), chain[1].to);
});

test("after reassignment: the old trainer loses current-batch rights (history stays readable), the new one gains them; scheduled classes follow", async () => {
  await db.exec(`
    insert into public.classes (course_id, batch_id, trainer_id, title, class_date, start_time, end_time) values
      (t.id('C1'), t.id('bt_BRLS'), t.id('bt_TA'), 'BT taught', '2026-02-01', '09:00', '10:00'),
      (t.id('C1'), t.id('bt_BRLS'), t.id('bt_TA'), 'BT upcoming', '2026-12-01', '09:00', '10:00');
    update public.classes set status = 'completed' where batch_id = t.id('bt_BRLS') and title = 'BT taught';`, ids.A);
  const current = (key) => as(key).sql(`public.is_current_batch_trainer('${P.bt_BRLS}')`).then((r) => r.data);
  const sees = (key) => as(key).sql(`(select count(*) from public.batches where id = '${P.bt_BRLS}')`).then((r) => r.data);
  assert.deepEqual([await current("bt_TA"), await current("bt_TB")], [true, false]);

  assert.equal((await call(sa(), "admin_assign_batch_trainer", { p_batch_id: P.bt_BRLS, p_trainer_id: P.bt_TB })).ok, true);
  assert.deepEqual([await current("bt_TA"), await current("bt_TB")], [false, true], "rights move with the assignment");
  assert.equal(await sees("bt_TB"), 1, "the new trainer sees the batch");
  assert.equal(await sees("bt_TA"), 1, "the old trainer still reads it through the class they taught (0003 history rule)");
  assert.deepEqual(await db.admin(`select json_object_agg(title, trainer_id) from public.classes where batch_id = '${P.bt_BRLS}'`),
    { "BT taught": P.bt_TA, "BT upcoming": P.bt_TB }, "completed class keeps its trainer; scheduled class follows the batch");
  assert.equal(await sees("bt_TC"), 0, "an unrelated trainer sees nothing");
});

// ---------------------------------------------------------------- 0021 itself

test("hardening: both 0021 functions have search_path = '' and are not callable by clients; the guard is SECURITY INVOKER", async () => {
  const rows = await db.admin(`select json_agg(json_build_object('name', p.proname, 'definer', p.prosecdef, 'config', p.proconfig,
      'auth', has_function_privilege('authenticated', p.oid, 'execute'), 'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('batches_trainer_guard', 'batches_trainer_insert_audit')`);
  assert.deepEqual(rows, [
    { name: "batches_trainer_guard", definer: false, config: ["search_path=\"\""], auth: false, anon: false },
    { name: "batches_trainer_insert_audit", definer: true, config: ["search_path=\"\""], auth: false, anon: false },
  ]);
  assert.deepEqual(await db.admin(`select json_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.batches'::regclass and tgname like 'batches_trainer_%'`),
    ["batches_trainer_guard", "batches_trainer_insert_audit"]);
});

test("0021 on a 0020 database: unavailable assigned trainers are only reported; no row changes; re-running is refused", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [path.join(here, "fixtures/bootstrap.sql"), ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|20)_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)), path.join(here, "fixtures/seed.sql")]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  await up.exec(`
    insert into t.ids (k, v) select 'up_' || k, gen_random_uuid() from unnest(array['TS','B']) k;
    insert into auth.users (id) values (t.id('up_TS'));
    update public.profiles set role = 'trainer', account_status = 'active' where id = t.id('up_TS');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('up_TS'), 'UP-TS', 'Later suspended');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values (t.id('up_B'), 'UP-B', t.id('C1'), t.id('up_TS'), 'Up batch', '2026-01-01', '2026-12-31', 'ongoing', 10);
    update public.profiles set account_status = 'suspended' where id = t.id('up_TS');`);
  const snapshot = () => up.admin(`select json_agg(json_build_object('id', id, 'trainer', trainer_id, 'status', status, 'updated', updated_at) order by id) from public.batches`);
  const beforeRows = await snapshot();
  const beforeEvents = await up.admin("select count(*) from public.user_admin_events");

  r = await up.run(read(M0021));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /NOTICE:\s+(?:00000:\s+)?0021: 1 current batch\(es\) have an assigned trainer who is not available/);
  assert.deepEqual(await snapshot(), beforeRows, "no batch changed, nothing detached");
  assert.equal(await up.admin("select count(*) from public.user_admin_events"), beforeEvents, "nothing logged by the migration");

  r = await up.run(read(M0021));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0021 already applied/);
});

// ---------------------------------------------------------------- the real application modules

test("application path: the real repository/service (Super Admin session) list only available trainers and assign through the function", async () => {
  const build = process.env.QI_BUILD;
  const { createBatchTrainerRepository } = await import(`${build}/repositories/batch-trainer.repository.core.mjs`);
  const { createBatchTrainerService, BatchTrainerAuthorizationError } = await import(`${build}/services/batch-trainer.service.core.mjs`);
  const svcFor = (key, role) =>
    createBatchTrainerService({
      repository: createBatchTrainerRepository(async () => as(key)),
      getCurrentUser: async () => ({ id: P[key] ?? ids[key], email: "x@bt.test", fullName: key, role, isActive: true, createdAt: "2026-01-01" }),
    });
  const admin = svcFor("A", "admin");
  const listed = (await admin.listAvailableTrainers()).map((t) => t.id);
  for (const key of ["bt_TA", "bt_TB", "bt_TC"]) assert.ok(listed.includes(P[key]), `${key} listed`);
  for (const key of ["bt_TSUS", "bt_TINV", "bt_TINACT", "bt_STU"]) assert.ok(!listed.includes(P[key]), `${key} not listed`);

  const target = (await insertBatch(sa(), {})).id;
  assert.deepEqual(await admin.assignTrainer(target, P.bt_TC), { ok: true, message: "Trainer assigned." });
  assert.deepEqual(await admin.assignTrainer(target, P.bt_TB), { ok: true, message: "Trainer changed." });
  assert.deepEqual(await admin.assignTrainer(target, P.bt_TB), { ok: false, error: "This trainer is already assigned to the batch." });
  assert.deepEqual(await admin.assignTrainer(P.bt_BCOMP, P.bt_TB), { ok: false, error: "Only upcoming or ongoing batches can have their trainer changed." });
  assert.match((await admin.assignTrainer(target, P.bt_TSUS)).error, /isn't available/);
  assert.equal(await db.admin(`select trainer_id from public.batches where id = '${target}'`), P.bt_TB);

  // A trainer whose app role were wrongly resolved as admin is still refused by the database (42501 → permission message).
  assert.deepEqual(await svcFor("bt_TA", "admin").assignTrainer(target, P.bt_TC), { ok: false, error: "Only Super Admins can assign trainers to batches." });
  await assert.rejects(svcFor("bt_TA", "trainer").assignTrainer(target, P.bt_TC), BatchTrainerAuthorizationError);
  assert.equal(await db.admin(`select trainer_id from public.batches where id = '${target}'`), P.bt_TB);
});

test("batch list query (batches.repository.ts BATCH_LIST_SELECT): Super Admin sees each trainer's availability; a trainer sees only their own batches", async () => {
  const repoSrc = fs.readFileSync(path.resolve(here, "../../src/repositories/batches.repository.ts"), "utf8");
  const select = /const BATCH_LIST_SELECT = `([\s\S]*?)`;/.exec(repoSrc)[1].replace(/\s+/g, " ").trim();
  assert.match(select, /trainer_id/);
  assert.match(select, /trainers \( full_name, status, profiles \( role, account_status \) \)/);
  // An assigned trainer who is later suspended (privileged setup, as an operator might leave it).
  await db.exec(`update public.batches set trainer_id = t.id('bt_TC') where id = t.id('bt_B2');`);
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('bt_TC');`);
  try {
    const { data, error } = await sa().from("batches").select(select).eq("id", P.bt_B2).maybeSingle();
    assert.equal(error, null);
    assert.equal(data.trainer_id, P.bt_TC);
    assert.deepEqual([data.trainers.status, data.trainers.profiles.role, data.trainers.profiles.account_status], ["active", "trainer", "suspended"], "the Super Admin can tell the trainer is unavailable");
    const mine = await as("bt_TA").from("batches").select(select).eq("trainer_id", P.bt_TA);
    assert.equal(mine.error, null);
    assert.ok(mine.data.length > 0 && mine.data.every((b) => b.trainer_id === P.bt_TA), "the trainer reads their own assigned batches");
    assert.ok(mine.data.every((b) => b.trainers.profiles?.account_status === "active"), "their own profile is readable");
  } finally {
    await db.exec(`update public.profiles set account_status = 'active' where id = t.id('bt_TC'); update public.batches set trainer_id = t.id('bt_TA') where id = t.id('bt_B2');`);
  }
});
