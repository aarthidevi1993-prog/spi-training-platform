// Phase 7 P3.11-B — Remove student / trainer = deactivate (suspend) through the existing 0017/0018
// admin_set_account_status, via the real users repository + service on each caller's OWN session (never the
// service role). Nothing is deleted: the Auth user, profile, record and every training / audit row stay; the
// account can no longer sign in. A trainer with current batches or scheduled/live classes is refused until
// they are reassigned (admin_assign_batch_trainer; classes follow the batch). Own fixtures only (ar_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createUsersRepository } = await import(`${build}/repositories/users.repository.core.mjs`);
const { createUsersService, UsersAuthorizationError, UsersActionError } = await import(`${build}/services/users.service.core.mjs`);
const { fetchProfileRole } = await import(`${build}/lib/auth/profile-role.mjs`);

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => `'${v}'`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const svcAs = (uid, role) =>
  createUsersService({
    repository: createUsersRepository(async () => as(uid)),
    getCurrentUser: async () => ({ id: uid, email: "x@ar.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
  });
const admin = () => svcAs(ids.A, "admin");
const status = (k) => db.admin(`select account_status from public.profiles where id = '${X[k]}'`);
const counts = (k) =>
  db.admin(`select json_build_object(
    'profile', (select count(*) from public.profiles where id = '${X[k]}'),
    'auth', (select count(*) from auth.users where id = '${X[k]}'),
    'student', (select count(*) from public.students where id = '${X[k]}'),
    'trainer', (select count(*) from public.trainers where id = '${X[k]}'),
    'enrolments', (select count(*) from public.batch_students where student_id = '${X[k]}'),
    'attendance', (select count(*) from public.class_attendance where student_id = '${X[k]}'),
    'batches_run', (select count(*) from public.batches where trainer_id = '${X[k]}'),
    'classes_taught', (select count(*) from public.classes where trainer_id = '${X[k]}'))`);
const lastStatusEvent = (k) =>
  db.admin(`select json_build_object('actor', actor_id, 'detail', detail) from public.user_admin_events
             where target_user_id = '${X[k]}' and event_type = 'account_status_changed' order by id desc limit 1`);
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

before(async () => {
  const people = ["S", "S_INV", "T_BUSY", "T_OLD", "T_NEW"];
  for (const k of people) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${people.map((k) => `(${q(X[k])}, '${k.toLowerCase()}@ar.test')`).join(", ")};
    update public.profiles set role = 'student', account_status = 'active' where id = ${q(X.S)};
    update public.profiles set role = 'student' where id = ${q(X.S_INV)};
    update public.profiles set role = 'trainer', account_status = 'active' where id in (${q(X.T_BUSY)}, ${q(X.T_OLD)}, ${q(X.T_NEW)});
    insert into public.students (id, student_code, full_name) values (${q(X.S)}, 'AR-S', 'AR Student'), (${q(X.S_INV)}, 'AR-SI', 'AR Invited');
    insert into public.trainers (id, trainer_code, full_name) values
      (${q(X.T_BUSY)}, 'AR-TB', 'AR Busy'), (${q(X.T_OLD)}, 'AR-TO', 'AR Old'), (${q(X.T_NEW)}, 'AR-TN', 'AR New');`, ids.A);
  await db.exec(`
    set session_replication_role = replica;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (${q(id("B_CUR"))}, 'AR-BC', t.id('C1'), ${q(X.T_BUSY)}, 'AR current', '2026-01-01', '2027-12-31', 'ongoing',   30),
      (${q(id("B_DONE"))}, 'AR-BD', t.id('C1'), ${q(X.T_OLD)}, 'AR done',    '2025-01-01', '2025-06-30', 'completed', 30);
    insert into public.batch_students (batch_id, student_id) values (${q(X.B_CUR)}, ${q(X.S)});
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      (${q(id("K_SCHED"))}, t.id('C1'), ${q(X.B_CUR)}, ${q(X.T_BUSY)}, 'AR scheduled', '2027-01-10', '09:00', '10:00', 'scheduled'),
      (${q(id("K_HELD"))},  t.id('C1'), ${q(X.B_CUR)}, ${q(X.T_BUSY)}, 'AR held',      '2026-02-10', '09:00', '10:00', 'completed'),
      (${q(id("K_OLD"))},   t.id('C1'), ${q(X.B_DONE)}, ${q(X.T_OLD)}, 'AR old',       '2025-02-10', '09:00', '10:00', 'completed');
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values (${q(X.K_HELD)}, ${q(X.S)}, ${q(X.B_CUR)}, 'present', ${q(X.T_BUSY)});
    set session_replication_role = origin;`);
});

test("student: Remove deactivates (suspended), sign-in is refused, every record is kept; audited with the reason", async () => {
  const before = await counts("S");
  assert.equal(await quiet(() => fetchProfileRole(as(X.S), X.S)), "student", "can sign in before");
  const message = await admin().removeStudent(X.S);
  assert.match(message, /Student removed\./);
  assert.equal(await status("S"), "suspended");
  assert.equal(await quiet(() => fetchProfileRole(as(X.S), X.S)), null, "the session role lookup now refuses sign-in");
  assert.equal(await db.client({ role: "authenticated", userId: X.S }).sql("select public.current_app_role()").then((r) => r.data), null, "no role → no RLS access");
  assert.deepEqual(await counts("S"), before, "Auth user, profile, record, enrolment and attendance all kept");
  assert.deepEqual(await lastStatusEvent("S"), { actor: ids.A, detail: { from: "active", to: "suspended", reason: "Removed from the Students list" } });
  await assert.rejects(admin().removeStudent(X.S), /already been removed/);
});

test("the target's role must match the list; invited accounts and your own account are refused; nothing changes", async () => {
  await assert.rejects(admin().removeTrainer(X.S_INV), /This account is not a trainer/);
  await assert.rejects(admin().removeStudent(X.T_NEW), /This account is not a student/);
  await assert.rejects(admin().removeStudent(X.S_INV), /hasn't accepted its invitation yet/);
  assert.equal(await status("S_INV"), "invited");
  assert.equal(await status("T_NEW"), "active");
  await assert.rejects(admin().removeTrainer(ids.A), /You can't remove your own account\./);
  await assert.rejects(admin().removeStudent(randomUUID()), /no longer exists/);
});

test("trainer with current work: refused with the counts until reassigned; then removed; history kept", async () => {
  await assert.rejects(admin().removeTrainer(X.T_BUSY), (err) => err instanceof UsersActionError && /1 current batch \(upcoming or ongoing\) and 1 scheduled or live class\b/.test(err.message));
  assert.equal(await status("T_BUSY"), "active", "nothing changed");

  // Reassign through the existing mechanism (Super Admin session); the scheduled class follows the batch.
  const r = await as(ids.A).rpc("admin_assign_batch_trainer", { p_batch_id: X.B_CUR, p_trainer_id: X.T_NEW });
  assert.equal(r.data?.ok, true, JSON.stringify(r));
  assert.equal(await db.admin(`select trainer_id from public.classes where id = '${X.K_SCHED}'`), X.T_NEW, "scheduled class moved with the batch");
  assert.equal(await db.admin(`select trainer_id from public.classes where id = '${X.K_HELD}'`), X.T_BUSY, "the held class stays attributed (history)");

  assert.match(await admin().removeTrainer(X.T_BUSY), /Trainer removed\./);
  assert.equal(await status("T_BUSY"), "suspended");
  assert.deepEqual(await counts("T_BUSY"), { profile: 1, auth: 1, student: 0, trainer: 1, enrolments: 0, attendance: 0, batches_run: 0, classes_taught: 1 });
  assert.equal(await db.admin(`select count(*) from public.class_attendance where marked_by = '${X.T_BUSY}'`), 1, "attendance they marked is kept");
  assert.deepEqual((await lastStatusEvent("T_BUSY")).detail, { from: "active", to: "suspended", reason: "Removed from the Trainers list" });
});

test("trainer with only finished batches / completed classes: not blocked; removed; their history keeps pointing at them", async () => {
  assert.match(await admin().removeTrainer(X.T_OLD), /Trainer removed\./);
  assert.equal(await status("T_OLD"), "suspended");
  assert.equal(await db.admin(`select trainer_id from public.batches where id = '${X.B_DONE}'`), X.T_OLD);
  assert.equal(await db.admin(`select trainer_id from public.classes where id = '${X.K_OLD}'`), X.T_OLD);
});

test("only an active Super Admin: trainers and students are refused by the service and by the database itself", async () => {
  await assert.rejects(svcAs(X.T_NEW, "trainer").removeStudent(X.S_INV), UsersAuthorizationError);
  await assert.rejects(svcAs(X.T_NEW, "trainer").removeTrainer(X.T_NEW), UsersAuthorizationError);
  const direct = await as(X.T_NEW).rpc("admin_set_account_status", { p_user_id: X.S_INV, p_status: "suspended", p_reason: null });
  assert.equal(direct.error?.code, "42501", "the database refuses a trainer's direct call");
  assert.equal(await status("S_INV"), "invited");
});

test("lists: the Super Admin reads each record's account status through the profile embed (suspended = removed)", async () => {
  const s = await as(ids.A).from("students").select("id, profiles!students_id_fkey ( account_status )").eq("id", X.S);
  assert.deepEqual(s.data, [{ id: X.S, profiles: { account_status: "suspended" } }]);
  const t = await as(ids.A).from("trainers").select("id, profiles!trainers_id_fkey ( account_status )").eq("id", X.T_NEW);
  assert.deepEqual(t.data, [{ id: X.T_NEW, profiles: { account_status: "active" } }]);
  // The trainer's Students list uses the same select: it still loads; the embedded profile is whatever RLS allows.
  const own = await as(X.T_NEW).from("students").select("id, status, profiles!students_id_fkey ( account_status )").eq("id", X.S);
  assert.equal(own.error, null, JSON.stringify(own.error));
  assert.ok(Array.isArray(own.data));
  assert.ok(own.data.every((row) => row.profiles === null || typeof row.profiles.account_status === "string"));
});
