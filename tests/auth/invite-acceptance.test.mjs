// Phase 7 P3.5 — invitation acceptance + password setup (pure, fake-dependency and source tests).
// The real modules (transpiled by run.mjs): link and password rules, the session-client
// repository against a stand-in Supabase client, the service's ordering and refusal
// handling, and source-level checks of the security boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.AUTH_BUILD;
if (!build) throw new Error("Run through tests/auth/run.mjs");
const lib = await import(`${build}/lib/auth/invite-acceptance.mjs`);
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

const TOKEN = "pkce_TOKENsecret-0123456789abcdef0123456789abcdef";
const PASSWORD = "Sup3r-Secret-Pass!";

/** Captures everything written to the console while fn runs. */
async function capture(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

// ---------------------------------------------------------------- link rules

test("link: a valid invite link is accepted; next and other extra parameters are ignored", () => {
  assert.deepEqual(lib.parseInviteLink({ token_hash: TOKEN, type: "invite" }), { ok: true, tokenHash: TOKEN });
  const withExtras = lib.parseInviteLink({ token_hash: TOKEN, type: "invite", next: "https://evil.example/", redirect_to: "//evil", utm_source: "mail" });
  assert.deepEqual(withExtras, { ok: true, tokenHash: TOKEN }, "the result carries nothing but the token");
  assert.deepEqual(lib.parseInviteInput(TOKEN, "invite"), { ok: true, tokenHash: TOKEN });
});

test("link: missing, empty or malformed token_hash is refused", () => {
  for (const token_hash of [undefined, "", "short", "a".repeat(15), "a".repeat(513), "abc def ghijklmnopq", "abc/defghijklmnopq", "abc.defghijklmnopq", "abc%2Fdefghijklmnop", "<script>alert(1)</script>xx"]) {
    assert.deepEqual(lib.parseInviteLink({ token_hash, type: "invite" }), { ok: false }, String(token_hash));
  }
  assert.deepEqual(lib.parseInviteLink({ token_hash: "a".repeat(16), type: "invite" }).ok, true, "16 is the minimum");
  assert.deepEqual(lib.parseInviteLink({ token_hash: "a".repeat(512), type: "invite" }).ok, true, "512 is the maximum");
  for (const bad of [null, undefined, 42, {}, ["x"]]) assert.deepEqual(lib.parseInviteInput(bad, "invite"), { ok: false });
});

test("link: only type=invite is accepted", () => {
  for (const type of [undefined, "", "recovery", "signup", "magiclink", "email", "email_change", "INVITE", "invite ", ["invite"]]) {
    assert.deepEqual(lib.parseInviteLink({ token_hash: TOKEN, type }), { ok: false }, String(type));
  }
  assert.deepEqual(lib.parseInviteInput(TOKEN, "recovery"), { ok: false });
  assert.deepEqual(lib.parseInviteLink(null), { ok: false });
  assert.deepEqual(lib.parseInviteLink(undefined), { ok: false });
});

test("link: a repeated token_hash or type parameter is refused", () => {
  assert.deepEqual(lib.parseInviteLink({ token_hash: [TOKEN, TOKEN], type: "invite" }), { ok: false });
  assert.deepEqual(lib.parseInviteLink({ token_hash: TOKEN, type: ["invite", "invite"] }), { ok: false });
});

test("redirects: only fixed /login error paths and the three fixed portals", () => {
  assert.equal(lib.inviteLoginErrorPath("invite_invalid"), "/login?error=invite_invalid");
  assert.equal(lib.inviteLoginErrorPath("invite_session_missing"), "/login?error=invite_session_missing");
  assert.equal(lib.inviteLoginErrorPath("invite_failed"), "/login?error=invite_failed");
  for (const bad of ["https://evil.example", "//evil", "constructor", "__proto__", undefined, 3]) assert.equal(lib.inviteLoginErrorPath(bad), "/login?error=invite_failed");
  assert.equal(lib.INVITE_ACCEPT_PATH, "/auth/accept");
  assert.deepEqual([...lib.PORTAL_HOMES], ["/admin", "/trainer", "/student"]);
  for (const ok of ["/admin", "/trainer", "/student"]) assert.equal(lib.isPortalHome(ok), true);
  for (const bad of ["/admin/users", "//admin", "https://x/admin", "/", "", null, "/Admin"]) assert.equal(lib.isPortalHome(bad), false, String(bad));
});

// ---------------------------------------------------------------- password rules

test("password: 8–72 characters and the confirmation must match; never trimmed", () => {
  assert.deepEqual(lib.validateNewPassword("", ""), { ok: false, field: "password", error: "Enter a password." });
  assert.equal(lib.validateNewPassword("1234567", "1234567").field, "password", "7 characters");
  assert.match(lib.validateNewPassword("1234567", "1234567").error, /at least 8/);
  assert.deepEqual(lib.validateNewPassword("12345678", "12345678"), { ok: true, password: "12345678" });
  assert.deepEqual(lib.validateNewPassword("x".repeat(72), "x".repeat(72)), { ok: true, password: "x".repeat(72) });
  const long = lib.validateNewPassword("x".repeat(73), "x".repeat(73));
  assert.equal(long.ok, false);
  assert.match(long.error, /at most 72/);
  assert.deepEqual(lib.validateNewPassword("abcdefgh", "abcdefgX"), { ok: false, field: "confirmPassword", error: "Passwords do not match." });
  assert.deepEqual(lib.validateNewPassword(" spaced pass ", " spaced pass "), { ok: true, password: " spaced pass " });
  for (const bad of [null, undefined, 12345678, {}]) assert.equal(lib.validateNewPassword(bad, bad).ok, false);
  assert.equal(lib.validateNewPassword("abcdefgh", undefined).field, "confirmPassword");
});

test("messages: database refusals map to fixed sentences; anything else is generic", () => {
  assert.match(lib.acceptRefusalMessage("not_pending"), /can no longer be used/);
  assert.match(lib.acceptRefusalMessage("expired"), /expired/);
  assert.match(lib.acceptRefusalMessage("code_in_use"), /conflict/);
  // P5.2 (0029a): an unexpired, unbound invitation — actionable without promising a plain resend (the administrator
  // may need to send a sign-in link instead); an expired one asks for a NEW invitation, never a resend.
  assert.match(lib.acceptRefusalMessage("resend_required"), /isn't ready to use yet[\s\S]*new invitation link[\s\S]*newest email/);
  assert.doesNotMatch(lib.acceptRefusalMessage("expired"), /resend/i);
  assert.match(lib.acceptRefusalMessage("expired"), /new invitation/);
  for (const r of ["unknown", "error", "toString", "__proto__", "constructor", undefined, 5]) assert.equal(lib.acceptRefusalMessage(r), lib.SETUP_GENERIC_ERROR, String(r));
});

// ---------------------------------------------------------------- repository (stand-in Supabase client)

function fakeClient(over = {}) {
  const calls = [];
  const client = {
    calls,
    auth: {
      async verifyOtp(args) { calls.push(["verifyOtp", args]); return over.verifyOtp ? over.verifyOtp(args) : { data: {}, error: null }; },
      async getUser() { calls.push(["getUser"]); return over.getUser ? over.getUser() : { data: { user: { id: "u1", email: "new@example.test" } }, error: null }; },
      async updateUser(args) { calls.push(["updateUser"]); return over.updateUser ? over.updateUser(args) : { data: {}, error: null }; },
      async signOut() { calls.push(["signOut"]); if (over.signOut) return over.signOut(); return { error: null }; },
    },
    async rpc(fn, args) { calls.push(["rpc", fn, args]); return over.rpc ? over.rpc(fn, args) : { data: { ok: true, role: "student", enrolled: false }, error: null }; },
    from(table) {
      calls.push(["from", table]);
      const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { return over.profile ?? { data: { role: "student", account_status: "active" }, error: null }; } };
      return q;
    },
  };
  return client;
}
const repoWith = (client) => createInvitationAcceptanceRepository(async () => client);

test("repository: verifyOtp is called with type invite and the token hash only; refusals and throws are told apart", async () => {
  const c = fakeClient();
  const s = await repoWith(c).open();
  assert.equal(await s.verifyInvite(TOKEN), "verified");
  assert.deepEqual(c.calls[0], ["verifyOtp", { type: "invite", token_hash: TOKEN }]);

  const refused = await capture(async () => (await repoWith(fakeClient({ verifyOtp: () => ({ data: {}, error: { name: "AuthApiError", status: 403, code: "otp_expired", message: `bad token ${TOKEN}` } }) })).open()).verifyInvite(TOKEN));
  assert.equal(refused.result, "invalid");
  assert.match(refused.logs, /otp_expired/);
  assert.doesNotMatch(refused.logs, new RegExp(TOKEN), "the token is never logged, even when the error echoes it");
  assert.doesNotMatch(refused.logs, /bad token/, "Auth messages are never logged");

  const thrown = await capture(async () => (await repoWith(fakeClient({ verifyOtp: () => { throw new Error(`network ${TOKEN}`); } })).open()).verifyInvite(TOKEN));
  assert.equal(thrown.result, "failed");
  assert.doesNotMatch(thrown.logs, new RegExp(TOKEN));
});

test("repository: password update maps weak_password; the RPC takes no arguments; signOut never throws", async () => {
  const weak = await capture(async () => (await repoWith(fakeClient({ updateUser: () => ({ error: { code: "weak_password", status: 422, message: PASSWORD } }) })).open()).updatePassword(PASSWORD));
  assert.deepEqual(weak.result, { ok: false, reason: "weak_password" });
  assert.doesNotMatch(weak.logs, new RegExp(PASSWORD));
  const other = await capture(async () => (await repoWith(fakeClient({ updateUser: () => ({ error: { code: "same_password", status: 422 } }) })).open()).updatePassword(PASSWORD));
  assert.deepEqual(other.result, { ok: false, reason: "failed" });
  const threw = await capture(async () => (await repoWith(fakeClient({ updateUser: () => { throw new Error(PASSWORD); } })).open()).updatePassword(PASSWORD));
  assert.deepEqual(threw.result, { ok: false, reason: "failed" });
  assert.doesNotMatch(threw.logs, new RegExp(PASSWORD));

  const c = fakeClient();
  assert.deepEqual(await (await repoWith(c).open()).acceptInvitation(), { ok: true, role: "student", enrolled: false, enrolmentSkipped: null });
  assert.deepEqual(c.calls.at(-1), ["rpc", "accept_user_invitation", undefined], "nothing about the role, person or batch is sent");
  assert.deepEqual(await (await repoWith(fakeClient({ rpc: () => ({ data: { ok: false, reason: "expired" }, error: null }) })).open()).acceptInvitation(), { ok: false, reason: "expired" });
  const rpcErr = await capture(async () => (await repoWith(fakeClient({ rpc: () => ({ data: null, error: { code: "42501", message: "permission denied" } }) })).open()).acceptInvitation());
  assert.deepEqual(rpcErr.result, { ok: false, reason: "error" });
  assert.doesNotMatch(rpcErr.logs, /permission denied/);
  assert.deepEqual((await capture(async () => (await repoWith(fakeClient({ rpc: () => ({ data: "weird", error: null }) })).open()).acceptInvitation())).result, { ok: false, reason: "unknown" });
  assert.deepEqual((await capture(async () => (await repoWith(fakeClient({ rpc: () => { throw new Error("x"); } })).open()).acceptInvitation())).result, { ok: false, reason: "error" });

  await capture(async () => (await repoWith(fakeClient({ signOut: () => { throw new Error("down"); } })).open()).signOut());
  assert.equal(await createInvitationAcceptanceRepository(async () => null).open(), null, "no client → no session");
  assert.equal((await capture(() => createInvitationAcceptanceRepository(async () => { throw new Error("cookies"); }).open())).result, null);
});

// ---------------------------------------------------------------- service (fake session)

/** A fake session recording the order of calls; `roles` is the sequence fetchRole returns. */
function fakeSession(over = {}) {
  const calls = [];
  const roles = [...(over.roles ?? [null, "student"])];
  const session = {
    async verifyInvite(t) { calls.push(["verifyInvite", t]); return over.verify ?? "verified"; },
    async getUser() { calls.push(["getUser"]); return over.user === undefined ? { id: "u1", email: "new@example.test" } : over.user; },
    async fetchRole(id) { calls.push(["fetchRole", id]); return roles.length > 1 ? roles.shift() : roles[0]; },
    async updatePassword(p) { calls.push(["updatePassword", p]); return over.update ?? { ok: true }; },
    async acceptInvitation() { calls.push(["acceptInvitation"]); if (over.acceptThrows) throw new Error("boom"); return over.accept ?? { ok: true, role: "student", enrolled: false }; },
    async signOut() { calls.push(["signOut"]); },
  };
  let opened = 0;
  const repository = { async open() { opened++; return over.noSession ? null : session; } };
  return { calls, repository, opened: () => opened, service: createInvitationAcceptanceService({ repository }) };
}
const names = (calls) => calls.map((c) => c[0]);

test("confirm: invalid input never reaches Auth; verifyOtp refusal → invite_invalid; throw or no user → invite_failed; success → ok", async () => {
  for (const [token, type] of [[TOKEN, "recovery"], ["bad", "invite"], [undefined, undefined], [[TOKEN], "invite"]]) {
    const f = fakeSession();
    assert.deepEqual(await f.service.confirmInvitation(token, type), { ok: false, code: "invite_invalid" });
    assert.equal(f.opened(), 0, "no session opened, nothing verified");
  }
  let f = fakeSession({ verify: "invalid" });
  assert.deepEqual(await f.service.confirmInvitation(TOKEN, "invite"), { ok: false, code: "invite_invalid" });
  f = fakeSession({ verify: "failed" });
  assert.deepEqual(await f.service.confirmInvitation(TOKEN, "invite"), { ok: false, code: "invite_failed" });
  f = fakeSession({ user: null });
  assert.deepEqual(await f.service.confirmInvitation(TOKEN, "invite"), { ok: false, code: "invite_failed" });
  assert.deepEqual(names(f.calls), ["verifyInvite", "getUser"]);
  f = fakeSession({ noSession: true });
  assert.deepEqual(await f.service.confirmInvitation(TOKEN, "invite"), { ok: false, code: "invite_failed" });
  f = fakeSession();
  const ok = await capture(() => f.service.confirmInvitation(TOKEN, "invite"));
  assert.deepEqual(ok.result, { ok: true });
  assert.deepEqual(f.calls, [["verifyInvite", TOKEN], ["getUser"]], "verify, then confirm the session; no acceptance here");
  assert.doesNotMatch(JSON.stringify(ok.result) + ok.logs, new RegExp(TOKEN), "the token is never returned or logged");
});

test("accept page: no session → session_missing; active → its portal; invited → the form with the session email", async () => {
  assert.deepEqual(await fakeSession({ noSession: true }).service.acceptPageState(), { kind: "session_missing" });
  assert.deepEqual(await fakeSession({ user: null }).service.acceptPageState(), { kind: "session_missing" });
  assert.deepEqual(await fakeSession({ roles: ["trainer"] }).service.acceptPageState(), { kind: "active", home: "/trainer" });
  assert.deepEqual(await fakeSession({ roles: [null] }).service.acceptPageState(), { kind: "invited", email: "new@example.test" });
});

test("complete: an invalid password makes no Auth call at all", async () => {
  for (const [p, c] of [["short", "short"], ["x".repeat(73), "x".repeat(73)], ["abcdefgh", "abcdefgX"], ["", ""]]) {
    const f = fakeSession();
    const r = await f.service.completeInvitation(p, c);
    assert.equal(r.ok, false);
    assert.equal(r.ended, false);
    assert.ok(r.field, "a field error");
    assert.equal(f.opened(), 0, "no session, no getUser, no updateUser, no RPC");
  }
});

test("complete: order is getUser → role → updateUser → accept_user_invitation → role; success goes to the database role's portal (all three roles)", async () => {
  for (const [role, home] of [["admin", "/admin"], ["trainer", "/trainer"], ["student", "/student"]]) {
    const f = fakeSession({ roles: [null, role] });
    const { result, logs } = await capture(() => f.service.completeInvitation(PASSWORD, PASSWORD));
    assert.deepEqual(result, { ok: true, home });
    assert.deepEqual(names(f.calls), ["getUser", "fetchRole", "updatePassword", "acceptInvitation", "fetchRole"]);
    assert.deepEqual(f.calls[2], ["updatePassword", PASSWORD]);
    assert.doesNotMatch(JSON.stringify(result) + logs, new RegExp(PASSWORD), "the password is never returned or logged");
  }
});

test("complete: missing session; already active (password untouched); no Supabase client", async () => {
  let f = fakeSession({ user: null });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: false, error: lib.SESSION_MISSING_ERROR, ended: true });
  assert.deepEqual(names(f.calls), ["getUser"]);

  f = fakeSession({ roles: ["student"] });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: true, home: "/student" });
  assert.deepEqual(names(f.calls), ["getUser", "fetchRole"], "no password change, no RPC");

  f = fakeSession({ noSession: true });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: false, error: lib.SETUP_GENERIC_ERROR, ended: true });
});

