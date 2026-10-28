// Integration (Phase 7 P3.2): the read-only Users view — the real users repository/service cores
// against the local 0001–0017 database, each viewer on their own session (RLS). The embedded read
// is resolved from the real foreign keys (pg-client.mjs), so every embedded table is read under
// the viewer's role exactly as behind PostgREST. Nothing here changes RLS, grants or migrations;
// the only writes are this file's own fixture rows (as the superuser, like every other test file).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { USERS, clientFor, db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createUsersRepository, UsersRepositoryError } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService, UsersAuthorizationError } = await import(`${build}/services/users.service.core.mjs`);
const { fetchProfileRole } = await import(`${build}/lib/auth/profile-role.mjs`);

let W; // ids
const session = (id) => db.client({ role: "authenticated", userId: id });
const userObj = (id, role) => ({ id, email: "x@test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" });

/** A client wrapper that counts every request (from / rpc) made through it. */
function counted(client) {
  const log = [];
  return {
    log,
    client: {
      from: (t) => (log.push(`from:${t}`), client.from(t)),
      rpc: (fn, a) => (log.push(`rpc:${fn}`), client.rpc(fn, a)),
    },
  };
}
const repoFor = (client, pageSize) => createUsersRepository(async () => client, pageSize ? { pageSize } : {});
/** The service exactly as wired in the app: identity from the session's own profile lookup (fetchProfileRole). */
function serviceForSession(id, { pageSize } = {}) {
  const client = id ? session(id) : clientFor(null);
  return createUsersService({
    repository: repoFor(client),
    getCurrentUser: async () => {
      if (!id) return null;
      const quiet = [console.warn, console.error];
      console.warn = console.error = () => {};
      try {
        const role = await fetchProfileRole(client, id);
        return role ? userObj(id, role) : null;
      } finally {
        [console.warn, console.error] = quiet;
      }
    },
    pageSize,
  });
}
const allPages = async (svc, params = {}) => {
  const first = await svc.listUsers({ ...params, page: "1" });
  const rows = [...first.rows];
  for (let p = 2; p <= first.pageCount; p++) rows.push(...(await svc.listUsers({ ...params, page: String(p) })).rows);
  return { first, rows };
};
const quietly = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ur_' || k, gen_random_uuid() from unnest(array['SA','SA_SUS','ORPHAN','INV','SUS','DUP1','DUP2','RC','TR']) k;
    insert into auth.users (id) select v from t.ids where k like 'ur\\_%';
    -- A fresh active Super Admin, and one that will be suspended.
    update public.profiles set role = 'super_admin' where id in (t.id('ur_SA'), t.id('ur_SA_SUS'));
    update public.profiles set account_status = 'active'
     where id in (t.id('ur_SA'), t.id('ur_SA_SUS'), t.id('ur_DUP1'), t.id('ur_DUP2'), t.id('ur_RC'), t.id('ur_TR'), t.id('ur_SUS'));
    -- ORPHAN: invited student-role profile without any record (as handle_new_user leaves it).
    -- INV: invited account whose student record is ACTIVE; SUS: suspended account whose record is ACTIVE.
    insert into public.students (id, student_code, full_name) values
      (t.id('ur_INV'), 'UR-INV', 'Ur Invited Person'),
      (t.id('ur_SUS'), 'UR-SUS', 'Ur Suspended Person'),
      (t.id('ur_DUP1'), 'UR-D1', 'Ur Same Name'),
      (t.id('ur_DUP2'), 'UR-D2', 'Ur Same Name'),
      (t.id('ur_RC'), 'UR-RC', 'Ur Role Changed');
    insert into public.student_details (student_id, email) values
      (t.id('ur_INV'), 'ur-inv@example.test'), (t.id('ur_SUS'), 'ur-sus@example.test'), (t.id('ur_DUP1'), 'ur-d1@example.test');
    update public.profiles set account_status = 'suspended' where id = t.id('ur_SUS');
    insert into public.batch_students (batch_id, student_id) select id, t.id('ur_DUP1') from public.batches where batch_code = 'B1';
    -- RC: a student who became a trainer — the 0003 trigger retires the student record (inactive).
    update public.profiles set role = 'trainer' where id in (t.id('ur_RC'), t.id('ur_TR'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ur_RC'), 'UR-TRC', 'Ur Role Changed'), (t.id('ur_TR'), 'UR-TR', 'Ur Trainer Inactive');
    insert into public.trainer_details (trainer_id, email) values (t.id('ur_TR'), 'ur-tr@example.test');
    update public.trainers set status = 'inactive' where id = t.id('ur_TR');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("1. Super Admin: every profile in the database, each exactly once, with domain data", async () => {
  const { first, rows } = await allPages(serviceForSession(W.ur_SA, { pageSize: 10 }));
  const expected = await db.admin("select json_agg(id order by id) from public.profiles");
  assert.equal(first.totals.all, expected.length);
  assert.deepEqual(rows.map((r) => r.id).sort(), expected);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[W.ur_INV].email, "ur-inv@example.test", "student_details email (readable by Super Admin)");
  assert.equal(byId[W.ur_TR].email, "ur-tr@example.test", "trainer_details email");
  assert.equal(byId[W.ur_SA].email, null, "no domain email for a Super Admin — never auth.users");
  assert.equal(byId[W.ur_SA].recordState, "not_applicable");
  assert.equal(byId[W.ur_SUS].record.code, "UR-SUS");
  assert.deepEqual(byId[W.ur_DUP1].batches.current.map((b) => b.code), ["B1"]);
  assert.deepEqual(byId[W.T1].batches.current.map((b) => b.code), ["B1"], "T1: B1 ongoing current; B3 completed");
  assert.ok(byId[W.T1].batches.completed >= 1);
});

test("2–4. trainer, student and signed-out callers are refused by the service — no request is made", async () => {
  for (const [label, id] of [["trainer", W.T1], ["student", W.ST1], ["anonymous", null]]) {
    const c = id ? counted(session(id)) : counted(clientFor(null));
    const svc = createUsersService({
      repository: repoFor(c.client),
      getCurrentUser: async () => (id ? userObj(id, label) : null),
    });
    await assert.rejects(svc.listUsers({ role: "admin", status: "active" }), UsersAuthorizationError, label);
    assert.deepEqual(c.log, [], `${label}: no database request`);
    // Through the real session lookup too.
    await assert.rejects(serviceForSession(id).listUsers({}), UsersAuthorizationError, `${label} (session)`);
  }
  // Anonymous straight at the repository: the database refuses (no privileges on profiles).
  await quietly(() => assert.rejects(repoFor(clientFor(null)).listProfiles(), UsersRepositoryError));
});

test("5. a suspended Super Admin cannot obtain Users data (session lookup refuses; RLS returns nothing)", async () => {
  const before = await serviceForSession(W.ur_SA_SUS).listUsers({});
  assert.ok(before.totals.all > 1, "active: works");
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('ur_SA_SUS');`);
  try {
    await assert.rejects(serviceForSession(W.ur_SA_SUS).listUsers({}), UsersAuthorizationError);
    // Even with a stale application identity, the database returns nothing on that session.
    const stale = createUsersService({ repository: repoFor(session(W.ur_SA_SUS)), getCurrentUser: async () => userObj(W.ur_SA_SUS, "admin") });
    const page = await stale.listUsers({});
    assert.equal(page.totals.all, 0);
    assert.deepEqual(await repoFor(session(W.ur_SA_SUS)).listProfiles(), []);
  } finally {
    await db.exec(`update public.profiles set account_status = 'active' where id = t.id('ur_SA_SUS');`);
  }
});

test("6. profiles without a domain record stay visible to the Super Admin", async () => {
  const svc = serviceForSession(W.ur_SA);
  // Every page: profiles without a name sort last by id, so the orphan's page depends on the other
  // record-less profiles already in the shared test database.
  const { first: missing, rows: missingRows } = await allPages(svc, { record: "missing" });
  const orphan = missingRows.find((r) => r.id === W.ur_ORPHAN);
  assert.ok(orphan, "invited profile with no student record is listed");
  assert.deepEqual([orphan.role, orphan.accountStatus, orphan.recordState, orphan.name, orphan.email], ["student", "invited", "missing", null, null]);
  assert.equal(missing.totals.missingRecord, missing.matching);
  const sa = (await svc.listUsers({ role: "admin" })).rows.map((r) => r.id);
  for (const id of [W.A, W.ur_SA, W.ur_SA_SUS]) assert.ok(sa.includes(id), "Super Admins (no domain record) are listed");
});

test("7. account status and person/domain status are read separately and never conflated", async () => {
  const svc = serviceForSession(W.ur_SA);
  const row = async (id, q) => (await svc.listUsers({ q })).rows.find((r) => r.id === id);
  const inv = await row(W.ur_INV, "UR-INV");
  assert.deepEqual([inv.accountStatus, inv.record.status], ["invited", "active"]);
  const sus = await row(W.ur_SUS, "UR-SUS");
  assert.deepEqual([sus.accountStatus, sus.record.status], ["suspended", "active"]);
  const tr = await row(W.ur_TR, "UR-TR");
  assert.deepEqual([tr.accountStatus, tr.record.status], ["active", "inactive"]);
  const rc = await row(W.ur_RC, "Ur Role Changed");
  assert.deepEqual([rc.role, rc.record.code, rc.record.status], ["trainer", "UR-TRC", "active"]);
  assert.deepEqual(rc.otherRecord, { kind: "student", code: "UR-RC", status: "inactive" }, "the retired student record is shown as such");
  // Filters on one status never match on the other.
  assert.ok(!(await svc.listUsers({ status: "active", q: "UR-SUS" })).rows.length);
  assert.ok((await svc.listUsers({ record: "active", q: "UR-SUS" })).rows.length === 1);
  assert.ok(!(await svc.listUsers({ status: "invited", q: "UR-TR" })).rows.some((r) => r.id === W.ur_TR));
});

test("8–9. RLS is authoritative: through this repository a trainer or student reads only their own profile", async () => {
  for (const key of ["T1", "ST1"]) {
    const rows = await repoFor(session(W[key])).listProfiles();
    assert.deepEqual(rows.map((r) => r.id), [W[key]], `${key}: own profile only`);
  }
  const [t1] = await repoFor(session(W.T1)).listProfiles();
  assert.equal(t1.trainers.trainer_code, "T1", "own trainer record readable by self");
  // No other account's profile, account status or contact email leaks to a trainer.
  const text = JSON.stringify(await repoFor(session(W.T1)).listProfiles());
  for (const leak of [W.ur_SA, W.ur_DUP1, "ur-d1@example.test", "ur-inv@example.test", "super_admin"]) assert.equal(text.includes(leak), false, leak);
  // A tampered service call (trainer claiming filters for admins) is still refused.
  await assert.rejects(serviceForSession(W.T1).listUsers({ role: "admin", page: "1" }), UsersAuthorizationError);
  // The Super Admin result equals what the database itself says profiles contains — nothing more.
  const ids = (await repoFor(session(W.ur_SA)).listProfiles()).map((r) => r.id);
  assert.deepEqual(ids, await db.admin("select json_agg(id order by id) from public.profiles"));
});

test("10. keyset pagination: small pages return the same rows, in id order, with no gaps or repeats", async () => {
  const full = await repoFor(session(W.ur_SA)).listProfiles();
  for (const size of [1, 2, 3, 7]) {
    const c = counted(session(W.ur_SA));
    const paged = await repoFor(c.client, size).listProfiles();
    assert.deepEqual(paged.map((r) => r.id), full.map((r) => r.id), `page size ${size}`);
    assert.equal(c.log.length, Math.ceil(full.length / size) + 1, `page size ${size}: ⌈n/size⌉ pages + the empty end page`);
  }
  const ids = full.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort(), "ascending id order");
});

test("11. stable ordering: lower(name), then id — identical across calls, duplicate names by id", async () => {
  const svc = serviceForSession(W.ur_SA, { pageSize: 7 });
  const a = (await allPages(svc)).rows.map((r) => r.id);
  const b = (await allPages(svc)).rows.map((r) => r.id);
  assert.deepEqual(a, b);
  const dup = (await svc.listUsers({ q: "Ur Same Name" })).rows.map((r) => r.id);
  assert.deepEqual(dup, [W.ur_DUP1, W.ur_DUP2].sort());
  const names = (await allPages(svc)).rows.map((r) => r.name);
  const named = names.filter((n) => n !== null);
  assert.deepEqual(named, [...named].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0)));
  assert.ok(names.indexOf(null) === -1 || names.slice(names.indexOf(null)).every((n) => n === null), "unnamed accounts last");
});

test("12. no N+1: the request count does not grow with records, enrolments or batches", async () => {
  const measure = async () => {
    const c = counted(session(W.ur_SA));
    const rows = await repoFor(c.client).listProfiles();
    return { requests: c.log, rows: rows.length };
  };
  const before = await measure();
  assert.deepEqual(before.requests, ["from:profiles", "from:profiles"], "one embedded read + the empty end page");
  await db.exec(`
    insert into public.batch_students (batch_id, student_id)
    select b.id, s.id from public.batches b cross join (values (t.id('ur_DUP2')), (t.id('ur_SUS')), (t.id('ur_INV'))) s(id)
     where b.batch_code in ('B1', 'B2') on conflict do nothing;`);
  const after = await measure();
  assert.deepEqual(after.requests, before.requests);
  assert.equal(after.rows, before.rows);
});

test("the embed is unambiguous: exactly one foreign key links each record table to profiles", async () => {
  const fks = await db.admin(`select json_object_agg(r, n) from (
      select cr.relname r, count(*) n from pg_constraint c join pg_class cr on cr.oid = c.conrelid
       where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and cr.relname in ('students', 'trainers') group by 1) x`);
  assert.deepEqual(fks, { students: 1, trainers: 1 });
  assert.deepEqual(await db.admin(`select json_agg(conname order by conname) from pg_constraint where conname in ('students_id_fkey', 'trainers_id_fkey')`), ["students_id_fkey", "trainers_id_fkey"]);
});

test("reads only: listing users changes no table and writes no audit or history rows", async () => {
  const snapshot = () =>
    db.admin(`select json_build_object(
      'profiles', (select md5(string_agg(to_jsonb(p)::text, ',' order by id)) from public.profiles p),
      'events', (select count(*) from public.user_admin_events),
      'enrol', (select count(*) from public.enrollment_events))`);
  const s1 = await snapshot();
  await allPages(serviceForSession(W.ur_SA, { pageSize: 5 }), { q: "ur" });
  assert.deepEqual(await snapshot(), s1);
  assert.ok(USERS.A, "seed admin still present");
});
