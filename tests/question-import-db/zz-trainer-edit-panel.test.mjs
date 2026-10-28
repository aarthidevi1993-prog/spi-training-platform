// Phase 7 P3.11-C — Trainers list "View profile" / "Edit trainer" reuse the Users account panel. This drives the
// real users repository + service exactly as that panel does (each caller's OWN session, never the service role):
// the selected account loads with its existing trainer values, a save goes through admin_update_trainer, invalid
// input and non-Super-Admin callers are refused, a suspended trainer can be edited WITHOUT being reactivated, and
// a stale trainer record (account role since changed) is detectable and never edited as a trainer. Own fixtures (tep_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService, UsersAuthorizationError, UsersActionError } = await import(`${build}/services/users.service.core.mjs`);

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => `'${v}'`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const svcAs = (uid, role) =>
  createUsersService({
    repository: createUsersRepository(async () => as(uid)),
    getCurrentUser: async () => ({ id: uid, email: "x@tep.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
  });
const admin = () => svcAs(ids.A, "admin");
const row = (k) =>
  db.admin(`select json_build_object('name', t.full_name, 'phone', d.phone, 'org', d.organization, 'des', d.designation,
              'spec', d.specializations, 'bio', d.bio, 'status', p.account_status, 'role', p.role,
              'batches', (select count(*) from public.batches b where b.trainer_id = t.id))
              from public.trainers t join public.profiles p on p.id = t.id left join public.trainer_details d on d.trainer_id = t.id
             where t.id = '${X[k]}'`);

before(async () => {
  for (const k of ["T_ACT", "T_SUS", "STALE", "T_OTHER"]) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${["T_ACT", "T_SUS", "STALE", "T_OTHER"].map((k) => `(${q(X[k])}, '${k.toLowerCase()}@tep.test')`).join(", ")};
    update public.profiles set role = 'trainer', account_status = 'active' where id in (${q(X.T_ACT)}, ${q(X.T_SUS)}, ${q(X.T_OTHER)}, ${q(X.STALE)});
    insert into public.trainers (id, trainer_code, full_name) values
      (${q(X.T_ACT)}, 'TEP-TA', 'TEP Active'), (${q(X.T_SUS)}, 'TEP-TS', 'TEP Suspended'), (${q(X.T_OTHER)}, 'TEP-TO', 'TEP Other'),
      (${q(X.STALE)}, 'TEP-STALE', 'TEP Stale Trainer');
    -- The real stale case: the account's role changes to student; the database retires the trainer record (inactive).
    update public.profiles set role = 'student' where id = ${q(X.STALE)};
    insert into public.students (id, student_code, full_name) values (${q(X.STALE)}, 'TEP-STALE-S', 'TEP Stale As Student');
    insert into public.trainer_details (trainer_id, email, phone, organization, designation, specializations, bio) values
      (${q(X.T_ACT)}, 't_act@tep.test', '+91 1000', 'ARSENE', 'Senior Trainer', array['HART','PID'], 'Original bio'),
      (${q(X.T_SUS)}, 't_sus@tep.test', null, null, null, '{}', null);`, ids.A);
  await db.exec(`
    set session_replication_role = replica;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values (${q(id("B"))}, 'TEP-B', t.id('C1'), ${q(X.T_ACT)}, 'TEP batch', '2026-01-01', '2027-12-31', 'ongoing', 30);
    set session_replication_role = origin;`);
  // A suspended trainer (through the existing Super Admin function, as the Users panel / Remove would).
  const r = await as(ids.A).rpc("admin_set_account_status", { p_user_id: X.T_SUS, p_status: "suspended", p_reason: "test fixture" });
  assert.equal(r.data?.ok, true, JSON.stringify(r));
});

test("View profile: the selected id loads exactly that trainer's account, with the existing trainer values to edit", async () => {
  const d = await admin().getUserDetail(X.T_ACT);
  assert.equal(d.user.id, X.T_ACT, "the selected account, not another one");
  assert.equal(d.user.role, "trainer");
  assert.equal(d.actions.editDetails, true);
  assert.deepEqual(d.contact, {
    kind: "trainer",
    fields: { fullName: "TEP Active", phone: "+91 1000", organization: "ARSENE", designation: "Senior Trainer", specializations: ["HART", "PID"], bio: "Original bio" },
  });
  const other = await admin().getUserDetail(X.T_OTHER);
  assert.equal(other.user.id, X.T_OTHER);
  assert.equal(other.contact.fields.fullName, "TEP Other");
  assert.equal(await admin().getUserDetail(randomUUID()), null, "an unknown id shows 'Account not found'");
});

test("Edit: a valid change saves through admin_update_trainer; only changed fields; status, role and batches untouched", async () => {
  const message = await admin().updateDetails(X.T_ACT, {
    fullName: "TEP Active Renamed", phone: "+91 1000", organization: "ARSENE", designation: "Lead Trainer", bio: "Original bio", specializations: ["HART", "PID", "SIS"],
  });
  assert.equal(message, "Details saved.");
  assert.deepEqual(await row("T_ACT"), {
    name: "TEP Active Renamed", phone: "+91 1000", org: "ARSENE", des: "Lead Trainer", spec: ["HART", "PID", "SIS"], bio: "Original bio",
    status: "active", role: "trainer", batches: 1,
  });
  const ev = await db.admin(`select detail from public.user_admin_events where target_user_id = '${X.T_ACT}' and event_type = 'user_details_changed' order by id desc limit 1`);
  assert.deepEqual([...ev.fields].sort(), ["designation", "full_name", "specializations"], "the audit names the changed fields only");
});

test("Edit: invalid input is refused before any change; nothing changed is refused too", async () => {
  const before = await row("T_ACT");
  await assert.rejects(admin().updateDetails(X.T_ACT, { fullName: "   " }), UsersActionError);
  await assert.rejects(admin().updateDetails(X.T_ACT, { fullName: "X", organization: "o".repeat(201) }), UsersActionError);
  // A smuggled role is never applied: only the whitelisted detail fields are read (here nothing else changed).
  await assert.rejects(admin().updateDetails(X.T_ACT, { fullName: before.name, phone: before.phone, organization: before.org, designation: before.des, bio: before.bio, specializations: before.spec, role: "super_admin" }), /Nothing changed/);
  await assert.rejects(
    admin().updateDetails(X.T_ACT, { fullName: before.name, phone: before.phone, organization: before.org, designation: before.des, bio: before.bio, specializations: before.spec }),
    /Nothing changed/
  );
  assert.deepEqual(await row("T_ACT"), before);
});

test("authorization: trainers and students are refused by the service and the database; nothing changes", async () => {
  const before = await row("T_ACT");
  await assert.rejects(svcAs(X.T_OTHER, "trainer").getUserDetail(X.T_ACT), UsersAuthorizationError);
  await assert.rejects(svcAs(X.T_OTHER, "trainer").updateDetails(X.T_ACT, { fullName: "HACKED" }), UsersAuthorizationError);
  await assert.rejects(svcAs(X.STALE, "student").updateDetails(X.T_ACT, { fullName: "HACKED" }), UsersAuthorizationError);
  const direct = await as(X.T_OTHER).rpc("admin_update_trainer", { p_trainer_id: X.T_ACT, p: { full_name: "HACKED" } });
  assert.equal(direct.error?.code, "42501");
  assert.deepEqual(await row("T_ACT"), before);
});

test("suspended trainer: viewable and editable, but editing never reactivates the account", async () => {
  const d = await admin().getUserDetail(X.T_SUS);
  assert.equal(d.user.accountStatus, "suspended");
  assert.equal(d.actions.editDetails, true);
  assert.equal(await admin().updateDetails(X.T_SUS, { fullName: "TEP Suspended", organization: "New Org" }), "Details saved.");
  const after = await row("T_SUS");
  assert.equal(after.org, "New Org");
  assert.equal(after.status, "suspended", "still suspended — no silent reactivation");
});

test("stale trainer record (account role since changed): detectable in the list; the panel never edits it as a trainer", async () => {
  // The Trainers list reads the account's role through the same embed as trainers.repository.ts.
  const list = await as(ids.A).from("trainers").select("id, status, profiles!trainers_id_fkey ( account_status, role )").eq("id", X.STALE);
  assert.deepEqual(list.data, [{ id: X.STALE, status: "inactive", profiles: { account_status: "active", role: "student" } }]);
  // View profile still opens the true account; its editable record is the CURRENT role's (student), not the trainer one.
  const d = await admin().getUserDetail(X.STALE);
  assert.equal(d.user.id, X.STALE);
  assert.equal(d.user.role, "student");
  assert.equal(d.contact.kind, "student", "Edit trainer is therefore not offered for this row");
  assert.equal((await row("STALE")).name, "TEP Stale Trainer", "the old trainer record is untouched");
});