test("complete: a password update failure stops before the RPC, without signing out; weak_password has its own message", async () => {
  let f = fakeSession({ update: { ok: false, reason: "failed" } });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: false, error: lib.PASSWORD_UPDATE_ERROR, ended: false });
  assert.deepEqual(names(f.calls), ["getUser", "fetchRole", "updatePassword"]);
  f = fakeSession({ update: { ok: false, reason: "weak_password" } });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: false, error: lib.PASSWORD_WEAK_ERROR, field: "password", ended: false });
  assert.ok(!names(f.calls).includes("acceptInvitation") && !names(f.calls).includes("signOut"));
});

test("complete: any acceptance refusal after the password update signs out exactly once and returns a mapped message", async () => {
  const cases = [
    [{ accept: { ok: false, reason: "not_pending" } }, lib.ACCEPT_REASON_MESSAGE.not_pending],
    [{ accept: { ok: false, reason: "expired" } }, lib.ACCEPT_REASON_MESSAGE.expired],
    [{ accept: { ok: false, reason: "code_in_use" } }, lib.ACCEPT_REASON_MESSAGE.code_in_use],
    [{ accept: { ok: false, reason: "resend_required" } }, lib.ACCEPT_REASON_MESSAGE.resend_required],
    [{ accept: { ok: false, reason: "something_new" } }, lib.SETUP_GENERIC_ERROR],
    [{ accept: { ok: false, reason: "error" } }, lib.SETUP_GENERIC_ERROR],
  ];
  for (const [over, message] of cases) {
    const f = fakeSession(over);
    const { result, logs } = await capture(() => f.service.completeInvitation(PASSWORD, PASSWORD));
    assert.deepEqual(result, { ok: false, error: message, ended: true }, JSON.stringify(over));
    assert.deepEqual(names(f.calls), ["getUser", "fetchRole", "updatePassword", "acceptInvitation", "signOut"]);
    assert.equal(names(f.calls).filter((n) => n === "signOut").length, 1);
    assert.doesNotMatch(JSON.stringify(result) + logs, new RegExp(PASSWORD));
  }
  // A thrown RPC (the repository turns it into reason "error"; a throw past it reaches the action's catch).
  const thrown = fakeSession({ acceptThrows: true });
  await assert.rejects(() => thrown.service.completeInvitation(PASSWORD, PASSWORD));
});

