// Trainer organization & designation (0022) against the real database: invitation → acceptance
// copies both fields (or null), admin_update_trainer edits/audits them with the student's rules,
// the real users repository reads them, the replaced functions keep their security settings, and
// 0022 on a 0021 database leaves existing trainers valid (null) and refuses a re-run.
// Leaves no invited account behind (every invitee is accepted): the database is shared.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { bindInvitation, clientFor, db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0022 = path.join(MIGRATIONS, "0022_trainer_organization_designation.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const UPGRADE_DB = "qi_tp_upgrade";
const build = process.env.QI_BUILD;
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);

let U = {};
const admin = () => db.client({ role: "authenticated", userId: ids.A });
const as = (key) => db.client({ role: "authenticated", userId: U[key] });
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const err = async (client, fn, args = {}) => (await client.rpc(fn, args)).error;
const details = (key) =>
  db.admin(`select to_json(x) from (select organization, designation, phone, specializations from public.trainer_details where trainer_id = '${U[key]}') x`);
const lastDetailsEvent = (key) =>
  db.admin(`select detail from public.user_admin_events where event_type = 'user_details_changed' and target_user_id = '${U[key]}' order by id desc limit 1`);

/** Invite (as the seed Super Admin), create the invitee's auth user, accept as the invitee. */
async function inviteAndAccept(key, p) {
  const inv = await call(admin(), "create_user_invitation", { p });
  await db.exec(`insert into t.ids values ('${key}', gen_random_uuid()); insert into auth.users (id, email) values (t.id('${key}'), lower('${p.email}'));`);
  U[key] = await db.admin(`select v from t.ids where k = '${key}'`);
  await bindInvitation(inv.invitation_id, U[key]); // 0029a: only the bound account accepts
  const accepted = await call(as(key), "accept_user_invitation");
  return { inv, accepted };
}

before(async () => {
  U = {};
});

after(async () => {
  await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
  const left = await db.admin(`select count(*) from public.profiles p join t.ids i on i.v = p.id where i.k like 'tp%' and p.account_status = 'invited'`);
  assert.equal(left, 0, "no invited accounts left behind by this file");
});

// ---------------------------------------------------------------- invitation → acceptance

test("trainer invitation with organization/designation: acceptance copies both into trainer_details; trainer code still automatic", async () => {
  const { inv, accepted } = await inviteAndAccept("tp_T1", {
    email: "tp.full@tp.test", role: "trainer", full_name: "TP Full", phone: "555", organization: "  Acme Controls ", designation: "Lead Trainer", specializations: ["PLC"],
  });
  assert.deepEqual(accepted, { ok: true, role: "trainer", enrolled: false });
  assert.match(inv.code, /^TRN-\d{5,}$/);
  assert.deepEqual(await details("tp_T1"), { organization: "Acme Controls", designation: "Lead Trainer", phone: "555", specializations: ["PLC"] });
  assert.equal(await db.admin(`select trainer_code from public.trainers where id = '${U.tp_T1}'`), inv.code);
});

test("trainer invitation without organization/designation: acceptance stores null", async () => {
  await inviteAndAccept("tp_T2", { email: "tp.plain@tp.test", role: "trainer", full_name: "TP Plain" });
  assert.deepEqual(await details("tp_T2"), { organization: null, designation: null, phone: null, specializations: [] });
});

test("student acceptance is unchanged: organization/designation still land in student_details", async () => {
  await inviteAndAccept("tp_S1", { email: "tp.student@tp.test", role: "student", full_name: "TP Student", organization: "Plant A", designation: "Operator" });
  assert.deepEqual(await db.admin(`select to_json(x) from (select organization, designation from public.student_details where student_id = '${U.tp_S1}') x`),
    { organization: "Plant A", designation: "Operator" });
  assert.equal(await db.admin(`select count(*) from public.trainer_details where trainer_id = '${U.tp_S1}'`), 0);
});

// ---------------------------------------------------------------- admin_update_trainer

