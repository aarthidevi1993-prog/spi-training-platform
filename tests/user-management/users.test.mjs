// Phase 7 P3.2 — read-only Users view (pure tests).
// The real src/lib/user-management/users.ts, users.service.core.ts and users.repository.core.ts
// (transpiled by run.mjs): URL filter validation, mapping, search, deterministic ordering, paging,
// the service's own authorization, keyset reads with a stand-in client, and source-level checks
// that the module stays read-only and never reaches the service-role client.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.UM_BUILD;
if (!build) throw new Error("Run through tests/user-management/run.mjs");
const U = await import(`${build}/lib/user-management/users.mjs`);
const { createUsersService, UsersAuthorizationError } = await import(`${build}/services/users.service.core.mjs`);
const { createUsersRepository, UsersRepositoryError, USER_PROFILE_SELECT } = await import(`${build}/repositories/users.repository.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ---------------------------------------------------------------- fixtures
let seq = 0;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const batch = (code, status, n = ++seq) => ({ id: uuid(9000 + n), batch_code: code, name: `Batch ${code}`, status });
function profile(over = {}) {
  return {
    id: uuid(++seq),
    role: "student",
    account_status: "active",
    account_status_changed_at: "2026-09-01T10:00:00+00:00",
    created_at: "2026-08-01T10:00:00+00:00",
    updated_at: "2026-09-01T10:00:00+00:00",
    students: null,
    trainers: null,
    ...over,
  };
}
const student = (name, code, over = {}) => ({
  student_code: code,
  full_name: name,
  status: "active",
  student_details: { email: `${code.toLowerCase()}@example.test` },
  batch_students: [],
  ...over,
});
const trainer = (name, code, over = {}) => ({
  trainer_code: code,
  full_name: name,
  status: "active",
  trainer_details: { email: `${code.toLowerCase()}@example.test` },
  batches: [],
  ...over,
});
const F = (over = {}) => ({ ...U.DEFAULT_USER_FILTERS, ...over });

// ---------------------------------------------------------------- filters
test("filters: defaults, whitelisted values only, first value of repeated params", () => {
  assert.deepEqual(U.parseUserListFilters(undefined), { q: "", role: "all", status: "all", record: "all", page: 1 });
  assert.deepEqual(U.parseUserListFilters({ q: " Asha ", role: "trainer", status: "suspended", record: "missing", page: "3" }), {
    q: "Asha",
    role: "trainer",
    status: "suspended",
    record: "missing",
    page: 3,
  });
  for (const role of ["super_admin", "ADMIN", "owner", "admin'--", ""]) assert.equal(U.parseUserListFilters({ role }).role, "all", role);
  for (const status of ["deleted", "Active", "inactive", "all;drop"]) assert.equal(U.parseUserListFilters({ status }).status, "all", status);
  for (const record of ["present", "not_applicable", "MISSING", "role"]) assert.equal(U.parseUserListFilters({ record }).record, "all", record);
  for (const record of ["active", "inactive", "invited", "missing"]) assert.equal(U.parseUserListFilters({ record }).record, record);
  assert.equal(U.parseUserListFilters({ role: ["student", "admin"] }).role, "student");
  // Unknown parameters (columns, sort keys, expressions) are ignored entirely.
  const parsed = U.parseUserListFilters({ order: "email.desc", select: "*", column: "auth.users", or: "(role.eq.super_admin)" });
  assert.deepEqual(Object.keys(parsed).sort(), ["page", "q", "record", "role", "status"]);
  assert.deepEqual(parsed, U.DEFAULT_USER_FILTERS);
});

test("filters: page is a positive bounded integer; anything else is page 1", () => {
  for (const page of ["0", "-1", "abc", "1e3", "2.5", " 2", "", "1234567"]) assert.equal(U.parseUserListFilters({ page }).page, 1, page);
  assert.equal(U.parseUserListFilters({ page: "000004" }).page, 4);
  assert.equal(U.parseUserListFilters({ page: "999999" }).page, 100000);
});

test("filters: search is trimmed, whitespace-collapsed, stripped of control characters and capped", () => {
  assert.equal(U.normalizeSearch("  a \t\n b  "), "a b");
  assert.equal(U.normalizeSearch("x\u0000y\u001fz\u007f"), "x y z");
  const long = "é".repeat(150);
  assert.equal(Array.from(U.normalizeSearch(long)).length, U.SEARCH_MAX_LENGTH);
  assert.equal(Array.from(U.normalizeSearch("😀".repeat(120))).length, U.SEARCH_MAX_LENGTH, "counts characters, not UTF-16 units");
  assert.equal(U.normalizeSearch(undefined), "");
  assert.equal(U.parseUserListFilters({ q: "%_' or 1=1 --" }).q, "%_' or 1=1 --", "kept as plain text; only ever compared in memory");
});

test("URLs: defaults omitted, values encoded, and parse(href) round-trips", () => {
  assert.equal(U.usersHref("/admin/users", F()), "/admin/users");
  const f = F({ q: "a&b=c ?", role: "trainer", status: "invited", record: "inactive", page: 2 });
  const href = U.usersHref("/admin/users", f);
  assert.match(href, /^\/admin\/users\?/);
  const params = Object.fromEntries(new URL(href, "http://x").searchParams);
  assert.deepEqual(U.parseUserListFilters(params), f);
  assert.equal(U.usersHref("/admin/users", f, { page: 1 }).includes("page="), false);
});

// ---------------------------------------------------------------- mapping
test("mapping: Super Admin has no domain record (not applicable) and no email source", () => {
  const u = U.mapUserRecord(profile({ role: "super_admin" }));
  assert.equal(u.role, "admin");
  assert.equal(u.recordState, "not_applicable");
  assert.equal(u.record, null);
  assert.equal(u.batches, null);
  assert.equal(u.email, null);
  assert.equal(u.name, null);
});

test("mapping: missing domain record stays a visible row (student/trainer role without its record)", () => {
  const s = U.mapUserRecord(profile({ role: "student", account_status: "invited" }));
  assert.equal(s.recordState, "missing");
  assert.equal(s.record, null);
  assert.equal(s.name, null);
  assert.equal(s.accountStatus, "invited");
  const t = U.mapUserRecord(profile({ role: "trainer", students: [student("Old Student", "OS1")] }));
  assert.equal(t.recordState, "missing", "a record of ANOTHER kind does not satisfy the trainer role");
  assert.deepEqual(t.otherRecord, { kind: "student", code: "OS1", status: "active" });
  assert.equal(t.name, "Old Student", "name falls back to the same person's other record");
  assert.equal(t.email, "os1@example.test");
});

test("mapping: account status and person/domain status are separate and never merged", () => {
  const cases = [
    ["invited", "active"],
    ["active", "inactive"],
    ["suspended", "active"],
    ["active", "invited"],
  ];
  for (const [account, person] of cases) {
    const u = U.mapUserRecord(profile({ account_status: account, students: student("A B", `C${account}${person}`, { status: person }) }));
    assert.equal(u.accountStatus, account);
    assert.equal(u.record.status, person);
  }
  // Values outside the enums are never shown as active.
  const odd = U.mapUserRecord(profile({ account_status: "weird", students: student("Odd", "ODD", { status: "weird" }) }));
  assert.equal(odd.accountStatus, "suspended");
  assert.equal(odd.record.status, "inactive");
  assert.equal(U.mapUserRecord(profile({ role: "owner" })).role, null);
});

test("mapping: student batches — current (enrolled, not cancelled), completed and withdrawn counts", () => {
  const u = U.mapUserRecord(
    profile({
      students: student("Asha", "S1", {
        batch_students: [
          { enrollment_status: "enrolled", batches: batch("B-2", "ongoing") },
          { enrollment_status: "enrolled", batches: [batch("B-1", "upcoming")] },
          { enrollment_status: "enrolled", batches: batch("B-X", "cancelled") },
          { enrollment_status: "completed", batches: batch("B-0", "completed") },
          { enrollment_status: "withdrawn", batches: batch("B-W", "ongoing") },
          { enrollment_status: "enrolled", batches: null },
        ],
      }),
    })
  );
  assert.deepEqual(u.batches.current.map((b) => b.code), ["B-1", "B-2"]);
  assert.equal(u.batches.completed, 1);
  assert.equal(u.batches.withdrawn, 1);
});

test("mapping: trainer batches — upcoming/ongoing current, completed counted, cancelled ignored", () => {
  const u = U.mapUserRecord(
    profile({ role: "trainer", trainers: [trainer("Tara", "T9", { status: "inactive", batches: [batch("Z", "ongoing"), batch("A", "upcoming"), batch("C", "completed"), batch("X", "cancelled")] })] })
  );
  assert.equal(u.recordState, "present");
  assert.deepEqual(u.record, { kind: "trainer", code: "T9", status: "inactive" });
  assert.deepEqual(u.batches.current.map((b) => b.code), ["A", "Z"]);
  assert.equal(u.batches.completed, 1);
  assert.equal(u.batches.withdrawn, 0);
  assert.equal(u.email, "t9@example.test");
});

test("mapping: blank or missing detail emails show as no email", () => {
  assert.equal(U.mapUserRecord(profile({ students: student("N", "N1", { student_details: null }) })).email, null);
  assert.equal(U.mapUserRecord(profile({ students: student("N", "N2", { student_details: [{ email: "  " }] }) })).email, null);
  assert.equal(U.mapUserRecord(profile({ students: student("N", "N3", { student_details: [] }) })).email, null);
});

// ---------------------------------------------------------------- ordering, filtering, paging
test("ordering: lower(name), then id; duplicate names break ties by id; unnamed accounts last", () => {
  const rows = [
    profile({ id: uuid(5), students: student("bravo", "S5") }),
    profile({ id: uuid(3), students: student("Alpha", "S3") }),
    profile({ id: uuid(9), role: "super_admin" }),
    profile({ id: uuid(2), students: student("ALPHA", "S2") }),
    profile({ id: uuid(1), role: "trainer" }),
    profile({ id: uuid(4), students: student("alpha", "S4") }),
  ];
  const order = (list) => U.buildUserListPage(list, F(), 50).rows.map((r) => r.id);
  const expected = [uuid(2), uuid(3), uuid(4), uuid(5), uuid(1), uuid(9)];
  assert.deepEqual(order(rows), expected);
  assert.deepEqual(order([...rows].reverse()), expected, "input order never changes the result");
});

test("paging: only the requested page is returned; out-of-range pages clamp to the last page", () => {
  const rows = Array.from({ length: 23 }, (_, i) => profile({ id: uuid(100 + i), students: student(`User ${String(i).padStart(2, "0")}`, `P${i}`) }));
  const p1 = U.buildUserListPage(rows, F(), 10);
  assert.equal(p1.rows.length, 10);
  assert.equal(p1.pageCount, 3);
  assert.equal(p1.matching, 23);
  const p3 = U.buildUserListPage(rows, F({ page: 3 }), 10);
  assert.deepEqual(p3.rows.map((r) => r.name), ["User 20", "User 21", "User 22"]);
  const far = U.buildUserListPage(rows, F({ page: 99 }), 10);
  assert.equal(far.page, 3);
  assert.equal(far.filters.page, 3);
  const all = [1, 2, 3].flatMap((page) => U.buildUserListPage(rows, F({ page }), 10).rows.map((r) => r.id));
  assert.equal(new Set(all).size, 23, "pages neither overlap nor skip");
  const empty = U.buildUserListPage([], F({ page: 4 }), 10);
  assert.deepEqual([empty.rows.length, empty.page, empty.pageCount, empty.matching], [0, 1, 1, 0]);
});

test("filters narrow only; totals always describe every readable account", () => {
  const rows = [
    profile({ role: "super_admin" }),
    profile({ account_status: "invited" }),
    profile({ account_status: "suspended", students: student("Sus Pended", "SP1") }),
    profile({ role: "trainer", trainers: trainer("Tina Inactive", "TI1", { status: "inactive" }) }),
    profile({ students: student("Ivy Invited Record", "IR1", { status: "invited" }) }),
    profile({ students: student("Find Me", "FM-77", { student_details: { email: "Needle@Example.test" } }) }),
  ];
  const run = (over) => U.buildUserListPage(rows, F(over), 50);
  const base = run({});
  assert.deepEqual(base.totals, { all: 6, byStatus: { invited: 1, active: 4, suspended: 1 }, missingRecord: 1 });
  assert.equal(run({ role: "admin" }).matching, 1);
  assert.equal(run({ role: "trainer" }).matching, 1);
  assert.equal(run({ status: "suspended" }).rows[0].name, "Sus Pended");
  assert.equal(run({ record: "missing" }).rows[0].accountStatus, "invited");
  assert.equal(run({ record: "inactive" }).rows[0].name, "Tina Inactive");
  assert.equal(run({ record: "invited" }).rows[0].name, "Ivy Invited Record");
  assert.equal(run({ record: "active" }).matching, 2, "Super Admins and missing records never match a person-status filter");
  for (const q of ["needle@example", "fm-77", "FIND me", rows[5].id.slice(-6)]) assert.equal(run({ q }).rows[0]?.name, "Find Me", q);
  assert.equal(run({ q: "nothing-like-this" }).matching, 0);
  for (const over of [{ role: "student" }, { status: "invited" }, { q: "e" }, { record: "missing" }]) {
    const r = run(over);
    assert.deepEqual(r.totals, base.totals);
    assert.ok(r.matching <= base.matching);
    for (const row of r.rows) assert.ok(base.rows.some((b) => b.id === row.id), "never a row that was not already readable");
  }
});

// ---------------------------------------------------------------- service authorization
const ADMIN = { id: uuid(1), email: "a@test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" };
function fakeRepo(records = []) {
  const calls = { n: 0 };
  return { calls, repository: { listProfiles: async () => (calls.n++, records) } };
}

test("service: signed-out, trainer and student callers are refused before any read", async () => {
  for (const user of [null, { ...ADMIN, role: "trainer" }, { ...ADMIN, role: "student" }, { ...ADMIN, role: "owner" }]) {
    const { calls, repository } = fakeRepo([profile()]);
    const svc = createUsersService({ repository, getCurrentUser: async () => user });
    await assert.rejects(svc.listUsers({}), UsersAuthorizationError);
    assert.equal(calls.n, 0, `no repository call for ${user?.role ?? "anonymous"}`);
  }
});

test("service: Super Admin gets one validated page; identity is never taken from parameters", async () => {
  const { calls, repository } = fakeRepo([profile({ students: student("Only", "O1") })]);
  const svc = createUsersService({ repository, getCurrentUser: async () => ADMIN, pageSize: 10 });
  const page = await svc.listUsers({ role: "student", userId: uuid(77), as: "super_admin", page: "x" });
  assert.equal(calls.n, 1);
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.filters, F({ role: "student" }));
  assert.equal(page.pageSize, 10);
});

test("service: demo mode shows an empty list instead of reading or inventing accounts", async () => {
  const { calls, repository } = fakeRepo([profile()]);
  const svc = createUsersService({ repository, getCurrentUser: async () => ADMIN, isDemoMode: () => true });
  const page = await svc.listUsers({});
  assert.equal(calls.n, 0);
  assert.equal(page.totals.all, 0);
});

// ---------------------------------------------------------------- Super Admin identity (accepted invitation)
const identity = (userId, name, acceptedAt = "2026-09-02T10:00:00+00:00", id = uuid(8000 + ++seq)) => ({ id, accepted_user_id: userId, full_name: name, accepted_at: acceptedAt });

test("identity: a Super Admin gets the name of its accepted invitation — never an email; records keep precedence", () => {
  const sa = profile({ role: "super_admin" });
  const u = U.mapUserRecord(sa, identity(sa.id, "  Asha Super  "));
  assert.equal(u.name, "Asha Super");
  assert.equal(u.email, null, "an invitation never provides an email");
  assert.equal(U.mapUserRecord(sa).name, null, "no accepted invitation → no name");
  assert.equal(U.mapUserRecord(sa, identity(sa.id, "   ")).name, null, "a blank invited name is no name");
  assert.equal(U.mapUserRecord(sa, identity(uuid(999), "Someone Else")).name, null, "another account's invitation is ignored");
  // Student / trainer: their own record stays the source of name and email.
  const st = profile({ role: "student", students: student("Record Name", "R1") });
  const s = U.mapUserRecord(st, identity(st.id, "Invited Name"));
  assert.equal(s.name, "Record Name");
  assert.equal(s.email, "r1@example.test");
  const tr = profile({ role: "trainer", trainers: trainer("Trainer Record", "T9") });
  assert.equal(U.mapUserRecord(tr, identity(tr.id, "Invited Name")).name, "Trainer Record");
  // A record without a name falls back to the invitation's name, still without taking its email.
  const blank = profile({ role: "trainer", trainers: trainer("  ", "T8", { trainer_details: null }) });
  const b = U.mapUserRecord(blank, identity(blank.id, "Invited Trainer"));
  assert.equal(b.name, "Invited Trainer");
  assert.equal(b.email, null);
});

test("identity: one per account — the most recently accepted invitation, stable on ties; junk ignored", () => {
  const id = uuid(4242);
  const index = U.identityIndex([
    identity(id, "Older", "2026-01-01T00:00:00+00:00", uuid(1)),
    identity(id, "Newer", "2026-05-01T00:00:00+00:00", uuid(2)),
    identity(id, "Same time, smaller id", "2026-05-01T00:00:00+00:00", uuid(0)),
    null,
    { accepted_user_id: null, full_name: "x", accepted_at: null },
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.get(id).full_name, "Newer");
  assert.equal(U.identityIndex(undefined).size, 0);
});

test("identity: the list uses identities for names, search and sort; totals and rows are unchanged", () => {
  const sa = profile({ role: "super_admin" });
  const st = profile({ role: "student", students: student("Zed Student", "Z1") });
  const without = U.buildUserListPage([sa, st], F(), 50);
  const withIds = U.buildUserListPage([sa, st], F(), 50, [identity(sa.id, "Asha Super")]);
  assert.deepEqual(withIds.totals, without.totals);
  assert.deepEqual(withIds.rows.map((r) => r.name), ["Asha Super", "Zed Student"], "named Super Admin sorts by name");
  assert.deepEqual(without.rows.map((r) => r.name), ["Zed Student", null], "unnamed accounts sort last");
  assert.deepEqual(U.buildUserListPage([sa, st], F({ q: "asha" }), 50, [identity(sa.id, "Asha Super")]).rows.map((r) => r.id), [sa.id]);
});

function identityRepo(o = {}) {
  const calls = [];
  const sa = o.sa ?? profile({ role: "super_admin" });
  const repository = {
    listProfiles: async () => (calls.push("listProfiles"), [sa]),
    getProfile: async (id) => (calls.push("getProfile"), { ...sa, id }),
    listAuditEvents: async () => (calls.push("listAuditEvents"), o.audit ?? []),
    latestStatusChange: async () => (calls.push("latestStatusChange"), null),
    listAcceptedIdentities: async (ids) => {
      calls.push(["listAcceptedIdentities", ids ?? "all"]);
      if (o.identityFails) throw new Error("boom");
      return (o.identities ?? [identity(sa.id, "Asha Super")]).filter((r) => !ids || ids.includes(r.accepted_user_id));
    },
    listRecordNames: async (ids) => {
      calls.push(["listRecordNames", ids]);
      return (o.recordNames ?? []).filter((r) => ids.includes(r.id));
    },
  };
  return { calls, repository, sa };
}

test("identity service: trainers, students and signed-out callers get nothing — not even an identity read", async () => {
  for (const user of [null, { ...ADMIN, role: "trainer" }, { ...ADMIN, role: "student" }]) {
    const { calls, repository, sa } = identityRepo();
    const svc = createUsersService({ repository, getCurrentUser: async () => user });
    await assert.rejects(svc.listUsers({}), UsersAuthorizationError);
    await assert.rejects(svc.getUserDetail(sa.id), UsersAuthorizationError);
    assert.deepEqual(calls, [], `no read at all for ${user?.role ?? "anonymous"}`);
  }
});

test("identity service: a Super Admin's list reads identities once, after the profiles; demo mode reads neither", async () => {
  const { calls, repository, sa } = identityRepo();
  const page = await createUsersService({ repository, getCurrentUser: async () => ADMIN }).listUsers({});
  assert.deepEqual(calls, ["listProfiles", ["listAcceptedIdentities", "all"]]);
  assert.equal(page.rows.find((r) => r.id === sa.id).name, "Asha Super");
  assert.equal(page.rows.find((r) => r.id === sa.id).email, null);
  const demo = identityRepo();
  await createUsersService({ repository: demo.repository, getCurrentUser: async () => ADMIN, isDemoMode: () => true }).listUsers({});
  assert.deepEqual(demo.calls, []);
});

test("identity service: a failed identity read leaves names out instead of failing the page", async () => {
  const { repository, sa } = identityRepo({ identityFails: true });
  const svc = createUsersService({ repository, getCurrentUser: async () => ADMIN });
  const page = await svc.listUsers({});
  assert.equal(page.rows[0].name, null);
  const detail = await svc.getUserDetail(sa.id);
  assert.equal(detail.user.name, null);
  assert.equal(detail.invitationAcceptedAt, null);
});

test("identity service: the detail shows the account's invited name, acceptance time and named history actors", async () => {
  const OTHER_SA = uuid(7001);
  const TRAINER = uuid(7002);
  const UNKNOWN = uuid(7003);
  const sa = profile({ role: "super_admin" });
  const audit = [
    { id: 4, occurred_at: "2026-09-04T00:00:00Z", event_type: "role_changed", actor_id: ADMIN.id, detail: {} },
    { id: 3, occurred_at: "2026-09-03T00:00:00Z", event_type: "account_status_changed", actor_id: OTHER_SA, detail: {} },
    { id: 2, occurred_at: "2026-09-02T00:00:00Z", event_type: "user_details_changed", actor_id: TRAINER, detail: {} },
    { id: 1, occurred_at: "2026-09-01T00:00:00Z", event_type: "invitation_accepted", actor_id: UNKNOWN, detail: {} },
    { id: 0, occurred_at: "2026-08-31T00:00:00Z", event_type: "invitation_created", actor_id: null, detail: {} },
  ];
  const { calls, repository } = identityRepo({
    sa,
    audit,
    identities: [identity(sa.id, "Asha Super", "2026-09-01T09:00:00+00:00"), identity(OTHER_SA, "Bala Super"), identity(TRAINER, "Old Invited Name")],
    recordNames: [{ id: TRAINER, students: null, trainers: { full_name: "Trainer Record Name" } }],
  });
  const detail = await createUsersService({ repository, getCurrentUser: async () => ADMIN }).getUserDetail(sa.id);
  assert.equal(detail.user.name, "Asha Super");
  assert.equal(detail.user.email, null);
  assert.equal(detail.invitationAcceptedAt, "2026-09-01T09:00:00+00:00");
  assert.deepEqual(
    detail.history.map((h) => [h.actor, h.actorName ?? null]),
    [["you", null], [OTHER_SA, "Bala Super"], [TRAINER, "Trainer Record Name"], [UNKNOWN, null], [null, null]],
    "you / invited name / own record name first / unknown keeps its id / system"
  );
  // The viewer itself is never looked up; record names first, invitations only for the rest.
  assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === "listRecordNames"), [["listRecordNames", [OTHER_SA, TRAINER, UNKNOWN]]]);
  assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === "listAcceptedIdentities"), [
    ["listAcceptedIdentities", [sa.id]],
    ["listAcceptedIdentities", [OTHER_SA, UNKNOWN]],
  ]);
});

// ---------------------------------------------------------------- repository (stand-in client)
function keysetClient(rows, log) {
  return {
    from(table) {
      log.push(table);
      return {
        select(cols) {
          const state = { after: null, limit: Infinity, cols };
          const b = {
            gt: (col, v) => (assert.equal(col, "id"), (state.after = v), b),
            order: (col) => (assert.equal(col, "id"), b),
            limit: (n) => ((state.limit = n), b),
            then: (res, rej) =>
              Promise.resolve({ data: rows.filter((r) => state.after === null || r.id > state.after).slice(0, state.limit), error: null }).then(res, rej),
          };
          return b;
        },
      };
    },
  };
}

test("repository: keyset pages over profiles — requests grow with accounts / page size only (no N+1)", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => profile({ id: uuid(500 + i), students: student(`K${i}`, `K${i}`, { batch_students: [{ enrollment_status: "enrolled", batches: batch(`KB${i}`, "ongoing") }] }) }));
  const log = [];
  const repo = createUsersRepository(async () => keysetClient(rows, log), { pageSize: 3 });
  const read = await repo.listProfiles();
  assert.deepEqual(read.map((r) => r.id), rows.map((r) => r.id));
  assert.deepEqual(log, ["profiles", "profiles", "profiles", "profiles"], "ceil(7/3) pages + the empty end page, all on profiles");
});

test("repository: missing client or database error → generic error, no detail leaked", async () => {
  await assert.rejects(createUsersRepository(async () => null).listProfiles(), UsersRepositoryError);
  const failing = { from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "42501", message: "permission denied for table secrets" } }) }) }) }) };
  const err = console.error;
  console.error = () => {};
  try {
    await assert.rejects(createUsersRepository(async () => failing).listProfiles(), (e) => e instanceof UsersRepositoryError && !/secrets|42501/.test(e.message));
  } finally {
    console.error = err;
  }
});

test("repository: identities come only from ACCEPTED invitations, with a fixed name-only column list; names from records", async () => {
  const { USER_IDENTITY_SELECT, USER_NAME_SELECT } = await import(`${build}/repositories/users.repository.core.mjs`);
  assert.equal(USER_IDENTITY_SELECT, "id, accepted_user_id, full_name, accepted_at");
  assert.doesNotMatch(USER_IDENTITY_SELECT, /email|token|auth_user_id|code|phone|password|meta/i);
  assert.doesNotMatch(USER_NAME_SELECT, /email|details|auth|token|phone/i);
  const ops = [];
  const client = {
    from(table) {
      ops.push(["from", table]);
      const b = {
        select: (cols) => (ops.push(["select", cols]), b),
        eq: (c, v) => (ops.push(["eq", c, v]), b),
        not: (c, op, v) => (ops.push(["not", c, op, v]), b),
        in: (c, v) => (ops.push(["in", c, v]), b),
        gt: (c, v) => (ops.push(["gt", c, v]), b),
        order: (c) => (ops.push(["order", c]), b),
        limit: (n) => (ops.push(["limit", n]), b),
        then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return b;
    },
  };
  const repo = createUsersRepository(async () => client);
  await repo.listAcceptedIdentities([uuid(1), uuid(2)]);
  assert.deepEqual(ops.slice(0, 4), [
    ["from", "user_invitations"],
    ["select", USER_IDENTITY_SELECT],
    ["eq", "status", "accepted"],
    ["in", "accepted_user_id", [uuid(1), uuid(2)]],
  ]);
  ops.length = 0;
  await repo.listAcceptedIdentities();
  assert.ok(!ops.some((o) => o[0] === "in"), "the list reads every accepted invitation (RLS-scoped)");
  assert.ok(ops.some((o) => o[0] === "eq" && o[1] === "status" && o[2] === "accepted"));
  ops.length = 0;
  assert.deepEqual(await repo.listAcceptedIdentities([]), []);
  assert.deepEqual(await repo.listRecordNames([]), []);
  assert.deepEqual(ops, [], "no ids → no request");
  await repo.listRecordNames([uuid(3)]);
  assert.deepEqual(ops.slice(0, 3), [["from", "profiles"], ["select", USER_NAME_SELECT], ["in", "id", [uuid(3)]]]);
});

test("source: an account without any name is labelled 'Name not recorded' in the Super Admin list and panel", () => {
  for (const rel of ["src/components/modules/UsersTable.tsx", "src/components/modules/UserDetailPanel.tsx"]) {
    assert.match(src(rel), /u\.name \?\? "Name not recorded"/, rel);
    assert.doesNotMatch(src(rel), /No name on record/, rel);
  }
  assert.match(src("src/components/modules/UserDetailPanel.tsx"), /h\.actorName \? \(\s*<>· by \{h\.actorName\}<\/>/);
});

test("repository select: only profile/domain/batch columns — nothing from auth, no secrets", () => {
  const cols = USER_PROFILE_SELECT.replace(/\s+/g, " ");
  assert.doesNotMatch(cols, /auth|password|token|secret|session|raw_|meta|phone|invit/i);
  for (const needed of ["account_status", "students!students_id_fkey", "trainers!trainers_id_fkey", "student_details ( email )", "trainer_details ( email )", "batch_students"]) {
    assert.ok(cols.includes(needed), needed);
  }
});

// ---------------------------------------------------------------- source checks
const USER_FILES = [
  "src/types/user-management.ts",
  "src/lib/user-management/users.ts",
  "src/repositories/users.repository.core.ts",
  "src/repositories/users.repository.ts",
  "src/services/users.service.core.ts",
  "src/services/users.service.ts",
  "src/app/admin/users/page.tsx",
  "src/app/admin/users/loading.tsx",
  "src/components/modules/UsersTable.tsx",
  // P3.3 lifecycle actions
  "src/lib/user-management/lifecycle.ts",
  "src/services/users.actions.ts",
  "src/components/modules/UserDetailPanel.tsx",
];
/** The only database functions the Users module may call — the 0017 Super Admin functions for P3.3. */
// P5.2 (0029a): + invitation_recovery_candidate — a Super Admin-only READ (lifecycle facts, never the address).
const ALLOWED_RPCS = ["admin_set_account_status", "admin_set_user_role", "admin_update_student", "admin_update_trainer", "invitation_recovery_candidate"];

test("source: no Users file imports the service-role client, reads auth.users or the service-role key", () => {
  for (const rel of USER_FILES) {
    const code = src(rel);
    assert.doesNotMatch(code, /@\/lib\/supabase\/admin|lib\/supabase\/admin|createSupabaseAdminClient/, rel);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role/, rel);
    assert.doesNotMatch(code, /auth\.admin|\.schema\(\s*["']auth["']|from\(\s*["']users["']/, rel);
  }
  // The admin client has exactly one importer in src: the P3.4 Auth Admin repository.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const importers = walk(path.join(root, "src"))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(path.join("supabase", "admin.ts")))
    .filter((f) => /from\s+["'][^"']*lib\/supabase\/admin["']/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(root, f).split(path.sep).join("/"));
  assert.deepEqual(importers, ["src/repositories/auth-admin.repository.ts"]);
});

test("source: no direct table writes; changes only through the approved 0017 functions; the list stays action-free", () => {
  const rpcsIn = (code) => Array.from(code.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g), (m) => m[1]);
  for (const rel of USER_FILES) {
    const code = src(rel);
    assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/, `${rel}: no direct table writes`);
    const rpcs = rpcsIn(code);
    for (const fn of rpcs) assert.ok(ALLOWED_RPCS.includes(fn), `${rel}: unexpected RPC ${fn}`);
    if (rpcs.length) assert.equal(rel, "src/repositories/users.repository.core.ts", "RPCs only in the repository");
    if (/["']use server["']/.test(code)) assert.equal(rel, "src/services/users.actions.ts", "server actions only in users.actions.ts");
    // Never here: invitations, acceptance, enrolment, trainer assignment, Auth Admin (later phases / out of scope).
    assert.doesNotMatch(
      code,
      /create_user_invitation|revoke_user_invitation|expire_user_invitations|accept_user_invitation|admin_set_enrollment|admin_assign_batch_trainer|trainer_enroll_student|trainer_update_student|deleteUser|inviteUserByEmail/,
      rel
    );
  }
  assert.deepEqual(rpcsIn(src("src/repositories/users.repository.core.ts")).sort(), [...ALLOWED_RPCS].sort());
  const actions = src("src/services/users.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(actions, /@\/repositories\/|@\/lib\/supabase\//, "actions go through the service only");
  const panel = src("src/components/modules/UserDetailPanel.tsx");
  assert.doesNotMatch(panel, /@\/services\/users\.service|@\/repositories\/|@\/lib\/supabase\/(server|admin)/, "the client panel only calls server actions");
  const table = src("src/components/modules/UsersTable.tsx");
  assert.doesNotMatch(table, /Dropdown|method=["']post["']|onClick=|Suspend|Invite|Remove|Edit/);
  assert.doesNotMatch(table, /@\/services\/|@\/repositories\//, "the client component receives data only");
  assert.match(src("src/repositories/users.repository.ts"), /createSupabaseServerClient/);
  assert.match(src("src/repositories/users.repository.ts"), /^import "server-only";/);
  assert.match(src("src/services/users.service.ts"), /^import "server-only";/);
});

test("source: Users is in the admin navigation only, under the admin portal (RoleGuard + middleware)", () => {
  const nav = src("src/config/navigation.ts");
  const section = (name) => nav.slice(nav.indexOf(`  ${name}: [`), nav.indexOf("],", nav.indexOf(`  ${name}: [`)));
  assert.match(section("admin"), /href: "\/admin\/users"/);
  assert.doesNotMatch(section("trainer"), /users/i);
  assert.doesNotMatch(section("student"), /users/i);
  assert.match(src("src/app/admin/layout.tsx"), /RoleGuard allowedRoles=\{\["admin"\]\}/);
  assert.equal(fs.existsSync(path.join(root, "src/app/trainer/users")), false);
  assert.equal(fs.existsSync(path.join(root, "src/app/student/users")), false);
});
