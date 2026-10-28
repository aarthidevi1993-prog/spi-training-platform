// Integration (Phase 7 P3.9): the existing invitation lifecycle from the Users panel — the real users and
// invitations repository/service cores against the local database, each caller on their own session.
// Resend of an EXISTING pending invitation (begin_invitation_delivery: cooldown, cap, expiry), revoke
// (revoke_user_invitation: state change only, audited, nothing deleted), the invited account's panel data
// (invitation summary + invitation events in the account history), and refusals for trainers, students and
// invitations that are no longer pending. Only Supabase Auth Admin is simulated (as in
// zz-invitation-service): a fake inviteUserByEmail that inserts the auth.users row it would create.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationsRepository } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createAuthAdminRepository } = await import(`${build}/repositories/auth-admin.repository.core.mjs`);
const { createInvitationsService, InvitationsAuthorizationError } = await import(`${build}/services/invitations.service.core.mjs`);
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService } = await import(`${build}/services/users.service.core.mjs`);

const REDIRECT = "http://localhost:3000/auth/confirm";
let W;
let n = 0;
const uniq = (p) => `${p}${Date.now().toString(36)}${++n}`;
const inv = (id) =>
  db.admin(`select json_build_object('status', status, 'resend_count', resend_count, 'revoked_by', revoked_by, 'revoke_reason', revoke_reason,
              'auth_user_id', auth_user_id) from public.user_invitations where id = '${id}'`);
const age = (id, s) => db.exec(`update public.user_invitations set last_sent_at = now() - interval '${s} seconds' where id = '${id}';`);
const invEvents = (id) =>
  db.admin(`select coalesce(json_agg(json_build_object('type', event_type, 'actor', actor_id) order by id), '[]'::json)
              from public.user_admin_events where invitation_id = '${id}'`);
const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

/** A fake Auth Admin client: inviteUserByEmail inserts the auth.users row Supabase would; rpc goes to the database as service_role. */
function fakeAuth() {
  const calls = [];
  const service = db.client({ role: "service_role" });
  const client = {
    auth: {
      admin: {
        inviteUserByEmail: async (email) => {
          calls.push(email);
          const existing = await db.admin(`select id from auth.users where lower(email) = lower('${email}') limit 1`);
          const id = existing ?? randomUUID();
          if (!existing) await db.exec(`insert into auth.users (id, email) values ('${id}', lower('${email}'));`);
          return { data: { user: { id, email: email.toLowerCase() } }, error: null };
        },
      },
    },
    rpc: (fn, args) => service.rpc(fn, args),
  };
  return { calls, client };
}

const user = (id, role) => ({ id, email: "x@test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" });

function invitationsAs(id, role, auth = fakeAuth()) {
  return createInvitationsService({
    invitations: createInvitationsRepository(async () => db.client({ role: "authenticated", userId: id })),
    authAdmin: createAuthAdminRepository(() => auth.client),
    getCurrentUser: async () => user(id, role),
    redirectUrl: () => REDIRECT,
  });
}

function usersAs(id, role) {
  return createUsersService({
    repository: createUsersRepository(async () => db.client({ role: "authenticated", userId: id })),
    getCurrentUser: async () => user(id, role),
  });
}

