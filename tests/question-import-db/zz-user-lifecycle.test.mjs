// Integration (0016): user lifecycle foundation — account status on profiles.
// Active accounts keep their role and access; invited and suspended accounts get no usable
// role (current_app_role() is NULL) and no application data through RLS, the 0005/0012 paths
// that bypass current_app_role(), or the app's own role lookup (fetchProfileRole).
// The backfill and "nothing else changed" checks run on a separate throwaway database
// built without 0016, which then gets 0016 applied (twice).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { clientFor, db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0016 = path.join(MIGRATIONS, "0016_user_lifecycle.sql");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const { fetchProfileRole } = await import(`${process.env.QI_BUILD}/lib/auth/profile-role.mjs`);

const PRE_DB = "qi_user_lifecycle_pre";
const pre = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: PRE_DB });

let U; // ids (t.ids) after setup
const as = (key) => db.client({ role: "authenticated", userId: U[key] });
const roleOf = async (client) => (await client.sql("public.current_app_role()")).data;
const rows = async (client, query) => {
  const { data, error } = await client.sql(`(select coalesce(json_agg(x), '[]'::json) from (${query}) x)`);
  if (error) throw new Error(error.message);
  return data;
};
const profile = (key) => db.admin(`select to_json(x) from (select role, account_status, account_status_changed_at, account_status_changed_by from public.profiles where id = '${U[key]}') x`);
/** Change an account's status the way trusted server code will (privileged role), acting as `byKey`. */
const setStatus = (key, status, byKey = "A") => db.exec(`update public.profiles set account_status = '${status}' where id = t.id('${key}');`, U[byKey]);

