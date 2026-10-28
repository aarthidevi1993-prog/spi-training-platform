// Phase 7 P3.12 — Invite a new Super Admin, end to end against the throwaway local database:
//   invitationsService.inviteUser with exactly what inviteSuperAdminAction forwards ({ role: "admin", email, fullName }
//   — proven by tests/user-management/invitations.test.mjs) on the Super Admin's OWN session → the existing
//   create_user_invitation (0028: Super Admin only) / begin_invitation_delivery → a FAKE Auth Admin sender (it only
//   inserts the auth.users row the real one would; never Supabase, never an email) → the invitee's own session
//   accepts through the real acceptance service → the database role is super_admin → the admin portal.
// Plus duplicates, refusals for trainers / students / suspended Super Admins / signed-out callers, and the
// database guard against batch fields on a Super Admin invitation. Own fixtures only (sai_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationsRepository } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createAuthAdminRepository } = await import(`${build}/repositories/auth-admin.repository.core.mjs`);
const { createInvitationsService, InvitationsAuthorizationError } = await import(`${build}/services/invitations.service.core.mjs`);
const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);
const { fetchProfileRole } = await import(`${build}/lib/auth/profile-role.mjs`);
const { decidePortalAccess } = await import(`${build}/lib/auth/roles.mjs`);

const REDIRECT = "http://localhost:3000/auth/confirm";
const PASSWORD = "Accept-Me-123!";
let W;
let n = 0;
const uniq = (p) => `${p}${Date.now().toString(36)}${++n}`;
/** Exactly the service input inviteSuperAdminAction builds (role fixed, name + email only). */
const actionInput = (email, fullName = "New Super Admin") => ({ role: "admin", email, fullName });
const inv = (id) =>
  db.admin(`select json_build_object('role', intended_role, 'status', status, 'delivery', delivery_status, 'batch', batch_id,
              'student_code', student_code, 'trainer_code', trainer_code, 'auth_user_id', auth_user_id, 'invited_by', invited_by)
              from public.user_invitations where id = '${id}'`);
const profile = (id) => db.admin(`select json_build_object('role', role, 'status', account_status) from public.profiles where id = '${id}'`);
const quiet = async (fn) => {
  const saved = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { [console.warn, console.error] = saved; }
};

/** Fake Auth Admin: inviteUserByEmail inserts the auth.users row it would create; rpc → the real database as service_role. */
function fakeAuth() {
  const calls = [];
  const service = db.client({ role: "service_role" });
  return {
    calls,
    client: {
      auth: {
        admin: {
          inviteUserByEmail: async (email, options) => {
            calls.push({ email, options });
            const existing = await db.admin(`select id from auth.users where lower(email) = lower('${email}') limit 1`);
            const id = existing ?? randomUUID();
            if (!existing) await db.exec(`insert into auth.users (id, email) values ('${id}', lower('${email}'));`);
            return { data: { user: { id, email: email.toLowerCase() } }, error: null };
          },
        },
      },
      rpc: (fn, args) => service.rpc(fn, args),
    },
  };
}

