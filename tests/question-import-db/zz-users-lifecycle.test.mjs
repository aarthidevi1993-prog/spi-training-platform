// Integration (Phase 7 P3.3): user lifecycle actions — the real users repository/service cores
// calling the 0017/0018 functions on the local 0001–0018 database, each caller on their own session.
// Suspend / reactivate, role changes (records kept, never deleted), detail edits, self-protection,
// the last-active-Super-Admin rule under a real concurrent change, audit rows stamped by the
// database, refusal for trainers, students, signed-out and suspended callers, and the 0018 activation
// guard (invited accounts change only through acceptance), including the upgrade path from 0017.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { clientFor, db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createUsersRepository, UsersFunctionError } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService, UsersAuthorizationError, UsersActionError } = await import(`${build}/services/users.service.core.mjs`);
const L = await import(`${build}/lib/user-management/lifecycle.mjs`);
const { fetchProfileRole } = await import(`${build}/lib/auth/profile-role.mjs`);

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const RACE_DB = "qi_lc_race";
const UPGRADE_DB = "qi_lc_upgrade";

let W; // ids
const quiet = async (fn) => {
  const saved = [console.warn, console.error];
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.warn, console.error] = saved;
  }
};
/** The service exactly as wired in the app: identity from the session's own profile lookup. */
function serviceAs(database, id) {
  const client = id ? database.client({ role: "authenticated", userId: id }) : clientFor(null);
  return createUsersService({
    repository: createUsersRepository(async () => client),
    getCurrentUser: async () => {
      if (!id) return null;
      const role = await quiet(() => fetchProfileRole(client, id));
      return role ? { id, email: "x@test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" } : null;
    },
  });
}
const as = (id) => serviceAs(db, id);
const state = (id) =>
  db.admin(`select json_build_object('role', p.role, 'account', p.account_status,
      'student', (select s.status from public.students s where s.id = p.id),
      'trainer', (select t.status from public.trainers t where t.id = p.id)) from public.profiles p where p.id = '${id}'`);
const events = (id) =>
  db.admin(`select coalesce(json_agg(json_build_object('type', event_type, 'actor', actor_id, 'detail', detail) order by id), '[]'::json)
              from public.user_admin_events where target_user_id = '${id}'`);