/** A Super Admin invitation for a new student, sent: returns the invitation id and the invited account id. */
async function invitedStudent() {
  const auth = fakeAuth();
  const sent = await invitationsAs(W.ilc_SA, "admin", auth).inviteUser({ email: `${uniq("ilc")}@ilc.test`, role: "student", fullName: "ILC Student" });
  assert.equal(sent.kind, "sent", JSON.stringify(sent));
  const row = await inv(sent.invitationId);
  assert.ok(row.auth_user_id, "the invited account is bound");
  return { invitationId: sent.invitationId, accountId: row.auth_user_id };
}

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ilc_' || k, gen_random_uuid() from unnest(array['SA','T','S']) k;
    insert into auth.users (id, email) select v, lower(k) || '@ilc.test' from t.ids where k in ('ilc_SA','ilc_T','ilc_S');
    update public.profiles set role = 'super_admin' where id = t.id('ilc_SA');
    update public.profiles set role = 'trainer' where id = t.id('ilc_T');
    update public.profiles set account_status = 'active' where id in (t.id('ilc_SA'), t.id('ilc_T'), t.id('ilc_S'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ilc_T'), 'ILC-T', 'ILC Trainer');
    insert into public.students (id, student_code, full_name) values (t.id('ilc_S'), 'ILC-S', 'ILC Student Account');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("panel data: an invited account shows its pending invitation (resend + revoke offered) and its invitation events in the history", async () => {
  const { invitationId, accountId } = await invitedStudent();
  const detail = await usersAs(W.ilc_SA, "admin").getUserDetail(accountId);
  assert.equal(detail.user.accountStatus, "invited");
  assert.deepEqual(
    { id: detail.invitation.id, status: detail.invitation.status, resendCount: detail.invitation.resendCount, canResend: detail.invitation.canResend, canRevoke: detail.invitation.canRevoke },
    { id: invitationId, status: "pending", resendCount: 0, canResend: true, canRevoke: true }
  );
  assert.ok(detail.invitation.lastSentAt, "sent");
  assert.ok(detail.history.some((h) => h.summary === "Invitation created"), "invitation events now join the account history");
  assert.equal(JSON.stringify(detail.invitation).includes("@"), false, "no address (or anything else personal) in the invitation summary");
  // An active account never shows an invitation section.
  const active = await usersAs(W.ilc_SA, "admin").getUserDetail(W.ilc_T);
  assert.equal(active.invitation, null);
});

test("resend existing: cooldown answered with the wait; after it a real resend (counted, audited); the cap is enforced — Auth is called only when authorized", async () => {
  const { invitationId } = await invitedStudent();
  const auth = fakeAuth();
  const svc = invitationsAs(W.ilc_SA, "admin", auth);

  const early = await svc.resendInvitation(invitationId);
  assert.equal(early.kind, "refused");
  assert.equal(early.reason, "cooldown");
  assert.ok(early.retryAfterSeconds >= 1 && early.retryAfterSeconds <= 60);
  assert.equal(auth.calls.length, 0, "no email during the cooldown");

  await age(invitationId, 61);
  const resent = await svc.resendInvitation(invitationId);
  assert.deepEqual({ kind: resent.kind, attempt: resent.attempt }, { kind: "sent", attempt: "resend" });
  assert.equal(auth.calls.length, 1);
  assert.equal((await inv(invitationId)).resend_count, 1);
  assert.ok((await invEvents(invitationId)).some((e) => e.type === "invitation_resent" && e.actor === W.ilc_SA), "audited with the actor");

  await db.exec(`update public.user_invitations set resend_count = 5, last_sent_at = now() - interval '2 minutes' where id = '${invitationId}';`);
  const capped = await svc.resendInvitation(invitationId);
  assert.deepEqual({ kind: capped.kind, reason: capped.reason }, { kind: "refused", reason: "resend_limit" });
  assert.equal(auth.calls.length, 1, "no email past the cap");
  const panel = await usersAs(W.ilc_SA, "admin").getUserDetail((await inv(invitationId)).auth_user_id);
  assert.deepEqual({ canResend: panel.invitation.canResend, canRevoke: panel.invitation.canRevoke }, { canResend: false, canRevoke: true }, "the panel stops offering resend at the cap");
});

test("revoke: state change only — the Auth user, profile and account status stay; audited; cannot be repeated; resend afterwards is refused", async () => {
  const { invitationId, accountId } = await invitedStudent();
  const svc = invitationsAs(W.ilc_SA, "admin");

  assert.deepEqual(await svc.revokeInvitation(invitationId, "  sent to the wrong person  "), { ok: true });
  const row = await inv(invitationId);
  assert.deepEqual({ status: row.status, revoked_by: row.revoked_by, revoke_reason: row.revoke_reason }, { status: "revoked", revoked_by: W.ilc_SA, revoke_reason: "sent to the wrong person" });
  assert.equal(await db.admin(`select count(*)::int from auth.users where id = '${accountId}'`), 1, "the Auth user is not deleted");
  assert.equal(await db.admin(`select account_status from public.profiles where id = '${accountId}'`), "invited", "the profile is untouched");
  assert.ok((await invEvents(invitationId)).some((e) => e.type === "invitation_revoked" && e.actor === W.ilc_SA), "audited with the actor");

  assert.deepEqual(await svc.revokeInvitation(invitationId, null), { ok: false, reason: "not_pending" }, "a second revoke changes nothing");
  const auth = fakeAuth();
  const resend = await invitationsAs(W.ilc_SA, "admin", auth).resendInvitation(invitationId);
  assert.deepEqual({ kind: resend.kind, reason: resend.reason }, { kind: "refused", reason: "not_pending" });
  assert.equal(auth.calls.length, 0, "a revoked invitation is never emailed again");

  const panel = await usersAs(W.ilc_SA, "admin").getUserDetail(accountId);
  assert.deepEqual({ status: panel.invitation.status, canResend: panel.invitation.canResend, canRevoke: panel.invitation.canRevoke }, { status: "revoked", canResend: false, canRevoke: false });
  assert.ok(panel.history.some((h) => h.summary === "Invitation revoked"));

  // The address can be invited again afterwards (0019 D1 placeholder rule) — what the success message promises.
  const email = await db.admin(`select email from public.user_invitations where id = '${invitationId}'`);
  const again = await invitationsAs(W.ilc_SA, "admin").inviteUser({ email, role: "student", fullName: "ILC Student" });
  assert.equal(again.kind, "sent", JSON.stringify(again));
});

test("expired: a pending invitation past its expiry is shown as expired with no actions; revoke answers expired and marks it", async () => {
  const { invitationId, accountId } = await invitedStudent();
  // created_at is immutable (0017 guard), so expire it the only allowed way: an expiry just after creation, now in the past.
  await db.exec(`update public.user_invitations set expires_at = created_at + interval '1 millisecond' where id = '${invitationId}';`);
  const before = await usersAs(W.ilc_SA, "admin").getUserDetail(accountId);
  assert.deepEqual({ status: before.invitation.status, canResend: before.invitation.canResend, canRevoke: before.invitation.canRevoke }, { status: "expired", canResend: false, canRevoke: false });
  assert.deepEqual(await invitationsAs(W.ilc_SA, "admin").revokeInvitation(invitationId, null), { ok: false, reason: "expired" });
  assert.equal((await inv(invitationId)).status, "expired");
});

test("refusals: trainers and students are refused by the service before any call; the database refuses them directly too; bad ids never reach it", async () => {
  const { invitationId } = await invitedStudent();
  for (const [id, role] of [[W.ilc_T, "trainer"], [W.ilc_S, "student"]]) {
    const auth = fakeAuth();
    const svc = invitationsAs(id, role, auth);
    await assert.rejects(svc.revokeInvitation(invitationId, null), InvitationsAuthorizationError);
    await assert.rejects(svc.resendInvitation(invitationId), InvitationsAuthorizationError);
    assert.equal(auth.calls.length, 0);
  }
  // Direct database calls on their own sessions: neither a student nor (0029) a trainer has any authority.
  const student = await db.client({ role: "authenticated", userId: W.ilc_S }).rpc("revoke_user_invitation", { p_invitation_id: invitationId });
  assert.equal(student.error?.code, "42501");
  const trainer = await db.client({ role: "authenticated", userId: W.ilc_T }).rpc("revoke_user_invitation", { p_invitation_id: invitationId });
  assert.equal(trainer.error?.code, "42501");
  assert.equal((await inv(invitationId)).status, "pending", "nothing changed");

  const svc = invitationsAs(W.ilc_SA, "admin");
  assert.deepEqual(await svc.revokeInvitation("not-a-uuid", null), { ok: false, reason: "not_found" });
  assert.deepEqual(await quiet(() => svc.revokeInvitation(randomUUID(), null)), { ok: false, reason: "not_found" });
});