before(async () => {
  // ul_SA super admin, ul_TR trainer (own batch UL-B), ul_ST student in B1 — all activated;
  // ul_INV invited (nothing else); ul_INVST invited but already given a student record + B1 enrolment.
  await db.exec(`
    insert into t.ids (k, v) select 'ul_' || k, gen_random_uuid() from unnest(array['SA','TR','ST','INV','INVST','NEW']) k;
    insert into auth.users (id) select v from t.ids where k in ('ul_SA','ul_TR','ul_ST','ul_INV','ul_INVST');
    update public.profiles set role = 'super_admin' where id = t.id('ul_SA');
    update public.profiles set role = 'trainer' where id = t.id('ul_TR');
    update public.profiles set account_status = 'active' where id in (t.id('ul_SA'), t.id('ul_TR'), t.id('ul_ST'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ul_TR'), 'UL-TR', 'Lifecycle Trainer');
    insert into public.students (id, student_code, full_name) values (t.id('ul_ST'), 'UL-ST', 'Lifecycle Student'), (t.id('ul_INVST'), 'UL-INVST', 'Invited Student');
    insert into public.batches (batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values ('UL-B', t.id('C1'), t.id('ul_TR'), 'Lifecycle batch', '2026-01-01', '2026-12-31', 'ongoing', 10);
    insert into public.batch_students (batch_id, student_id)
      select b.id, s from public.batches b, unnest(array[t.id('ul_ST'), t.id('ul_INVST')]) s where b.batch_code = 'B1';
    insert into public.notifications (recipient_id, type, title, body, event_key)
      select t.id(k), (enum_range(null::public.notification_type))[1], 'Lifecycle', 'Lifecycle test', 'ul-' || k
        from unnest(array['ul_ST','ul_INVST','ul_SA']) k;`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
  U.B1 = await db.admin("select id from public.batches where batch_code = 'B1'");
  U.B2 = await db.admin("select id from public.batches where batch_code = 'B2'");
  U.ULB = await db.admin("select id from public.batches where batch_code = 'UL-B'");
});

after(async () => {
  await db.run(`drop database if exists ${PRE_DB} with (force);`);
});

// ---------------------------------------------------------------- A–C, F: role resolution

test("A–C. active accounts resolve their existing role (super_admin, trainer, student)", async () => {
  assert.equal(await roleOf(clientFor({ id: ids.A })), "super_admin");
  assert.equal(await roleOf(db.client({ role: "authenticated", userId: ids.A })), "super_admin");
  assert.equal(await roleOf(db.client({ role: "authenticated", userId: ids.T1 })), "trainer");
  assert.equal(await roleOf(db.client({ role: "authenticated", userId: ids.ST1 })), "student");
  assert.equal(await roleOf(as("ul_SA")), "super_admin");
  assert.equal(await roleOf(as("ul_TR")), "trainer");
  assert.equal(await roleOf(as("ul_ST")), "student");
  // The app's own sign-in/session lookup (src/lib/auth/profile-role.ts) on the caller's own session.
  assert.equal(await fetchProfileRole(as("ul_SA"), U.ul_SA), "admin");
  assert.equal(await fetchProfileRole(as("ul_TR"), U.ul_TR), "trainer");
  assert.equal(await fetchProfileRole(as("ul_ST"), U.ul_ST), "student");
});

test("F. no authenticated user: current_app_role() is NULL; anonymous callers still cannot execute it or read profiles", async () => {
  assert.equal(await roleOf(db.client({ role: "authenticated" })), null);
  const anon = clientFor(null);
  const e1 = (await anon.sql("public.current_app_role()")).error;
  assert.equal(e1?.code, "42501");
  const e2 = (await anon.execute("select count(*) from public.profiles")).error;
  assert.equal(e2?.code, "42501");
});

// ---------------------------------------------------------------- D, J: invited

test("J. a new auth user gets an INVITED profile (role column default kept), stamped, with no usable role", async () => {
  await db.exec(`insert into auth.users (id) values (t.id('ul_NEW'));`);
  const p = await profile("ul_NEW");
  assert.equal(p.account_status, "invited");
  assert.equal(p.role, "student", "the 0002 column default is kept for compatibility — access is gated by status");
  assert.ok(p.account_status_changed_at);
  assert.equal(p.account_status_changed_by, null);
  assert.equal(await roleOf(as("ul_NEW")), null);
  assert.equal(await fetchProfileRole(as("ul_NEW"), U.ul_NEW), null, "the app refuses sign-in / the session");
});

test("D. invited accounts: no role, no profile, no data, no notifications — even with a student record and an enrolment", async () => {
  for (const key of ["ul_INV", "ul_INVST"]) {
    const c = as(key);
    assert.equal(await roleOf(c), null, key);
    assert.equal(await fetchProfileRole(c, U[key]), null, key);
    assert.equal((await c.sql("public.is_super_admin()")).data, false);
    assert.deepEqual(await rows(c, "select id from public.profiles"), [], "not even its own profile");
    for (const table of ["students", "student_details", "trainers", "batches", "batch_students", "courses", "modules", "classes", "questions", "tests", "notifications", "class_attendance", "assignment_submissions"]) {
      assert.deepEqual(await rows(c, `select 1 from public.${table}`), [], `${key}: ${table}`);
    }
    const e = (await c.sql("public.student_available_tests()")).error;
    assert.equal(e?.code, "42501");
    assert.match(e.message, /Only students can take tests/);
    assert.deepEqual(await rows(c, "select * from public.my_notifications()"), []);
    assert.equal((await c.sql("public.my_unread_notification_count()")).data, 0);
    const m = (await c.sql("public.mark_all_notifications_read()")).error;
    assert.equal(m?.code, "42501");
    assert.match(m.message, /Your account is not active/);
  }
  const c = as("ul_INVST");
  assert.equal((await c.sql(`public.owns_student_record('${U.ul_INVST}')`)).data, false, "0005 helper is status-aware");
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B1}')`)).data, false);
  // Its notification is still stored (nothing deleted), just not readable.
  assert.equal(await db.admin(`select count(*) from public.notifications where recipient_id = '${U.ul_INVST}' and read_at is null`), 1);
});

// ---------------------------------------------------------------- E: suspended (and reactivated)