test("complete: accepted but no usable role afterwards → signed out, generic message", async () => {
  const f = fakeSession({ roles: [null, null] });
  assert.deepEqual(await f.service.completeInvitation(PASSWORD, PASSWORD), { ok: false, error: lib.SETUP_GENERIC_ERROR, ended: true });
  assert.deepEqual(names(f.calls), ["getUser", "fetchRole", "updatePassword", "acceptInvitation", "fetchRole", "signOut"]);
});

// ---------------------------------------------------------------- source boundaries

const ACCEPTANCE_FILES = [
  "src/lib/auth/invite-acceptance.ts",
  "src/repositories/invitation-acceptance.repository.core.ts",
  "src/repositories/invitation-acceptance.repository.ts",
  "src/services/invitation-acceptance.service.core.ts",
  "src/services/invitation-acceptance.service.ts",
  "src/services/invitation-acceptance.actions.ts",
  "src/app/auth/confirm/page.tsx",
  "src/components/auth/InvitationContinueForm.tsx",
  "src/app/auth/accept/page.tsx",
  "src/components/auth/AcceptInvitationForm.tsx",
];
// P5.2: the invitation-recovery flow is held to exactly the same rules (own session, no service role, Auth and
// RPC calls only in the acceptance repository core, no table writes, no user-controlled redirect).
const RECOVERY_FILES = [
  "src/lib/auth/invitation-recovery.ts",
  "src/services/invitation-recovery.service.core.ts",
  "src/services/invitation-recovery.service.ts",
  "src/services/invitation-recovery.actions.ts",
  "src/app/auth/recover/page.tsx",
  "src/app/auth/recover/incomplete/page.tsx",
  "src/components/auth/RecoveryContinueForm.tsx",
  "src/components/auth/RecoveryIncompletePanel.tsx",
];
// P5.2: the recovery mailer is an Auth call site by design (like the repository core above): it gets the
// service-role rule, and its own pinned boundary below (exactly one Auth operation, no database access).
const RECOVERY_MAILER_FILES = ["src/repositories/recovery-mailer.repository.core.ts", "src/repositories/recovery-mailer.repository.ts"];
const FLOW_FILES = [...ACCEPTANCE_FILES, ...RECOVERY_FILES];
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("boundary: no acceptance file touches the service role, the admin client or the Auth Admin repository", () => {
  for (const rel of [...FLOW_FILES, ...RECOVERY_MAILER_FILES]) {
    assert.ok(exists(rel), rel);
    const code = strip(src(rel));
    for (const spec of importsOf(code)) assert.doesNotMatch(spec, /supabase\/admin|auth-admin/, `${rel} imports ${spec}`);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role|createSupabaseAdminClient|auth\.admin|inviteUserByEmail|record_invitation_delivery/, rel);
  }
  assert.match(src("src/repositories/invitation-acceptance.repository.ts"), /createSupabaseServerClient/, "the session (cookie) client");
});

