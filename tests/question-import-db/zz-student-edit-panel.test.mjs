// Phase 7 P3.11-D — Students list "Edit" opens the Users account panel's existing student details form
// (/admin/users?user=<id>&edit=details). This drives the real users repository + service exactly as that form
// does (each caller's OWN session, never the service role): the selected student loads with their stored values,
// a valid save goes through admin_update_student and is audited, invalid input and non-Super-Admin callers are
// refused, a suspended student is edited WITHOUT being reactivated, enrolments / attendance are untouched, and a
// stale student record (account role since changed) is detectable and never edited as a student. Own fixtures (sep_*).
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
    getCurrentUser: async () => ({ id: uid, email: "x@sep.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
  });
const admin = () => svcAs(ids.A, "admin");
const row = (k) =>
  db.admin(`select json_build_object('name', s.full_name, 'phone', d.phone, 'org', d.organization, 'des', d.designation, 'email', d.email,
              'status', p.account_status, 'role', p.role,
              'enrolments', (select count(*) from public.batch_students b where b.student_id = s.id),
              'attendance', (select count(*) from public.class_attendance a where a.student_id = s.id))
              from public.students s join public.profiles p on p.id = s.id left join public.student_details d on d.student_id = s.id
             where s.id = '${X[k]}'`);

before(async () => {
  for (const k of ["S", "S_SUS", "STALE", "T"]) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${["S", "S_SUS", "STALE", "T"].map((k) => `(${q(X[k])}, '${k.toLowerCase()}@sep.test')`).join(", ")};
    update public.profiles set role = 'student', account_status = 'active' where id in (${q(X.S)}, ${q(X.S_SUS)}, ${q(X.STALE)});
    update public.profiles set role = 'trainer', account_status = 'active' where id = ${q(X.T)};
    insert into public.trainers (id, trainer_code, full_name) values (${q(X.T)}, 'SEP-T', 'SEP Trainer');
    insert into public.students (id, student_code, full_name) values
      (${q(X.S)}, 'SEP-S', 'Test Student Updated'), (${q(X.S_SUS)}, 'SEP-SS', 'SEP Suspended'), (${q(X.STALE)}, 'SEP-STALE', 'SEP Stale Student');
    insert into public.student_details (student_id, email, phone, organization, designation) values
      (${q(X.S)}, 'student@sep.test', '+91 22222', null, null), (${q(X.S_SUS)}, 'sus@sep.test', null, null, null);
    -- The real stale case: the account's role changes to trainer; the database retires the student record (inactive).
    update public.profiles set role = 'trainer' where id = ${q(X.STALE)};
    insert into public.trainers (id, trainer_code, full_name) values (${q(X.STALE)}, 'SEP-STALE-T', 'SEP Stale As Trainer');`, ids.A);
  await db.exec(`
    set session_replication_role = replica;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values (${q(id("B"))}, 'SEP-B', t.id('C1'), ${q(X.T)}, 'SEP batch', '2026-01-01', '2027-12-31', 'ongoing', 30);
    insert into public.batch_students (batch_id, student_id) values (${q(X.B)}, ${q(X.S)});
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status)
      values (${q(id("K"))}, t.id('C1'), ${q(X.B)}, ${q(X.T)}, 'SEP held', '2026-02-10', '09:00', '10:00', 'completed');
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values (${q(X.K)}, ${q(X.S)}, ${q(X.B)}, 'present', ${q(X.T)});
    set session_replication_role = origin;`);
  const r = await as(ids.A).rpc("admin_set_account_status", { p_user_id: X.S_SUS, p_status: "suspended", p_reason: "test fixture" });
  assert.equal(r.data?.ok, true, JSON.stringify(r));
});

test("the selected student's panel offers editing and pre-populates the form with the stored values", async () => {
  const d = await admin().getUserDetail(X.S);
  assert.equal(d.user.id, X.S, "the selected account, not another one");
  assert.equal(d.user.role, "student");
  assert.equal(d.actions.editDetails, true, "the panel shows Edit (and &edit=details opens the form)");
  assert.deepEqual(d.contact, { kind: "student", fields: { fullName: "Test Student Updated", phone: "+91 22222", organization: null, designation: null } });
});

test("Save: valid changes persist through admin_update_student; audited; role, status, email, enrolment and attendance untouched", async () => {
  const before = await row("S");
  const message = await admin().updateDetails(X.S, { fullName: "Test Student Updated", phone: "+91 22222", organization: "ARSENE", designation: "Engineer" });
  assert.equal(message, "Details saved.");
  assert.deepEqual(await row("S"), { ...before, org: "ARSENE", des: "Engineer" });
  // The refreshed panel (as after router.refresh) shows the new values and the history entry.
  const d = await admin().getUserDetail(X.S);
  assert.deepEqual(d.contact.fields, { fullName: "Test Student Updated", phone: "+91 22222", organization: "ARSENE", designation: "Engineer" });
  const ev = await db.admin(`select detail from public.user_admin_events where target_user_id = '${X.S}' and event_type = 'user_details_changed' order by id desc limit 1`);
  assert.deepEqual([...ev.fields].sort(), ["designation", "organization"], "only the changed fields, never their values");
  assert.ok(d.history.length > 0, "Account history has the entry");
});

test("invalid input and no-op saves are refused before any change", async () => {
  const before = await row("S");
  await assert.rejects(admin().updateDetails(X.S, { fullName: "   " }), UsersActionError);
  await assert.rejects(admin().updateDetails(X.S, { fullName: "Test Student Updated", designation: "d".repeat(201) }), UsersActionError);
  await assert.rejects(admin().updateDetails(X.S, { fullName: "Test Student Updated", phone: "+91 22222", organization: "ARSENE", designation: "Engineer", role: "super_admin" }), /Nothing changed/);
  assert.deepEqual(await row("S"), before);
});

test("authorization: trainers and students are refused by the service and by the database; nothing changes", async () => {
  const before = await row("S");
  await assert.rejects(svcAs(X.T, "trainer").getUserDetail(X.S), UsersAuthorizationError);
  await assert.rejects(svcAs(X.T, "trainer").updateDetails(X.S, { fullName: "HACKED" }), UsersAuthorizationError);
  await assert.rejects(svcAs(X.S, "student").updateDetails(X.S, { fullName: "HACKED" }), UsersAuthorizationError);
  const direct = await as(X.T).rpc("admin_update_student", { p_student_id: X.S, p: { full_name: "HACKED" } });
  assert.equal(direct.error?.code, "42501");
  assert.deepEqual(await row("S"), before);
});

test("suspended student: editable, but saving never reactivates the account", async () => {
  const d = await admin().getUserDetail(X.S_SUS);
  assert.equal(d.user.accountStatus, "suspended");
  assert.equal(d.actions.editDetails, true);
  assert.equal(await admin().updateDetails(X.S_SUS, { fullName: "SEP Suspended", phone: "+91 33333" }), "Details saved.");
  const after = await row("S_SUS");
  assert.equal(after.phone, "+91 33333");
  assert.equal(after.status, "suspended");
});

test("stale student record (account role since changed): detectable in the list; never edited as a student", async () => {
  const list = await as(ids.A).from("students").select("id, status, profiles!students_id_fkey ( account_status, role )").eq("id", X.STALE);
  assert.deepEqual(list.data, [{ id: X.STALE, status: "inactive", profiles: { account_status: "active", role: "trainer" } }]);
  const d = await admin().getUserDetail(X.STALE);
  assert.equal(d.contact.kind, "trainer", "the panel edits the current role's record — the Students list therefore offers no Edit here");
  assert.equal((await row("STALE")).name, "SEP Stale Student", "the old student record is untouched");
});