test("E. suspending a student removes role and data access; reactivating restores it; changes are stamped", async () => {
  const c = as("ul_ST");
  assert.deepEqual((await rows(c, "select id from public.students")).map((r) => r.id), [U.ul_ST], "active: own record only");
  assert.equal((await rows(c, "select id from public.notifications")).length, 1);
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B1}')`)).data, true);
  const before = await profile("ul_ST");

  await setStatus("ul_ST", "suspended", "ul_SA");
  const s = await profile("ul_ST");
  assert.equal(s.account_status, "suspended");
  assert.equal(s.role, "student", "the role is kept, only access is withdrawn");
  assert.equal(s.account_status_changed_by, U.ul_SA);
  assert.ok(new Date(s.account_status_changed_at) >= new Date(before.account_status_changed_at));
  assert.equal(await roleOf(c), null);
  assert.equal(await fetchProfileRole(c, U.ul_ST), null);
  for (const table of ["profiles", "students", "batches", "batch_students", "courses", "classes", "notifications", "tests"]) {
    assert.deepEqual(await rows(c, `select 1 from public.${table}`), [], table);
  }
  assert.equal((await c.sql(`public.owns_student_record('${U.ul_ST}')`)).data, false);
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B1}')`)).data, false);
  assert.equal((await c.sql("public.student_available_tests()")).error?.code, "42501");
  assert.equal((await c.sql("public.mark_all_notifications_read()")).error?.code, "42501");
  assert.equal((await c.sql(`public.mark_notification_read('${await db.admin(`select id from public.notifications where recipient_id = '${U.ul_ST}'`)}')`)).error?.code, "42501");
  assert.equal(await db.admin(`select count(*) from public.batch_students where student_id = '${U.ul_ST}'`), 1, "enrolment untouched");

  await setStatus("ul_ST", "active", "ul_SA");
  assert.equal(await roleOf(c), "student");
  assert.equal(await fetchProfileRole(c, U.ul_ST), "student");
  assert.deepEqual((await rows(c, "select id from public.students")).map((r) => r.id), [U.ul_ST]);
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B1}')`)).data, true);
  assert.equal((await c.sql("public.mark_all_notifications_read()")).data, 1, "an active account can mark its notification read");
});

// ---------------------------------------------------------------- G, H, I: scope preserved

test("G. trainer scope is unchanged for active trainers and withdrawn from a suspended one", async () => {
  const t1 = db.client({ role: "authenticated", userId: ids.T1 });
  const t2 = db.client({ role: "authenticated", userId: ids.T2 });
  assert.equal((await t1.sql(`public.is_current_batch_trainer('${U.B1}')`)).data, true);
  assert.equal((await t1.sql(`public.is_batch_trainer('${U.B1}')`)).data, true);
  assert.equal((await t2.sql(`public.is_current_batch_trainer('${U.B1}')`)).data, false, "another trainer's batch");
  assert.equal((await t2.sql(`public.is_current_batch_trainer('${U.B2}')`)).data, true);
  assert.deepEqual((await rows(t1, `select student_id from public.batch_students where batch_id = '${U.B2}'`)), [], "no other trainer's enrolments");

  const tr = as("ul_TR");
  assert.equal((await tr.sql(`public.is_current_batch_trainer('${U.ULB}')`)).data, true);
  assert.deepEqual((await rows(tr, "select batch_code from public.batches")).map((r) => r.batch_code), ["UL-B"]);
  await setStatus("ul_TR", "suspended");
  assert.equal((await tr.sql(`public.is_current_batch_trainer('${U.ULB}')`)).data, false);
  assert.deepEqual(await rows(tr, "select 1 from public.batches"), []);
  assert.deepEqual(await rows(tr, "select 1 from public.trainers"), []);
  await setStatus("ul_TR", "active");
  assert.equal((await tr.sql(`public.is_current_batch_trainer('${U.ULB}')`)).data, true);
});

