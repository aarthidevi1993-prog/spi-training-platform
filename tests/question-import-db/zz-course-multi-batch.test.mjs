// One course, many batches, against the throwaway local database (never Supabase): a single published course is
// reused by Batch 01 / 02 / 03 without copying the course record; each batch keeps its own trainer, dates, capacity,
// enrolments, classes and attendance; nothing can be recorded across batches or across courses (the composite
// foreign keys of 0003/0005); training in one batch locks the shared course's structure (0030 history lock) while the
// other batches keep running. Each caller uses its OWN session (RLS and triggers apply). Own fixtures only (mb_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createCourseManagementRepository } = await import(`${build}/repositories/course-management.repository.core.mjs`);
const { createCourseManagementService } = await import(`${build}/services/course-management.service.core.mjs`);

let W;
let C;
let M;
let n = 0;
const uniq = (p) => `${p}-${Date.now().toString(36)}-${++n}`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const admin = () =>
  createCourseManagementService({
    repository: createCourseManagementRepository(async () => as(ids.A)),
    getCurrentUser: async () => ({ id: ids.A, email: "a@mb.test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" }),
  });
const lit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
/** INSERT … RETURNING id on the caller's own session (RLS and triggers apply). */
const insertAs = (uid, table, values) => {
  const cols = Object.keys(values);
  return as(uid).execute(`with ins as (insert into public.${table} (${cols.join(", ")}) values (${cols.map((c) => lit(values[c])).join(", ")}) returning id)
                          select json_build_object('id', id)::text from ins`);
};
const enrol = (batch, student) => as(ids.A).rpc("admin_set_enrollment", { p_batch_id: batch, p_student_id: student, p_status: "enrolled" });
const count = (sql) => db.admin(`select count(*) from ${sql}`);
const classIn = (batch) => db.admin(`select id from public.classes where batch_id = '${batch}' order by created_at limit 1`);

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'mb_' || k, gen_random_uuid() from unnest(array['T1','T2','S1','S2','S3','S4','B1','B2','B3']) k;
    insert into auth.users (id, email) select v, lower(k) || '@mb.test' from t.ids where k in ('mb_T1','mb_T2','mb_S1','mb_S2','mb_S3','mb_S4');
    update public.profiles set role = 'trainer', account_status = 'active' where id in (t.id('mb_T1'), t.id('mb_T2'));
    update public.profiles set role = 'student', account_status = 'active' where id in (select v from t.ids where k in ('mb_S1','mb_S2','mb_S3','mb_S4'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('mb_T1'), 'MB-T1', 'MB Trainer One'), (t.id('mb_T2'), 'MB-T2', 'MB Trainer Two');
    insert into public.students (id, student_code, full_name) select v, upper(replace(k, '_', '-')), 'MB ' || k from t.ids where k in ('mb_S1','mb_S2','mb_S3','mb_S4');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");

  // One published course with one module, created through Course Management (the app's path).
  const created = await admin().createCourse({ title: uniq("Shared SPI course"), description: "", level: "foundation", durationHours: 30, status: "published" });
  assert.equal(created.ok, true, JSON.stringify(created));
  C = created.courseId;
  assert.equal((await admin().createModule(C, { title: "Module one", description: "", durationHours: 3 })).ok, true);
  M = await db.admin(`select id from public.modules where course_id = '${C}'`);

  // Three batches of the SAME course, each with its own trainer, dates and capacity.
  await db.exec(`insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      ('${W.mb_B1}', '${uniq("MB-01")}', '${C}', '${W.mb_T1}', 'Batch 01', '2026-09-01', '2027-01-31', 'ongoing',  2),
      ('${W.mb_B2}', '${uniq("MB-02")}', '${C}', '${W.mb_T2}', 'Batch 02', '2026-10-01', '2027-02-28', 'ongoing',  1),
      ('${W.mb_B3}', '${uniq("MB-03")}', '${C}', '${W.mb_T1}', 'Batch 03', '2027-03-01', '2027-06-30', 'upcoming', 5);`);
});

test("one course record serves Batch 01/02/03: no copies; each batch keeps its own trainer, dates and capacity", async () => {
  assert.equal(await count(`public.courses where id = '${C}'`), 1);
  assert.equal(await count(`public.courses where title = (select title from public.courses where id = '${C}')`), 1, "the course is reused, never duplicated");
  const batches = await db.admin(`select json_agg(json_build_object('name', name, 'trainer', trainer_id, 'start', start_date, 'seats', max_seats) order by name)
                                    from public.batches where course_id = '${C}'`);
  assert.deepEqual(batches, [
    { name: "Batch 01", trainer: W.mb_T1, start: "2026-09-01", seats: 2 },
    { name: "Batch 02", trainer: W.mb_T2, start: "2026-10-01", seats: 1 },
    { name: "Batch 03", trainer: W.mb_T1, start: "2027-03-01", seats: 5 },
  ]);
  const usage = await createCourseManagementRepository(async () => as(ids.A)).getUsage(C);
  assert.equal(usage.batchCount, 3, "the course page lists all three batches");
});

