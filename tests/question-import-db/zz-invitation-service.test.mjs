// Integration (Phase 7 P3.4, slice 1): the real invitations service, session repository and Auth Admin
// repository cores against the local 0001–0019 database. create_user_invitation and
// begin_invitation_delivery run on the Super Admin's own session; record_invitation_delivery runs as
// service_role. Only Supabase Auth Admin is simulated: a fake inviteUserByEmail that inserts the
// auth.users row it would create (never Supabase, never a real email).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createInvitationsRepository } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createAuthAdminRepository } = await import(`${build}/repositories/auth-admin.repository.core.mjs`);
const { createInvitationsService, InvitationsAuthorizationError } = await import(`${build}/services/invitations.service.core.mjs`);

const REDIRECT = "http://localhost:3000/auth/confirm";
let W;
let n = 0;
const uniq = (p) => `${p}${Date.now().toString(36)}${++n}`;
const input = (o = {}) => ({ email: `${uniq("svc")}@svc.test`, role: "student", fullName: "Svc Person", ...o });
const inv = (id) =>
  db.admin(`select json_build_object('email', email, 'status', status, 'delivery', delivery_status, 'resend_count', resend_count,
              'last_sent_at', last_sent_at, 'auth_user_id', auth_user_id) from public.user_invitations where id = '${id}'`);
const profile = (id) => db.admin(`select json_build_object('role', role, 'status', account_status) from public.profiles where id = '${id}'`);
const age = (id, s) => db.exec(`update public.user_invitations set last_sent_at = now() - interval '${s} seconds' where id = '${id}';`);
const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

/** A fake Auth Admin client: inviteUserByEmail behaves as configured; rpc goes to the real database as service_role. */
function fakeAuth(behaviour = "send") {
  const calls = [];
  const service = db.client({ role: "service_role" });
  const client = {
    auth: {
      admin: {
        inviteUserByEmail: async (email, options) => {
          calls.push({ email, options });
          const mode = typeof behaviour === "function" ? await behaviour(email, calls.length) : behaviour;
          if (mode === "registered") return { data: { user: null }, error: { name: "AuthApiError", status: 422, code: "email_exists", message: "A user with this email address has already been registered" } };
          if (mode === "network") return { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } };
          const existing = await db.admin(`select id from auth.users where lower(email) = lower('${email}') limit 1`);
          const id = existing ?? randomUUID();
          if (!existing) await db.exec(`insert into auth.users (id, email) values ('${id}', lower('${email}'));`);
          return { data: { user: { id, email: email.toLowerCase() } }, error: null };
        },
      },
    },
    rpc: (fn, args) => (behaviour === "record_throws" ? Promise.reject(new Error("network down")) : service.rpc(fn, args)),
  };
  return { calls, client };
}

