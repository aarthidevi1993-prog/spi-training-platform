// Phase 7 P3.8 slice 1 — the enrolment application layer (real repository + service) against the
// real database with 0001–0023, each caller through their OWN session client. Reads (header, roster,
// history, candidates) are RLS-scoped; writes go only through admin_set_enrollment /
// trainer_enroll_student; every outcome is a fixed sentence. Own fixtures only (ea_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createEnrollmentRepository } = await import(`${build}/repositories/enrollment.repository.core.mjs`);
const { createEnrollmentService, EnrollmentAuthorizationError } = await import(`${build}/services/enrollment.service.core.mjs`);
const lib = await import(`${build}/lib/enrollments/enrollment.mjs`);

let U = {};
/** The service exactly as wired in the app, for a given signed-in user (id + application role). */
const svcAs = (key, role) =>
  createEnrollmentService({
    repository: createEnrollmentRepository(async () => db.client({ role: "authenticated", userId: U[key] ?? ids[key] })),
    getCurrentUser: async () => ({ id: U[key] ?? ids[key], email: `${key}@ea.test`, fullName: key, role, isActive: true, createdAt: "2026-01-01" }),
  });
const admin = () => svcAs("A", "admin");
const statusOf = (b, s) => db.admin(`select enrollment_status from public.batch_students where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const quiet = async (fn) => {
  const saved = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = saved; }
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ea_' || k, gen_random_uuid()
      from unnest(array['TR','TR2','C','B1','B2','BC','BX','S1','S2','S3','SUS','INA','WD']) k;
    insert into auth.users (id, email) select v, lower(k) || '@ea.test' from t.ids
     where k in ('ea_TR','ea_TR2','ea_S1','ea_S2','ea_S3','ea_SUS','ea_INA','ea_WD');
    update public.profiles set account_status = 'active'
     where id in (select v from t.ids where k in ('ea_TR','ea_TR2','ea_S1','ea_S2','ea_S3','ea_SUS','ea_INA','ea_WD'));
    update public.profiles set role = 'trainer' where id in (t.id('ea_TR'), t.id('ea_TR2'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ea_TR'), 'EA-TR', 'EA Trainer'), (t.id('ea_TR2'), 'EA-TR2', 'EA Other Trainer');
    insert into public.students (id, student_code, full_name)
      select v, upper(k), 'EA ' || substr(k, 4) from t.ids where k in ('ea_S1','ea_S2','ea_S3','ea_SUS','ea_INA','ea_WD');
    insert into public.courses (id, course_code, title, level) values (t.id('ea_C'), 'EA-101', 'Enrolment App', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('ea_B1'), 'EA-B1', t.id('ea_C'), t.id('ea_TR'),  'EA one',       '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('ea_B2'), 'EA-B2', t.id('ea_C'), t.id('ea_TR'),  'EA two',       '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('ea_BC'), 'EA-BC', t.id('ea_C'), t.id('ea_TR'),  'EA completed', '2025-01-01', '2025-06-30', 'completed', 10),
      (t.id('ea_BX'), 'EA-BX', t.id('ea_C'), t.id('ea_TR2'), 'EA other',     '2026-01-01', '2026-12-31', 'ongoing',   10);
    -- B1 roster (fixture, privileged): S1, SUS and WD are the trainer's current students.
    insert into public.batch_students (batch_id, student_id) select t.id('ea_B1'), v from t.ids where k in ('ea_S1','ea_SUS','ea_WD');
    update public.profiles set account_status = 'suspended' where id = t.id('ea_SUS');
    update public.students set status = 'inactive' where id = t.id('ea_INA');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
  await setupSlice3B(); // after the ea_* fixture (root before hooks run concurrently)
});

// Slice 3B fixtures (ea3_*): their own batches and students, so the earlier tests are unaffected.
async function setupSlice3B() {
  await db.exec(`
    insert into t.ids (k, v) select 'ea3_' || k, gen_random_uuid()
      from unnest(array['BW','BF','BCC','BXX','CL','W1','C1','F1','F2','F3','SUS','INA','X1','X2','ATT','DONE']) k;
    insert into auth.users (id, email) select v, lower(k) || '@ea.test' from t.ids
     where k in ('ea3_W1','ea3_C1','ea3_F1','ea3_F2','ea3_F3','ea3_SUS','ea3_INA','ea3_X1','ea3_X2','ea3_ATT','ea3_DONE');
    update public.profiles set account_status = 'active'
     where id in (select v from t.ids where k in ('ea3_W1','ea3_C1','ea3_F1','ea3_F2','ea3_F3','ea3_SUS','ea3_INA','ea3_X1','ea3_X2','ea3_ATT','ea3_DONE'));
    insert into public.students (id, student_code, full_name)
      select v, upper(k), 'EA3 ' || substr(k, 5) from t.ids where k in ('ea3_W1','ea3_C1','ea3_F1','ea3_F2','ea3_F3','ea3_SUS','ea3_INA','ea3_X1','ea3_X2','ea3_ATT','ea3_DONE');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('ea3_BW'),  'EA3-BW',  t.id('ea_C'), t.id('ea_TR'), 'EA3 status',    '2026-01-01', '2026-12-31', 'ongoing', 10),
      (t.id('ea3_BF'),  'EA3-BF',  t.id('ea_C'), t.id('ea_TR'), 'EA3 full',      '2026-01-01', '2026-12-31', 'ongoing', 2),
      (t.id('ea3_BCC'), 'EA3-BCC', t.id('ea_C'), t.id('ea_TR'), 'EA3 completed', '2025-01-01', '2025-06-30', 'ongoing', 10),
      (t.id('ea3_BXX'), 'EA3-BXX', t.id('ea_C'), t.id('ea_TR'), 'EA3 cancelled', '2026-01-01', '2026-12-31', 'ongoing', 10);
    -- Fixture rows (privileged) in the batches that then end / are cancelled.
    insert into public.batch_students (batch_id, student_id) values
      (t.id('ea3_BCC'), t.id('ea3_DONE')), (t.id('ea3_BXX'), t.id('ea3_X1')), (t.id('ea3_BXX'), t.id('ea3_X2'));
    update public.batch_students set enrollment_status = 'withdrawn'
     where (batch_id, student_id) in ((t.id('ea3_BCC'), t.id('ea3_DONE')), (t.id('ea3_BXX'), t.id('ea3_X2')));
    update public.batches set status = 'completed' where id = t.id('ea3_BCC');
    update public.batches set status = 'cancelled' where id = t.id('ea3_BXX');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
}