test("H. student enrolment restrictions are unchanged: own batch only, other students invisible", async () => {
  const c = as("ul_ST");
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B1}')`)).data, true);
  assert.equal((await c.sql(`public.is_enrolled_in_batch('${U.B2}')`)).data, false);
  assert.deepEqual((await rows(c, "select batch_code from public.batches")).map((r) => r.batch_code), ["B1"]);
  assert.deepEqual((await rows(c, "select id from public.students")).map((r) => r.id), [U.ul_ST], "not ST1 or the invited student");
  assert.deepEqual((await rows(c, "select student_id from public.batch_students")).map((r) => r.student_id), [U.ul_ST]);
  assert.deepEqual(await rows(c, "select 1 from public.student_details where student_id <> auth.uid()"), []);
});

test("I. super admin access is unchanged while active and withdrawn while suspended", async () => {
  const c = as("ul_SA");
  const total = await db.admin("select count(*) from public.profiles");
  assert.equal((await rows(c, "select id from public.profiles")).length, total, "sees every profile, including invited ones");
  assert.equal((await rows(c, "select id from public.students")).length, await db.admin("select count(*) from public.students"));
  assert.equal((await c.sql("public.is_super_admin()")).data, true);
  await setStatus("ul_SA", "suspended");
  assert.equal((await c.sql("public.is_super_admin()")).data, false);
  assert.deepEqual(await rows(c, "select 1 from public.profiles"), []);
  assert.deepEqual(await rows(c, "select 1 from public.students"), []);
  await setStatus("ul_SA", "active");
  assert.equal((await c.sql("public.is_super_admin()")).data, true);
  // The seeded super admins were never touched.
  assert.equal(await roleOf(db.client({ role: "authenticated", userId: ids.A2 })), "super_admin");
});

// ---------------------------------------------------------------- write protection

test("status cannot be written by clients; the guard refuses non-privileged changes even if a grant/policy existed", async () => {
  const c = as("ul_ST");
  for (const sql of [`update public.profiles set account_status = 'active' where id = '${U.ul_INV}'`, `update public.profiles set account_status = 'suspended' where id = auth.uid()`]) {
    const e = (await c.execute(sql)).error;
    assert.equal(e?.code, "42501", sql);
  }
  const anon = (await clientFor(null).execute(`update public.profiles set account_status = 'active'`)).error;
  assert.equal(anon?.code, "42501");
  // Defence in depth: inside a transaction that is rolled back, give authenticated an UPDATE/INSERT grant and an
  // open policy — the trigger still refuses a status change or a non-invited insert by a non-privileged role.
  const probe = async (stmt) => db.run(`begin;
    grant update, insert on public.profiles to authenticated;
    create policy tmp_all on public.profiles for all to authenticated using (true) with check (true);
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${U.ul_ST}"}', true);
    ${stmt};
    rollback;`);
  let r = await probe(`update public.profiles set account_status = 'active' where id = '${U.ul_INV}'`);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /account_status can only be changed by a privileged role/);
  r = await probe(`insert into public.profiles (id, account_status) values ('${U.ul_NEW}'::uuid, 'active')`);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /always starts as invited/);
  assert.equal((await profile("ul_INV")).account_status, "invited", "nothing changed");
  assert.equal(await db.admin("select count(*) from pg_policies where policyname = 'tmp_all'"), 0, "probe rolled back");
});

// ---------------------------------------------------------------- functions: exact changes + hardening