const rejectsWith = (promise, message) => assert.rejects(promise, (e) => e instanceof UsersActionError && e.message === message);

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'lc_' || k, gen_random_uuid() from unnest(array['SA','SA2','SA3','S1','S2','INV','T']) k;
    insert into auth.users (id) select v from t.ids where k like 'lc\\_%';
    update auth.users set email = lower(k) || '@lc.test' from t.ids where t.ids.v = auth.users.id and k like 'lc\\_%';
    update public.profiles set role = 'super_admin' where id in (t.id('lc_SA'), t.id('lc_SA2'), t.id('lc_SA3'));
    update public.profiles set role = 'trainer' where id = t.id('lc_T');
    update public.profiles set account_status = 'active' where id in (select v from t.ids where k like 'lc\\_%' and k <> 'lc_INV');
    insert into public.students (id, student_code, full_name) values (t.id('lc_S1'), 'LC-S1', 'Lc Student One'), (t.id('lc_S2'), 'LC-S2', 'Lc Student Two');
    insert into public.student_details (student_id, email, phone) values (t.id('lc_S1'), 'lc_s1@lc.test', '111'), (t.id('lc_S2'), 'lc_s2@lc.test', null);
    insert into public.trainers (id, trainer_code, full_name) values (t.id('lc_T'), 'LC-T', 'Lc Trainer');
    insert into public.trainer_details (trainer_id, email, specializations) values (t.id('lc_T'), 'lc_t@lc.test', '{PLC}');
    insert into public.batch_students (batch_id, student_id) select id, t.id('lc_S2') from public.batches where batch_code = 'B1';`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

after(async () => {
  await db.run(`drop database if exists ${RACE_DB} with (force);\ndrop database if exists ${UPGRADE_DB} with (force);`);
});

test("suspend → reactivate: access follows account status; person status untouched; each change audited by the database", async () => {
  const svc = as(W.lc_SA);
  const student = db.client({ role: "authenticated", userId: W.lc_S1 });
  assert.equal(await quiet(() => fetchProfileRole(student, W.lc_S1)), "student");

  assert.match(await svc.setAccountStatus(W.lc_S1, "suspended", "  Left the programme  "), /suspended/i);
  assert.deepEqual(await state(W.lc_S1), { role: "student", account: "suspended", student: "active", trainer: null });
  assert.equal(await quiet(() => fetchProfileRole(student, W.lc_S1)), null, "the same session loses access immediately");
  await rejectsWith(svc.setAccountStatus(W.lc_S1, "suspended", null), L.STATUS_REASON_MESSAGE.unchanged);

  assert.match(await svc.setAccountStatus(W.lc_S1, "active", null), /reactivated/i);
  assert.deepEqual(await state(W.lc_S1), { role: "student", account: "active", student: "active", trainer: null });
  assert.equal(await quiet(() => fetchProfileRole(student, W.lc_S1)), "student");

  const ev = await events(W.lc_S1);
  assert.deepEqual(ev.map((e) => [e.type, e.actor, e.detail.from, e.detail.to, e.detail.reason]), [
    ["account_status_changed", W.lc_SA, "active", "suspended", "Left the programme"],
    ["account_status_changed", W.lc_SA, "suspended", "active", null],
  ]);
  const detail = await svc.getUserDetail(W.lc_S1);
  assert.deepEqual(detail.history.map((h) => [h.summary, h.actor]), [
    ["Account status: Suspended → Active", "you"],
    ["Account status: Active → Suspended — “Left the programme”", "you"],
  ]);
});

test("invited accounts: neither activated nor suspended by an administrator — only invitation acceptance changes them (0018)", async () => {
  const svc = as(W.lc_SA);
  await rejectsWith(svc.setAccountStatus(W.lc_INV, "active", null), L.STATUS_REASON_MESSAGE.transition_not_allowed);
  await rejectsWith(svc.setAccountStatus(W.lc_INV, "suspended", "no longer needed"), L.STATUS_REASON_MESSAGE.transition_not_allowed);
  assert.equal((await state(W.lc_INV)).account, "invited");
  // The two-step path (invited → suspended → active) is closed at its first step, also when called directly.
  const direct = createUsersRepository(async () => db.client({ role: "authenticated", userId: W.lc_SA }));
  assert.deepEqual(await direct.setAccountStatus(W.lc_INV, "suspended", null), { ok: false, reason: "transition_not_allowed" });
  assert.deepEqual(await direct.setAccountStatus(W.lc_INV, "active", null), { ok: false, reason: "transition_not_allowed" });
  assert.equal((await state(W.lc_INV)).account, "invited");
  await rejectsWith(svc.changeRole(W.lc_INV, "trainer", { fullName: "Lc Invited" }), L.ROLE_REASON_MESSAGE.account_not_active);
  assert.deepEqual(await events(W.lc_INV), [], "refusals write no audit rows");
  const detail = await svc.getUserDetail(W.lc_INV);
  assert.deepEqual([detail.user.recordState, detail.actions.suspend, detail.actions.reactivate, detail.actions.changeRole], ["missing", false, false, false]);
});

test("self-protection: a Super Admin cannot suspend or demote their own account", async () => {
  const svc = as(W.lc_SA);
  await rejectsWith(svc.setAccountStatus(W.lc_SA, "suspended", null), L.STATUS_REASON_MESSAGE.cannot_change_self);
  await rejectsWith(svc.changeRole(W.lc_SA, "student", { fullName: "Me" }), L.ROLE_REASON_MESSAGE.cannot_change_self);
  assert.deepEqual(await state(W.lc_SA), { role: "super_admin", account: "active", student: null, trainer: null });
  assert.deepEqual(await events(W.lc_SA), []);
  const detail = await svc.getUserDetail(W.lc_SA);
  assert.deepEqual([detail.isSelf, detail.actions.suspend, detail.actions.changeRole], [true, false, false]);
});

test("role change: Student → Trainer creates the trainer record and keeps the student record (inactive); back again reactivates it", async () => {
  const svc = as(W.lc_SA);
  await rejectsWith(svc.changeRole(W.lc_S1, "trainer", null), "A full name is needed to create the trainer record.");
  assert.equal((await state(W.lc_S1)).role, "student", "refused before the database call");

  const changed = await svc.changeRole(W.lc_S1, "trainer", { code: "FORGED", fullName: "Lc Student One" });
  assert.match(changed, /^Role changed to Trainer\. Trainer code: TRN-\d{5,}\.$/, "the generated code is reported");
  const generated = await db.admin(`select trainer_code from public.trainers where id = '${W.lc_S1}'`);
  assert.equal(changed, `Role changed to Trainer. Trainer code: ${generated}.`, "a browser-supplied code is never used (0020)");
  assert.deepEqual(await state(W.lc_S1), { role: "trainer", account: "active", student: "inactive", trainer: "active" });
  assert.equal(await db.admin(`select email from public.trainer_details where trainer_id = '${W.lc_S1}'`), "lc_s1@lc.test", "email from the account, not the browser");
  assert.equal(await quiet(() => fetchProfileRole(db.client({ role: "authenticated", userId: W.lc_S1 }), W.lc_S1)), "trainer");

  assert.equal(await svc.changeRole(W.lc_S1, "student", { fullName: "Ignored" }), "Role changed to Student.");
  assert.deepEqual(await state(W.lc_S1), { role: "student", account: "active", student: "active", trainer: "inactive" });
  assert.equal(await db.admin(`select student_code from public.students where id = '${W.lc_S1}'`), "LC-S1", "the original record, reactivated");
  assert.equal(await db.admin(`select count(*) from public.trainers where id = '${W.lc_S1}'`), 1, "the trainer record is kept, not deleted");

  const roles = (await events(W.lc_S1)).filter((e) => e.type === "role_changed");
  assert.deepEqual(roles.map((e) => [e.actor, e.detail.from, e.detail.to, e.detail.domain_record_created]), [
    [W.lc_SA, "student", "trainer", true],
    [W.lc_SA, "trainer", "student", false],
  ]);
});

test("role change is refused while the old role has live responsibilities, with a safe message and no change", async () => {
  const svc = as(W.lc_SA);
  await rejectsWith(svc.changeRole(W.lc_S2, "admin", null), L.ROLE_REASON_MESSAGE.has_active_enrollments);
  assert.deepEqual(await state(W.lc_S2), { role: "student", account: "active", student: "active", trainer: null });
  await rejectsWith(svc.changeRole(W.T1, "student", { fullName: "T One" }), L.ROLE_REASON_MESSAGE.has_current_batches);
  assert.equal((await state(W.T1)).role, "trainer");
  assert.deepEqual(await state(W.lc_SA2), { role: "super_admin", account: "active", student: null, trainer: null });
  assert.deepEqual(await events(W.lc_S2), []);
  assert.deepEqual(await events(W.lc_SA2), []);
});

test("another Super Admin can be demoted while one stays active (record created, audited)", async () => {
  const svc = as(W.lc_SA);
  assert.match(await svc.changeRole(W.lc_SA2, "student", { fullName: "Former Admin" }), /^Role changed to Student\. Student code: STU-\d{5,}\.$/);
  assert.deepEqual(await state(W.lc_SA2), { role: "student", account: "active", student: "active", trainer: null });
  assert.ok((await db.admin("select count(*) from public.profiles where role = 'super_admin' and account_status = 'active'")) >= 1);
});

test("details: only changed fields are written and audited; email is never edited; invalid input changes nothing", async () => {
  const svc = as(W.lc_SA);
  const before = (await events(W.lc_T)).length;
  assert.equal(await svc.updateDetails(W.lc_T, { fullName: "Lc Trainer", phone: "555-0100", specializations: ["PLC", "DCS"], bio: "" }), "Details saved.");
  const row = await db.admin(`select json_build_object('phone', phone, 'specs', specializations, 'bio', bio, 'email', email) from public.trainer_details where trainer_id = '${W.lc_T}'`);
  assert.deepEqual(row, { phone: "555-0100", specs: ["PLC", "DCS"], bio: null, email: "lc_t@lc.test" });
  const ev = await events(W.lc_T);
  assert.equal(ev.length, before + 1);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).actor, ev.at(-1).detail.fields], ["user_details_changed", W.lc_SA, ["phone", "specializations"]]);
  await rejectsWith(svc.updateDetails(W.lc_T, { fullName: "Lc Trainer", phone: "555-0100", specializations: ["PLC", "DCS"] }), "Nothing changed.");
  await rejectsWith(svc.updateDetails(W.lc_T, { fullName: "" }), "A full name is required.");
  await rejectsWith(svc.updateDetails(W.lc_T, { fullName: "Lc Trainer", phone: "9".repeat(41) }), "Phone can be at most 40 characters.");
  assert.equal((await events(W.lc_T)).length, before + 1, "no audit rows for refused or empty edits");
  // A student's details go to the student function.
  assert.equal(await svc.updateDetails(W.lc_S2, { fullName: "Lc Student Two", organization: "Plant 7" }), "Details saved.");
  assert.equal(await db.admin(`select organization from public.student_details where student_id = '${W.lc_S2}'`), "Plant 7");
  // An account without a record has nothing to edit.
  await rejectsWith(svc.updateDetails(W.lc_INV, { fullName: "X" }), "This account has no student or trainer record to edit.");
});

test("trainers, students and signed-out callers are refused; the database refuses them too when called directly", async () => {
  for (const id of [W.T1, W.ST1, null]) {
    const svc = as(id);
    await assert.rejects(svc.setAccountStatus(W.lc_S2, "suspended", null), UsersAuthorizationError);
    await assert.rejects(svc.changeRole(W.lc_S2, "trainer", { fullName: "X" }), UsersAuthorizationError);
    await assert.rejects(svc.updateDetails(W.lc_S2, { fullName: "Hacked" }), UsersAuthorizationError);
  }
  for (const id of [W.T1, W.ST1]) {
    const repo = createUsersRepository(async () => db.client({ role: "authenticated", userId: id }));
    await quiet(() => assert.rejects(repo.setAccountStatus(W.lc_S2, "suspended", null), (e) => e instanceof UsersFunctionError && e.code === "42501"));
    await quiet(() => assert.rejects(repo.setUserRole(W.lc_S2, "super_admin", {}), (e) => e instanceof UsersFunctionError && e.code === "42501"));
    await quiet(() => assert.rejects(repo.updateStudent(W.lc_S2, { full_name: "Hacked" }), (e) => e instanceof UsersFunctionError && e.code === "42501"));
  }
  const anon = createUsersRepository(async () => clientFor(null));
  await quiet(() => assert.rejects(anon.setAccountStatus(W.lc_S2, "suspended", null), UsersFunctionError));
  assert.deepEqual(await state(W.lc_S2), { role: "student", account: "active", student: "active", trainer: null });
  assert.equal(await db.admin(`select full_name from public.students where id = '${W.lc_S2}'`), "Lc Student Two");
});

test("a suspended Super Admin can no longer act (session lookup refuses; the database refuses the call)", async () => {
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('lc_SA3');`);
  await assert.rejects(as(W.lc_SA3).setAccountStatus(W.lc_S2, "suspended", null), UsersAuthorizationError);
  const stale = createUsersService({
    repository: createUsersRepository(async () => db.client({ role: "authenticated", userId: W.lc_SA3 })),
    getCurrentUser: async () => ({ id: W.lc_SA3, email: "x", fullName: "x", role: "admin", isActive: true, createdAt: "2026-01-01" }),
  });
  await quiet(() => rejectsWith(stale.setAccountStatus(W.lc_S2, "suspended", null), L.PERMISSION_ERROR));
  assert.equal((await state(W.lc_S2)).account, "active");
});

