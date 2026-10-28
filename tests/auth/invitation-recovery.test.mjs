// P5.2 — invitation recovery: the /auth/recover link rules, the Continue service with fake sessions (no database),
// and source-level guarantees (the page consumes nothing; the action and service never use the service role; the
// flow is never a passwordless login — any account it is not for is signed out and sent to /login).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.AUTH_BUILD;
if (!build) throw new Error("Run through tests/auth/run.mjs");
const lib = await import(`${build}/lib/auth/invitation-recovery.mjs`);
const accept = await import(`${build}/lib/auth/invite-acceptance.mjs`);
const { createInvitationRecoveryService } = await import(`${build}/services/invitation-recovery.service.core.mjs`);
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const TOKEN = "b".repeat(40);

test("link: exactly one token_hash and type=email; anything else is refused", () => {
  assert.deepEqual(lib.parseRecoveryLink({ token_hash: TOKEN, type: "email" }), { ok: true, tokenHash: TOKEN });
  for (const params of [
    { token_hash: TOKEN, type: "invite" },
    { token_hash: TOKEN, type: "magiclink" },
    { token_hash: TOKEN },
    { token_hash: "short", type: "email" },
    { token_hash: "has space and !", type: "email" },
    { token_hash: [TOKEN, TOKEN], type: "email" },
    { token_hash: TOKEN, type: ["email", "email"] },
    null,
  ]) {
    assert.deepEqual(lib.parseRecoveryLink(params), { ok: false }, JSON.stringify(params));
  }
  assert.equal(lib.RECOVERY_OTP_TYPE, "email");
});

test("messages: every database refusal maps to a fixed sentence; unknown codes are generic; nothing promises a plain resend", () => {
  for (const reason of ["not_pending", "not_requested", "expired", "recovery_window_passed", "stale_sign_in", "not_recoverable"]) {
    assert.ok(lib.recoveryRefusalMessage(reason).length > 20, reason);
  }
  for (const r of ["error", "unknown", "toString", "__proto__", undefined, 7]) assert.equal(lib.recoveryRefusalMessage(r), lib.RECOVERY_GENERIC_ERROR, String(r));
  assert.match(lib.RECOVERY_REASON_MESSAGE.expired, /new invitation/);
  assert.match(lib.RECOVERY_REASON_MESSAGE.stale_sign_in, /newest sign-in link/);
  assert.doesNotMatch(Object.values(lib.RECOVERY_REASON_MESSAGE).join(" "), /token|supabase|amr|sqlstate|42501|service role/i);
});

/** A fake session recording the order of Auth calls and RPCs; `ended` is what endSession() confirms. */
function fakeSession({ verify = "verified", user = { id: "u1", email: "p@x.test" }, role = null, complete = { ok: true }, ended = "ended" } = {}) {
  const calls = [];
  const session = {
    async verifyEmailLink() { calls.push("verifyEmailLink"); return verify; },
    async getUser() { calls.push("getUser"); return user; },
    async fetchRole() { calls.push("fetchRole"); return role; },
    async completeRecovery() { calls.push("completeRecovery"); return complete; },
    async endSession() { calls.push("endSession"); return ended; },
    async signOut() { calls.push("signOut(unchecked)"); },
  };
  return { calls, service: createInvitationRecoveryService({ repository: { open: async () => session } }) };
}

test("service: verify first, then the database; only an eligible invitee continues, and only to /auth/accept", async () => {
  let f = fakeSession();
  assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: true, destination: accept.INVITE_ACCEPT_PATH });
  assert.deepEqual(f.calls, ["verifyEmailLink", "getUser", "fetchRole", "completeRecovery"]);
  assert.ok(!f.calls.includes("endSession"), "the eligible invitee keeps the session to set a password");
});

test("not a passwordless login (P5.2 HIGH): an ACTIVE account's session is ended (confirmed) and it goes to /login — never to a portal", async () => {
  for (const role of ["admin", "trainer", "student"]) {
    const f = fakeSession({ role });
    assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "recovery_not_eligible" }, role);
    assert.deepEqual(f.calls, ["verifyEmailLink", "getUser", "fetchRole", "endSession"], `${role}: ended once, nothing recovered`);
  }
  assert.equal(lib.recoveryFailurePath("recovery_not_eligible"), "/login?error=recovery_not_eligible");
});

