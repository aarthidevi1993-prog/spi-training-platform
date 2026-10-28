// Phase 7 P2 — application account-status enforcement (pure tests).
// The real src/lib/auth modules (transpiled by run.mjs): role resolution from a profile row,
// the Supabase lookup with a stand-in client, the middleware's portal decision, and
// source-level checks of where the decision is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lib = process.env.AUTH_LIB;
if (!lib) throw new Error("Run through tests/auth/run.mjs");
const { resolveProfileRole, fetchProfileRole, mapProfileRole, NO_ACCESS_MESSAGE } = await import(`${lib}/profile-role.mjs`);
const { decidePortalAccess, getPortalForPath } = await import(`${lib}/roles.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const ROLES = ["admin", "trainer", "student"];
const PORTAL_PATHS = { admin: "/admin/tests", trainer: "/trainer/students", student: "/student/tests/abc" };

/** Minimal stand-in for the Supabase client used by fetchProfileRole. */
function fakeClient(result, calls = []) {
  return {
    from(table) {
      calls.push(["from", table]);
      const q = {
        select(cols) { calls.push(["select", cols]); return q; },
        eq(col, v) { calls.push(["eq", col, v]); return q; },
        async maybeSingle() {
          calls.push(["maybeSingle"]);
          if (result instanceof Error) throw result;
          return result;
        },
      };
      return q;
    },
  };
}
const quiet = async (fn) => {
  const [w, e] = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { [console.warn, console.error] = [w, e]; }
};

// ---------------------------------------------------------------- A–H: role resolution

test("A–C. active accounts: super_admin → admin, trainer → trainer, student → student", () => {
  assert.equal(resolveProfileRole({ role: "super_admin", account_status: "active" }), "admin");
  assert.equal(resolveProfileRole({ role: "trainer", account_status: "active" }), "trainer");
  assert.equal(resolveProfileRole({ role: "student", account_status: "active" }), "student");
});

test("D–E. invited and suspended accounts have no usable role, whatever their role column says", () => {
  for (const status of ["invited", "suspended"]) {
    for (const role of ["super_admin", "trainer", "student"]) assert.equal(resolveProfileRole({ role, account_status: status }), null, `${status}/${role}`);
  }
});

test("F–H. missing profile, unknown role, unknown/missing status, and no row at all → no role (fails closed)", () => {
  for (const row of [null, undefined, {}, { role: "student" }, { account_status: "active" }]) assert.equal(resolveProfileRole(row), null, JSON.stringify(row));
  for (const role of ["admin", "owner", "SUPER_ADMIN", "", null, 1, ["super_admin"]]) assert.equal(resolveProfileRole({ role, account_status: "active" }), null, String(role));
  for (const status of ["Active", "ACTIVE", "enabled", "", null, true, "active "]) assert.equal(resolveProfileRole({ role: "super_admin", account_status: status }), null, String(status));
  // Extra fields (e.g. user_metadata-like data) are ignored — the role comes from the role column only.
  assert.equal(resolveProfileRole({ role: "student", account_status: "active", user_metadata: { role: "super_admin" }, app_role: "super_admin" }), "student");
  assert.equal(mapProfileRole("super_admin"), "admin", "the super_admin → admin convention is kept");
});

test("fetchProfileRole: reads role + account_status of exactly this user, and fails closed on every problem", async () => {
  const calls = [];
  assert.equal(await fetchProfileRole(fakeClient({ data: { role: "trainer", account_status: "active" }, error: null }, calls), "u-1"), "trainer");
  assert.deepEqual(calls, [["from", "profiles"], ["select", "role, account_status"], ["eq", "id", "u-1"], ["maybeSingle"]]);
  const cases = [
    [{ data: { role: "trainer", account_status: "invited" }, error: null }, "invited"],
    [{ data: { role: "super_admin", account_status: "suspended" }, error: null }, "suspended"],
    [{ data: null, error: null }, "missing profile (or hidden by RLS)"],
    [{ data: { role: "wizard", account_status: "active" }, error: null }, "unknown role"],
    [{ data: { role: "trainer" }, error: null }, "no account_status column value"],
    [{ data: null, error: { code: "42703", message: "column profiles.account_status does not exist" } }, "database without 0016"],
    [{ data: null, error: { code: "42501", message: "permission denied for table profiles" } }, "unauthenticated / anon"],
    [new Error("network down"), "client throws"],
  ];
  for (const [result, label] of cases) assert.equal(await quiet(() => fetchProfileRole(fakeClient(result), "u-1")), null, label);
});

// ---------------------------------------------------------------- I–L: portal access (the middleware decision)

test("I. an active user reaches their own portal", () => {
  for (const role of ROLES) assert.equal(decidePortalAccess(getPortalForPath(PORTAL_PATHS[role]), role), "allow", role);
  assert.equal(decidePortalAccess("admin", resolveProfileRole({ role: "super_admin", account_status: "active" })), "allow");
});

test("J. an active user cannot reach another role's portal", () => {
  for (const role of ROLES) {
    for (const portal of ROLES.filter((p) => p !== role)) assert.equal(decidePortalAccess(getPortalForPath(PORTAL_PATHS[portal]), role), "unauthorized", `${role} → ${portal}`);
  }
});

test("K–L. invited and suspended users (and anyone without a usable role) reach no portal — sent to login, never allowed", () => {
  for (const status of ["invited", "suspended"]) {
    for (const dbRole of ["super_admin", "trainer", "student"]) {
      const role = resolveProfileRole({ role: dbRole, account_status: status });
      for (const portal of ROLES) assert.equal(decidePortalAccess(portal, role), "login", `${status}/${dbRole} → ${portal}`);
    }
  }
  for (const role of [null, undefined]) for (const portal of ROLES) assert.equal(decidePortalAccess(portal, role), "login");
  // Path tricks resolve to a portal (or to none, i.e. a public page) — never to "allow" without a role.
  for (const p of ["/admin", "/admin/", "/admin/../student", "/trainer?role=admin", "/student/x#admin"]) {
    const portal = getPortalForPath(p.split(/[?#]/)[0]);
    if (portal) assert.equal(decidePortalAccess(portal, null), "login", p);
  }
  assert.equal(getPortalForPath("/administrator"), null, "prefix look-alikes are not portals");
});

// ---------------------------------------------------------------- generic denial, wiring and source checks

test("one generic denial message: it reveals neither the account status nor whether the account exists", () => {
  assert.equal(NO_ACCESS_MESSAGE, "Your account isn't set up for access yet. Contact your administrator.");
  assert.doesNotMatch(NO_ACCESS_MESSAGE, /invit|suspend|active|exist|role|admin(?!istrator)|trainer|student|profile/i);
  const repo = src("src/repositories/auth.repository.ts");
  const login = repo.slice(repo.indexOf("async function loginSupabase"), repo.indexOf("export const authRepository"));
  assert.match(login, /const role = await fetchProfileRole\(supabase, data\.user\.id\);\s+if \(!role\) \{\s+await supabase\.auth\.signOut\(\);[\s\S]*?return \{ success: false, error: NO_ACCESS_MESSAGE \};/);
  assert.match(login, /return \{ success: false, error: "Invalid email or password\." \};/, "wrong credentials keep the existing message");
  // The complete set of sign-in outcomes: none is specific to an account's status.
  assert.deepEqual(login.match(/error: [^}]+/g).map((s) => s.trim()), [
    `error: "Authentication isn't configured yet. Contact your administrator."`,
    `error: "Invalid email or password."`,
    "error: NO_ACCESS_MESSAGE",
    "error: GENERIC_AUTH_ERROR",
  ]);
});

test("every portal entry point resolves the role through fetchProfileRole (middleware, session, sign-in), never from the request", () => {
  const mw = src("src/lib/supabase/middleware.ts");
  assert.match(mw, /fetchProfileRole\(supabase, user\.id\)/);
  const middleware = src("src/middleware.ts");
  assert.match(middleware, /const decision = decidePortalAccess\(requiredPortal, role\);/);
  assert.doesNotMatch(middleware, /searchParams\.get\(|user_metadata|app_metadata/);
  const repo = src("src/repositories/auth.repository.ts");
  const session = repo.slice(repo.indexOf("async getSession()"), repo.indexOf("async requestPasswordReset"));
  assert.match(session, /const role = await fetchProfileRole\(supabase, user\.id\);\s+if \(!role\) return null;/);
  const profileRole = src("src/lib/auth/profile-role.ts");
  assert.doesNotMatch(profileRole.replace(/\/\*[\s\S]*?\*\//g, ""), /user_metadata|app_metadata/, "role never read from user metadata");
  // RoleGuard (portal layouts) still decides from the server-resolved user only.
  const guard = src("src/components/auth/RoleGuard.tsx");
  assert.match(guard, /const user = await authService\.getCurrentUser\(\);[\s\S]*if \(!user\) \{\s+redirect\("\/login"\);[\s\S]*if \(!allowedRoles\.includes\(user\.role\)\) \{\s+redirect\("\/unauthorized"\);/);
});

test("no redirect loop: the login page only redirects a user who HAS a usable role", () => {
  const page = src("src/app/login/page.tsx");
  assert.match(page, /const user = await authService\.getCurrentUser\(\);\s+if \(user\) \{\s+redirect\(getHomeRouteForRole\(user\.role\)\);/);
  // An inactive session: middleware → /login (decision "login"); login page → getCurrentUser() is null → form is shown.
  assert.equal(decidePortalAccess("student", resolveProfileRole({ role: "student", account_status: "suspended" })), "login");
  assert.equal(getPortalForPath("/login"), null, "/login is not a protected portal");
});