test("enrolment and capacity are per batch: joining one batch never enrols, fills or blocks another", async () => {
  assert.equal((await enrol(W.mb_B1, W.mb_S1)).data?.ok, true);
  assert.equal(await count(`public.batch_students where student_id = '${W.mb_S1}'`), 1, "S1 is only in Batch 01");
  assert.equal(await count(`public.batch_students where batch_id in ('${W.mb_B2}', '${W.mb_B3}')`), 0);

  // Batch 02 has one seat: S2 takes it, S3 is refused there …
  assert.equal((await enrol(W.mb_B2, W.mb_S2)).data?.ok, true);
  assert.deepEqual((await enrol(W.mb_B2, W.mb_S3)).data, { ok: false, reason: "batch_full" });
  // … while Batch 01 (two seats) and Batch 03 (five seats) still take students.
  assert.equal((await enrol(W.mb_B1, W.mb_S3)).data?.ok, true);
  assert.equal((await enrol(W.mb_B3, W.mb_S4)).data?.ok, true);
  assert.deepEqual(
    await db.admin(`select json_object_agg(b.name, (select count(*) from public.batch_students bs where bs.batch_id = b.id)) from public.batches b where b.course_id = '${C}'`),
    { "Batch 01": 2, "Batch 02": 1, "Batch 03": 1 },
  );
});

test("trainers act only in their own batch of the shared course", async () => {
  // Trainer One schedules in Batch 01; Trainer Two schedules in Batch 02.
  const own1 = await insertAs(W.mb_T1, "classes", { course_id: C, batch_id: W.mb_B1, module_id: M, trainer_id: W.mb_T1, title: "B01 class",
    class_date: "2026-11-02", start_time: "09:00", end_time: "10:00", status: "scheduled" });
  assert.equal(own1.error, null, JSON.stringify(own1.error));
  const own2 = await insertAs(W.mb_T2, "classes", { course_id: C, batch_id: W.mb_B2, module_id: M, trainer_id: W.mb_T2, title: "B02 class",
    class_date: "2026-11-03", start_time: "09:00", end_time: "10:00", status: "scheduled" });
  assert.equal(own2.error, null, JSON.stringify(own2.error));

  // Trainer Two cannot schedule a class in Batch 01 (not their batch), as themselves or as Trainer One.
  for (const trainer of [W.mb_T2, W.mb_T1]) {
    const r = await insertAs(W.mb_T2, "classes", { course_id: C, batch_id: W.mb_B1, module_id: M, trainer_id: trainer, title: "Intrusion",
      class_date: "2026-11-04", start_time: "09:00", end_time: "10:00", status: "scheduled" });
    assert.ok(r.error, `trainer two scheduling in Batch 01 as ${trainer === W.mb_T2 ? "self" : "trainer one"} must be refused`);
  }
  // … nor record attendance there.
  const cls1 = await classIn(W.mb_B1);
  const att = await as(W.mb_T2).execute(`insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by)
    values ('${cls1}', '${W.mb_S1}', '${W.mb_B1}', 'present', '${W.mb_T2}')`);
  assert.ok(att.error, "trainer two cannot mark attendance in Batch 01");
  assert.equal(await count(`public.classes where batch_id = '${W.mb_B1}'`), 1);
  assert.equal(await count(`public.class_attendance where batch_id = '${W.mb_B1}'`), 0);
});