test("Super Admin: batch detail from the database — header, roster, seats, and only AVAILABLE students as candidates", async () => {
  const d = await quiet(() => admin().getBatchDetail(U.ea_B2));
  assert.equal(d.mode, "admin");
  assert.deepEqual([d.batch.code, d.batch.name, d.batch.status, d.batch.course, d.batch.trainerId, d.batch.trainerName, d.batch.maxSeats], ["EA-B2", "EA two", "ongoing", "Enrolment App", U.ea_TR, "EA Trainer", 10]);
  assert.deepEqual(d.roster, []);
  assert.equal(d.canEnrol, true);
  const ids2 = d.candidates.map((c) => c.id);
  for (const k of ["ea_S1", "ea_S2", "ea_S3", "ea_WD"]) assert.ok(ids2.includes(U[k]), `${k} offered`);
  for (const k of ["ea_SUS", "ea_INA", "ea_TR"]) assert.ok(!ids2.includes(U[k]), `${k} not offered`);
});

test("Super Admin: enrol → duplicate refused → withdraw → re-enrol → complete; history and seats follow; fixed sentences", async () => {
  const a = admin();
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "enrolled", "Joined"), { ok: true, message: "Student enrolled." });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.unchanged });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "withdrawn", "Moved"), { ok: true, message: "Enrolment withdrawn." });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "completed", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.transition_not_allowed });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "enrolled", null), { ok: true, message: "Student re-enrolled." });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S2, "completed", null), { ok: true, message: "Enrolment marked as completed." });
  assert.equal(await statusOf("ea_B2", "ea_S2"), "completed");

  const d = await quiet(() => a.getBatchDetail(U.ea_B2));
  assert.deepEqual(d.roster.map((r) => [r.studentId, r.enrollmentStatus, r.studentCode]), [[U.ea_S2, "completed", "EA_S2"]]);
  assert.equal(d.seatsUsed, 1);
  assert.ok(!d.candidates.some((c) => c.id === U.ea_S2), "already in this batch → not a candidate");
  assert.deepEqual(d.history.map((h) => [h.previousStatus, h.newStatus, h.source, h.sourceLabel, h.reason]), [
    ["enrolled", "completed", "admin", "Super Admin", null],
    ["withdrawn", "enrolled", "admin", "Super Admin", null],
    ["enrolled", "withdrawn", "admin", "Super Admin", "Moved"],
    [null, "enrolled", "admin", "Super Admin", "Joined"],
  ], "newest first");
});

