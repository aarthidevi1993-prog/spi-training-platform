// P5.2 — invitation recovery (0029a) for an already-registered, never-activated invited account whose invitation
// Supabase Auth refuses to (re)send ("already registered"): the invitation stays unbound and acceptance says
// resend_required. A Super Admin requests recovery (begin_invitation_recovery — a request, not a binding); the
// application e-mails a passwordless sign-in link through a session-less mailer; the person opens it, and
// complete_invitation_recovery binds the invitation on that FRESH e-mail sign-in (JWT amr "otp"/"magiclink"
// < 15 min — simulated here; the exact Supabase amr values must be confirmed on staging). Real database functions,
// real repository/service modules; Supabase Auth and the mailer are recording stand-ins. No account is ever deleted
// by the code under test.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { USERS, bindInvitation, db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationsService, InvitationsAuthorizationError } = await import(`${build}/services/invitations.service.core.mjs`);
const { createInvitationsRepository } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);
const { createInvitationRecoveryService } = await import(`${build}/services/invitation-recovery.service.core.mjs`);
const recoveryLib = await import(`${build}/lib/auth/invitation-recovery.mjs`);
const acceptLib = await import(`${build}/lib/auth/invite-acceptance.mjs`);
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);
const lifecycle = await import(`${build}/lib/user-management/lifecycle.mjs`);

const SA = ids.A;
const asSA = () => db.client({ role: "authenticated", userId: SA });
const as = (id) => db.client({ role: "authenticated", userId: id });
const service = () => db.client({ role: "service_role" });
const now = () => Math.floor(Date.now() / 1000);
/** The person's session after signing in from the e-mail link `minutesAgo` minutes ago (amr as Supabase issues it). */
const signedIn = (id, { method = "otp", minutesAgo = 0 } = {}) => db.client({ role: "authenticated", userId: id, amr: [{ method, timestamp: now() - minutesAgo * 60 }] });
const PASSWORD = "Recover-Me-123!";

async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const errCode = async (client, fn, args = {}) => (await client.rpc(fn, args)).error?.code ?? null;
const inv = (id) =>
  db.admin(`select to_json(x) from (select status, auth_user_id, recovery_user_id, recovery_requested_by, resend_count,
    recovery_requested_at is not null as requested from public.user_invitations where id = '${id}') x`);
const profile = (uid) => db.admin(`select to_json(x) from (select role, account_status from public.profiles where id = '${uid}') x`);
const events = (type, where) => db.admin(`select coalesce(json_agg(json_build_object('actor', actor_id, 'target', target_user_id, 'detail', detail) order by id), '[]') from public.user_admin_events where event_type = '${type}' and ${where}`);
const age = (id, seconds = 61) => db.exec(`update public.user_invitations set last_sent_at = now() - interval '${seconds} seconds' where id = '${id}';`);

let n = 0;
const created = [];
/** A new Auth account with this address (profile 'invited' — 0016). */
async function authUser(email) {
  const key = `ir_${++n}`;
  await db.exec(`insert into t.ids values ('${key}', gen_random_uuid()); insert into auth.users (id, email) values (t.id('${key}'), '${email}');`);
  const id = await db.admin(`select v from t.ids where k = '${key}'`);
  created.push(id);
  return id;
}
const invite = async (email, extra = {}) => (await call(asSA(), "create_user_invitation", { p: { email, role: "student", full_name: "Recovering Person", ...extra } })).invitation_id;

/**
 * A never-activated placeholder that already confirmed its address (it opened an earlier invitation link): an
 * earlier invitation (revoked), the Auth account, then a new pending invitation whose send Auth REFUSED
 * ("already registered") — recorded as failed, nothing bound.
 */