test("refusals: 'not for this account' → session ended + /login; an eligible invitee who must act → session ended + message here", async () => {
  assert.deepEqual([...lib.RECOVERY_NOT_ELIGIBLE_REASONS].sort(), ["not_pending", "not_recoverable", "not_requested"]);
  for (const reason of ["not_pending", "not_requested", "not_recoverable"]) {
    const f = fakeSession({ complete: { ok: false, reason } });
    assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "recovery_not_eligible" }, reason);
    assert.equal(f.calls.filter((c) => c === "endSession").length, 1, reason);
  }
  for (const reason of ["stale_sign_in", "expired", "recovery_window_passed", "error", "unknown"]) {
    const f = fakeSession({ complete: { ok: false, reason } });
    assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, error: lib.recoveryRefusalMessage(reason) }, reason);
    assert.equal(f.calls.filter((c) => c === "endSession").length, 1, reason);
  }
});

test("UNCONFIRMED sign-out (P5.2 second review HIGH): every refusal path goes to the safe page, never /login or a portal", async () => {
  const cases = [
    { role: "admin" },
    { role: "trainer" },
    { role: "student" },
    { user: null },
    { verify: "failed" },
    ...["not_pending", "not_requested", "not_recoverable", "stale_sign_in", "expired", "recovery_window_passed", "error"].map((reason) => ({ complete: { ok: false, reason } })),
  ];
  for (const c of cases) {
    const f = fakeSession({ ...c, ended: "unconfirmed" });
    assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "signout_unconfirmed" }, JSON.stringify(c));
    assert.ok(f.calls.includes("endSession"), JSON.stringify(c));
    assert.ok(!f.calls.includes("signOut(unchecked)"), "the unchecked sign-out is never used by this flow");
  }
  assert.equal(lib.recoveryFailurePath("signout_unconfirmed"), lib.RECOVERY_INCOMPLETE_PATH);
  assert.equal(lib.RECOVERY_INCOMPLETE_PATH, "/auth/recover/incomplete");
  for (const code of ["invite_invalid", "invite_failed"]) assert.equal(lib.recoveryFailurePath(code), `/login?error=${code}`);
  for (const bad of ["https://evil.example", "//evil", "__proto__", undefined]) assert.equal(lib.recoveryFailurePath(bad), "/login?error=invite_failed");
});

test("link and session failures: a refused link creates no session; a verification that THREW is cleaned up like any refusal", async () => {
  let f = fakeSession({ verify: "invalid" });
  assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "invite_invalid" });
  assert.deepEqual(f.calls, ["verifyEmailLink"], "a refused link stops before the database");
  f = fakeSession({ verify: "failed" });
  assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "invite_failed" });
  assert.deepEqual(f.calls, ["verifyEmailLink", "endSession"], "verification threw → the session is ended (and confirmed) first");
  f = fakeSession({ user: null });
  assert.deepEqual(await f.service.confirmRecovery(TOKEN, "email"), { ok: false, code: "invite_failed" });
  assert.deepEqual(f.calls, ["verifyEmailLink", "getUser", "endSession"], "a verified link without a readable user is ended");

  f = fakeSession();
  assert.deepEqual(await f.service.confirmRecovery(TOKEN, "invite"), { ok: false, code: "invite_invalid" });
  assert.deepEqual(f.calls, [], "the link is re-checked before any Auth call");
  assert.deepEqual(await createInvitationRecoveryService({ repository: { open: async () => null } }).confirmRecovery(TOKEN, "email"), { ok: false, code: "invite_failed" });
});

test("safe page button: endRecoverySession ends (confirmed) or reports unconfirmed; no client → unconfirmed", async () => {
  assert.equal(await fakeSession({ ended: "ended" }).service.endRecoverySession(), "ended");
  assert.equal(await fakeSession({ ended: "unconfirmed" }).service.endRecoverySession(), "unconfirmed");
  assert.equal(await createInvitationRecoveryService({ repository: { open: async () => null } }).endRecoverySession(), "unconfirmed");
});

test("repository endSession: local-scope sign-out, then a confirming read; any doubt → unconfirmed; the error is checked, never trusted", async () => {
  /** A stand-in Supabase client: what signOut returns/throws and whether a session is still readable afterwards. */
  function client({ signOutError = null, signOutThrows = false, remaining = null, readError = null } = {}) {
    const calls = [];
    return {
      calls,
      auth: {
        async signOut(opts) {
          calls.push(["signOut", opts]);
          if (signOutThrows) throw new Error("network down");
          return { error: signOutError };
        },
        async getSession() {
          calls.push(["getSession"]);
          return { data: { session: remaining }, error: readError };
        },
      },
    };
  }
  const end = async (c) => {
    const saved = console.error;
    console.error = () => {};
    try {
      return await (await createInvitationAcceptanceRepository(async () => c).open()).endSession();
    } finally {
      console.error = saved;
    }
  };
  let c = client();
  assert.equal(await end(c), "ended");
  assert.deepEqual(c.calls, [["signOut", { scope: "local" }], ["getSession"]], "local scope only — never the person's other devices");
  // auth-js removes the local session even when the server call fails: confirmed by the read, the error is only logged.
  assert.equal(await end(client({ signOutError: { name: "AuthRetryableFetchError", status: 0 } })), "ended");
  assert.equal(await end(client({ signOutError: { name: "AuthApiError", status: 500 }, remaining: { access_token: "x" } })), "unconfirmed");
  assert.equal(await end(client({ remaining: { access_token: "x" } })), "unconfirmed", "a session still readable → unconfirmed");
  assert.equal(await end(client({ readError: { name: "AuthSessionMissingError" } })), "unconfirmed", "the read failed → unconfirmed");
  assert.equal(await end(client({ signOutThrows: true })), "unconfirmed", "threw → unconfirmed");
});

