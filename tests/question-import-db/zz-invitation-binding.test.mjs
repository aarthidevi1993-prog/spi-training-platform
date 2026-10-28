// P5.2 — 0029a (carried by 0030): an invitation is accepted only by the Auth account it is bound to — bound when
// the invitation e-mail was actually sent to that account (begin_invitation_delivery + record_invitation_delivery)
// or, for an already-registered placeholder, by complete_invitation_recovery (zz-invitation-recovery.test.mjs).
// Before 0029a any signed-in account whose Auth e-mail matched an UNBOUND pending invitation could claim it and
// its role (super_admin included). Each caller uses its own session (authenticated, its own user id).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bindInvitation, db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);
const lib = await import(`${build}/lib/auth/invite-acceptance.mjs`);

let U = {};
const sa = () => db.client({ role: "authenticated", userId: ids.A });
const as = (id) => db.client({ role: "authenticated", userId: id });
const service = () => db.client({ role: "service_role" });
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.code} ${error.message}`), { code: error.code });
  return data;
}
const invite = async (email, extra = {}) => (await call(sa(), "create_user_invitation", { p: { email, role: "student", full_name: "Binding Person", ...extra } })).invitation_id;
const inv = (id) => db.admin(`select to_json(x) from (select status, auth_user_id, accepted_user_id from public.user_invitations where id = '${id}') x`);
const profile = (uid) => db.admin(`select to_json(x) from (select role, account_status from public.profiles where id = '${uid}') x`);
const accepted = (uid) => db.admin(`select count(*) from public.user_admin_events where event_type = 'invitation_accepted' and target_user_id = '${uid}'`);
const records = (uid) => db.admin(`select (select count(*) from public.students where id = '${uid}') + (select count(*) from public.trainers where id = '${uid}')`);

/** A new Auth account (its profile starts 'invited' — 0016). Same-address duplicates model a pre-registered or re-linked account. */
async function authUser(key, email) {
  await db.exec(`insert into t.ids values ('${key}', gen_random_uuid()); insert into auth.users (id, email) values (t.id('${key}'), '${email}');`);
  U[key] = await db.admin(`select v from t.ids where k = '${key}'`);
  return U[key];
}

/** Nothing changed for this caller: still invited, no domain record, no acceptance event. */
async function unchanged(uid, label) {
  assert.deepEqual(await profile(uid), { role: "student", account_status: "invited" }, `${label}: still invited`);
  assert.equal(await records(uid), 0, `${label}: no student/trainer record`);
  assert.equal(await accepted(uid), 0, `${label}: no acceptance event`);
}

before(async () => {
  U = {};
});

// Leave no never-acting invited account behind for the files that follow (they list every profile).
after(async () => {
  await db.exec(`delete from auth.users u using t.ids i, public.profiles p
    where i.k like 'ib\\_%' and u.id = i.v and p.id = u.id and p.account_status = 'invited'
      and not exists (select 1 from public.user_admin_events e where e.target_user_id = u.id or e.actor_id = u.id);`);
  const left = await db.admin(`select count(*) from public.profiles p join t.ids i on i.v = p.id where i.k like 'ib\\_%' and p.account_status = 'invited'`);
  assert.equal(left, 0, "no invited accounts left behind by this file");
});

test("unbound pending invitation: the matching-address account gets resend_required — student, trainer and super_admin — and nothing changes", async () => {
  for (const [role, key] of [["student", "ib_US"], ["trainer", "ib_UT"], ["super_admin", "ib_UA"]]) {
    const email = `${key.toLowerCase()}@ib.test`;
    const id = await invite(email, { role });
    const uid = await authUser(key, email);
    assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "resend_required" }, role);
    assert.deepEqual(await inv(id), { status: "pending", auth_user_id: null, accepted_user_id: null }, `${role}: invitation untouched`);
    await unchanged(uid, role);
    assert.equal((await as(uid).sql("public.current_app_role()")).data, null, `${role}: no access`);
    // Repeating it never changes anything either.
    assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "resend_required" });
  }
});

test("bound invitation: only the bound account accepts — another account with the same address, or any other account, gets not_pending", async () => {
  const email = "ib.bound@ib.test";
  const id = await invite(email, { role: "super_admin" });
  const owner = await authUser("ib_OWN", email);
  await bindInvitation(id, owner);
  // A second Auth account with the same address (pre-registered / re-linked) and an unrelated invited account.
  const twin = await authUser("ib_TWIN", email);
  const other = await authUser("ib_OTH", "ib.other@ib.test");
  for (const [uid, label] of [[twin, "same address, different account"], [other, "different address"]]) {
    assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "not_pending" }, label);
    await unchanged(uid, label);
  }
  assert.deepEqual(await inv(id), { status: "pending", auth_user_id: owner, accepted_user_id: null }, "still pending for its owner");

  // The bound owner accepts the super_admin invitation; the role comes from the stored invitation.
  assert.deepEqual(await call(as(owner), "accept_user_invitation"), { ok: true, role: "super_admin", enrolled: false });
  assert.deepEqual(await profile(owner), { role: "super_admin", account_status: "active" });
  assert.deepEqual(await inv(id), { status: "accepted", auth_user_id: owner, accepted_user_id: owner });
  assert.equal(await accepted(owner), 1);
  // Afterwards the twin still gets nothing.
  assert.deepEqual(await call(as(twin), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  await unchanged(twin, "twin after acceptance");
});

test("pre-registered account can never claim an invitation by address: refused at creation, or (our earlier placeholder) left unbound when the send is refused", async () => {
  // (a) An Auth account that exists WITHOUT any earlier invitation of ours (e.g. a sign-up): create_user_invitation
  //     refuses the address outright (0019 rule — only our own never-activated placeholders may be invited again).
  const squatterEmail = "ib.prereg@ib.test";
  const squatter = await authUser("ib_PRE", squatterEmail);
  const refused = await call(sa(), "create_user_invitation", { p: { email: squatterEmail, role: "super_admin", full_name: "Pre Registered" } });
  assert.deepEqual([refused.ok, refused.reason], [false, "account_exists"], "no invitation is created for an unknown pre-existing account");
  assert.equal(await db.admin(`select count(*) from public.user_invitations where email_normalized = '${squatterEmail}'`), 0);
  assert.deepEqual(await call(as(squatter), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  await unchanged(squatter, "pre-registered (no invitation)");

  // (b) Our own earlier placeholder (an earlier invitation, since revoked) may be invited again, but Auth refuses to
  //     send to the already-registered address: recorded as failed, nothing bound, and the account cannot claim it.
  const email = "ib.prereg-placeholder@ib.test";
  const first = await invite(email);
  const placeholder = await authUser("ib_PREP", email);
  await call(sa(), "revoke_user_invitation", { p_invitation_id: first });
  const id = await invite(email);
  assert.ok(id, "the placeholder's address may be invited again");
  assert.equal((await call(sa(), "begin_invitation_delivery", { p_invitation_id: id })).ok, true);
  assert.deepEqual(await call(service(), "record_invitation_delivery", { p_invitation_id: id, p_sent: false, p_auth_user_id: null }), { ok: true, delivery_status: "failed" });
  assert.deepEqual(await call(as(placeholder), "accept_user_invitation"), { ok: false, reason: "resend_required" });
  assert.deepEqual(await inv(id), { status: "pending", auth_user_id: null, accepted_user_id: null });
  await unchanged(placeholder, "pre-registered placeholder");
});

test("successful resend binds the account, then it accepts; replay is refused and nothing is duplicated", async () => {
  const email = "ib.resend@ib.test";
  const id = await invite(email, { role: "trainer", organization: "IB Org", designation: "Lead" });
  const uid = await authUser("ib_RS", email);
  // First attempt: delivery outcome unknown — nothing recorded, so the invitation is unbound. The person has not
  // used any link yet (unconfirmed), so a resend can bind (assumption: Supabase re-invites an unconfirmed account;
  // an already-confirmed one is refused — that case is recovery, zz-invitation-recovery.test.mjs).
  assert.equal((await call(sa(), "begin_invitation_delivery", { p_invitation_id: id })).ok, true);
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "resend_required" });
  // Resend after the cooldown: Auth sends to this account and the outcome binds it.
  await db.exec(`update public.user_invitations set last_sent_at = now() - interval '61 seconds' where id = '${id}';`);
  assert.equal((await call(sa(), "begin_invitation_delivery", { p_invitation_id: id })).attempt, "resend");
  assert.deepEqual(await call(service(), "record_invitation_delivery", { p_invitation_id: id, p_sent: true, p_auth_user_id: uid }), { ok: true, delivery_status: "sent" });
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: true, role: "trainer", enrolled: false });
  // 0022 copying is unchanged.
  assert.deepEqual(await db.admin(`select to_json(x) from (select organization, designation from public.trainer_details where trainer_id = '${uid}') x`), { organization: "IB Org", designation: "Lead" });
  // Replay.
  assert.deepEqual(await call(as(uid), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  assert.equal(await accepted(uid), 1, "accepted exactly once");
  assert.equal(await db.admin(`select count(*) from public.trainers where id = '${uid}'`), 1);
});

test("expiry and revocation: bound + expired → expired (marked); unbound + expired → expired (untouched — never told to ask for a resend); bound + revoked → not_pending", async () => {
  const exB = await invite("ib.exp-bound@ib.test");
  const uB = await authUser("ib_EXB", "ib.exp-bound@ib.test");
  await bindInvitation(exB, uB);
  const exU = await invite("ib.exp-unbound@ib.test");
  const uU = await authUser("ib_EXU", "ib.exp-unbound@ib.test");
  await db.run(`update public.user_invitations set expires_at = created_at + interval '1 second' where id in ('${exB}', '${exU}'); select pg_sleep(1.1);`);
  assert.deepEqual(await call(as(uB), "accept_user_invitation"), { ok: false, reason: "expired" });
  assert.equal((await inv(exB)).status, "expired");
  // 0029a: an expired invitation is reported as expired (a resend would be refused as expired too), and an
  // unbound caller never changes it.
  assert.deepEqual(await call(as(uU), "accept_user_invitation"), { ok: false, reason: "expired" });
  assert.equal((await inv(exU)).status, "pending", "an unbound caller never changes the invitation");
  await unchanged(uB, "expired bound");
  await unchanged(uU, "expired unbound");
  // Recovery for the bound account (it is now an audit actor, so it finishes its real path): a new invitation,
  // sent and bound, is accepted normally.
  const again = await invite("ib.exp-bound@ib.test");
  await bindInvitation(again, uB);
  assert.deepEqual(await call(as(uB), "accept_user_invitation"), { ok: true, role: "student", enrolled: false });

  const rv = await invite("ib.revoked@ib.test", { role: "super_admin" });
  const uR = await authUser("ib_RV", "ib.revoked@ib.test");
  await bindInvitation(rv, uR);
  await call(sa(), "revoke_user_invitation", { p_invitation_id: rv });
  assert.deepEqual(await call(as(uR), "accept_user_invitation"), { ok: false, reason: "not_pending" });
  assert.equal((await inv(rv)).status, "revoked");
  await unchanged(uR, "revoked");
});

test("race: concurrent acceptances by the bound account activate exactly once", async () => {
  const email = "ib.race@ib.test";
  const id = await invite(email);
  const uid = await authUser("ib_RACE", email);
  await bindInvitation(id, uid);
  const results = await Promise.all([1, 2, 3].map(() => call(as(uid), "accept_user_invitation")));
  assert.equal(results.filter((r) => r.ok === true).length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter((r) => r.ok !== true), [{ ok: false, reason: "not_pending" }, { ok: false, reason: "not_pending" }]);
  assert.equal(await accepted(uid), 1);
  assert.equal(await db.admin(`select count(*) from public.students where id = '${uid}'`), 1);
  assert.equal((await inv(id)).status, "accepted");
});

test("the application maps resend_required to the actionable message and signs the invitee out once", async () => {
  const email = "ib.app@ib.test";
  await invite(email);
  const uid = await authUser("ib_APP", email);
  const calls = [];
  const c = as(uid);
  const session = {
    rpc(fn, args) { calls.push(`rpc:${fn}`); return c.rpc(fn, args); },
    from: (t) => c.from(t),
    auth: {
      async verifyOtp() { return { data: {}, error: null }; },
      async getUser() { calls.push("getUser"); return { data: { user: { id: uid, email } }, error: null }; },
      async updateUser() { calls.push("updateUser"); return { data: {}, error: null }; },
      async signOut() { calls.push("signOut"); return { error: null }; },
    },
  };
  const svc = createInvitationAcceptanceService({ repository: createInvitationAcceptanceRepository(async () => session) });
  const saved = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  let result;
  try { result = await svc.completeInvitation("Accept-Me-123!", "Accept-Me-123!"); } finally { [console.warn, console.error] = saved; }
  assert.deepEqual(result, { ok: false, error: lib.ACCEPT_REASON_MESSAGE.resend_required, ended: true });
  assert.match(lib.ACCEPT_REASON_MESSAGE.resend_required, /new invitation link/);
  assert.equal(calls.filter((x) => x === "signOut").length, 1);
  await unchanged(uid, "app path");
});

test("accept_user_invitation attributes (0029a rule, kept by 0030): SECURITY DEFINER, search_path '', authenticated only", async () => {
  const f = await db.admin(`select json_build_object('definer', p.prosecdef, 'config', p.proconfig,
      'anon', has_function_privilege('anon', p.oid, 'execute'), 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
      'resend', position('''resend_required''' in p.prosrc) > 0, 'unbound', position('auth_user_id is null or auth_user_id = v_uid' in p.prosrc) > 0,
      'marker', position('0029a: never accepted by e-mail match alone' in p.prosrc) > 0,
      'org', position('0022: the invitation''s organization and designation are copied too' in p.prosrc) > 0,
      'archived', position('course_mgmt_enrolment_closed' in p.prosrc) > 0)
    from pg_proc p where p.oid = 'public.accept_user_invitation()'::regprocedure`);
  assert.deepEqual(f, { definer: true, config: ['search_path=""'], anon: false, authenticated: true, resend: true, unbound: false, marker: true, org: true, archived: true });
});