test("re-created functions: 0005/0012 bodies + only lines tagged '-- 0016'; security settings and privileges", async () => {
  const live = async (sig) => (await db.admin(`select prosrc from pg_proc where oid = '${sig}'::regprocedure`)).replace(/\r/g, "");
  const body = (file, name) => {
    const src = read(path.join(MIGRATIONS, file));
    const start = src.indexOf(`create function public.${name}(`);
    const as = src.indexOf("as $$", start) + "as $$".length;
    return src.slice(as, src.indexOf("$$;", as));
  };
  const strip = (s) => s.split("\n").filter((l) => !/(^|\s)-- 0016$/.test(l)).join("\n");
  for (const [sig, file, name, tagged] of [
    ["public.owns_student_record(uuid)", "0005_class_attendance.sql", "owns_student_record", 1],
    ["public.mark_notification_read(uuid)", "0012_notifications.sql", "mark_notification_read", 3],
    ["public.mark_all_notifications_read()", "0012_notifications.sql", "mark_all_notifications_read", 3],
  ]) {
    const src = await live(sig);
    assert.equal(src.split("\n").filter((l) => /(^|\s)-- 0016$/.test(l)).length, tagged, `${name}: tagged lines`);
    assert.equal(strip(src), body(file, name), `${name}: body minus tagged lines == original`);
  }
  assert.match(await live("public.current_app_role()"), /p\.id = auth\.uid\(\)\s+and p\.account_status = 'active'::public\.account_status/);

  const info = await db.admin(`select json_object_agg(p.proname, json_build_object('definer', p.prosecdef, 'config', p.proconfig,
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE')))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('current_app_role', 'handle_new_user', 'profiles_account_status_guard',
      'owns_student_record', 'mark_notification_read', 'mark_all_notifications_read')`);
  const cfg = ['search_path=""'];
  assert.deepEqual(info, {
    current_app_role: { definer: true, config: cfg, anon: false, authenticated: true, service_role: true },
    handle_new_user: { definer: true, config: cfg, anon: false, authenticated: false, service_role: true },
    profiles_account_status_guard: { definer: false, config: cfg, anon: false, authenticated: false, service_role: true },
    owns_student_record: { definer: true, config: cfg, anon: false, authenticated: true, service_role: true },
    mark_notification_read: { definer: true, config: cfg, anon: false, authenticated: true, service_role: false },
    mark_all_notifications_read: { definer: true, config: cfg, anon: false, authenticated: true, service_role: false },
  });
  const policies = await db.admin(`select json_agg(tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' || qual order by tablename, policyname)
    from pg_policies where policyname in ('profiles_active_account_only', 'notifications_active_account_only')`);
  assert.deepEqual(policies, [
    "notifications.notifications_active_account_only:RESTRICTIVE:SELECT:(( SELECT current_app_role() AS current_app_role) IS NOT NULL)",
    "profiles.profiles_active_account_only:RESTRICTIVE:SELECT:(( SELECT current_app_role() AS current_app_role) IS NOT NULL)",
  ]);
});

// ---------------------------------------------------------------- K, L: backfill on a pre-0016 database

const fingerprint = (dbx) => dbx.admin(`select json_build_object(
  'tables', (select json_object_agg(c.relname, (xpath('/row/n/text()', query_to_xml(format(
      'select md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as n from public.%I x', ',', '', c.relname), false, true, '')))[1]::text)
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'profiles'),
  'profiles', (select md5(string_agg(id || ':' || role || ':' || created_at || ':' || updated_at, ',' order by id)) from public.profiles),
  'functions', (select json_object_agg(p.oid::regprocedure::text, md5(p.prosrc) || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ';'), ''))
    from pg_proc p where p.pronamespace = 'public'::regnamespace),
  'policies', (select json_object_agg(tablename || '.' || policyname, permissive || cmd || coalesce(qual, '') || coalesce(with_check, '')) from pg_policies where schemaname = 'public'),
  'triggers', (select json_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal),
  'table_grants', (select json_object_agg(c.relname, coalesce(c.relacl::text, '')) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')))`);