function serviceFor(userId, role, auth) {
  return createInvitationsService({
    invitations: createInvitationsRepository(async () => db.client({ role: "authenticated", userId })),
    authAdmin: createAuthAdminRepository(() => auth.client),
    getCurrentUser: async () => ({ id: userId, email: "x@test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
    redirectUrl: () => REDIRECT,
  });
}

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'isv_' || k, gen_random_uuid() from unnest(array['SA']) k;
    insert into auth.users (id, email) values (t.id('isv_SA'), 'isv_sa@svc.test');
    update public.profiles set role = 'super_admin', account_status = 'active' where id = t.id('isv_SA');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("happy path: created on the session, sent with the database address and the configured redirect, recorded as service_role", async () => {
  const auth = fakeAuth();
  const svc = serviceFor(W.isv_SA, "admin", auth);
  const typed = input({ email: `  ${uniq("Mixed.Case")}@Svc.Test ` });
  const r = await svc.inviteUser(typed);
  assert.equal(r.kind, "sent", JSON.stringify(r));
  assert.equal(r.attempt, "initial");
  const row = await inv(r.invitationId);
  assert.equal(auth.calls.length, 1);
  assert.deepEqual(auth.calls[0], { email: row.email, options: { redirectTo: REDIRECT } }, "Auth got the stored address and nothing else");
  assert.deepEqual([row.status, row.delivery, row.resend_count], ["pending", "sent", 0]);
  assert.ok(row.auth_user_id);
  assert.deepEqual(await profile(row.auth_user_id), { role: "student", status: "invited" }, "never activated");
  assert.equal(await db.admin(`select count(*) from public.user_admin_events where invitation_id = '${r.invitationId}' and event_type = 'invitation_created' and actor_id = '${W.isv_SA}'`), 1);
});

test("resend: cooldown and cap enforced by the database before Auth is called; a resend is audited", async () => {
  const auth = fakeAuth();
  const svc = serviceFor(W.isv_SA, "admin", auth);
  const { invitationId } = await svc.inviteUser(input());
  const cool = await svc.resendInvitation(invitationId);
  assert.deepEqual([cool.kind, cool.stage, cool.reason], ["refused", "deliver", "cooldown"]);
  assert.ok(cool.retryAfterSeconds >= 1);
  assert.equal(auth.calls.length, 1, "no Auth call during the cooldown");
  await age(invitationId, 61);
  assert.deepEqual(await svc.resendInvitation(invitationId), { kind: "sent", invitationId, attempt: "resend" });
  assert.equal(auth.calls.length, 2);
  assert.equal((await inv(invitationId)).resend_count, 1);
  assert.equal(await db.admin(`select count(*) from public.user_admin_events where invitation_id = '${invitationId}' and event_type = 'invitation_resent'`), 1);
  await db.exec(`update public.user_invitations set resend_count = 5, last_sent_at = now() - interval '120 seconds' where id = '${invitationId}';`);
  assert.equal((await svc.resendInvitation(invitationId)).reason, "resend_limit");
  assert.equal(auth.calls.length, 2);
});

test("database refusals: existing account at create; revoked/expired/unknown at delivery — Auth never called", async () => {
  const auth = fakeAuth();
  const svc = serviceFor(W.isv_SA, "admin", auth);
  assert.deepEqual(await svc.inviteUser(input({ email: "isv_sa@svc.test" })), { kind: "refused", stage: "create", reason: "account_exists", invitationId: null });
  const { invitationId } = await svc.inviteUser(input());
  await db.client({ role: "authenticated", userId: W.isv_SA }).rpc("revoke_user_invitation", { p_invitation_id: invitationId });
  await age(invitationId, 61);
  const revoked = await svc.resendInvitation(invitationId);
  assert.deepEqual([revoked.kind, revoked.reason], ["refused", "not_pending"]);
  const expiring = (await svc.inviteUser(input())).invitationId;
  await db.exec(`update public.user_invitations set expires_at = created_at + interval '1 millisecond' where id = '${expiring}';`);
  assert.equal((await svc.resendInvitation(expiring)).reason, "expired");
  assert.equal((await svc.resendInvitation(randomUUID())).reason, "not_found");
  assert.equal(auth.calls.length, 2, "only the two successful initial sends reached Auth");
});

test("Auth refusal (already registered) is recorded as failed; no answer leaves nothing recorded", async () => {
  const refused = fakeAuth("registered");
  const r = await quiet(() => serviceFor(W.isv_SA, "admin", refused).inviteUser(input()));
  assert.deepEqual([r.kind, r.reason, r.recorded], ["delivery_failed", "already_registered", true]);
  assert.deepEqual([(await inv(r.invitationId)).delivery, (await inv(r.invitationId)).auth_user_id, (await inv(r.invitationId)).status], ["failed", null, "pending"]);

  const silent = fakeAuth("network");
  const u = await quiet(() => serviceFor(W.isv_SA, "admin", silent).inviteUser(input()));
  assert.equal(u.kind, "delivery_unknown");
  const row = await inv(u.invitationId);
  assert.deepEqual([row.delivery, row.status], ["not_sent", "pending"], "not falsely recorded as failed");
  assert.ok(row.last_sent_at, "the authorized attempt remains visible");
});

test("CRITICAL: Auth sent but recording failed → sent_unrecorded; database left as begin left it; recoverable by a later resend", async () => {
  const broken = fakeAuth("record_throws");
  const r = await quiet(() => serviceFor(W.isv_SA, "admin", broken).inviteUser(input()));
  assert.deepEqual(r, { kind: "sent_unrecorded", invitationId: r.invitationId, code: r.code });
  assert.match(r.code, /^STU-\d{5,}$/, "the generated code is reported even when recording failed (0020)");
  assert.equal(broken.calls.length, 1, "exactly one Auth invite — no automatic second send");
  const row = await inv(r.invitationId);
  assert.deepEqual([row.status, row.delivery, row.auth_user_id], ["pending", "not_sent", null], "no compensating write");
  assert.ok(row.last_sent_at);
  const placeholder = await db.admin(`select id from auth.users where lower(email) = lower('${row.email}')`);
  assert.deepEqual(await profile(placeholder), { role: "student", status: "invited" });

  // Recovery (an explicit resend after the cooldown) binds the same Auth account.
  const auth = fakeAuth();
  const svc = serviceFor(W.isv_SA, "admin", auth);
  assert.equal((await svc.resendInvitation(r.invitationId)).reason, "cooldown");
  await age(r.invitationId, 61);
  assert.deepEqual(await svc.resendInvitation(r.invitationId), { kind: "sent", invitationId: r.invitationId, attempt: "resend" });
  assert.deepEqual([(await inv(r.invitationId)).delivery, (await inv(r.invitationId)).auth_user_id], ["sent", placeholder]);
});

test("email mismatch: Auth returns an account whose address differs → refused by the database, reported as sent_unrecorded (not failed)", async () => {
  const otherId = randomUUID();
  await db.exec(`insert into auth.users (id, email) values ('${otherId}', '${uniq("someone.else")}@svc.test');`);
  const wrong = {
    calls: [],
    client: {
      auth: { admin: { inviteUserByEmail: async (email) => (wrong.calls.push(email), { data: { user: { id: otherId } }, error: null }) } },
      rpc: (fn, args) => db.client({ role: "service_role" }).rpc(fn, args),
    },
  };
  const r = await quiet(() => serviceFor(W.isv_SA, "admin", wrong).inviteUser(input()));
  assert.equal(r.kind, "sent_unrecorded");
  assert.deepEqual([(await inv(r.invitationId)).delivery, (await inv(r.invitationId)).auth_user_id], ["not_sent", null], "the wrong account is never bound");
});

test("only Super Admins: a trainer or student session is refused by the service before anything runs", async () => {
  for (const [key, role] of [["T1", "trainer"], ["ST1", "student"]]) {
    const auth = fakeAuth();
    const id = await db.admin(`select v from t.ids where k = '${key}'`);
    await assert.rejects(serviceFor(id, role, auth).inviteUser(input()), InvitationsAuthorizationError);
    assert.equal(auth.calls.length, 0);
  }
  // Even with a forged application role, the database refuses the student's session.
  const auth = fakeAuth();
  const st = await db.admin(`select v from t.ids where k = 'ST1'`);
  const forged = await serviceFor(st, "admin", auth).inviteUser(input());
  assert.deepEqual(forged, { kind: "refused", stage: "create", reason: "permission", invitationId: null });
  assert.equal(auth.calls.length, 0);
});

/** A fake Auth Admin that, while "sending", lets something else change the database first (the race window). */
function racingAuth(duringSend) {
  const calls = [];
  return {
    calls,
    client: {
      auth: {
        admin: {
          inviteUserByEmail: async (email) => {
            calls.push(email);
            const id = randomUUID();
            await db.exec(`insert into auth.users (id, email) values ('${id}', lower('${email}'));`);
            await duringSend(email, id);
            return { data: { user: { id } }, error: null };
          },
        },
      },
      rpc: (fn, args) => db.client({ role: "service_role" }).rpc(fn, args),
    },
  };
}

test("race: invitation revoked between begin and Auth → sent_unrecorded, nothing bound, acceptance refused, no second email", async () => {
  let invitationId;
  const auth = racingAuth(async (email) => {
    invitationId = await db.admin(`select id from public.user_invitations where email_normalized = lower('${email}') and status = 'pending'`);
    const r = await db.client({ role: "authenticated", userId: W.isv_SA }).rpc("revoke_user_invitation", { p_invitation_id: invitationId });
    assert.equal(r.data?.ok, true);
  });
  const out = await quiet(() => serviceFor(W.isv_SA, "admin", auth).inviteUser(input()));
  assert.deepEqual(out, { kind: "sent_unrecorded", invitationId, code: out.code });
  assert.match(out.code, /^STU-\d{5,}$/);
  assert.equal(auth.calls.length, 1);
  const row = await inv(invitationId);
  assert.deepEqual([row.status, row.delivery, row.auth_user_id], ["revoked", "not_sent", null]);
  const placeholder = await db.admin(`select id from auth.users where lower(email) = lower('${row.email}')`);
  assert.deepEqual(await db.client({ role: "authenticated", userId: placeholder }).rpc("accept_user_invitation").then((x) => x.data), { ok: false, reason: "not_pending" });
  assert.deepEqual(await profile(placeholder), { role: "student", status: "invited" });
});

test("race: account status changed between begin and Auth → sent_unrecorded, the account is never bound or changed by delivery", async () => {
  const auth = racingAuth(async (_email, id) => {
    await db.exec(`update public.profiles set account_status = 'active' where id = '${id}';`);
  });
  const out = await quiet(() => serviceFor(W.isv_SA, "admin", auth).inviteUser(input()));
  assert.equal(out.kind, "sent_unrecorded");
  const row = await inv(out.invitationId);
  assert.deepEqual([row.status, row.delivery, row.auth_user_id], ["pending", "not_sent", null], "record refused (account_not_invited)");
});