async function strandedPlaceholder(email, role = "student") {
  const first = await invite(email, { role });
  const uid = await authUser(email);
  await call(asSA(), "revoke_user_invitation", { p_invitation_id: first });
  const id = await invite(email, { role });
  assert.equal((await call(asSA(), "begin_invitation_delivery", { p_invitation_id: id })).ok, true);
  assert.deepEqual(await call(service(), "record_invitation_delivery", { p_invitation_id: id, p_sent: false, p_auth_user_id: null }), { ok: true, delivery_status: "failed" });
  await age(id);
  return { uid, id, email };
}

// Never-acting accounts are removed (accounts referenced by audit rows finish their real path inside the tests).
after(async () => {
  if (!created.length) return;
  await db.exec(`delete from auth.users u using public.profiles p
    where u.id = any (array[${created.map((c) => `'${c}'::uuid`).join(", ")}]) and p.id = u.id and p.account_status = 'invited'
      and not exists (select 1 from public.user_admin_events e where e.target_user_id = u.id or e.actor_id = u.id)
      and not exists (select 1 from public.user_invitations i where i.recovery_user_id = u.id or i.accepted_user_id = u.id);`);
});

// ---------------------------------------------------------------- the realistic path through the real service

test("already registered: Auth refuses the send, acceptance says resend_required; recoverInvitation e-mails a sign-in link to the database address only and binds nothing", async () => {
  const email = "ir.realistic@ir.test";
  const first = await invite(email);
  const uid = await authUser(email);
  await call(asSA(), "revoke_user_invitation", { p_invitation_id: first });

  const mails = [];
  const authCalls = [];
  const deps = {
    invitations: createInvitationsRepository(async () => asSA()),
    authAdmin: {
      openDelivery: () => ({
        // Supabase Auth refuses to invite an address that already belongs to a confirmed account.
        async inviteUserByEmail(address) {
          authCalls.push(address);
          return { kind: "refused", failure: "already_registered", diagnostic: "AuthApiError status=422 code=email_exists" };
        },
        async recordDelivery(invitationId, sent, authUserId) {
          const { data, error } = await service().rpc("record_invitation_delivery", { p_invitation_id: invitationId, p_sent: sent, p_auth_user_id: authUserId });
          return error ? { ok: false, reason: "db_error" } : data.ok ? { ok: true } : { ok: false, reason: data.reason };
        },
      }),
    },
    getCurrentUser: async () => USERS.A,
    redirectUrl: () => "http://localhost:3000/auth/confirm",
    recoveryRedirectUrl: () => "http://localhost:3000/auth/recover",
    recoveryEnabled: () => true, // the server-side switch (off by default) — on for this test only
    recoveryMailer: {
      isConfigured: () => true,
      async sendSignInLink(address, redirectTo) {
        mails.push({ address, redirectTo });
        return { kind: "sent" };
      },
    },
  };
  const svc = createInvitationsService(deps);
  const quietly = async (fn) => {
    const saved = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = saved; }
  };

  const sent = await quietly(() => svc.inviteUser({ role: "student", email, fullName: "Recovering Person" }));
  assert.equal(sent.kind, "delivery_failed", JSON.stringify(sent));
  assert.deepEqual([sent.reason, sent.recorded, authCalls], ["already_registered", true, [email]]);
  const id = sent.invitationId;
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "resend_required" }, "unbound: never accepted by address");

  // The server-side switch is OFF by default: nothing is recorded or sent.
  assert.deepEqual(await createInvitationsService({ ...deps, recoveryEnabled: undefined }).recoverInvitation(id), { kind: "unavailable", invitationId: id, reason: "disabled" });
  assert.deepEqual(await createInvitationsService({ ...deps, recoveryEnabled: () => false }).recoverInvitation(id), { kind: "unavailable", invitationId: id, reason: "disabled" });
  assert.equal((await inv(id)).requested, false, "switch off → no request recorded");

  // The cooldown is shared with invitation sends.
  const early = await svc.recoverInvitation(id);
  assert.equal(early.kind, "refused");
  assert.equal(early.reason, "cooldown");
  assert.ok(early.retryAfterSeconds >= 1);
  assert.deepEqual(mails, [], "nothing sent while cooling down");

  await age(id);
  assert.deepEqual(await svc.recoverInvitation(id), { kind: "sent", invitationId: id });
  assert.deepEqual(mails, [{ address: email, redirectTo: "http://localhost:3000/auth/recover" }], "the database-owned address, the configured landing page");
  const row = await inv(id);
  assert.deepEqual([row.status, row.auth_user_id, row.recovery_user_id, row.recovery_requested_by, row.requested], ["pending", null, uid, SA, true], "a request, not a binding");
  assert.deepEqual(await events("invitation_recovery_requested", `invitation_id = '${id}'`), [{ actor: SA, target: uid, detail: { resend_count: 1 } }]);
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "resend_required" }, "still not accepted before the person signs in");

  // Only a Super Admin; demo / not configured → nothing is attempted.
  await assert.rejects(() => createInvitationsService({ ...deps, getCurrentUser: async () => USERS.T1 }).recoverInvitation(id), InvitationsAuthorizationError);
  assert.deepEqual(await createInvitationsService({ ...deps, recoveryMailer: undefined }).recoverInvitation(id), { kind: "unavailable", invitationId: id, reason: "not_configured" });
  assert.deepEqual(await createInvitationsService({ ...deps, isDemoMode: () => true }).recoverInvitation(id), { kind: "unavailable", invitationId: id, reason: "not_configured" });
  assert.equal(mails.length, 1);

  // The person opens the link: fresh e-mail sign-in → bound → normal acceptance.
  assert.deepEqual(await call(signedIn(uid), "complete_invitation_recovery"), { ok: true, bound: true });
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: true, role: "student", enrolled: false });
  assert.deepEqual(await profile(uid), { role: "student", account_status: "active" });
});