function inviter(userId, role, auth, { signedOut = false } = {}) {
  return createInvitationsService({
    invitations: createInvitationsRepository(async () => db.client({ role: "authenticated", userId })),
    authAdmin: createAuthAdminRepository(() => auth.client),
    getCurrentUser: async () => (signedOut ? null : { id: userId, email: "x@sai.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
    redirectUrl: () => REDIRECT,
  });
}

/** The invitee's own session (real database), with a recording Auth stand-in for verifyOtp / updateUser / signOut. */
function acceptanceFor(userId, email) {
  const c = db.client({ role: "authenticated", userId });
  const session = {
    rpc: (fn, args) => c.rpc(fn, args),
    from: (t) => c.from(t),
    auth: {
      verifyOtp: async () => ({ data: {}, error: null }),
      getUser: async () => ({ data: { user: { id: userId, email } }, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
    },
  };
  return createInvitationAcceptanceService({ repository: createInvitationAcceptanceRepository(async () => session) });
}

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'sai_' || k, gen_random_uuid() from unnest(array['SA','SA_SUS','T','S']) k;
    insert into auth.users (id, email) select v, lower(k) || '@sai.test' from t.ids where k in ('sai_SA','sai_SA_SUS','sai_T','sai_S');
    update public.profiles set role = 'super_admin', account_status = 'active' where id in (t.id('sai_SA'), t.id('sai_SA_SUS'));
    update public.profiles set role = 'trainer', account_status = 'active' where id = t.id('sai_T');
    update public.profiles set role = 'student', account_status = 'active' where id = t.id('sai_S');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('sai_T'), 'SAI-T', 'SAI Trainer');
    insert into public.students (id, student_code, full_name) values (t.id('sai_S'), 'SAI-S', 'SAI Student');
    update public.profiles set account_status = 'suspended' where id = t.id('sai_SA_SUS');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("end to end: a Super Admin invites; the invitee accepts; the database role is super_admin; the admin portal opens", async () => {
  const auth = fakeAuth();
  const email = `${uniq("new.admin")}@sai.test`;
  const r = await inviter(W.sai_SA, "admin", auth).inviteUser(actionInput(email));
  assert.equal(r.kind, "sent", JSON.stringify(r));
  assert.equal("code" in r, false, "no student/trainer code for a Super Admin");
  const row = await inv(r.invitationId);
  assert.deepEqual(
    { role: row.role, status: row.status, delivery: row.delivery, batch: row.batch, student_code: row.student_code, trainer_code: row.trainer_code, invited_by: row.invited_by },
    { role: "super_admin", status: "pending", delivery: "sent", batch: null, student_code: null, trainer_code: null, invited_by: W.sai_SA }
  );
  assert.equal(auth.calls.length, 1);
  assert.deepEqual(auth.calls[0].options, { redirectTo: REDIRECT });
  const newId = row.auth_user_id;
  assert.ok(newId);
  assert.deepEqual(await profile(newId), { role: "student", status: "invited" }, "before acceptance: invited, no portal");
  assert.equal(await quiet(() => fetchProfileRole(db.client({ role: "authenticated", userId: newId }), newId)), null);

  // Acceptance through the real service on the invitee's own session: the role comes from the stored invitation.
  assert.deepEqual(await quiet(() => acceptanceFor(newId, email).completeInvitation(PASSWORD, PASSWORD)), { ok: true, home: "/admin" });
  assert.deepEqual(await profile(newId), { role: "super_admin", status: "active" });
  const role = await quiet(() => fetchProfileRole(db.client({ role: "authenticated", userId: newId }), newId));
  assert.equal(role, "admin", "the session role lookup resolves the database role");
  assert.equal(decidePortalAccess("admin", role), "allow");
  assert.equal(decidePortalAccess("trainer", role), "unauthorized");
  assert.equal(decidePortalAccess("student", role), "unauthorized");
  assert.equal(await db.admin(`select count(*) from public.user_admin_events where invitation_id = '${r.invitationId}' and event_type in ('invitation_created', 'invitation_accepted')`), 2, "created and accepted are audited");
});

test("duplicates: a pending invitation or an existing account for the address is refused before any email", async () => {
  const auth = fakeAuth();
  const svc = inviter(W.sai_SA, "admin", auth);
  const email = `${uniq("dup.admin")}@sai.test`;
  assert.equal((await svc.inviteUser(actionInput(email))).kind, "sent");
  // The first invitation's delivery already created the invited Auth account, so the database answers
  // account_exists (it reports an existing account before a pending invitation). Case-insensitive.
  const pending = await svc.inviteUser(actionInput(email.toUpperCase()));
  assert.deepEqual([pending.kind, pending.stage, pending.reason, pending.invitationId], ["refused", "create", "account_exists", null]);
  // An invitation not yet delivered (no Auth account yet) is reported as already_invited.
  const undelivered = `${uniq("undelivered")}@sai.test`;
  const created = await db.client({ role: "authenticated", userId: W.sai_SA }).rpc("create_user_invitation", { p: { email: undelivered, role: "super_admin", full_name: "U" } });
  assert.equal(created.data?.ok, true, JSON.stringify(created));
  const again = await svc.inviteUser(actionInput(undelivered));
  assert.deepEqual([again.kind, again.stage, again.reason], ["refused", "create", "already_invited"]);
  const existing = await svc.inviteUser(actionInput("sai_t@sai.test"));
  assert.deepEqual([existing.kind, existing.stage, existing.reason], ["refused", "create", "account_exists"]);
  assert.equal(auth.calls.length, 1, "Auth was called only for the first invitation");
});

test("refusals: trainers, students, suspended Super Admins and signed-out callers cannot invite a Super Admin", async () => {
  const before = await db.admin("select count(*) from public.user_invitations");
  for (const [label, svc] of [
    ["trainer", inviter(W.sai_T, "trainer", fakeAuth())],
    ["student", inviter(W.sai_S, "student", fakeAuth())],
    ["signed out (incl. a suspended Super Admin: the session lookup returns no user)", inviter(W.sai_SA_SUS, "admin", fakeAuth(), { signedOut: true })],
  ]) {
    await assert.rejects(svc.inviteUser(actionInput(`${uniq("x")}@sai.test`)), InvitationsAuthorizationError, label);
  }
  // The database refuses them itself too, whatever the application believed (0028).
  for (const uid of [W.sai_T, W.sai_S, W.sai_SA_SUS]) {
    const r = await db.client({ role: "authenticated", userId: uid }).rpc("create_user_invitation", { p: { email: `${uniq("y")}@sai.test`, role: "super_admin", full_name: "Y" } });
    assert.equal(r.error?.code, "42501", uid);
  }
  // A suspended Super Admin whose application session were still believed active is refused by the database.
  const stale = await quiet(() => inviter(W.sai_SA_SUS, "admin", fakeAuth()).inviteUser(actionInput(`${uniq("z")}@sai.test`)));
  assert.equal(stale.kind, "refused");
  assert.equal(stale.invitationId, null);
  assert.equal(await db.admin("select count(*) from public.user_invitations"), before, "no invitation row was created");
});

test("the database keeps a Super Admin invitation free of batch and code fields, whatever is sent", async () => {
  const sa = db.client({ role: "authenticated", userId: W.sai_SA });
  const batch = await sa.rpc("create_user_invitation", { p: { email: `${uniq("b")}@sai.test`, role: "super_admin", full_name: "B", batch_id: randomUUID() } });
  assert.equal(batch.error?.code, "22023");
  const code = await sa.rpc("create_user_invitation", { p: { email: `${uniq("c")}@sai.test`, role: "super_admin", full_name: "C", student_code: "X1" } });
  assert.equal(code.error?.code, "22023", "codes are never supplied (0020)");
});