test("K + L. applying 0016 to a database that already has users: all backfilled active with roles unchanged; no training record changes; safe to re-run", async () => {
  let r = await db.run(`drop database if exists ${PRE_DB} with (force);\ncreate database ${PRE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  const files = [path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((f) => /^00\d\d_.*\.sql$/.test(f) && f < "0016").sort().map((f) => path.join(MIGRATIONS, f)),
    path.join(here, "fixtures/seed.sql")];
  for (const f of files) {
    r = await pre.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  const P = await pre.admin("select json_object_agg(k, v) from t.ids"); // this database's own people
  // Some training history before 0016: an enrolment and a notification.
  await pre.exec(`insert into public.batch_students (batch_id, student_id) select id, t.id('ST1') from public.batches where batch_code = 'B1';
    insert into public.notifications (recipient_id, type, title, body, event_key) values (t.id('ST1'), (enum_range(null::public.notification_type))[1], 'Before', 'Before 0016', 'pre-0016');`, P.A);
  assert.equal(await pre.admin("select count(*) from information_schema.columns where table_name = 'profiles' and column_name = 'account_status'"), 0);
  const roles = await pre.admin("select json_object_agg(id, role) from public.profiles");
  const before = await fingerprint(pre);

  r = await pre.run(read(M0016));
  assert.equal(r.code, 0, r.stderr);
  const statuses = await pre.admin("select json_object_agg(account_status, n) from (select account_status, count(*) n from public.profiles group by 1) x");
  assert.deepEqual(statuses, { active: Object.keys(roles).length }, "every existing profile active");
  assert.deepEqual(await pre.admin("select json_object_agg(id, role) from public.profiles"), roles, "roles unchanged");
  assert.equal(await pre.admin("select count(*) from public.profiles where account_status_changed_by is not null or account_status_changed_at is null"), 0);
  assert.equal(await pre.admin("select column_default from information_schema.columns where table_name = 'profiles' and column_name = 'account_status'"), "'invited'::account_status");
  const afterFp = await fingerprint(pre);
  assert.deepEqual(afterFp.tables, before.tables, "no training, enrolment, result, certificate or notification row changed");
  assert.equal(afterFp.profiles, before.profiles, "profile ids, roles and timestamps unchanged");
  assert.deepEqual(afterFp.table_grants, before.table_grants, "table privileges unchanged");
  const changed = Object.keys(afterFp.functions).filter((k) => before.functions[k] !== afterFp.functions[k]).sort();
  assert.deepEqual(changed, [
    "current_app_role()", "handle_new_user()", "mark_all_notifications_read()", "mark_notification_read(uuid)", "owns_student_record(uuid)", "profiles_account_status_guard()",
  ], "only the intended functions are new or changed");
  for (const k of Object.keys(before.functions)) {
    if (!changed.includes(k)) continue;
    assert.equal(afterFp.functions[k].split("|").slice(1).join("|"), before.functions[k].split("|").slice(1).join("|"), `${k}: privileges and security settings kept`);
  }
  assert.deepEqual(Object.keys(afterFp.policies).filter((k) => !(k in before.policies)).sort(), ["notifications.notifications_active_account_only", "profiles.profiles_active_account_only"]);
  for (const k of Object.keys(before.policies)) assert.equal(afterFp.policies[k], before.policies[k], `${k} unchanged`);
  assert.deepEqual(afterFp.triggers.filter((t) => !before.triggers.includes(t)), ["profiles.profiles_account_status_guard"]);

  // The pre-0016 people keep working.
  for (const key of ["A", "T1", "ST1"]) assert.ok(await roleOf(pre.client({ role: "authenticated", userId: P[key] })), key);

  // Re-run: a suspended account stays suspended; nothing else changes.
  await pre.exec(`update public.profiles set account_status = 'suspended' where id = t.id('ST1');`);
  const beforeRerun = await fingerprint(pre);
  r = await pre.run(read(M0016));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await pre.admin(`select account_status from public.profiles where id = t.id('ST1')`), "suspended", "a re-run never reactivates");
  assert.deepEqual(await fingerprint(pre), beforeRerun);
});

test("preflight: 0016 refuses a database without the earlier migrations", async () => {
  const name = "qi_user_lifecycle_empty";
  await db.run(`drop database if exists ${name} with (force);\ncreate database ${name};`);
  const empty = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: name });
  const r = await empty.run(read(M0016));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Preflight failed: 0002, 0003, 0005 and 0012 must be applied first/);
  await db.run(`drop database if exists ${name} with (force);`);
});
