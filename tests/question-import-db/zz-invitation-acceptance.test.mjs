// Phase 7 P3.5 — invitation acceptance against the real database (accept_user_invitation; since
// P5.2 / 0029a only the Auth account the invitation is bound to may accept) through the real
// repository/service modules. Invitations are bound the way a successful send binds them
// (bindInvitation: begin_invitation_delivery + record_invitation_delivery). Each invitee uses its OWN session
// client (authenticated, its own user id); Supabase Auth itself (verifyOtp / updateUser /
// signOut) is a recording stand-in, since only the database decides activation.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bindInvitation, clientFor, db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);
const lib = await import(`${build}/lib/auth/invite-acceptance.mjs`);

const PASSWORD = "Accept-Me-123!";
let U = {};
const admin = () => db.client({ role: "authenticated", userId: ids.A });
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const profile = (key) => db.admin(`select to_json(x) from (select role, account_status from public.profiles where id = '${U[key]}') x`);
const invitation = (id) => db.admin(`select to_json(x) from (select status, accepted_user_id, auth_user_id from public.user_invitations where id = '${id}') x`);
const invite = (email, extra = {}) => call(admin(), "create_user_invitation", { p: { email, role: "student", full_name: "Accepting Person", ...extra } });

/** A new auth user (its profile starts 'invited' — 0016). */
async function newAuthUser(key, email) {
  await db.exec(`insert into t.ids values ('${key}', gen_random_uuid()); insert into auth.users (id, email) values (t.id('${key}'), '${email}');`);
  U[key] = await db.admin(`select v from t.ids where k = '${key}'`);
}