// ---------------------------------------------------------------- authorization

test("authorization: trainers, invited accounts, suspended Super Admins and anonymous callers are refused (42501)", async () => {
  const p = await strandedPlaceholder("ir.auth@ir.test");
  await db.exec(`insert into t.ids values ('ir_SAS', gen_random_uuid()); insert into auth.users (id, email) values (t.id('ir_SAS'), 'ir.sas@ir.test');
    update public.profiles set role = 'super_admin', account_status = 'suspended' where id = t.id('ir_SAS');`);
  const suspendedSA = await db.admin("select v from t.ids where k = 'ir_SAS'");
  for (const [label, client] of [["trainer", as(ids.T1)], ["invited", as(p.uid)], ["suspended super admin", as(suspendedSA)], ["anon", db.client({ role: "anon" })]]) {
    assert.equal(await errCode(client, "begin_invitation_recovery", { p_invitation_id: p.id }), "42501", `${label}: begin`);
    assert.equal(await errCode(client, "invitation_recovery_candidate", { p_user_id: p.uid }), "42501", `${label}: candidate`);
  }
  assert.equal(await errCode(db.client({ role: "anon" }), "complete_invitation_recovery"), "42501", "anon: complete");
  assert.equal((await inv(p.id)).requested, false, "nothing was recorded");
  assert.equal(await errCode(asSA(), "user_mgmt_recoverable_placeholder", { p_user_id: p.uid, p_email: p.email }), "42501", "the helper is not client-callable");
  await db.exec(`delete from auth.users where id = '${suspendedSA}';`); // this test's own fixture (never acted)
});

// ---------------------------------------------------------------- eligibility