test("nothing can be recorded across batches or across courses (database constraints, even for a Super Admin)", async () => {
  // Run as the Super Admin's own session: every RLS policy allows it, so only the database constraints decide.
  const sa = as(ids.A);
  const cls1 = await classIn(W.mb_B1);
  // Attendance for a Batch 01 class booked under Batch 02 → refused (the class belongs to Batch 01).
  const crossClass = await sa.execute(`insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by)
    values ('${cls1}', '${W.mb_S2}', '${W.mb_B2}', 'present', '${ids.A}')`);
  assert.equal(crossClass.error?.code, "23503", JSON.stringify(crossClass.error));
  // Attendance in Batch 01 for a student enrolled only in Batch 02 → refused (not enrolled in that batch).
  const notEnrolled = await sa.execute(`insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by)
    values ('${cls1}', '${W.mb_S2}', '${W.mb_B1}', 'present', '${ids.A}')`);
  assert.equal(notEnrolled.error?.code, "23503", JSON.stringify(notEnrolled.error));
  // An assignment for a Batch 01 class filed under Batch 02 → refused (by its validation trigger or the foreign key).
  const crossTask = await sa.execute(`insert into public.class_assignments (class_id, batch_id, title, created_by, updated_by)
    values ('${cls1}', '${W.mb_B2}', 'Cross-batch assignment', '${ids.A}', '${ids.A}')`);
  assert.ok(["23503", "23514"].includes(crossTask.error?.code), JSON.stringify(crossTask.error));

  // Another course: a class cannot pair this course's batch with the other course, nor use the other course's module.
  const other = await admin().createCourse({ title: uniq("Other course"), description: "", level: "foundation", durationHours: 5, status: "published" });
  assert.equal(other.ok, true);
  assert.equal((await admin().createModule(other.courseId, { title: "Other module", description: "", durationHours: 1 })).ok, true);
  const otherModule = await db.admin(`select id from public.modules where course_id = '${other.courseId}'`);
  const wrongCourse = await sa.execute(`insert into public.classes (course_id, batch_id, trainer_id, title, class_date, start_time, end_time)
    values ('${other.courseId}', '${W.mb_B1}', '${W.mb_T1}', 'Wrong course', '2026-11-05', '09:00', '10:00')`);
  assert.equal(wrongCourse.error?.code, "23503", JSON.stringify(wrongCourse.error));
  const wrongModule = await sa.execute(`insert into public.classes (course_id, batch_id, module_id, trainer_id, title, class_date, start_time, end_time)
    values ('${C}', '${W.mb_B1}', '${otherModule}', '${W.mb_T1}', 'Wrong module', '2026-11-05', '09:00', '10:00')`);
  assert.equal(wrongModule.error?.code, "23503", JSON.stringify(wrongModule.error));
  assert.equal(await count(`public.classes where batch_id = '${W.mb_B1}'`), 1, "nothing was added");
  assert.equal(await count(`public.class_attendance where batch_id in ('${W.mb_B1}', '${W.mb_B2}')`), 0, "no cross-batch attendance");
  assert.equal(await count(`public.class_assignments where batch_id = '${W.mb_B2}'`), 0, "no cross-batch assignment");
});

test("attendance in Batch 01 stays in Batch 01; students see only their own batch", async () => {
  const cls1 = await classIn(W.mb_B1);
  const ok = await as(W.mb_T1).execute(`insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by)
    values ('${cls1}', '${W.mb_S1}', '${W.mb_B1}', 'present', '${W.mb_T1}')`);
  assert.equal(ok.error, null, JSON.stringify(ok.error));
  assert.deepEqual(
    await db.admin(`select json_object_agg(b.name, (select count(*) from public.class_attendance a where a.batch_id = b.id)) from public.batches b where b.course_id = '${C}'`),
    { "Batch 01": 1, "Batch 02": 0, "Batch 03": 0 },
  );
  // S2 (Batch 02 only) sees Batch 02's class but nothing of Batch 01 — classes or attendance.
  const s2Classes = await as(W.mb_S2).from("classes").select("batch_id").eq("course_id", C);
  assert.equal(s2Classes.error, null, JSON.stringify(s2Classes.error));
  assert.deepEqual([...new Set(s2Classes.data.map((r) => r.batch_id))], [W.mb_B2]);
  const s2Attendance = await as(W.mb_S2).from("class_attendance").select("student_id").eq("batch_id", W.mb_B1);
  assert.equal(s2Attendance.data?.length ?? 0, 0);
});

test("training in one batch locks the SHARED course structure, while every batch keeps running independently", async () => {
  // Attendance now exists in Batch 01 → the course has history: title/level/duration and modules are locked …
  const before = await db.admin(`select json_build_object('title', title, 'modules', (select count(*) from public.modules where course_id = '${C}')) from public.courses where id = '${C}'`);
  const rename = await admin().updateCourse(C, { title: uniq("Renamed") });
  assert.equal(rename.ok, false, JSON.stringify(rename));
  const addModule = await admin().createModule(C, { title: "Late module", description: "", durationHours: 1 });
  assert.equal(addModule.ok, false, JSON.stringify(addModule));
  assert.deepEqual(
    await db.admin(`select json_build_object('title', title, 'modules', (select count(*) from public.modules where course_id = '${C}')) from public.courses where id = '${C}'`),
    before, "the shared course is unchanged",
  );
  // … but the description stays editable, and the other batches carry on: Batch 03 still enrols, Batch 02 still schedules.
  assert.equal((await admin().updateCourse(C, { description: "Updated outline" })).ok, true);
  assert.equal((await enrol(W.mb_B3, W.mb_S2)).data?.ok, true, "a student may also join a later batch of the same course");
  const later = await insertAs(W.mb_T2, "classes", { course_id: C, batch_id: W.mb_B2, module_id: M, trainer_id: W.mb_T2, title: "B02 second class",
    class_date: "2026-11-10", start_time: "09:00", end_time: "10:00", status: "scheduled" });
  assert.equal(later.error, null, JSON.stringify(later.error));
  assert.equal(await count(`public.batches where course_id = '${C}'`), 3, "no batch was lost or moved");
});
