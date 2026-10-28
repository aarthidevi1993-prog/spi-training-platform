// Integration: the Super Admin identity fallback against the real database (RLS, each viewer on its OWN session).
// A Super Admin account has no student/trainer record: its name comes from its ACCEPTED invitation, read through
// the real users repository/service cores (user_invitations_admin_select). Proves that only Super Admins get the
// names and acceptance times (and named history actors), that pending invitations never provide one, that no
// invitation address is ever read, and that trainers, students and signed-out callers get nothing new.
// Own fixtures only (ui_*); no RLS, grant or migration change.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { USERS, bindInvitation, clientFor, db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService, UsersAuthorizationError } = await import(`${build}/services/users.service.core.mjs`);

const session = (id) => db.client({ role: "authenticated", userId: id });
const repoFor = (client) => createUsersRepository(async () => client);
const serviceAs = (user) => createUsersService({ repository: repoFor(clientFor(user)), getCurrentUser: async () => user });
const quietly = async (fn) => {
  const saved = [console.warn, console.error];
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.warn, console.error] = saved;
  }
};
async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code} ${error.message}`);
  return data;
}

const U = {};
/** Create an invitation as this file's own Super Admin (its own hourly invitation budget, unaffected by other files). */
async function invite(email, fullName) {
  const inv = await rpc(session(U.ui_CREATOR), "create_user_invitation", { p: { email, role: "super_admin", full_name: fullName } });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  return inv;
}
/** Invite, bind and accept on the invitee's own session — the real flow. */
async function acceptedSuperAdmin(key, email, fullName) {
  const inv = await invite(email, fullName);
  await db.exec(`insert into t.ids values ('${key}', gen_random_uuid()); insert into auth.users (id, email) values (t.id('${key}'), '${email}');`);
  U[key] = await db.admin(`select v from t.ids where k = '${key}'`);
  await bindInvitation(inv.invitation_id, U[key], U.ui_CREATOR);
  const accepted = await rpc(session(U[key]), "accept_user_invitation", {});
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  return inv.invitation_id;
}

before(async () => {
  // This file's own active Super Admin creates the fixture invitations (fixture rows as the superuser, like every file).
  await db.exec(`
    insert into t.ids values ('ui_CREATOR', gen_random_uuid());
    insert into auth.users (id, email) values (t.id('ui_CREATOR'), 'ui.creator@ui.test');
    update public.profiles set role = 'super_admin', account_status = 'active' where id = t.id('ui_CREATOR');`);
  U.ui_CREATOR = await db.admin(`select v from t.ids where k = 'ui_CREATOR'`);
  await acceptedSuperAdmin("ui_SA1", "ui.sa1@ui.test", "Identity Super One");
  await acceptedSuperAdmin("ui_SA2", "ui.sa2@ui.test", "Identity Super Two");
  // A PENDING (sent, never accepted) invitation and its invited account — its name must never be used.
  const pending = await invite("ui.pend@ui.test", "Pending Person");
  await db.exec(`insert into t.ids values ('ui_PEND', gen_random_uuid()); insert into auth.users (id, email) values (t.id('ui_PEND'), 'ui.pend@ui.test');`);
  U.ui_PEND = await db.admin(`select v from t.ids where k = 'ui_PEND'`);
  await bindInvitation(pending.invitation_id, U.ui_PEND, U.ui_CREATOR);
  // An action by SA2 on SA1 (suspend, then reactivate) so a history actor other than the viewer exists.
  for (const status of ["suspended", "active"]) {
    const r = await rpc(session(U.ui_SA2), "admin_set_account_status", { p_user_id: U.ui_SA1, p_status: status, p_reason: "identity test" });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
});

test("Super Admin: accepted Super Admins are named from their invitation; no invitation address; pending invitations never name anyone", async () => {
  const svc = serviceAs(USERS.A);
  const allRows = async (params) => {
    const first = await svc.listUsers({ ...params, page: "1" });
    const rows = [...first.rows];
    for (let p = 2; p <= first.pageCount; p++) rows.push(...(await svc.listUsers({ ...params, page: String(p) })).rows);
    return new Map(rows.map((r) => [r.id, r]));
  };
  const rows = await allRows({});
  assert.equal(rows.get(U.ui_SA1)?.name, "Identity Super One");
  assert.equal(rows.get(U.ui_SA2)?.name, "Identity Super Two");
  for (const id of [U.ui_SA1, U.ui_SA2]) assert.equal(rows.get(id)?.email, null, "an invitation never provides an email");
  // The pending invitee's profile is still an invited student-role profile without a record: no name from a pending invitation.
  const pend = rows.get(U.ui_PEND);
  assert.ok(pend, "the pending invitee is listed");
  assert.equal(pend.name, null);
  // Search finds a Super Admin by its invited name.
  assert.ok((await serviceAs(USERS.A).listUsers({ q: "Identity Super One" })).rows.some((r) => r.id === U.ui_SA1));
});

test("Super Admin: the detail shows the invited name, acceptance time and named history actors", async () => {
  const detail = await serviceAs(USERS.A).getUserDetail(U.ui_SA1);
  assert.equal(detail.user.name, "Identity Super One");
  assert.equal(detail.user.email, null);
  const acceptedAt = await db.admin(`select to_json(accepted_at) from public.user_invitations where accepted_user_id = '${U.ui_SA1}' and status = 'accepted'`);
  assert.equal(new Date(detail.invitationAcceptedAt).getTime(), new Date(acceptedAt).getTime());
  const bySa2 = detail.history.filter((h) => h.actor === U.ui_SA2);
  assert.ok(bySa2.length >= 2, "suspend + reactivate by SA2");
  for (const h of bySa2) assert.equal(h.actorName, "Identity Super Two", "the other Super Admin is named from their accepted invitation");
  // Viewed by SA2 itself, its own actions are "you" and carry no name.
  const asSa2 = await serviceAs({ ...USERS.A, id: U.ui_SA2 }).getUserDetail(U.ui_SA1);
  for (const h of asSa2.history.filter((e) => e.actor === "you")) assert.equal(h.actorName, undefined);
  assert.ok(asSa2.history.some((e) => e.actor === "you"));
});

test("Trainers, students and signed-out callers: refused by the service before any read", async () => {
  for (const user of [USERS.T1, USERS.ST1, null]) {
    const svc = serviceAs(user);
    await assert.rejects(svc.listUsers({}), UsersAuthorizationError, user?.role ?? "anonymous");
    await assert.rejects(svc.getUserDetail(U.ui_SA1), UsersAuthorizationError, user?.role ?? "anonymous");
  }
});

test("RLS: even calling the repository directly, trainers, students and anonymous callers read no Super Admin identity", async () => {
  const fixtureIds = [U.ui_SA1, U.ui_SA2, U.ui_PEND];
  for (const user of [USERS.T1, USERS.ST1, null]) {
    const repo = repoFor(clientFor(user));
    const rows = await quietly(() => repo.listAcceptedIdentities().catch(() => []));
    assert.deepEqual(rows.filter((r) => fixtureIds.includes(r.accepted_user_id)), [], `${user?.role ?? "anonymous"}: no fixture identity`);
    const scoped = await quietly(() => repo.listAcceptedIdentities(fixtureIds).catch(() => []));
    assert.deepEqual(scoped, [], `${user?.role ?? "anonymous"}: nothing when asked for the fixture accounts`);
  }
  // The Super Admin sees exactly the two accepted fixtures — names and times only.
  const own = await repoFor(clientFor(USERS.A)).listAcceptedIdentities(fixtureIds);
  assert.deepEqual(own.map((r) => r.accepted_user_id).sort(), [U.ui_SA1, U.ui_SA2].sort());
  for (const r of own) assert.deepEqual(Object.keys(r).sort(), ["accepted_at", "accepted_user_id", "full_name", "id"], "no address, token or Auth data");
});