test("eligibility: only a never-activated placeholder that is the address's only Auth account; already bound → already_bound", async () => {
  // Two Auth accounts with the address → not recoverable.
  const twin = await strandedPlaceholder("ir.twin@ir.test");
  await authUser("ir.twin@ir.test");
  assert.deepEqual(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: twin.id }), { ok: false, reason: "not_recoverable" });

  // Already bound to the account → use the normal resend instead.
  const email = "ir.bound@ir.test";
  const id = await invite(email);
  const uid = await authUser(email);
  await bindInvitation(id, uid);
  assert.deepEqual(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: id }), { ok: false, reason: "already_bound" });

  // The helper itself (as the database owner): active accounts, accepted addresses and an address bound to a
  // different account are never eligible.
  const helper = (u, e) => db.admin(`select public.user_mgmt_recoverable_placeholder('${u}', '${e}')`);
  assert.equal(await helper(twin.uid, twin.email), true, "an invited placeholder with no history is eligible");
  assert.equal(await helper(ids.ST1, "st1@test"), false, "an active account with a student record");
  const other = await authUser("ir.other@ir.test");
  await db.exec(`update public.user_invitations set auth_user_id = '${other}' where id = '${twin.id}';`); // test-only: bound elsewhere
  assert.equal(await helper(twin.uid, twin.email), false, "an invitation for the address is bound to a different account");
  await db.exec(`update public.user_invitations set auth_user_id = null where id = '${twin.id}';`);
  assert.equal(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: "00000000-0000-4000-8000-000000000000" }).then((r) => r.reason), "not_found");
});

// ---------------------------------------------------------------- mailbox proof, window, audit, replay

test("mailbox proof: only the requested account, only within 24 h, only on a fresh e-mail sign-in; audited once; replay changes nothing", async () => {
  const p = await strandedPlaceholder("ir.proof@ir.test", "trainer");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: p.id })).ok, true);

  // A second account with the same address, created after the request, is not the requested one.
  const twin = await authUser(p.email);
  assert.deepEqual(await call(signedIn(twin), "complete_invitation_recovery"), { ok: false, reason: "not_requested" });

  for (const [label, client] of [
    ["no amr", as(p.uid)],
    ["password sign-in", signedIn(p.uid, { method: "password" })],
    ["e-mail sign-in 20 minutes ago", signedIn(p.uid, { minutesAgo: 20 })],
    ["a timestamp in the future", signedIn(p.uid, { minutesAgo: -5 })],
  ]) {
    assert.deepEqual(await call(client, "complete_invitation_recovery"), { ok: false, reason: "stale_sign_in" }, label);
  }
  await db.exec(`update public.user_invitations set recovery_requested_at = now() - interval '25 hours' where id = '${p.id}';`);
  assert.deepEqual(await call(signedIn(p.uid), "complete_invitation_recovery"), { ok: false, reason: "recovery_window_passed" });
  await db.exec(`update public.user_invitations set recovery_requested_at = now() where id = '${p.id}';`);
  assert.equal((await inv(p.id)).auth_user_id, null, "no refusal bound anything");
  assert.deepEqual(await events("invitation_recovered", `invitation_id = '${p.id}'`), [], "no refusal is audited as recovered");

  // "magiclink" is accepted too (Supabase's method name for link sign-ins may differ — see the runbook).
  assert.deepEqual(await call(signedIn(p.uid, { method: "magiclink" }), "complete_invitation_recovery"), { ok: true, bound: true });
  assert.deepEqual(await call(signedIn(p.uid), "complete_invitation_recovery"), { ok: true, bound: true }, "replay: already bound to this account");
  assert.deepEqual(await events("invitation_recovered", `invitation_id = '${p.id}'`), [{ actor: p.uid, target: p.uid, detail: { requested_by: SA } }]);
  assert.equal((await inv(p.id)).auth_user_id, p.uid);
  assert.deepEqual(await call(signedIn(twin), "complete_invitation_recovery"), { ok: false, reason: "not_pending" }, "bound to another account");
  assert.deepEqual(await call(as(twin), "accept_user_invitation"), { ok: false, reason: "not_pending" });

  assert.deepEqual(await call(as(p.uid), "accept_user_invitation"), { ok: true, role: "trainer", enrolled: false });
  assert.deepEqual(await call(signedIn(p.uid), "complete_invitation_recovery"), { ok: false, reason: "not_pending" }, "after acceptance");
});

// ---------------------------------------------------------------- expiry, revocation, rate limits