test("Super Admin: database refusals come back as fixed sentences (unavailable student, completed batch, unknown batch)", async () => {
  const a = admin();
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_SUS, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.student_not_available });
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_INA, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.student_not_available });
  assert.deepEqual(await a.setEnrollment(U.ea_BC, U.ea_S3, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.batch_not_current });
  assert.deepEqual(await a.setEnrollment("00000000-0000-4000-8000-000000000000", U.ea_S3, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.not_found });
  assert.equal(await statusOf("ea_B2", "ea_SUS"), null, "nothing written");
  // Withdrawing a now-unavailable student stays possible (0023).
  assert.deepEqual(await a.setEnrollment(U.ea_B1, U.ea_SUS, "withdrawn", "Suspended"), { ok: true, message: "Enrolment withdrawn." });
});

test("Trainer: own batch only; roster without withdrawn rows (RLS); history; in-scope candidates; enrol through trainer_enroll_student", async () => {
  const t = svcAs("ea_TR", "trainer");
  assert.equal(await quiet(() => t.getBatchDetail(U.ea_BX)), null, "another trainer's batch");
  const d = await quiet(() => t.getBatchDetail(U.ea_B2));
  assert.equal(d.mode, "trainer");
  assert.ok(d.roster.every((r) => r.enrollmentStatus !== "withdrawn"));
  assert.ok(d.roster.every((r) => !r.actions.withdraw && !r.actions.complete && !r.actions.reEnrol), "no admin actions for trainers");
  assert.ok(d.history.length > 0, "history of a batch they currently teach");
  // Candidates: their current students in OTHER current batches (B1: S1, WD — SUS was withdrawn above).
  assert.deepEqual(d.candidates.map((c) => c.id).sort(), [U.ea_S1, U.ea_WD].sort());
  assert.deepEqual(await t.trainerEnrol(U.ea_B2, U.ea_S1), { ok: true, message: "Student enrolled." });
  assert.equal(await statusOf("ea_B2", "ea_S1"), "enrolled");
  assert.deepEqual(await t.trainerEnrol(U.ea_B2, U.ea_S1), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.unchanged });
  const ev = await db.admin(`select json_agg(source order by id) from public.enrollment_events where batch_id = '${U.ea_B2}' and student_id = '${U.ea_S1}'`);
  assert.deepEqual(ev, ["trainer"]);
});