test("admin_update_trainer: sets, persists and audits organization/designation; blank → null; over 200 refused; other fields untouched", async () => {
  assert.deepEqual(await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: " Beta Ltd ", designation: "Senior Trainer" } }),
    { ok: true, fields: ["organization", "designation"] });
  assert.deepEqual(await details("tp_T2"), { organization: "Beta Ltd", designation: "Senior Trainer", phone: null, specializations: [] });
  assert.deepEqual(await lastDetailsEvent("tp_T2"), { fields: ["organization", "designation"] });

  // Only the keys sent are written and audited (the application sends only changed fields).
  assert.deepEqual(await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { bio: "Hi" } }), { ok: true, fields: ["bio"] });
  assert.deepEqual(await details("tp_T2"), { organization: "Beta Ltd", designation: "Senior Trainer", phone: null, specializations: [] }, "untouched");

  // Blank clears to null.
  assert.deepEqual(await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: "   ", designation: "" } }), { ok: true, fields: ["organization", "designation"] });
  assert.deepEqual([(await details("tp_T2")).organization, (await details("tp_T2")).designation], [null, null]);

  // 200 allowed; 201 refused with the existing validation error; nothing written on refusal.
  assert.equal((await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: "o".repeat(200) } })).ok, true);
  const tooLong = await err(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { designation: "d".repeat(201) } });
  assert.equal(tooLong?.code, "22023");
  assert.match(tooLong.message, /designation is too long \(at most 200 characters\)/);
  assert.equal((await details("tp_T2")).designation, null);

  // Existing behaviour kept: unknown keys and wrong types refused; full name, specializations, bio still work.
  assert.equal((await err(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { batch_id: ids.A } }))?.code, "22023");
  assert.equal((await err(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { specializations: "PLC" } }))?.code, "22023");
  assert.deepEqual(await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { full_name: "TP Renamed", specializations: ["DCS"] } }),
    { ok: true, fields: ["full_name", "specializations"] });
});

test("admin_update_trainer authorization unchanged: trainers, students and anonymous callers are refused", async () => {
  for (const key of ["tp_T1", "tp_S1"]) {
    assert.equal((await err(as(key), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: "X" } }))?.code, "42501", key);
  }
  const anon = await err(clientFor(null), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: "X" } });
  assert.equal(anon?.code, "42501");
  assert.notEqual((await details("tp_T2")).organization, "X");
});

test("the real users repository reads trainer organization/designation for the detail panel", async () => {
  await call(admin(), "admin_update_trainer", { p_trainer_id: U.tp_T2, p: { organization: "Gamma", designation: "Coach" } });
  const repo = createUsersRepository(async () => admin());
  const row = await repo.getProfile(U.tp_T2);
  const t = Array.isArray(row.trainers) ? row.trainers[0] : row.trainers;
  const d = Array.isArray(t.trainer_details) ? t.trainer_details[0] : t.trainer_details;
  assert.deepEqual([d.organization, d.designation], ["Gamma", "Coach"]);
});

// ---------------------------------------------------------------- 0022 itself

test("hardening: both replaced functions keep SECURITY DEFINER, search_path = '' and their grants", async () => {
  const rows = await db.admin(`select json_agg(json_build_object('name', p.proname, 'definer', p.prosecdef, 'config', p.proconfig,
      'auth', has_function_privilege('authenticated', p.oid, 'execute'), 'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('accept_user_invitation', 'admin_update_trainer')`);
  assert.deepEqual(rows, [
    { name: "accept_user_invitation", definer: true, config: ["search_path=\"\""], auth: true, anon: false },
    { name: "admin_update_trainer", definer: true, config: ["search_path=\"\""], auth: true, anon: false },
  ]);
  assert.deepEqual(await db.admin(`select json_agg(json_build_object('col', column_name, 'nullable', is_nullable, 'type', data_type, 'default', column_default) order by column_name)
      from information_schema.columns where table_schema = 'public' and table_name = 'trainer_details' and column_name in ('organization', 'designation')`),
    [{ col: "designation", nullable: "YES", type: "text", default: null }, { col: "organization", nullable: "YES", type: "text", default: null }]);
});

test("0022 on a 0021 database: existing trainers stay valid with null, nothing else changes, re-running is refused", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [path.join(here, "fixtures/bootstrap.sql"), ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2[01])_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)), path.join(here, "fixtures/seed.sql")]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  await up.exec(`insert into public.trainer_details (trainer_id, email, phone, specializations, bio) values (t.id('T1'), 't1@up.test', '111', '{PLC}', 'Bio')`);
  const snapshot = () => up.admin(`select json_build_object(
      'details', (select json_agg(json_build_object('t', trainer_id, 'e', email, 'p', phone, 's', specializations, 'b', bio, 'u', updated_at) order by trainer_id) from public.trainer_details),
      'trainers', (select json_agg(json_build_object('id', id, 'code', trainer_code, 'status', status) order by id) from public.trainers),
      'students', (select count(*) from public.student_details), 'events', (select count(*) from public.user_admin_events))`);
  const before = await snapshot();

  r = await up.run(read(M0022));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await snapshot(), before, "no existing row changed, nothing logged");
  assert.deepEqual(await up.admin(`select json_build_object('o', organization, 'd', designation) from public.trainer_details where trainer_id = (select v from t.ids where k = 'T1')`),
    { o: null, d: null }, "existing trainers: null");

  r = await up.run(read(M0022));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0022 already applied/);
});