test("expiry and revocation: an expired request is refused (and marked expired); a revoked one is not_pending; begin on an expired invitation → expired", async () => {
  const ex = await strandedPlaceholder("ir.expired@ir.test");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: ex.id })).ok, true);
  await db.run(`update public.user_invitations set expires_at = created_at + interval '1 second' where id = '${ex.id}'; select pg_sleep(1.1);`);
  assert.deepEqual(await call(signedIn(ex.uid), "complete_invitation_recovery"), { ok: false, reason: "expired" });
  assert.equal((await inv(ex.id)).status, "expired");
  assert.equal((await inv(ex.id)).auth_user_id, null);

  const ex2 = await strandedPlaceholder("ir.expired2@ir.test");
  await db.run(`update public.user_invitations set expires_at = created_at + interval '1 second' where id = '${ex2.id}'; select pg_sleep(1.1);`);
  assert.deepEqual(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: ex2.id }), { ok: false, reason: "expired" });
  assert.equal((await inv(ex2.id)).status, "expired");

  const rv = await strandedPlaceholder("ir.revoked@ir.test");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: rv.id })).ok, true);
  await call(asSA(), "revoke_user_invitation", { p_invitation_id: rv.id });
  assert.deepEqual(await call(signedIn(rv.uid), "complete_invitation_recovery"), { ok: false, reason: "not_pending" });
  assert.deepEqual(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: rv.id }), { ok: false, reason: "not_pending", status: "revoked" });
});

test("rate limits: the 60 s cooldown and the cap of 5 are shared with invitation sends", async () => {
  const p = await strandedPlaceholder("ir.rate@ir.test");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: p.id })).ok, true);
  const again = await call(asSA(), "begin_invitation_recovery", { p_invitation_id: p.id });
  assert.equal(again.reason, "cooldown");
  assert.ok(again.retry_after_seconds >= 1 && again.retry_after_seconds <= 60);
  assert.equal((await call(asSA(), "begin_invitation_delivery", { p_invitation_id: p.id })).reason, "cooldown", "a plain resend waits too");
  await db.exec(`update public.user_invitations set resend_count = 5, last_sent_at = now() - interval '61 seconds' where id = '${p.id}';`);
  assert.deepEqual(await call(asSA(), "begin_invitation_recovery", { p_invitation_id: p.id }), { ok: false, reason: "resend_limit" });
});

// ---------------------------------------------------------------- concurrency

test("concurrency: parallel requests → one recorded; parallel completions bind once; completion racing a revoke ends consistently", async () => {
  const a = await strandedPlaceholder("ir.race-begin@ir.test");
  const begins = await Promise.all([1, 2].map(() => call(asSA(), "begin_invitation_recovery", { p_invitation_id: a.id })));
  assert.equal(begins.filter((r) => r.ok === true).length, 1, JSON.stringify(begins));
  assert.equal(begins.filter((r) => r.reason === "cooldown").length, 1);
  assert.equal((await events("invitation_recovery_requested", `invitation_id = '${a.id}'`)).length, 1);

  const completes = await Promise.all([1, 2, 3].map(() => call(signedIn(a.uid), "complete_invitation_recovery")));
  assert.deepEqual(completes, [{ ok: true, bound: true }, { ok: true, bound: true }, { ok: true, bound: true }]);
  assert.equal((await events("invitation_recovered", `invitation_id = '${a.id}'`)).length, 1, "bound and audited exactly once");
  assert.deepEqual(await call(as(a.uid), "accept_user_invitation"), { ok: true, role: "student", enrolled: false });

  const b = await strandedPlaceholder("ir.race-revoke@ir.test");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: b.id })).ok, true);
  await Promise.all([call(signedIn(b.uid), "complete_invitation_recovery"), call(asSA(), "revoke_user_invitation", { p_invitation_id: b.id })]);
  assert.equal((await inv(b.id)).status, "revoked", "the revocation always wins in the end");
  assert.deepEqual(await call(as(b.uid), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  assert.ok((await events("invitation_recovered", `invitation_id = '${b.id}'`)).length <= 1);
  assert.deepEqual(await profile(b.uid), { role: "student", account_status: "invited" });
});