test("Trainer: out-of-scope student or batch → the fixed scope sentence (database 42501); unavailable in-scope student → student_not_available", async () => {
  const t = svcAs("ea_TR", "trainer");
  assert.deepEqual(await quiet(() => t.trainerEnrol(U.ea_B2, U.ea_S3)), { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR }, "S3 is not their student");
  assert.deepEqual(await quiet(() => t.trainerEnrol(U.ea_BX, U.ea_S1)), { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR }, "BX is not their batch");
  // WD is in scope (enrolled in B1); suspend it → the database refuses with student_not_available.
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('ea_WD');`);
  assert.deepEqual(await t.trainerEnrol(U.ea_B2, U.ea_WD), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.student_not_available });
  await db.exec(`update public.profiles set account_status = 'active' where id = t.id('ea_WD');`);
  assert.equal(await statusOf("ea_B2", "ea_WD"), null);
});

test("the database stays the authority: a wrongly resolved role is still refused (42501 → fixed sentence); students are refused by the service", async () => {
  assert.deepEqual(await quiet(() => svcAs("ea_TR", "admin").setEnrollment(U.ea_B2, U.ea_S3, "enrolled", null)), { ok: false, error: lib.ENROLLMENT_ADMIN_ONLY_ERROR });
  assert.equal(await statusOf("ea_B2", "ea_S3"), null);
  await assert.rejects(svcAs("ea_S1", "student").getBatchDetail(U.ea_B2), EnrollmentAuthorizationError);
  await assert.rejects(svcAs("ea_S1", "student").setEnrollment(U.ea_B2, U.ea_S3, "enrolled", null), EnrollmentAuthorizationError);
  // Every enrolment change in this file went through the functions (no 'direct' rows for these batches).
  assert.equal(await db.admin(`select count(*) from public.enrollment_events where batch_id in ('${U.ea_B2}', '${U.ea_BX}', '${U.ea_BC}') and source = 'direct'`), 0);
});

test("slice 2 read model: the Super Admin roster shows every status including withdrawn; a trainer's roster of the same batch does not (RLS)", async () => {
  // ea_SUS was withdrawn from B1 above (through the function).
  const adminView = await quiet(() => admin().getBatchDetail(U.ea_B1));
  const row = adminView.roster.find((r) => r.studentId === U.ea_SUS);
  assert.deepEqual([row?.enrollmentStatus, row?.studentCode, row?.studentName], ["withdrawn", "EA_SUS", "EA SUS"]);
  assert.ok(adminView.history.some((h) => h.studentId === U.ea_SUS && h.newStatus === "withdrawn" && h.reason === "Suspended"));
  assert.equal(adminView.seatsUsed, adminView.roster.filter((r) => r.enrollmentStatus !== "withdrawn").length, "seats exclude withdrawn");
  const trainerView = await quiet(() => svcAs("ea_TR", "trainer").getBatchDetail(U.ea_B1));
  assert.ok(!trainerView.roster.some((r) => r.studentId === U.ea_SUS), "trainers do not see withdrawn enrolments");
  assert.equal(await quiet(() => admin().getBatchDetail("00000000-0000-4000-8000-000000000000")), null, "unknown batch → null (page: 404)");
});

test("slice 3A: after an enrolment through the service, the re-read detail shows the student enrolled, seats +1, the candidate gone and the history row", async () => {
  const a = admin();
  const before = await quiet(() => a.getBatchDetail(U.ea_B2));
  assert.ok(before.candidates.some((c) => c.id === U.ea_S3), "S3 offered before");
  assert.ok(before.candidates.every((c) => Object.keys(c).sort().join(",") === "code,id,name"), "candidates carry id, code and name only");
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S3, "enrolled", "Added from batch detail"), { ok: true, message: "Student enrolled." });
  const after = await quiet(() => a.getBatchDetail(U.ea_B2));
  const row = after.roster.find((r) => r.studentId === U.ea_S3);
  assert.equal(row?.enrollmentStatus, "enrolled");
  assert.ok(row?.enrolledAt, "enrolled date present");
  assert.equal(after.seatsUsed, before.seatsUsed + 1);
  assert.ok(!after.candidates.some((c) => c.id === U.ea_S3), "no longer offered");
  assert.deepEqual([after.history[0].studentId, after.history[0].previousStatus, after.history[0].newStatus, after.history[0].sourceLabel, after.history[0].reason],
    [U.ea_S3, null, "enrolled", "Super Admin", "Added from batch detail"]);
  // A second attempt for the same student (e.g. a double submit) is refused by the database with the fixed sentence.
  assert.deepEqual(await a.setEnrollment(U.ea_B2, U.ea_S3, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.unchanged });
});

// ---------------------------------------------------------------- slice 3B: withdraw / complete / re-enrol

const row3 = (b, s) => db.admin(`select json_build_object('n', count(*), 'status', max(enrollment_status::text), 'enrolled_at', max(enrolled_at), 'created_at', max(created_at), 'completed_at', max(completed_at))
  from public.batch_students where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const history3 = (b, s) => db.admin(`select coalesce(json_agg(json_build_object('prev', previous_status, 'new', new_status, 'source', source, 'reason', reason, 'actor', actor_id) order by id), '[]')
  from public.enrollment_events where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const detail3 = (b) => quiet(() => admin().getBatchDetail(U[b]));
const NONE3 = { enrol: false, reEnrol: false, withdraw: false, complete: false };

test("slice 3B withdraw: enrolled → withdrawn, seat freed, history row with reason, source admin and the Super Admin as actor; re-enrol offered", async () => {
  const a = admin();
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_W1, "enrolled", "Joined"), { ok: true, message: "Student enrolled." });
  const before3 = await detail3("ea3_BW");
  assert.deepEqual(before3.roster.find((r) => r.studentId === U.ea3_W1).actions, { ...NONE3, withdraw: true, complete: true });
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_W1, "withdrawn", "Left the course"), { ok: true, message: "Enrolment withdrawn." });
  const after3 = await detail3("ea3_BW");
  const r = after3.roster.find((x) => x.studentId === U.ea3_W1);
  assert.equal(r.enrollmentStatus, "withdrawn");
  assert.deepEqual(r.actions, { ...NONE3, reEnrol: true });
  assert.equal(after3.seatsUsed, before3.seatsUsed - 1, "seat freed");
  assert.deepEqual([after3.history[0].studentId, after3.history[0].previousStatus, after3.history[0].newStatus, after3.history[0].sourceLabel, after3.history[0].reason],
    [U.ea3_W1, "enrolled", "withdrawn", "Super Admin", "Left the course"]);
  assert.deepEqual((await history3("ea3_BW", "ea3_W1")).at(-1), { prev: "enrolled", new: "withdrawn", source: "admin", reason: "Left the course", actor: ids.A });
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_W1, "withdrawn", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.unchanged }, "withdraw twice");
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_W1, "completed", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.transition_not_allowed }, "complete a withdrawn student");
});

test("slice 3B re-enrol: withdrawn → enrolled on the SAME row, original enrolled_at kept, history keeps the withdrawal, seat taken again", async () => {
  const a = admin();
  const rowBefore = await row3("ea3_BW", "ea3_W1");
  const seatsBefore = (await detail3("ea3_BW")).seatsUsed;
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_W1, "enrolled", "Came back"), { ok: true, message: "Student re-enrolled." });
  const rowAfter = await row3("ea3_BW", "ea3_W1");
  assert.equal(rowAfter.n, 1, "one batch_students row (updated, not inserted)");
  assert.equal(rowAfter.status, "enrolled");
  assert.equal(rowAfter.enrolled_at, rowBefore.enrolled_at, "original enrolment date kept");
  assert.equal(rowAfter.created_at, rowBefore.created_at, "same row");
  assert.equal(rowAfter.completed_at, null);
  assert.deepEqual((await history3("ea3_BW", "ea3_W1")).map((h) => [h.prev, h.new, h.source, h.reason]), [
    [null, "enrolled", "admin", "Joined"],
    ["enrolled", "withdrawn", "admin", "Left the course"],
    ["withdrawn", "enrolled", "admin", "Came back"],
  ], "the whole history is preserved");
  const d = await detail3("ea3_BW");
  assert.equal(d.seatsUsed, seatsBefore + 1);
  assert.deepEqual(d.roster.find((r) => r.studentId === U.ea3_W1).actions, { ...NONE3, withdraw: true, complete: true });
});

test("slice 3B complete: enrolled → completed with completed_at, seats unchanged, final (repeat unchanged; withdraw / re-enrol refused)", async () => {
  const a = admin();
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_C1, "enrolled", null), { ok: true, message: "Student enrolled." });
  const seatsBefore = (await detail3("ea3_BW")).seatsUsed;
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_C1, "completed", "Finished"), { ok: true, message: "Enrolment marked as completed." });
  const row = await row3("ea3_BW", "ea3_C1");
  assert.equal(row.status, "completed");
  assert.ok(row.completed_at, "completed_at set");
  const d = await detail3("ea3_BW");
  assert.equal(d.seatsUsed, seatsBefore, "a completed enrolment keeps its seat");
  const r = d.roster.find((x) => x.studentId === U.ea3_C1);
  assert.ok(r.completedAt, "completed date shown");
  assert.deepEqual(r.actions, NONE3, "no action for a completed enrolment");
  assert.deepEqual((await history3("ea3_BW", "ea3_C1")).at(-1), { prev: "enrolled", new: "completed", source: "admin", reason: "Finished", actor: ids.A });
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_C1, "completed", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.unchanged });
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_C1, "withdrawn", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.transition_not_allowed });
  assert.deepEqual(await a.setEnrollment(U.ea3_BW, U.ea3_C1, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.transition_not_allowed });
  assert.equal((await row3("ea3_BW", "ea3_C1")).status, "completed");
  assert.equal((await history3("ea3_BW", "ea3_C1")).length, 2, "refusals write no history");
});

test("slice 3B full batch: withdrawing in a full batch is allowed; re-enrol after the freed seat was taken → batch_full, nothing changes", async () => {
  const a = admin();
  assert.equal((await a.setEnrollment(U.ea3_BF, U.ea3_F1, "enrolled", null)).ok, true);
  assert.equal((await a.setEnrollment(U.ea3_BF, U.ea3_F2, "enrolled", null)).ok, true);
  assert.equal((await detail3("ea3_BF")).seatsUsed, 2, "full (2/2)");
  assert.deepEqual(await a.setEnrollment(U.ea3_BF, U.ea3_F1, "withdrawn", null), { ok: true, message: "Enrolment withdrawn." }, "withdraw in a full batch");
  assert.deepEqual(await a.setEnrollment(U.ea3_BF, U.ea3_F3, "enrolled", null), { ok: true, message: "Student enrolled." }, "another student takes the freed seat");
  const events = (await history3("ea3_BF", "ea3_F1")).length;
  assert.deepEqual(await a.setEnrollment(U.ea3_BF, U.ea3_F1, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.batch_full });
  assert.equal((await row3("ea3_BF", "ea3_F1")).status, "withdrawn", "no mutation");
  assert.equal((await history3("ea3_BF", "ea3_F1")).length, events, "no history row");
  const d = await detail3("ea3_BF");
  assert.equal(d.seatsUsed, 2);
  assert.equal(d.roster.find((r) => r.studentId === U.ea3_F1).actions.reEnrol, true, "re-enrol stays offered; the database decides");
});

test("slice 3B availability: a withdrawn student who is now suspended or whose record is inactive cannot be re-enrolled", async () => {
  const a = admin();
  for (const k of ["ea3_SUS", "ea3_INA"]) {
    assert.equal((await a.setEnrollment(U.ea3_BW, U[k], "enrolled", null)).ok, true, k);
    assert.equal((await a.setEnrollment(U.ea3_BW, U[k], "withdrawn", null)).ok, true, k);
  }
  await db.exec(`update public.profiles set account_status = 'suspended' where id = t.id('ea3_SUS');
                 update public.students set status = 'inactive' where id = t.id('ea3_INA');`);
  for (const k of ["ea3_SUS", "ea3_INA"]) {
    assert.deepEqual(await a.setEnrollment(U.ea3_BW, U[k], "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.student_not_available }, k);
    assert.equal((await row3("ea3_BW", k)).status, "withdrawn", `${k}: unchanged`);
  }
});

test("slice 3B batch status: re-enrol in a completed batch → batch_not_current; every change in a cancelled batch → batch_cancelled; no actions offered", async () => {
  const a = admin();
  assert.deepEqual(await a.setEnrollment(U.ea3_BCC, U.ea3_DONE, "enrolled", null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.batch_not_current });
  assert.equal((await row3("ea3_BCC", "ea3_DONE")).status, "withdrawn");
  assert.deepEqual((await detail3("ea3_BCC")).roster.find((r) => r.studentId === U.ea3_DONE).actions, NONE3, "no re-enrol in a completed batch");
  for (const [s, status] of [["ea3_X1", "withdrawn"], ["ea3_X1", "completed"], ["ea3_X2", "enrolled"]]) {
    assert.deepEqual(await a.setEnrollment(U.ea3_BXX, U[s], status, null), { ok: false, error: lib.ENROLLMENT_REASON_MESSAGE.batch_cancelled }, `${s} → ${status}`);
  }
  assert.equal((await row3("ea3_BXX", "ea3_X1")).status, "enrolled");
  assert.equal((await row3("ea3_BXX", "ea3_X2")).status, "withdrawn");
  assert.ok((await detail3("ea3_BXX")).roster.every((r) => JSON.stringify(r.actions) === JSON.stringify(NONE3)), "no actions in a cancelled batch");
});

test("slice 3B attempt finalization: marking an enrolment completed ends an in-progress test attempt (enrollment_ended)", async () => {
  assert.equal((await admin().setEnrollment(U.ea3_BW, U.ea3_ATT, "enrolled", null)).ok, true);
  const testId = randomUUID();
  await db.exec(`
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time)
      values (t.id('ea3_CL'), t.id('ea_C'), t.id('ea3_BW'), t.id('ea_TR'), 'EA3 class', current_date, '09:00', '10:00');
    insert into t.ids values ('ea3_q1', public.save_question(t.p(t.id('ea_C'), 'true_false', 1, t.opts('True*','False'), 'EA3: completion ends attempts.')));
    select public.set_question_status(t.id('ea3_q1'), 'active');`, ids.A);
  await db.exec(`
    insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
    values ('${testId}', t.id('ea3_CL'), t.id('ea3_BW'), 'quiz', 'EA3 test', 50, 30, 1, now() - interval '1 minute', now() + interval '2 hours', t.id('ea_TR'), t.id('ea_TR'));
    select public.add_test_questions('${testId}', array[t.id('ea3_q1')]);
    update public.tests set status = 'active' where id = '${testId}';`, U.ea_TR);
  const started = await db.client({ role: "authenticated", userId: U.ea3_ATT, sessionId: randomUUID() }).rpc("start_test_attempt", { p_test_id: testId });
  assert.equal(started.error, null);
  const attemptId = started.data.attempt_id;
  assert.equal(await db.admin(`select status from public.test_attempts where id = '${attemptId}'`), "in_progress");
  assert.deepEqual(await admin().setEnrollment(U.ea3_BW, U.ea3_ATT, "completed", null), { ok: true, message: "Enrolment marked as completed." });
  assert.equal(await db.admin(`select finalize_reason from public.test_attempts where id = '${attemptId}'`), "enrollment_ended");
  assert.notEqual(await db.admin(`select status from public.test_attempts where id = '${attemptId}'`), "in_progress");
});

test("slice 3B security: trainers and students cannot call admin_set_enrollment (42501); direct batch_students writes stay blocked, even for the Super Admin", async () => {
  for (const key of ["ea_TR", "ea_S1"]) {
    const { error } = await db.client({ role: "authenticated", userId: U[key] }).rpc("admin_set_enrollment", { p_batch_id: U.ea3_BW, p_student_id: U.ea3_W1, p_status: "withdrawn" });
    assert.equal(error?.code, "42501", key);
  }
  for (const key of ["A", "ea_TR", "ea_S1"]) {
    const r = await db.client({ role: "authenticated", userId: U[key] ?? ids[key] })
      .execute(`update public.batch_students set enrollment_status = 'withdrawn' where batch_id = '${U.ea3_BW}' and student_id = '${U.ea3_W1}'`);
    assert.equal(r.error?.code, "42501", `${key}: direct update`);
  }
  assert.equal((await row3("ea3_BW", "ea3_W1")).status, "enrolled", "nothing changed");
  assert.equal(await db.admin(`select count(*) from public.enrollment_events where batch_id in ('${U.ea3_BW}', '${U.ea3_BF}') and source = 'direct'`), 0, "every change went through the function");
});
