// Phase 7 P3.10-A — trainer batch detail + trainer enrolment: the real enrolment repository/service exactly
// as the new /trainer/batches/[batchId] page uses them, against the local database, each caller through
// their OWN session client (never the service role). Own batch loads; another trainer's batch and unknown
// ids do not; trainer_enroll_student enrols an in-scope student (audited, seat counted), refuses duplicates
// and full batches; students and other trainers are refused; the Super Admin view is unchanged; and the
// enrolled student sees the new enrolment through the existing student-side RLS. Own fixtures only (tb_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createEnrollmentRepository } = await import(`${build}/repositories/enrollment.repository.core.mjs`);
const { createEnrollmentService, EnrollmentAuthorizationError } = await import(`${build}/services/enrollment.service.core.mjs`);
const lib = await import(`${build}/lib/enrollments/enrollment.mjs`);

let U = {};
const svcAs = (key, role) =>
  createEnrollmentService({
    repository: createEnrollmentRepository(async () => db.client({ role: "authenticated", userId: U[key] ?? ids[key] })),
    getCurrentUser: async () => ({ id: U[key] ?? ids[key], email: `${key}@tb.test`, fullName: key, role, isActive: true, createdAt: "2026-01-01" }),
  });
const trainer = () => svcAs("tb_TR", "trainer");
const statusOf = (b, s) => db.admin(`select enrollment_status from public.batch_students where batch_id = '${U[b]}' and student_id = '${U[s]}'`);
const quiet = async (fn) => {
  const saved = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = saved;
  }
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'tb_' || k, gen_random_uuid()
      from unnest(array['TR','TR2','C','B1','B2','BF','BX','S1','S2','S3','F1','F2','X1']) k;
    insert into auth.users (id, email) select v, lower(k) || '@tb.test' from t.ids
     where k in ('tb_TR','tb_TR2','tb_S1','tb_S2','tb_S3','tb_F1','tb_F2','tb_X1');
    update public.profiles set account_status = 'active'
     where id in (select v from t.ids where k in ('tb_TR','tb_TR2','tb_S1','tb_S2','tb_S3','tb_F1','tb_F2','tb_X1'));
    update public.profiles set role = 'trainer' where id in (t.id('tb_TR'), t.id('tb_TR2'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('tb_TR'), 'TB-TR', 'TB Trainer'), (t.id('tb_TR2'), 'TB-TR2', 'TB Other Trainer');
    insert into public.students (id, student_code, full_name)
      select v, upper(k), 'TB ' || substr(k, 4) from t.ids where k in ('tb_S1','tb_S2','tb_S3','tb_F1','tb_F2','tb_X1');
    insert into public.courses (id, course_code, title, level) values (t.id('tb_C'), 'TB-101', 'Trainer Batch Detail', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('tb_B1'), 'TB-B1', t.id('tb_C'), t.id('tb_TR'),  'TB one',   '2026-01-01', '2026-12-31', 'ongoing',  10),
      (t.id('tb_B2'), 'TB-B2', t.id('tb_C'), t.id('tb_TR'),  'TB two',   '2027-01-01', '2027-06-30', 'upcoming', 10),
      (t.id('tb_BF'), 'TB-BF', t.id('tb_C'), t.id('tb_TR'),  'TB full',  '2026-01-01', '2026-12-31', 'ongoing',  1),
      (t.id('tb_BX'), 'TB-BX', t.id('tb_C'), t.id('tb_TR2'), 'TB other', '2026-01-01', '2026-12-31', 'ongoing',  10);
    -- Fixture rows (privileged): S1, S2, F1 are the trainer's current students (in B1); BF is already full (F2);
    -- X1 belongs only to the other trainer's batch.
    insert into public.batch_students (batch_id, student_id) values
      (t.id('tb_B1'), t.id('tb_S1')), (t.id('tb_B1'), t.id('tb_S2')), (t.id('tb_B1'), t.id('tb_F1')),
      (t.id('tb_BF'), t.id('tb_F2')), (t.id('tb_BX'), t.id('tb_X1'));`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("own batch: the trainer view loads (trainer mode, own roster, enrol allowed, in-scope candidates only)", async () => {
  const d = await trainer().getBatchDetail(U.tb_B2);
  assert.equal(d.mode, "trainer");
  assert.equal(d.batch.id, U.tb_B2);
  assert.equal(d.canEnrol, true, "upcoming batch they teach");
  const candidateIds = d.candidates.map((c) => c.id).sort();
  assert.deepEqual(candidateIds, [U.tb_F1, U.tb_F2, U.tb_S1, U.tb_S2].sort(), "only students already in another of their current batches (B1, BF)");
  assert.ok(!candidateIds.includes(U.tb_X1), "never another trainer's student");
  assert.ok(!candidateIds.includes(U.tb_S3), "never an unenrolled student");
  for (const r of d.roster) assert.deepEqual(r.actions, { enrol: false, reEnrol: false, withdraw: false, complete: false }, "trainers get no per-row status actions");
});

test("out of scope: another trainer's batch and an unknown UUID load nothing (the page answers 404)", async () => {
  assert.equal(await trainer().getBatchDetail(U.tb_BX), null);
  assert.equal(await trainer().getBatchDetail(randomUUID()), null);
  assert.equal(await trainer().getBatchDetail("not-a-uuid"), null);
});

test("enrol: an in-scope student joins the trainer's own batch — seat counted, history 'trainer', audited; a repeat is refused", async () => {
  const before = await trainer().getBatchDetail(U.tb_B2);
  const ok = await trainer().trainerEnrol(U.tb_B2, U.tb_S1);
  assert.deepEqual(ok, { ok: true, message: lib.enrollmentSuccessMessage(null, "enrolled") });
  assert.equal(await statusOf("tb_B2", "tb_S1"), "enrolled");
  const after = await trainer().getBatchDetail(U.tb_B2);
  assert.equal(after.seatsUsed, before.seatsUsed + 1);
  assert.ok(after.roster.some((r) => r.studentId === U.tb_S1 && r.enrollmentStatus === "enrolled"));
  assert.ok(!after.candidates.some((c) => c.id === U.tb_S1), "no longer a candidate");
  assert.ok(after.history.some((h) => h.studentId === U.tb_S1 && h.source === "trainer" && h.newStatus === "enrolled"));
  assert.equal(
    await db.admin(`select count(*)::int from public.user_admin_events where event_type = 'enrollment_changed' and actor_id = '${U.tb_TR}' and target_user_id = '${U.tb_S1}' and batch_id = '${U.tb_B2}'`),
    1,
    "audited with the trainer as actor"
  );
  // Duplicate: the database answers "unchanged"; nothing new is written.
  const dup = await trainer().trainerEnrol(U.tb_B2, U.tb_S1);
  assert.deepEqual(dup, { ok: false, error: lib.enrollmentRefusalMessage("unchanged") });
  assert.equal(await db.admin(`select count(*)::int from public.batch_students where batch_id = '${U.tb_B2}' and student_id = '${U.tb_S1}'`), 1);
});

test("seat limit: a full batch refuses the enrolment (batch_full) and the view stops offering it", async () => {
  const d = await trainer().getBatchDetail(U.tb_BF);
  assert.equal(d.seatsUsed, d.batch.maxSeats, "fixture: full");
  const r = await trainer().trainerEnrol(U.tb_BF, U.tb_S2);
  assert.deepEqual(r, { ok: false, error: lib.enrollmentRefusalMessage("batch_full") });
  assert.equal(await statusOf("tb_BF", "tb_S2"), null, "nothing written");
});

test("scope: no enrolment into another trainer's batch, and no out-of-scope student — the database refuses (fixed sentence)", async () => {
  const other = await trainer().trainerEnrol(U.tb_BX, U.tb_S2);
  assert.deepEqual(other, { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR });
  const stranger = await trainer().trainerEnrol(U.tb_B2, U.tb_X1);
  assert.deepEqual(stranger, { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR });
  assert.equal(await statusOf("tb_BX", "tb_S2"), null);
  assert.equal(await statusOf("tb_B2", "tb_X1"), null);
  // The other trainer cannot use this trainer's batch either.
  const cross = await svcAs("tb_TR2", "trainer").trainerEnrol(U.tb_B1, U.tb_X1);
  assert.deepEqual(cross, { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR });
});

test("unauthorized: students are refused by the service and by the database; trainers cannot use the Super Admin action", async () => {
  const student = svcAs("tb_S2", "student");
  await assert.rejects(student.getBatchDetail(U.tb_B1), EnrollmentAuthorizationError);
  await assert.rejects(student.trainerEnrol(U.tb_B2, U.tb_S2), EnrollmentAuthorizationError);
  const direct = await db.client({ role: "authenticated", userId: U.tb_S2 }).rpc("trainer_enroll_student", { p_batch_id: U.tb_B2, p_student_id: U.tb_S2 });
  assert.equal(direct.error?.code, "42501");
  // A trainer cannot withdraw / re-enrol / complete: the Super Admin action refuses them.
  await assert.rejects(trainer().setEnrollment(U.tb_B1, U.tb_S2, "withdrawn", null), EnrollmentAuthorizationError);
  const viaDb = await db.client({ role: "authenticated", userId: U.tb_TR }).rpc("admin_set_enrollment", { p_batch_id: U.tb_B1, p_student_id: U.tb_S2, p_status: "withdrawn", p_reason: null });
  assert.equal(viaDb.error?.code, "42501");
  // Direct client writes stay blocked even for the trainer's own batch.
  const write = await db.client({ role: "authenticated", userId: U.tb_TR }).execute(`insert into public.batch_students (batch_id, student_id) values ('${U.tb_B2}', '${U.tb_S3}')`);
  assert.equal(write.error?.code, "42501", "direct insert refused");
  assert.equal(await statusOf("tb_B2", "tb_S3"), null, "nothing written");
  assert.equal(await statusOf("tb_B1", "tb_S2"), "enrolled", "unchanged");
});

test("Super Admin regression: the admin view of the same batch is unchanged (admin mode, status actions) and still enrols", async () => {
  const admin = svcAs("A", "admin");
  const d = await admin.getBatchDetail(U.tb_B1);
  assert.equal(d.mode, "admin");
  assert.ok(d.roster.find((r) => r.studentId === U.tb_S2).actions.withdraw, "the Super Admin keeps per-row status actions");
  assert.ok(d.candidates.some((c) => c.id === U.tb_S3), "any available student, not only the trainer's");
  const r = await quiet(() => admin.setEnrollment(U.tb_B1, U.tb_S3, "enrolled", "regression"));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("student impact: the student enrolled by the trainer sees the new batch through the existing student-side RLS", async () => {
  await trainer().trainerEnrol(U.tb_B2, U.tb_S2);
  const own = db.client({ role: "authenticated", userId: U.tb_S2 });
  const rows = await own.from("batch_students").select("batch_id, enrollment_status").eq("batch_id", U.tb_B2);
  assert.deepEqual(rows.data, [{ batch_id: U.tb_B2, enrollment_status: "enrolled" }]);
  const batch = await own.from("batches").select("id").eq("id", U.tb_B2);
  assert.deepEqual(batch.data, [{ id: U.tb_B2 }], "the batch is now visible to the student");
  const others = await own.from("batch_students").select("student_id").eq("batch_id", U.tb_B2);
  assert.ok(others.data.every((x) => x.student_id === U.tb_S2), "and still only their own enrolment");
});