// ---------------------------------------------------------------- Users panel read

test("Users panel: invitation_recovery_candidate shows the recoverable invitation (no address) for eligible accounts only", async () => {
  const p = await strandedPlaceholder("ir.panel@ir.test");
  const c = await call(asSA(), "invitation_recovery_candidate", { p_user_id: p.uid });
  assert.equal(c.ok, true);
  assert.equal(c.invitation_id, p.id);
  assert.equal("email" in c, false, "never the address");
  assert.deepEqual(await call(asSA(), "invitation_recovery_candidate", { p_user_id: ids.ST1 }), { ok: false }, "an active account");

  const repo = createUsersRepository(async () => asSA());
  const record = await repo.getRecoveryCandidate(p.uid);
  assert.equal(record.invitation_id, p.id);
  assert.equal(await repo.getRecoveryCandidate(ids.ST1), null);
  assert.deepEqual(lifecycle.mapRecoveryCandidate(record), {
    invitationId: p.id, expiresAt: record.expires_at, lastSentAt: record.last_sent_at, resendCount: record.resend_count, recoveryRequestedAt: null,
    available: false, // the server-side recovery switch is off by default
  });
  // A trainer's session gets no candidate (the function refuses; the repository answers null — no button).
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await createUsersRepository(async () => as(ids.T1)).getRecoveryCandidate(p.uid), null);
  } finally {
    console.error = quiet;
  }
});

// ---------------------------------------------------------------- /auth/recover (real service, stand-in Auth)

test("/auth/recover: the link is checked before Auth; verifyOtp(email) then complete_invitation_recovery; refusals sign out once; success → /auth/accept → acceptance; an active account → /login", async () => {
  const p = await strandedPlaceholder("ir.page@ir.test");
  assert.equal((await call(asSA(), "begin_invitation_recovery", { p_invitation_id: p.id })).ok, true);

  function recoveryFor(client) {
    const calls = [];
    let signedOut = false;
    const session = {
      rpc(fn, args) { calls.push(`rpc:${fn}`); return client.rpc(fn, args); },
      from: (t) => client.from(t),
      auth: {
        async verifyOtp({ type }) { calls.push(`verifyOtp:${type}`); return { data: {}, error: null }; },
        async getUser() { calls.push("getUser"); return { data: { user: { id: p.uid, email: p.email } }, error: null }; },
        async updateUser() { calls.push("updateUser"); return { data: {}, error: null }; },
        // endSession(): local-scope sign-out, then a confirming read (signed out → no session).
        async signOut(opts) { calls.push(opts?.scope === "local" ? "signOut" : "signOut(global)"); signedOut = true; return { error: null }; },
        async getSession() { return { data: { session: signedOut ? null : { access_token: "stand-in" } }, error: null }; },
      },
    };
    const repository = createInvitationAcceptanceRepository(async () => session);
    return { calls, recovery: createInvitationRecoveryService({ repository }), acceptance: createInvitationAcceptanceService({ repository }) };
  }
  const quietly = async (fn) => {
    const saved = [console.warn, console.error];
    console.warn = () => {};
    console.error = () => {};
    try { return await fn(); } finally { [console.warn, console.error] = saved; }
  };
  const TOKEN = "a".repeat(40);

  let f = recoveryFor(signedIn(p.uid));
  assert.deepEqual(await f.recovery.confirmRecovery(TOKEN, "invite"), { ok: false, code: "invite_invalid" });
  assert.deepEqual(await f.recovery.confirmRecovery("bad token!", "email"), { ok: false, code: "invite_invalid" });
  assert.deepEqual(f.calls, [], "an unusable link never reaches Auth or the database");

  f = recoveryFor(signedIn(p.uid, { minutesAgo: 30 }));
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: false, error: recoveryLib.RECOVERY_REASON_MESSAGE.stale_sign_in });
  assert.equal(f.calls.filter((c) => c === "signOut").length, 1, "signed out exactly once");
  assert.ok(f.calls.indexOf("verifyOtp:email") < f.calls.indexOf("rpc:complete_invitation_recovery"), "verifyOtp first");

  f = recoveryFor(signedIn(p.uid));
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: true, destination: acceptLib.INVITE_ACCEPT_PATH });
  assert.ok(!f.calls.includes("signOut"));
  assert.deepEqual(await quietly(() => f.acceptance.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/student" });
  assert.deepEqual(await profile(p.uid), { role: "student", account_status: "active" });
  // Not a passwordless login: the same link for the now ACTIVE account ends the session and goes to /login.
  f = recoveryFor(signedIn(p.uid));
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: false, code: "recovery_not_eligible" });
  assert.ok(!f.calls.includes("rpc:complete_invitation_recovery"), "nothing recovered");
  assert.equal(f.calls.filter((c) => c === "signOut").length, 1, "signed out exactly once");
});