/** The invitee's own session client: real database calls, recorded Auth stand-in. */
function sessionClient(key, email, calls) {
  const c = db.client({ role: "authenticated", userId: U[key] });
  return {
    rpc(fn, args) { calls.push(["rpc", fn]); return c.rpc(fn, args); },
    from(table) { return c.from(table); },
    auth: {
      async verifyOtp() { calls.push(["verifyOtp"]); return { data: {}, error: null }; },
      async getUser() { calls.push(["getUser"]); return { data: { user: { id: U[key], email } }, error: null }; },
      async updateUser() { calls.push(["updateUser"]); return { data: {}, error: null }; },
      async signOut() { calls.push(["signOut"]); return { error: null }; },
    },
  };
}
function serviceFor(key, email) {
  const calls = [];
  const repository = createInvitationAcceptanceRepository(async () => sessionClient(key, email, calls));
  return { calls, service: createInvitationAcceptanceService({ repository }) };
}
const names = (calls) => calls.map((c) => (c[0] === "rpc" ? `rpc:${c[1]}` : c[0]));
const quiet = async (fn) => {
  const saved = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { [console.warn, console.error] = saved; }
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ia_' || k, gen_random_uuid() from unnest(array['SEAT','BTR','BF','BO']) k;
    insert into auth.users (id, email) values (t.id('ia_SEAT'), 'ia.seat@ia.test'), (t.id('ia_BTR'), 'ia.batch-trainer@ia.test');
    update public.profiles set account_status = 'active' where id in (t.id('ia_SEAT'), t.id('ia_BTR'));
    update public.profiles set role = 'trainer' where id = t.id('ia_BTR');
    insert into public.students (id, student_code, full_name) values (t.id('ia_SEAT'), 'IA-SEAT', 'Seat Holder');
    -- This file's own trainer: the shared seed trainers (T1…) are asserted on by other files.
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ia_BTR'), 'IA-BTR', 'IA Batch Trainer');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('ia_BF'), 'IA-BF', t.id('C1'), t.id('ia_BTR'), 'IA full',    '2026-01-01', '2026-12-31', 'ongoing', 1),
      (t.id('ia_BO'), 'IA-BO', t.id('C1'), t.id('ia_BTR'), 'IA ongoing', '2026-01-01', '2026-12-31', 'ongoing', 10);
    insert into public.batch_students (batch_id, student_id) values (t.id('ia_BF'), t.id('ia_SEAT'));`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

// The database is shared with the files that follow (e.g. zz-users-read lists every profile):
// leave no invited account without a domain record behind. Accounts that never acted (no audit
// row references them) are removed; the others finish their real recovery path in the tests.
after(async () => {
  await db.exec(`delete from auth.users where id in (select v from t.ids where k in ('ia_OTHER', 'ia_BOUNDX', 'ia_BOUNDTO'));`);
  const left = await db.admin(`select count(*) from public.profiles p join t.ids i on i.v = p.id
    where i.k like 'ia\_%' and p.account_status = 'invited'`);
  assert.equal(left, 0, "no invited accounts left behind by this file");
});

test("the invitee's own session: password, then accept_user_invitation, then the database role's portal; enrolled; replay changes nothing", async () => {
  const inv = await invite("ia.student@ia.test", { batch_id: U.ia_BO });
  await newAuthUser("ia_STU", "ia.student@ia.test");
  await bindInvitation(inv.invitation_id, U.ia_STU);
  const { calls, service } = serviceFor("ia_STU", "ia.student@ia.test");
  assert.deepEqual(await quiet(() => service.acceptPageState()), { kind: "invited", email: "ia.student@ia.test" }, "invited → the form");
  calls.length = 0;
  assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/student" });
  assert.deepEqual(names(calls), ["getUser", "updateUser", "rpc:accept_user_invitation"], "password update strictly before the RPC; no other RPC");
  assert.deepEqual(await profile("ia_STU"), { role: "student", account_status: "active" });
  assert.deepEqual(await invitation(inv.invitation_id), { status: "accepted", accepted_user_id: U.ia_STU, auth_user_id: U.ia_STU });
  assert.equal(await db.admin(`select student_code from public.students where id = '${U.ia_STU}'`), inv.code);
  assert.equal(await db.admin(`select enrollment_status from public.batch_students where batch_id = '${U.ia_BO}' and student_id = '${U.ia_STU}'`), "enrolled");

  // Replay: the page and the action send an active account home; the RPC itself refuses.
  calls.length = 0;
  assert.deepEqual(await service.acceptPageState(), { kind: "active", home: "/student" });
  assert.deepEqual(await service.completeInvitation(PASSWORD, PASSWORD), { ok: true, home: "/student" });
  assert.ok(!names(calls).includes("updateUser") && !names(calls).some((x) => x.startsWith("rpc:")), "no password change, no RPC for an active account");
  assert.deepEqual(await call(db.client({ role: "authenticated", userId: U.ia_STU }), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  assert.equal(await db.admin(`select count(*) from public.user_admin_events where event_type = 'invitation_accepted' and target_user_id = '${U.ia_STU}'`), 1, "accepted exactly once");
});

test("trainer and Super Admin invitations route to their own portals (from the database role)", async () => {
  for (const [key, email, role, home] of [["ia_TRN", "ia.trainer@ia.test", "trainer", "/trainer"], ["ia_ADM", "ia.admin@ia.test", "super_admin", "/admin"]]) {
    const inv = await invite(email, { role });
    await newAuthUser(key, email);
    await bindInvitation(inv.invitation_id, U[key]);
    const { service } = serviceFor(key, email);
    assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home }, key);
    assert.deepEqual(await profile(key), { role, account_status: "active" });
  }
});

test("wrong user: another invited account (different email) cannot accept someone else's invitation — signed out, nothing changes", async () => {
  const inv = await invite("ia.owner@ia.test");
  await newAuthUser("ia_OTHER", "ia.other@ia.test");
  const { calls, service } = serviceFor("ia_OTHER", "ia.other@ia.test");
  assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: false, error: lib.ACCEPT_REASON_MESSAGE.not_pending, ended: true });
  assert.equal(names(calls).filter((x) => x === "signOut").length, 1, "signed out exactly once");
  assert.deepEqual(await profile("ia_OTHER"), { role: "student", account_status: "invited" });
  assert.deepEqual(await invitation(inv.invitation_id), { status: "pending", accepted_user_id: null, auth_user_id: null });
});

test("expired and revoked invitations never activate: mapped message, signed out, account stays invited", async () => {
  const ex = await invite("ia.expired@ia.test");
  await newAuthUser("ia_EXP", "ia.expired@ia.test");
  await bindInvitation(ex.invitation_id, U.ia_EXP); // bound, so the refusal is the expiry itself
  await db.run(`update public.user_invitations set expires_at = created_at + interval '1 second' where id = '${ex.invitation_id}'; select pg_sleep(1.1);`);
  let f = serviceFor("ia_EXP", "ia.expired@ia.test");
  assert.deepEqual(await quiet(() => f.service.completeInvitation(PASSWORD, PASSWORD)), { ok: false, error: lib.ACCEPT_REASON_MESSAGE.expired, ended: true });
  assert.ok(names(f.calls).includes("signOut"));
  assert.equal((await invitation(ex.invitation_id)).status, "expired");
  assert.deepEqual(await profile("ia_EXP"), { role: "student", account_status: "invited" });

  const rv = await invite("ia.revoked@ia.test");
  await call(admin(), "revoke_user_invitation", { p_invitation_id: rv.invitation_id });
  await newAuthUser("ia_REV", "ia.revoked@ia.test");
  f = serviceFor("ia_REV", "ia.revoked@ia.test");
  assert.deepEqual(await quiet(() => f.service.completeInvitation(PASSWORD, PASSWORD)), { ok: false, error: lib.ACCEPT_REASON_MESSAGE.not_pending, ended: true });
  assert.deepEqual(await profile("ia_REV"), { role: "student", account_status: "invited" });
  assert.equal((await invitation(rv.invitation_id)).status, "revoked");

  // Recovery (P5.2, realistic): the unaccepted placeholder may be invited again (0019 D1). Both people already used
  // an invitation link and set a password, so their address is confirmed and Supabase Auth REFUSES to invite it again
  // ("already registered"): the new invitation stays unbound and acceptance says resend_required. A Super Admin
  // sends a sign-in link (begin_invitation_recovery); the person signs in from it — a fresh e-mail one-time-code
  // session (JWT amr "otp") — and complete_invitation_recovery binds the invitation; then acceptance works.
  for (const [key, email] of [["ia_EXP", "ia.expired@ia.test"], ["ia_REV", "ia.revoked@ia.test"]]) {
    const again = await invite(email);
    assert.equal(again.ok, true, `${key}: re-invited`);
    assert.equal((await call(admin(), "begin_invitation_delivery", { p_invitation_id: again.invitation_id })).ok, true);
    assert.deepEqual(
      await call(db.client({ role: "service_role" }), "record_invitation_delivery", { p_invitation_id: again.invitation_id, p_sent: false, p_auth_user_id: null }),
      { ok: true, delivery_status: "failed" },
      `${key}: Auth refused (already registered) — recorded as failed, nothing bound`
    );
    assert.deepEqual(
      await quiet(() => serviceFor(key, email).service.completeInvitation(PASSWORD, PASSWORD)),
      { ok: false, error: lib.ACCEPT_REASON_MESSAGE.resend_required, ended: true },
      `${key}: unbound`
    );
    await db.exec(`update public.user_invitations set last_sent_at = now() - interval '61 seconds' where id = '${again.invitation_id}';`); // past the shared cooldown
    assert.equal((await call(admin(), "begin_invitation_recovery", { p_invitation_id: again.invitation_id })).ok, true, `${key}: recovery requested`);
    const freshSignIn = db.client({ role: "authenticated", userId: U[key], amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] });
    assert.deepEqual(await call(freshSignIn, "complete_invitation_recovery"), { ok: true, bound: true }, `${key}: bound after the sign-in link`);
    assert.deepEqual(await quiet(() => serviceFor(key, email).service.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/student" }, key);
    assert.deepEqual(await profile(key), { role: "student", account_status: "active" });
    assert.deepEqual(await invitation(again.invitation_id), { status: "accepted", accepted_user_id: U[key], auth_user_id: U[key] });
  }
  assert.equal((await invitation(ex.invitation_id)).status, "expired", "the old invitations keep their final state");
  assert.equal((await invitation(rv.invitation_id)).status, "revoked");
});

test("an invitation bound to a different Auth account cannot be accepted by the address's current account", async () => {
  const inv = await invite("ia.bound@ia.test");
  await newAuthUser("ia_BOUNDTO", "ia.someone-else@ia.test");
  await db.exec(`update public.user_invitations set auth_user_id = t.id('ia_BOUNDTO') where id = '${inv.invitation_id}';`); // test-only binding
  await newAuthUser("ia_BOUNDX", "ia.bound@ia.test");
  const { service } = serviceFor("ia_BOUNDX", "ia.bound@ia.test");
  assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: false, error: lib.ACCEPT_REASON_MESSAGE.not_pending, ended: true });
  assert.deepEqual(await profile("ia_BOUNDX"), { role: "student", account_status: "invited" });
  assert.equal((await invitation(inv.invitation_id)).status, "pending");
});

test("full batch: accepted (active, student portal) without enrolment", async () => {
  const inv = await invite("ia.full@ia.test", { batch_id: U.ia_BF });
  await newAuthUser("ia_FULL", "ia.full@ia.test");
  await bindInvitation(inv.invitation_id, U.ia_FULL);
  const { service } = serviceFor("ia_FULL", "ia.full@ia.test");
  assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/student" });
  assert.deepEqual(await profile("ia_FULL"), { role: "student", account_status: "active" });
  assert.equal(await db.admin(`select count(*) from public.batch_students where batch_id = '${U.ia_BF}' and student_id = '${U.ia_FULL}'`), 0);
});

test("anonymous callers cannot execute accept_user_invitation; an invalid password never reaches the database", async () => {
  const e = (await clientFor(null).rpc("accept_user_invitation", {})).error;
  assert.equal(e?.code, "42501");
  const inv = await invite("ia.weak@ia.test");
  await newAuthUser("ia_WEAK", "ia.weak@ia.test");
  await bindInvitation(inv.invitation_id, U.ia_WEAK);
  const { calls, service } = serviceFor("ia_WEAK", "ia.weak@ia.test");
  assert.equal((await service.completeInvitation("short", "short")).ok, false);
  assert.deepEqual(calls, [], "no Auth call, no RPC");
  assert.deepEqual(await profile("ia_WEAK"), { role: "student", account_status: "invited" });
  // Corrected password: accepted.
  assert.deepEqual(await quiet(() => service.completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/student" });
  assert.deepEqual(await profile("ia_WEAK"), { role: "student", account_status: "active" });
});