test("last active Super Admin: a concurrent mutual suspension leaves exactly one; the survivor cannot suspend or demote themselves", async () => {
  const race = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: RACE_DB });
  let r = await db.run(`drop database if exists ${RACE_DB} with (force);\ncreate database ${RACE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  const files = [
    path.join(here, "fixtures/bootstrap.sql"),
    // Through 0022: the current users repository reads this database (it selects columns added up to 0022).
    ...fs.readdirSync(MIGRATIONS).filter((f) => /^00(0\d|1\d|2[0-2])_.*\.sql$/.test(f)).sort().map((f) => path.join(MIGRATIONS, f)),
    path.join(here, "fixtures/seed.sql"),
  ];
  for (const f of files) {
    r = await race.run(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  const P = await race.admin("select json_object_agg(k, v) from t.ids");
  const activeAdmins = () => race.admin("select count(*) from public.profiles where role = 'super_admin' and account_status = 'active'");
  assert.equal(await activeAdmins(), 2, "the seed has exactly two active Super Admins (A, A2)");

  // A suspends A2 and holds the transaction open; meanwhile A2 tries to suspend A through the app.
  const claims = (id) => `select set_config('request.jwt.claims', '${JSON.stringify({ sub: id })}', true);`;
  const held = race.run(`begin;\nset local role authenticated;\n${claims(P.A)}\nselect public.admin_set_account_status('${P.A2}', 'suspended');\nselect pg_sleep(1.5);\ncommit;`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Settle the counter-attempt into a value right away: it may be refused before `held` resolves.
  const counter = quiet(() => serviceAs(race, P.A2).setAccountStatus(P.A, "suspended", "race")).then(
    () => null,
    (e) => e
  );
  assert.equal((await held).code, 0);
  const refused = await counter;
  assert.ok(refused instanceof UsersActionError, "the second, concurrent suspension is refused");
  assert.ok(refused.message === L.PERMISSION_ERROR || refused.message === L.STATUS_REASON_MESSAGE.last_super_admin, refused.message);
  assert.equal(await activeAdmins(), 1, "exactly one active Super Admin remains");
  assert.equal(await race.admin(`select account_status from public.profiles where id = '${P.A}'`), "active");

  // The survivor cannot remove their own access; the suspended admin cannot act at all.
  const a = serviceAs(race, P.A);
  await rejectsWith(a.setAccountStatus(P.A, "suspended", null), L.STATUS_REASON_MESSAGE.cannot_change_self);
  await rejectsWith(a.changeRole(P.A, "student", { fullName: "Last" }), L.ROLE_REASON_MESSAGE.cannot_change_self);
  await assert.rejects(serviceAs(race, P.A2).setAccountStatus(P.A, "suspended", null), UsersAuthorizationError);
  assert.equal(await activeAdmins(), 1);
});

test("refusals never expose database internals", async () => {
  const svc = as(W.lc_SA);
  const attempts = [
    () => svc.setAccountStatus(W.lc_SA, "suspended", null),
    () => svc.changeRole(W.lc_S2, "admin", null),
    () => svc.changeRole("00000000-0000-4000-8000-000000000000", "admin", null),
    () => svc.updateDetails(W.lc_T, { fullName: "x".repeat(250) }),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e) => {
      assert.ok(e instanceof UsersActionError);
      assert.doesNotMatch(e.message, /public\.|ERROR|SQLSTATE|violat|constraint|function|relation|42501|22023|_fkey/i);
      return true;
    });
  }
});

test("0018 upgrade: an account suspended from invited under 0017 can never be reactivated; only admin_set_account_status changes", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const upTo0017 = [
    path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((f) => /^00(0\d|1[0-7])_.*\.sql$/.test(f)).sort().map((f) => path.join(MIGRATIONS, f)),
    path.join(here, "fixtures/seed.sql"),
  ];
  for (const f of upTo0017) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  // Under 0017: an invited account suspended (the old two-step path) and an active account suspended.
  await up.exec(`
    insert into t.ids (k, v) select k, gen_random_uuid() from unnest(array['UP_INV','UP_ACT']) k;
    insert into auth.users (id) select v from t.ids where k in ('UP_INV','UP_ACT');
    update public.profiles set account_status = 'active' where id = t.id('UP_ACT');`);
  const P = await up.admin("select json_object_agg(k, v) from t.ids");
  const asA = up.client({ role: "authenticated", userId: P.A });
  for (const id of [P.UP_INV, P.UP_ACT]) {
    const res = await asA.rpc("admin_set_account_status", { p_user_id: id, p_status: "suspended" });
    assert.equal(res.data?.ok, true, "0017 allowed both suspensions");
  }

  // Catalog fingerprint of everything 0018 must not touch, and the security attributes of the one function it replaces.
  const untouched = () =>
    up.admin(`select json_build_object(
      'functions', (select md5(string_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), '') || '|' || coalesce(p.proacl::text, '') || '|' || md5(replace(p.prosrc, chr(13), '')), ',' order by p.oid::regprocedure::text))
                      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'admin_set_account_status'),
      'accept', (select md5(replace(prosrc, chr(13), '')) from pg_proc where proname = 'accept_user_invitation'),
      'tables', (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')),
      'policies', (select md5(string_agg(tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'),
      'triggers', (select md5(string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname)) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal),
      'data', (select md5(string_agg(to_jsonb(p)::text, ',' order by id)) from public.profiles p) || (select count(*) from public.user_admin_events)::text)`);
  const target = () =>
    up.admin(`select json_build_object('definer', p.prosecdef, 'config', p.proconfig, 'acl', p.proacl::text, 'owner', p.proowner::regrole::text,
                'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                'body', md5(replace(p.prosrc, chr(13), '')), 'comment', obj_description(p.oid, 'pg_proc'))
                from pg_proc p where p.oid = 'public.admin_set_account_status(uuid, public.account_status, text)'::regprocedure`);
  const catalogBefore = await untouched();
  const fnBefore = await target();

  const M0018 = path.join(MIGRATIONS, "0018_account_activation_guard.sql");
  r = await up.run(read(M0018));
  assert.equal(r.code, 0, r.stderr);

  assert.deepEqual(await untouched(), catalogBefore, "no other function, table, grant, policy, trigger or data changed");
  const fnAfter = await target();
  assert.deepEqual(
    { ...fnAfter, body: undefined, comment: undefined },
    { ...fnBefore, body: undefined, comment: undefined },
    "same SECURITY DEFINER, search_path, owner and grants"
  );
  assert.deepEqual([fnAfter.definer, fnAfter.config, fnAfter.anon, fnAfter.authenticated], [true, ['search_path=""'], false, true]);
  assert.notEqual(fnAfter.body, fnBefore.body);
  assert.match(fnAfter.comment, /^0018:/);

  // The read-only preflight query finds exactly the account suspended from invited.
  const flagged = await up.admin(`select coalesce(json_agg(p.id), '[]'::json) from public.profiles p
      join lateral (select ev.detail from public.user_admin_events ev where ev.target_user_id = p.id and ev.event_type = 'account_status_changed' order by ev.id desc limit 1) e on true
     where p.account_status = 'suspended' and e.detail ->> 'from' = 'invited'`);
  assert.deepEqual(flagged, [P.UP_INV]);

  // The 0017 → 0018 upgrade above is the scenario under test; the current users repository used below
  // reads columns added by later migrations, so bring this database to the current schema first (0019–0022).
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => /^00(19|2[0-2])_.*\.sql$/.test(x)).sort()) {
    r = await up.run(read(path.join(MIGRATIONS, f)));
    assert.equal(r.code, 0, `${f}: ${r.stderr}`);
  }

  // After 0018: reactivation of the never-activated account is refused (safe message), nothing written.
  const svc = serviceAs(up, P.A);
  // The panel does not offer it (read from the same audit fact); the previously active account still gets Reactivate.
  const neverDetail = await svc.getUserDetail(P.UP_INV);
  assert.deepEqual([neverDetail.user.accountStatus, neverDetail.actions.reactivate], ["suspended", false]);
  assert.match(neverDetail.actions.note, /before it was ever activated/);
  assert.equal((await svc.getUserDetail(P.UP_ACT)).actions.reactivate, true);
  const auditCount = (id) => up.admin(`select count(*) from public.user_admin_events where target_user_id = '${id}'`);
  const beforeAudit = await auditCount(P.UP_INV);
  await rejectsWith(svc.setAccountStatus(P.UP_INV, "active", null), L.STATUS_REASON_MESSAGE.never_activated);
  assert.deepEqual(await asA.rpc("admin_set_account_status", { p_user_id: P.UP_INV, p_status: "active" }).then((x) => x.data), { ok: false, reason: "never_activated" });
  assert.equal(await up.admin(`select account_status from public.profiles where id = '${P.UP_INV}'`), "suspended");
  assert.equal(await auditCount(P.UP_INV), beforeAudit);
  // A previously active account: suspended → active → suspended still works.
  assert.match(await svc.setAccountStatus(P.UP_ACT, "active", null), /reactivated/i);
  assert.match(await svc.setAccountStatus(P.UP_ACT, "suspended", null), /suspended/i);
  assert.match(await svc.setAccountStatus(P.UP_ACT, "active", null), /reactivated/i);

  // Applying 0018 twice is refused by its preflight.
  r = await up.run(read(M0018));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0018 already applied/);
});