test("/auth/recover for an account the flow is not for (suspended, or invited without a request): signed out and sent to /login", async () => {
  const quietly = async (fn) => {
    const saved = [console.warn, console.error];
    console.warn = () => {};
    console.error = () => {};
    try { return await fn(); } finally { [console.warn, console.error] = saved; }
  };
  function recoveryFor(uid, email, { signOutLeavesSession = false } = {}) {
    const calls = [];
    const client = signedIn(uid);
    let signedOut = false;
    const session = {
      rpc(fn, args) { calls.push(`rpc:${fn}`); return client.rpc(fn, args); },
      from: (t) => client.from(t),
      auth: {
        async verifyOtp() { calls.push("verifyOtp"); return { data: {}, error: null }; },
        async getUser() { return { data: { user: { id: uid, email } }, error: null }; },
        async signOut(opts) {
          calls.push(opts?.scope === "local" ? "signOut" : "signOut(global)");
          if (signOutLeavesSession) return { error: { name: "AuthRetryableFetchError", status: 0 } };
          signedOut = true;
          return { error: null };
        },
        async getSession() { return { data: { session: signedOut ? null : { access_token: "stand-in" } }, error: null }; },
      },
    };
    return { calls, recovery: createInvitationRecoveryService({ repository: createInvitationAcceptanceRepository(async () => session) }) };
  }
  const TOKEN = "c".repeat(40);

  // An invited placeholder with an unbound invitation but NO Super Admin request → not_requested → /login.
  const p = await strandedPlaceholder("ir.unrequested@ir.test");
  let f = recoveryFor(p.uid, p.email);
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: false, code: "recovery_not_eligible" });
  assert.equal(f.calls.filter((c) => c === "signOut").length, 1);
  assert.equal((await inv(p.id)).auth_user_id, null, "nothing bound");

  // A suspended account (no role, not invited) → not_pending → /login; never a portal.
  await db.exec(`insert into t.ids values ('ir_SUS', gen_random_uuid()); insert into auth.users (id, email) values (t.id('ir_SUS'), 'ir.suspended@ir.test');
    update public.profiles set account_status = 'suspended' where id = t.id('ir_SUS');`);
  const sus = await db.admin("select v from t.ids where k = 'ir_SUS'");
  f = recoveryFor(sus, "ir.suspended@ir.test");
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: false, code: "recovery_not_eligible" });
  assert.equal(f.calls.filter((c) => c === "signOut").length, 1);

  // Sign-out that cannot be confirmed (the network call failed and the session is still readable): the safe page,
  // never /login (which would send a signed-in account to its portal).
  f = recoveryFor(sus, "ir.suspended@ir.test", { signOutLeavesSession: true });
  assert.deepEqual(await quietly(() => f.recovery.confirmRecovery(TOKEN, "email")), { ok: false, code: "signout_unconfirmed" });
  assert.ok(!f.calls.includes("signOut(global)"), "only the local scope is used");
  await db.exec(`delete from auth.users where id = '${sus}';`); // this test's own fixture (never acted)
});