test("source: the page consumes nothing; Continue posts to a server action; no service role, no admin session, fixed destinations", () => {
  const page = strip(src("src/app/auth/recover/page.tsx"));
  assert.doesNotMatch(page, /verifyOtp|confirmRecovery|createSupabase|rpc\(|cookies\(/, "opening the page calls nothing");
  assert.match(page, /parseRecoveryLink\(searchParams\)/);
  assert.match(page, /redirect\(inviteLoginErrorPath\("invite_invalid"\)\)/);
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);

  // The service can only ever succeed towards /auth/accept: no portal route is derived from a role here.
  const service = strip(src("src/services/invitation-recovery.service.core.ts"));
  assert.doesNotMatch(service, /getHomeRouteForRole|PORTAL_HOMES|isPortalHome|"\/admin"|"\/trainer"|"\/student"/);
  assert.equal((service.match(/ok: true/g) ?? []).length, 1, "a single success path");
  assert.match(service, /return \{ ok: true, destination: INVITE_ACCEPT_PATH \};/);
  // The /login message for the new code exists and names the normal sign-in.
  assert.match(src("src/components/auth/LoginForm.tsx"), /recovery_not_eligible:\s*"That link can only be used to finish setting up an invited account, so you've been signed out\. Sign in here with your email and password\./);

  const form = strip(src("src/components/auth/RecoveryContinueForm.tsx"));
  assert.match(form, /onClick=\{handleContinue\}/, "only a deliberate click continues");
  assert.match(form, /confirmRecoveryAction\(tokenHash, RECOVERY_OTP_TYPE\)/);
  assert.match(form, /router\.replace\(result\.destination\)/);
  assert.doesNotMatch(form, /useEffect/, "nothing runs on load");

  const action = strip(src("src/services/invitation-recovery.actions.ts"));
  assert.match(action, /^"use server";/m);
  for (const rel of ["src/services/invitation-recovery.actions.ts", "src/services/invitation-recovery.service.ts", "src/services/invitation-recovery.service.core.ts", "src/lib/auth/invitation-recovery.ts"]) {
    assert.doesNotMatch(strip(src(rel)), /supabase\/admin|createSupabaseAdminClient|SERVICE_ROLE/, rel);
  }
  assert.match(src("src/repositories/invitation-acceptance.repository.core.ts"), /verifyOtp\(\{ type: "email", token_hash: tokenHash \}\)/);
  assert.match(src("src/repositories/invitation-acceptance.repository.core.ts"), /client\.rpc\("complete_invitation_recovery"\)/);

  // The sign-in e-mail is sent by a session-less public client — never the service role or the admin's cookies.
  const mailer = strip(src("src/repositories/recovery-mailer.repository.ts"));
  assert.match(mailer, /persistSession: false, autoRefreshToken: false, detectSessionInUrl: false/);
  assert.match(mailer, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \?\? process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(mailer, /supabase\/admin|SERVICE_ROLE|cookies|supabase\/server/);
  assert.match(strip(src("src/repositories/recovery-mailer.repository.core.ts")), /signInWithOtp\(\{ email, options: \{ shouldCreateUser: false, emailRedirectTo: redirectTo \} \}\)/);
});

test("source: the safe page redirects nobody; the action's unexpected-error path uses it; the form routes through recoveryFailurePath", () => {
  const page = strip(src("src/app/auth/recover/incomplete/page.tsx"));
  assert.doesNotMatch(page, /redirect\(|getCurrentUser|authService|createSupabase|cookies\(/, "reads no session and redirects nobody");
  const panel = strip(src("src/components/auth/RecoveryIncompletePanel.tsx"));
  assert.match(panel, /endRecoverySessionAction\(\)/);
  assert.doesNotMatch(panel, /router\.|useRouter|window\.location|useEffect/, "nothing navigates automatically");
  assert.match(panel, /state === "ended" \? \(/, "the sign-in link is offered only after the session is confirmed closed");
  assert.equal((panel.match(/href="\/login"/g) ?? []).length, 1);

  const action = strip(src("src/services/invitation-recovery.actions.ts"));
  assert.match(action, /catch \(err\) \{[\s\S]*?return \{ ok: false, code: "signout_unconfirmed" \};/, "an unexpected error never goes to /login");
  assert.match(action, /export async function endRecoverySessionAction\(\): Promise<EndSessionResult>/);
  const form = strip(src("src/components/auth/RecoveryContinueForm.tsx"));
  assert.match(form, /router\.replace\(recoveryFailurePath\(result\.code\)\)/);
  assert.doesNotMatch(form, /inviteLoginErrorPath/, "no direct /login routing from the form");
  // A rejected/failed request: caught, a safe message and a link to the safe page — no navigation, no sign-out claim.
  assert.match(form, /try \{\s*result = await confirmRecoveryAction\(tokenHash, RECOVERY_OTP_TYPE\);\s*\} catch \{\s*setDone\(true\);\s*setRequestFailed\(true\);\s*return;\s*\}/);
  assert.match(form, /\{RECOVERY_REQUEST_FAILED_MESSAGE\}/);
  assert.match(form, /<Link href=\{RECOVERY_INCOMPLETE_PATH\}/);
  assert.match(lib.RECOVERY_REQUEST_FAILED_MESSAGE, /can't tell whether you're signed in/);
  assert.doesNotMatch(lib.RECOVERY_REQUEST_FAILED_MESSAGE, /signed out|session (was|has been) closed/i, "never claims the sign-out succeeded");
  const failedBranch = form.slice(form.indexOf("if (requestFailed)"), form.indexOf("if (error)"));
  assert.doesNotMatch(failedBranch, /router\.|\/login|\/admin|\/trainer|\/student/, "the failure view navigates nowhere by itself");

  // Runbook: the in-memory nature of the check and the application-level switch are documented.
  const runbook = src("docs/runbooks/live-migration-0029a.md");
  assert.match(runbook, /in-memory\*\* session state/);
  assert.match(runbook, /does \*\*not\*\* prove that the browser cookie was\s+deleted/);
  assert.match(runbook, /The switch is application-level only\./);
  // Staging needs the switch ON for its checks; production stays OFF until they all pass.
  assert.match(runbook, /turn it \*\*on in STAGING only\*\* — `INVITATION_RECOVERY_EMAILS_ENABLED=true` for the staging application/);
  assert.match(runbook, /\*\*PRODUCTION keep it absent or not `true`\*\* \(disabled\) until every step below has passed on staging/);
  assert.match(runbook, /so that steps 2–4 below can send and complete recovery links/, "the steps that send links are 2–4");
  assert.doesNotMatch(runbook, /steps 2–5 below/);
  // Staging preparation: separate project/deployment, migrations 0001–0029 + 0029a, same app version, test accounts, e-mail.
  const prep = runbook.slice(runbook.indexOf("### 5a. Staging preparation"), runbook.indexOf("on a STAGING project first."));
  assert.ok(prep.length > 0, "the staging preparation section exists before the staging steps");
  for (const re of [/Separate from production/, /never at the production database/, /migrations 0001–0029, then 0029a/, /Same application version/, /No real personal data/, /E-mail delivery that works/, /No staging environment is assumed to exist/]) {
    assert.match(prep, re, String(re));
  }
  // Each Magic Link step names its environment; production needs its own verified template before its switch.
  assert.match(runbook, /1\. \*\*STAGING project\*\* Dashboard → \*\*Authentication → Emails → Templates → Magic Link\*\*/);
  assert.match(runbook, /\*\*Production template \(before the production switch\)\.\*\* Production needs its \*\*own\*\* verified Magic Link template/);
  // Numbering: the staging list runs 1–5 without the limitation paragraph splitting it.
  const staging = runbook.slice(runbook.indexOf("on a STAGING project first."), runbook.indexOf("**Known limitation (session clean-up).**"));
  assert.deepEqual([...staging.matchAll(/^(\d)\. /gm)].map((m) => m[1]), ["1", "2", "3", "4", "5"]);
  assert.doesNotMatch(runbook.slice(runbook.indexOf("**Known limitation (session clean-up).**"), runbook.indexOf("## 6.")), /^\d\. /m, "no numbered step after the limitation paragraph");
  assert.match(runbook, /Sign-in links are turned off on this server until their email setup has been\s+confirmed\. Nothing was requested or sent\./);

  const repo = strip(src("src/repositories/invitation-acceptance.repository.core.ts"));
  assert.match(repo, /client\.auth\.signOut\(\{ scope: "local" \}\)/);
  assert.match(repo, /client\.auth\.getSession\(\)/);
  const service = strip(src("src/services/invitation-recovery.service.core.ts"));
  assert.doesNotMatch(service, /session\.signOut\(/, "the flow never uses the unchecked sign-out");
});
