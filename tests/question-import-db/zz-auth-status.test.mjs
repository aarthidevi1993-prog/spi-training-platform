// Integration (Phase 7 P2): application account-status enforcement against the local 0001–0016
// database. The real fetchProfileRole (sign-in, session lookup and middleware all use it) on each
// user's own session, combined with the middleware's portal decision. Also: what the same code
// does against a database WITHOUT 0016 (today's live project) — it fails closed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { clientFor, db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { fetchProfileRole, NO_ACCESS_MESSAGE } = await import(`${build}/lib/auth/profile-role.mjs`);
const { decidePortalAccess, getPortalForPath } = await import(`${build}/lib/auth/roles.mjs`);

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const PRE_DB = "qi_auth_status_pre0016";
const pre = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: PRE_DB });

const PATHS = { admin: "/admin/exam-monitoring", trainer: "/trainer/tests", student: "/student/tests" };
let U;
const session = (id) => db.client({ role: "authenticated", userId: id });
const lookup = async (id, client = session(id)) => {
  const [w, e] = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await fetchProfileRole(client, id); } finally { [console.warn, console.error] = [w, e]; }
};
/** The middleware's outcome for each portal, for this user's own session. */
const portals = async (id, client) => {
  const role = await lookup(id, client);
  return Object.fromEntries(Object.entries(PATHS).map(([p, url]) => [p, decidePortalAccess(getPortalForPath(url), role)]));
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'as_' || k, gen_random_uuid() from unnest(array['INV','SUS','NOPROF','ACT']) k;
    insert into auth.users (id, raw_user_meta_data) select v, '{"role":"super_admin","full_name":"Meta Admin"}'::jsonb from t.ids where k = 'as_INV';
    insert into auth.users (id) select v from t.ids where k in ('as_SUS','as_NOPROF','as_ACT');
    update public.profiles set account_status = 'active' where id in (t.id('as_SUS'), t.id('as_ACT'));
    insert into public.students (id, student_code, full_name) values (t.id('as_SUS'), 'AS-SUS', 'Status Student'), (t.id('as_ACT'), 'AS-ACT', 'Active Student');
    delete from public.profiles where id = t.id('as_NOPROF');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

after(async () => {
  await db.run(`drop database if exists ${PRE_DB} with (force);`);
});

test("A–C. active Super Admin, Trainer and Student resolve to admin, trainer, student", async () => {
  assert.equal(await lookup(ids.A), "admin");
  assert.equal(await lookup(ids.T1), "trainer");
  assert.equal(await lookup(ids.ST1), "student");
  assert.equal(await lookup(U.as_ACT), "student");
});

test("D. invited → no role (even with user_metadata claiming super_admin)", async () => {
  assert.equal(await db.admin(`select account_status from public.profiles where id = '${U.as_INV}'`), "invited");
  assert.equal(await db.admin(`select raw_user_meta_data ->> 'role' from auth.users where id = '${U.as_INV}'`), "super_admin");
  assert.equal(await lookup(U.as_INV), null);
});

test("E. suspended → no role, immediately, on the SAME still-valid session (no reliance on token expiry)", async () => {
  const c = session(U.as_SUS);
  assert.equal(await lookup(U.as_SUS, c), "student");
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('as_SUS');`, ids.A);
  assert.equal(await lookup(U.as_SUS, c), null, "next lookup on the same session is refused");
  assert.deepEqual(await portals(U.as_SUS, c), { admin: "login", trainer: "login", student: "login" });
});

test("F–H. missing profile, unauthenticated (no session) and a lookup for someone else's id → no role", async () => {
  assert.equal(await db.admin(`select count(*) from public.profiles where id = '${U.as_NOPROF}'`), 0);
  assert.equal(await lookup(U.as_NOPROF), null, "missing profile");
  assert.equal(await lookup(ids.A, clientFor(null)), null, "anonymous: no privileges on profiles");
  assert.equal(await lookup(ids.A, db.client({ role: "authenticated" })), null, "authenticated role with no user");
  assert.equal(await lookup(ids.A, session(ids.ST1)), null, "a student cannot resolve another user's (an admin's) role");
});

test("G. unknown role: none can exist in the database (enum), and the app maps anything unknown to no role", async () => {
  const labels = await db.admin("select json_agg(enumlabel order by enumsortorder) from pg_enum where enumtypid = 'public.app_role'::regtype");
  assert.deepEqual(labels, ["super_admin", "trainer", "student"]);
  const r = await db.run(`update public.profiles set role = 'owner' where id = '${U.as_ACT}';`);
  assert.notEqual(r.code, 0, "an unknown role value is rejected by the database");
});

test("I–J. active users reach their own portal and are refused the others", async () => {
  assert.deepEqual(await portals(ids.A), { admin: "allow", trainer: "unauthorized", student: "unauthorized" });
  assert.deepEqual(await portals(ids.T1), { admin: "unauthorized", trainer: "allow", student: "unauthorized" });
  assert.deepEqual(await portals(ids.ST1), { admin: "unauthorized", trainer: "unauthorized", student: "allow" });
});

test("K–L. invited and suspended users reach no portal; the outcome is identical to 'no profile' (nothing to tell them apart)", async () => {
  const none = { admin: "login", trainer: "login", student: "login" };
  assert.deepEqual(await portals(U.as_INV), none);
  assert.deepEqual(await portals(U.as_SUS), none);
  assert.deepEqual(await portals(U.as_NOPROF), none);
  // Same result from the lookup itself for all three — and one generic sign-in message.
  assert.deepEqual([await lookup(U.as_INV), await lookup(U.as_SUS), await lookup(U.as_NOPROF)], [null, null, null]);
  assert.doesNotMatch(NO_ACCESS_MESSAGE, /invit|suspend/i);
  // Reactivation restores access on the same session.
  await db.exec(`update public.profiles set account_status = 'active' where id = t.id('as_SUS');`, ids.A);
  assert.deepEqual(await portals(U.as_SUS), { admin: "unauthorized", trainer: "unauthorized", student: "allow" });
});

test("live dependency: against a database WITHOUT 0016 (today's live project) the lookup fails closed for everyone", async () => {
  let r = await db.run(`drop database if exists ${PRE_DB} with (force);\ncreate database ${PRE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  const files = [path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((f) => /^00\d\d_.*\.sql$/.test(f) && f < "0016").sort().map((f) => path.join(MIGRATIONS, f)),
    path.join(here, "fixtures/seed.sql")];
  for (const f of files) {
    r = await pre.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  const P = await pre.admin("select json_object_agg(k, v) from t.ids");
  for (const key of ["A", "T1", "ST1"]) {
    assert.equal(await lookup(P[key], pre.client({ role: "authenticated", userId: P[key] })), null, `${key}: no account_status column → no access`);
  }
  // After 0016 is applied there, the same code works again for existing users.
  r = await pre.run(read(path.join(MIGRATIONS, "0016_user_lifecycle.sql")));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await lookup(P.A, pre.client({ role: "authenticated", userId: P.A })), "admin");
  assert.equal(await lookup(P.ST1, pre.client({ role: "authenticated", userId: P.ST1 })), "student");
});