test("boundary: verifyOtp and the RPC live only in the repository core; only the accept RPC; no table writes", () => {
  for (const rel of FLOW_FILES) {
    const code = strip(src(rel));
    if (rel !== "src/repositories/invitation-acceptance.repository.core.ts") {
      assert.doesNotMatch(code, /verifyOtp|\.rpc\(|updateUser\(|\.auth\./, rel);
    }
    assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/, `${rel}: no table writes`);
  }
  const repo = strip(src("src/repositories/invitation-acceptance.repository.core.ts"));
  // P5.2 adds the recovery pair on the same own-session client: verifyOtp(email) and complete_invitation_recovery.
  assert.deepEqual([...repo.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]).sort(), ["accept_user_invitation", "complete_invitation_recovery"]);
  assert.deepEqual([...repo.matchAll(/verifyOtp\(\s*\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, " ").trim()).sort(), ['type: "email", token_hash: tokenHash', 'type: "invite", token_hash: tokenHash']);
});

// ---- P5.2 Auth-usage guards ------------------------------------------------------------------------------
// These are source-level GUARDS against straightforward changes (a new Auth call, an alias, optional chaining, a
// split line, a raw fetch to the Auth REST API, realtime/storage access). Regex checks cannot prove the absence of
// every possible indirection (e.g. eval, a helper in another module); review still applies.

/** Code without comments and import lines, with property access normalised: `a ?. b`, `a\n  .b` → `a.b`. */
const accessCode = (rel) =>
  strip(src(rel))
    .replace(/^\s*import\b[^;]*;\s*$/gm, "")
    .replace(/\s*\?\.\s*/g, ".")
    .replace(/\s*\.\s*(?=[A-Za-z_$])/g, ".");
/** Every Auth call `x.auth.op(` (after normalisation), in order. */
const authOps = (code) => [...code.matchAll(/\.auth\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]);
/** Every reference to `auth` as an identifier/property — each one must be one of the pinned calls (no aliases). */
const authRefs = (code) => (code.match(/\bauth\b/g) ?? []).length;
/** Ways of reaching Supabase/Auth other than the injected client's pinned calls. */
const OTHER_ACCESS = /\bfetch\(|XMLHttpRequest|\baxios\b|\/auth\/v1|\.channel\(|\.removeChannel\(|\.realtime\b|\.schema\(|\.storage\b|\.functions\b|\[\s*["'`]auth["'`]\s*\]|\bcreate(Server|Browser)?Client\b|globalThis|\bprocess\.env\b/;

test("boundary (P5.2): the recovery mailer performs exactly one Auth operation — signInWithOtp, never creating a user — and no other Supabase access", () => {
  const core = accessCode("src/repositories/recovery-mailer.repository.core.ts");
  assert.deepEqual(authOps(core), ["signInWithOtp"], "only signInWithOtp — any other Auth operation fails this test");
  assert.equal(authRefs(core), 1, "the only `auth` reference is that call — no alias (const a = client.auth), destructuring ({ auth }) or re-use");
  assert.doesNotMatch(core, OTHER_ACCESS, "no raw fetch / Auth REST URL / realtime / storage / functions / bracket access / own client / env");
  assert.doesNotMatch(core, /\.rpc\(|\.from\(|\.(insert|update|upsert|delete)\(/, "no database access");
  assert.match(core, /\.auth\.signInWithOtp\(\{ email, options: \{ shouldCreateUser: false, emailRedirectTo: redirectTo \} \}\)/);
  // The redirect is only passed through (from the configured app URL — invitations.service.ts); nothing request-derived.
  assert.doesNotMatch(core, /["'`]next["'`]|\.next\b|searchParams|redirect_to|window\.location|document\.referrer|headers\(/);
  assert.equal((core.match(/\bredirectTo\b/g) ?? []).length, 2, "the parameter and its one pass-through");
  assert.match(strip(src("src/services/invitations.service.ts")), /recoveryRedirectUrl: \(\) => recoveryRedirectUrl\(process\.env\.NEXT_PUBLIC_APP_URL\)/);

  // The wiring only builds the session-less client: its single `auth` reference is the options key.
  const wiring = accessCode("src/repositories/recovery-mailer.repository.ts");
  assert.deepEqual(authOps(wiring), [], "the wiring makes no Auth calls itself");
  assert.equal(authRefs(wiring), 1, "only the `auth:` options key");
  assert.match(wiring, /createClient<Database, "public">\(url, publishableKey, \{\s*auth: \{ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false \},\s*\}\)/);
  assert.equal((wiring.match(/\bcreateClient\(|\bcreateClient</g) ?? []).length, 1, "exactly one client");
  assert.doesNotMatch(wiring, /\.rpc\(|\.from\(|\bfetch\(|\/auth\/v1|\.channel\(|\.storage\b|\.functions\b|SERVICE_ROLE|service_role/);
  for (const spec of importsOf(strip(src("src/repositories/recovery-mailer.repository.ts")))) {
    assert.doesNotMatch(spec, /supabase\/admin|supabase\/server|auth-admin|next\/headers/, `mailer wiring imports ${spec}`);
  }
});

test("boundary (P5.2): the acceptance repository core uses exactly its pinned Auth operations on the person's own session", () => {
  const core = accessCode("src/repositories/invitation-acceptance.repository.core.ts");
  assert.deepEqual(
    authOps(core).sort(),
    ["getSession", "getUser", "signOut", "signOut", "updateUser", "verifyOtp", "verifyOtp"],
    "verifyOtp (invite, email), getUser, updateUser (password), signOut (default; local-scope in endSession), getSession — nothing else"
  );
  assert.equal(authRefs(core), 7, "every `auth` reference is one of those calls — no alias or destructuring");
  assert.deepEqual([...core.matchAll(/\.auth\.signOut\(([^)]*)\)/g)].map((m) => m[1]).sort(), ["", '{ scope: "local" }']);
  assert.match(core, /\.auth\.updateUser\(\{ password \}\)/, "only the password is ever updated");
  assert.doesNotMatch(core, OTHER_ACCESS, "no raw fetch / Auth REST URL / realtime / storage / functions / bracket access / own client / env");
  assert.doesNotMatch(core, /\.from\(|\.admin\b/, "no direct table access and no Auth Admin API");
});

test("boundary: no `next` or other user-controlled redirect anywhere in the flow", () => {
  for (const rel of FLOW_FILES) {
    const code = strip(src(rel)).replace(/["']next\/(navigation|link|cache|headers)["']|["']next["']\s*;|from\s+["']next["']/g, "");
    assert.doesNotMatch(code, /["'`]next["'`]|\.next\b|searchParams\.get\(|redirectTo|redirect_to|window\.location|document\.referrer/, rel);
  }
  // P5.2 recovery: the fixed destinations only.
  const recoverPage = strip(src("src/app/auth/recover/page.tsx"));
  assert.deepEqual([...recoverPage.matchAll(/redirect\(([^)]*\)?)\)/g)].map((m) => m[1]), ['inviteLoginErrorPath("invite_invalid")']);
  assert.doesNotMatch(strip(src("src/app/auth/recover/incomplete/page.tsx")), /redirect\(|router\./, "the safe page redirects nobody");
  const recoverForm = strip(src("src/components/auth/RecoveryContinueForm.tsx"));
  assert.deepEqual([...recoverForm.matchAll(/router\.replace\(([^;]*)\);/g)].map((m) => m[1]), ["result.destination", "recoveryFailurePath(result.code)"]);
  assert.doesNotMatch(strip(src("src/components/auth/RecoveryIncompletePanel.tsx")), /router\.|redirect\(/, "the safe page's panel navigates nowhere by itself");
  // Every link in the recovery components goes to one fixed path (no computed or user-supplied href, no raw <a>).
  const hrefsOf = (code) => [...code.matchAll(/\bhref=(\{[^}]*\}|"[^"]*"|'[^']*')/g)].map((m) => m[1]);
  assert.deepEqual(hrefsOf(recoverForm), ["{RECOVERY_INCOMPLETE_PATH}"], "Continue form: only the safe page");
  const incompletePanel = strip(src("src/components/auth/RecoveryIncompletePanel.tsx"));
  assert.deepEqual(hrefsOf(incompletePanel), ['"/login"'], "safe-page panel: only the normal sign-in page");
  assert.ok(incompletePanel.indexOf('href="/login"') > incompletePanel.indexOf('state === "ended" ? ('), "…and only once the session is confirmed closed");
  for (const code of [recoverForm, incompletePanel]) assert.doesNotMatch(code, /<a\b|router\.push\(/, "links only through next/link with the pinned paths");
  assert.deepEqual(hrefsOf(strip(src("src/app/auth/recover/page.tsx"))).concat(hrefsOf(strip(src("src/app/auth/recover/incomplete/page.tsx")))), [], "the pages render no links of their own");
  assert.match(strip(src("src/lib/auth/invitation-recovery.ts")), /export const RECOVERY_INCOMPLETE_PATH = "\/auth\/recover\/incomplete";/);
  const confirm = strip(src("src/app/auth/confirm/page.tsx"));
  assert.deepEqual([...confirm.matchAll(/redirect\(([^)]*\)?)\)/g)].map((m) => m[1]), ['inviteLoginErrorPath("invite_invalid")']);
  const accept = strip(src("src/app/auth/accept/page.tsx"));
  assert.deepEqual([...accept.matchAll(/redirect\(([^;]*?)\);/g)].map((m) => m[1]), ['inviteLoginErrorPath("invite_session_missing")', "state.home"]);
  const cont = strip(src("src/components/auth/InvitationContinueForm.tsx"));
  assert.deepEqual([...cont.matchAll(/router\.replace\(([^;]*)\);/g)].map((m) => m[1]), ["result.ok ? INVITE_ACCEPT_PATH : inviteLoginErrorPath(result.code)"]);
  const form = strip(src("src/components/auth/AcceptInvitationForm.tsx"));
  assert.deepEqual([...form.matchAll(/router\.replace\(([^)]*)\)/g)].map((m) => m[1]), ["result.home"]);
  assert.ok(form.indexOf("isPortalHome(result.home)") > -1 && form.indexOf("isPortalHome(result.home)") < form.indexOf("router.replace(result.home)"), "the portal is checked before navigating");
  assert.match(form, /router\.refresh\(\)/);
});

test("/auth/confirm: GET makes no Auth or database call; no-referrer, noindex, always dynamic; the token is never rendered as text", () => {
  const page = strip(src("src/app/auth/confirm/page.tsx"));
  for (const spec of importsOf(page)) assert.doesNotMatch(spec, /repositories|services|lib\/supabase/, `confirm page imports ${spec}`);
  assert.doesNotMatch(page, /verifyOtp|getUser|\.rpc\(|createSupabase|fetch\(/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.doesNotMatch(page, /<(script|link|img|iframe)\b|https?:\/\//, "no external resources");
  assert.doesNotMatch(page, /[^=]\{\s*(link\.)?tokenHash\s*\}/, "the token is only passed as a prop");
  const cont = strip(src("src/components/auth/InvitationContinueForm.tsx"));
  assert.doesNotMatch(cont, /\{\s*tokenHash\s*\}(?!\s*:)/, "the Continue form never renders the token");
  assert.match(cont, /disabled=\{isPending \|\| done\}/, "Continue is disabled while submitting");
  const accept = strip(src("src/app/auth/accept/page.tsx"));
  assert.match(accept, /export const dynamic = "force-dynamic"/);
});

test("client boundary: client components import only the actions, the shared rules and UI", () => {
  for (const rel of ["src/components/auth/InvitationContinueForm.tsx", "src/components/auth/AcceptInvitationForm.tsx"]) {
    const code = src(rel);
    assert.match(code, /^"use client";/, rel);
    for (const spec of importsOf(code)) {
      assert.ok(
        ["react", "next/navigation", "next/link", "lucide-react", "@/services/invitation-acceptance.actions", "@/lib/auth/invite-acceptance"].includes(spec) || spec.startsWith("@/components/ui/"),
        `${rel} imports ${spec}`
      );
    }
  }
  const actions = src("src/services/invitation-acceptance.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.deepEqual([...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["confirmInvitationAction", "completeInvitationAction"]);
  assert.doesNotMatch(strip(actions), /console\.\w+\([^)]*(password|tokenHash|err\.message|String\(err)/i, "actions log only the error name");
  for (const rel of ["src/repositories/invitation-acceptance.repository.ts", "src/services/invitation-acceptance.service.ts"]) assert.match(src(rel), /^import "server-only";/, rel);
});

test("existing files: only the allowed additions (DB type, three login messages)", () => {
  assert.match(src("src/lib/supabase/types.ts"), /accept_user_invitation: \{\s*Args: Record<string, never>;\s*Returns: Json;\s*\}/);
  const login = src("src/components/auth/LoginForm.tsx");
  for (const k of ["invite_invalid", "invite_session_missing", "invite_failed"]) assert.match(login, new RegExp(`\\b${k}: "`), k);
});

test("0030: accepted but not enrolled because the course is archived → active account, portal home, and a notice to contact the Super Admin", async () => {
  // Repository: the database's reason is carried through (and only as a known code).
  const skipped = fakeClient({ rpc: () => ({ data: { ok: true, role: "student", enrolled: false, enrolment_skipped: "course_archived" }, error: null }) });
  assert.deepEqual(await (await repoWith(skipped).open()).acceptInvitation(), { ok: true, role: "student", enrolled: false, enrolmentSkipped: "course_archived" });

  // Service: the activation flow is unchanged (same calls, same order, same home); the notice is added.
  const f = fakeSession({ accept: { ok: true, role: "student", enrolled: false, enrolmentSkipped: "course_archived" } });
  const { result, logs } = await capture(() => f.service.completeInvitation(PASSWORD, PASSWORD));
  assert.deepEqual(result, { ok: true, home: "/student", notice: lib.ENROLMENT_SKIPPED_ARCHIVED_NOTICE });
  assert.match(result.notice, /account is active/);
  assert.match(result.notice, /course has been deactivated/);
  assert.match(result.notice, /contact your Super Admin to be assigned to an available batch/);
  assert.deepEqual(names(f.calls), ["getUser", "fetchRole", "updatePassword", "acceptInvitation", "fetchRole"], "no sign-out: the account is active");
  assert.doesNotMatch(JSON.stringify(result) + logs, new RegExp(PASSWORD));

  // Other outcomes keep the plain result: enrolled, a full batch (no reason), or an unknown code (never passed through).
  for (const accept of [
    { ok: true, role: "student", enrolled: true, enrolmentSkipped: null },
    { ok: true, role: "student", enrolled: false, enrolmentSkipped: null },
    { ok: true, role: "student", enrolled: false, enrolmentSkipped: "something_new" },
  ]) {
    const g = fakeSession({ accept });
    assert.deepEqual((await capture(() => g.service.completeInvitation(PASSWORD, PASSWORD))).result, { ok: true, home: "/student" }, JSON.stringify(accept));
  }
  assert.equal(lib.enrolmentSkippedNotice("course_archived"), lib.ENROLMENT_SKIPPED_ARCHIVED_NOTICE);
  assert.equal(lib.enrolmentSkippedNotice("batch_full"), undefined);
});

test("0030: the accept form shows the notice and waits for the person before going to the portal", () => {
  const form = src("src/components/auth/AcceptInvitationForm.tsx");
  assert.match(form, /if \(result\.notice\) \{[\s\S]*?setNotice\(\{ text: result\.notice, proceed \}\);\s*return;\s*\}/);
  assert.match(form, /onClick=\{notice\.proceed\}/, "Continue uses the same single, validated navigation");
  assert.match(form, /role="status"/);
  assert.match(form, /Continue to my portal/);
  assert.ok(form.indexOf("isPortalHome(result.home)") < form.indexOf("setNotice({"), "the destination is validated before anything else");
});
