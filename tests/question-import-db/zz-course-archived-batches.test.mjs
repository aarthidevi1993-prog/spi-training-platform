// Archived courses, against the throwaway local database (never Supabase): archiving a course stops NEW batches and
// new students in its UPCOMING batches, while its ongoing batches keep enrolling and every existing batch keeps
// running — class scheduling, attendance, tests, assignments and completion — through the same client paths and
// database functions the app uses (each caller's OWN session). Own fixtures only (ca_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createCourseManagementRepository } = await import(`${build}/repositories/course-management.repository.core.mjs`);
const { createCourseManagementService } = await import(`${build}/services/course-management.service.core.mjs`);

let W;
let C;
let n = 0;
const uniq = (p) => `${p}-${Date.now().toString(36)}-${++n}`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const admin = () =>
  createCourseManagementService({
    repository: createCourseManagementRepository(async () => as(ids.A)),
    getCurrentUser: async () => ({ id: ids.A, email: "a@ca.test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" }),
  });
/** INSERT … RETURNING id as `uid` (the stand-in client has no .insert()); RLS and triggers apply. */
const insertAs = (uid, table, values) => {
  const cols = Object.keys(values);
  const lit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  return as(uid).execute(`with ins as (insert into public.${table} (${cols.join(", ")}) values (${cols.map((c) => lit(values[c])).join(", ")}) returning id)
                          select json_build_object('id', id)::text from ins`);
};
const enrol = (batch, student, status = "enrolled") => as(ids.A).rpc("admin_set_enrollment", { p_batch_id: batch, p_student_id: student, p_status: status });
const rowOf = (batch, student) => db.admin(`select enrollment_status from public.batch_students where batch_id = '${batch}' and student_id = '${student}'`);
const auditCount = (batch) => db.admin(`select (select count(*) from public.user_admin_events where batch_id = '${batch}') + (select count(*) from public.enrollment_events where batch_id = '${batch}')`);
/** Invitations created BEFORE archiving (ids), accepted afterwards. */
const INV = {};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ca_' || k, gen_random_uuid() from unnest(array['T','T2','S1','S2','S3','S4','S5','S6','BU','BO']) k;
    insert into auth.users (id, email) select v, lower(k) || '@ca.test' from t.ids where k in ('ca_T','ca_T2','ca_S1','ca_S2','ca_S3','ca_S4','ca_S5','ca_S6');
    update public.profiles set role = 'trainer', account_status = 'active' where id in (t.id('ca_T'), t.id('ca_T2'));
    update public.profiles set role = 'student', account_status = 'active' where id in (select v from t.ids where k in ('ca_S1','ca_S2','ca_S3','ca_S4','ca_S5','ca_S6'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ca_T'), 'CA-T', 'CA Trainer'), (t.id('ca_T2'), 'CA-T2', 'CA Other Trainer');
    insert into public.students (id, student_code, full_name) select v, upper(replace(k, '_', '-')), 'CA ' || k from t.ids where k in ('ca_S1','ca_S2','ca_S3','ca_S4','ca_S5','ca_S6');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");

  // A published course with one UPCOMING and one ONGOING batch, both run by the trainer; S1 enrolled in the ongoing one.
  const created = await admin().createCourse({ title: uniq("Archived course"), description: "", level: "foundation", durationHours: 20, status: "published" });
  assert.equal(created.ok, true, JSON.stringify(created));
  C = created.courseId;
  assert.equal((await admin().createModule(C, { title: "Only module", description: "", durationHours: 2 })).ok, true);
  await db.exec(`insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      ('${W.ca_BU}', '${uniq("CA-UP")}', '${C}', '${W.ca_T}', 'Upcoming batch', '2027-03-01', '2027-05-31', 'upcoming', 10),
      ('${W.ca_BO}', '${uniq("CA-ON")}', '${C}', '${W.ca_T}', 'Ongoing batch',  '2026-09-01', '2027-02-28', 'ongoing', 10);`);
  assert.equal((await enrol(W.ca_BO, W.ca_S1)).data?.ok, true);
  // S4 and S5 are already in the UPCOMING batch before archiving (S4 is withdrawn later; S5 stays).
  assert.equal((await enrol(W.ca_BU, W.ca_S4)).data?.ok, true);
  assert.equal((await enrol(W.ca_BU, W.ca_S5)).data?.ok, true);
  // Invitations into each batch, created while the course was still published.
  for (const [key, batch] of [["up", W.ca_BU], ["on", W.ca_BO]]) {
    const r = await as(ids.A).rpc("create_user_invitation", { p: { email: `${uniq("ca-inv-" + key)}@ca.test`, role: "student", full_name: "CA Invitee", batch_id: batch } });
    assert.equal(r.data?.ok, true, JSON.stringify(r));
    INV[key] = r.data.invitation_id;
  }

  // Archive it.
  const archived = await admin().setCourseStatus(C, "archived");
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(await db.admin(`select status from public.courses where id = '${C}'`), "archived");
});

test("archived: a NEW batch for the course is rejected (with the hint the app maps); existing batches are untouched", async () => {
  const raw = await db.run(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${ids.A}"}', false);
    insert into public.batches (batch_code, course_id, name, start_date, end_date, max_seats) values ('${uniq("CA-NEW")}', '${C}', 'New', '2027-06-01', '2027-07-01', 5);`);
  assert.notEqual(raw.code, 0);
  assert.match(raw.stderr, /23514/);
  assert.match(raw.stderr, /HINT:\s+course_not_published/);
  assert.deepEqual(
    await db.admin(`select json_agg(status order by status) from public.batches where course_id = '${C}'`),
    ["upcoming", "ongoing"],
    "only the two existing batches (enum order), statuses unchanged"
  );
});

test("archived: the course page and batch page get what they need — archive impact counts and the course status", async () => {
  const usage = await createCourseManagementRepository(async () => as(ids.A)).getUsage(C);
  assert.deepEqual(
    [usage.upcomingBatchCount, usage.ongoingBatchCount, usage.pendingUpcomingInvitationCount],
    [1, 1, 1],
    "one upcoming, one ongoing, and the pending invitation into the upcoming batch (the ongoing one isn't counted)"
  );
  const { createEnrollmentRepository } = await import(`${build}/repositories/enrollment.repository.core.mjs`);
  for (const [uid, who] of [[ids.A, "Super Admin"], [W.ca_T, "batch trainer"]]) {
    const header = await createEnrollmentRepository(async () => as(uid)).getBatchHeader(W.ca_BU);
    assert.equal(header?.course_status, "archived", who);
  }
});

test("archived: classes can still be scheduled for its upcoming and ongoing batches (trainer's own session)", async () => {
  const mod = await db.admin(`select id from public.modules where course_id = '${C}'`);
  for (const [batch, date] of [[W.ca_BO, "2026-11-10"], [W.ca_BU, "2027-03-10"]]) {
    const r = await insertAs(W.ca_T, "classes", {
      course_id: C, batch_id: batch, module_id: mod, trainer_id: W.ca_T, title: "Class after archiving",
      class_date: date, start_time: "09:00", end_time: "10:00", status: "scheduled",
    });
    assert.equal(r.error, null, `${batch}: ${JSON.stringify(r.error)}`);
  }
  assert.equal(await db.admin(`select count(*) from public.classes where course_id = '${C}'`), 2);
});

test("archived + UPCOMING batch: admin_set_enrollment refuses a new student (course_archived); nothing written, nothing audited", async () => {
  const before = await auditCount(W.ca_BU);
  const r = await enrol(W.ca_BU, W.ca_S2);
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.deepEqual(r.data, { ok: false, reason: "course_archived" });
  assert.equal(await rowOf(W.ca_BU, W.ca_S2), null, "no enrolment row");
  assert.equal(await auditCount(W.ca_BU), before, "no audit or enrolment event for a refusal");
});

test("archived + ONGOING batch: admin_set_enrollment still enrols (audited as usual)", async () => {
  const before = await auditCount(W.ca_BO);
  const r = await enrol(W.ca_BO, W.ca_S2);
  assert.equal(r.data?.ok, true, JSON.stringify(r));
  assert.equal(await rowOf(W.ca_BO, W.ca_S2), "enrolled");
  assert.ok((await auditCount(W.ca_BO)) > before, "enrolment audited");
});

test("archived + UPCOMING batch: existing students stay; withdrawal still works; re-enrolment is refused", async () => {
  assert.equal(await rowOf(W.ca_BU, W.ca_S5), "enrolled", "enrolled before archiving: untouched");
  assert.equal((await enrol(W.ca_BU, W.ca_S4, "withdrawn")).data?.ok, true, "withdrawal is not an enrolment");
  assert.deepEqual((await enrol(W.ca_BU, W.ca_S4)).data, { ok: false, reason: "course_archived" }, "a returning student is a new enrolment");
  assert.equal(await rowOf(W.ca_BU, W.ca_S4), "withdrawn");
});

test("archived: the trainer's own enrolment path follows the same rule (trainer_enroll_student)", async () => {
  // S1 is the trainer's current student (enrolled in the ongoing batch) → refused for the upcoming one.
  const up = await as(W.ca_T).rpc("trainer_enroll_student", { p_batch_id: W.ca_BU, p_student_id: W.ca_S1 });
  assert.deepEqual(up.data, { ok: false, reason: "course_archived" }, JSON.stringify(up.error));
  assert.equal(await rowOf(W.ca_BU, W.ca_S1), null);
  // S5 is the trainer's current student (upcoming batch) → may still join the ongoing batch.
  const on = await as(W.ca_T).rpc("trainer_enroll_student", { p_batch_id: W.ca_BO, p_student_id: W.ca_S5 });
  assert.equal(on.data?.ok, true, JSON.stringify(on));
  assert.equal(await rowOf(W.ca_BO, W.ca_S5), "enrolled");
});

test("archived: unauthorized callers and attempts to bypass the UI are refused; nothing changes", async () => {
  const snapshot = () => db.admin(`select md5(coalesce(string_agg(batch_id::text || student_id::text || enrollment_status::text, ',' order by batch_id, student_id), ''))
                                    from public.batch_students where batch_id in ('${W.ca_BU}', '${W.ca_BO}')`);
  const before = await snapshot();
  // admin_set_enrollment: Super Admin only — a student, a trainer and an anonymous caller are refused.
  for (const uid of [W.ca_S6, W.ca_T]) {
    for (const batch of [W.ca_BU, W.ca_BO]) {
      const r = await as(uid).rpc("admin_set_enrollment", { p_batch_id: batch, p_student_id: W.ca_S6, p_status: "enrolled" });
      assert.equal(r.error?.code, "42501", `${uid} → ${batch}`);
    }
  }
  assert.ok((await db.client({ role: "anon" }).rpc("admin_set_enrollment", { p_batch_id: W.ca_BO, p_student_id: W.ca_S6, p_status: "enrolled" })).error);
  // trainer_enroll_student: a trainer who doesn't teach these batches, and a student, are refused.
  assert.equal((await as(W.ca_T2).rpc("trainer_enroll_student", { p_batch_id: W.ca_BO, p_student_id: W.ca_S1 })).error?.code, "42501");
  assert.equal((await as(W.ca_S6).rpc("trainer_enroll_student", { p_batch_id: W.ca_BO, p_student_id: W.ca_S6 })).error?.code, "42501");
  // Bypassing the functions: direct writes to batch_students are refused even for a Super Admin (0023 grants).
  for (const sql of [
    `insert into public.batch_students (batch_id, student_id) values ('${W.ca_BU}', '${W.ca_S6}')`,
    `update public.batch_students set enrollment_status = 'enrolled' where batch_id = '${W.ca_BU}' and student_id = '${W.ca_S4}'`,
  ]) {
    assert.equal((await as(ids.A).execute(sql)).error?.code, "42501", sql);
  }
  // The rule lives in the database: a direct function call with any arguments gets the same answer as the UI.
  assert.deepEqual((await enrol(W.ca_BU, W.ca_S6)).data, { ok: false, reason: "course_archived" });
  assert.equal(await snapshot(), before, "no enrolment changed");
});

test("archived: invitations — none into the upcoming batch; one created earlier activates the account but doesn't enrol", async () => {
  // New invitations.
  const up = await as(ids.A).rpc("create_user_invitation", { p: { email: `${uniq("ca-new-up")}@ca.test`, role: "student", full_name: "X", batch_id: W.ca_BU } });
  assert.deepEqual(up.data, { ok: false, reason: "course_archived" });
  const on = await as(ids.A).rpc("create_user_invitation", { p: { email: `${uniq("ca-new-on")}@ca.test`, role: "student", full_name: "X", batch_id: W.ca_BO } });
  assert.equal(on.data?.ok, true, "ongoing batches still take invitations");

  // Invitations created before archiving, delivered now and accepted through the REAL acceptance service
  // (repository + service) on the invitee's own session; only Auth's password update is stood in.
  const { createInvitationAcceptanceRepository } = await import(`${build}/repositories/invitation-acceptance.repository.core.mjs`);
  const { createInvitationAcceptanceService } = await import(`${build}/services/invitation-acceptance.service.core.mjs`);
  const { ENROLMENT_SKIPPED_ARCHIVED_NOTICE } = await import(`${build}/lib/auth/invite-acceptance.mjs`);
  const deliver = async (invitationId) => {
    assert.equal((await as(ids.A).rpc("begin_invitation_delivery", { p_invitation_id: invitationId })).error, null);
    const email = await db.admin(`select email from public.user_invitations where id = '${invitationId}'`);
    const uid = randomUUID();
    await db.exec(`insert into auth.users (id, email) values ('${uid}', '${email}');`);
    const rec = await db.client({ role: "service_role" }).rpc("record_invitation_delivery", { p_invitation_id: invitationId, p_sent: true, p_auth_user_id: uid });
    assert.equal(rec.error, null, JSON.stringify(rec.error));
    return { uid, email };
  };
  const acceptThroughService = async ({ uid, email }) => {
    const c = as(uid);
    const session = {
      rpc: (fn, args) => c.rpc(fn, args),
      from: (t) => c.from(t),
      auth: {
        verifyOtp: async () => ({ data: {}, error: null }),
        getUser: async () => ({ data: { user: { id: uid, email } }, error: null }),
        updateUser: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
    };
    const service = createInvitationAcceptanceService({ repository: createInvitationAcceptanceRepository(async () => session) });
    const saved = [console.warn, console.error];
    console.warn = () => {};
    console.error = () => {};
    try {
      return await service.completeInvitation("Accept-Me-123!", "Accept-Me-123!");
    } finally {
      [console.warn, console.error] = saved;
    }
  };

  // REGRESSION: upcoming batch of an archived course → account activated, NOT enrolled, and told why + what to do.
  const upInvitee = await deliver(INV.up);
  const upResult = await acceptThroughService(upInvitee);
  assert.deepEqual(upResult, { ok: true, home: "/student", notice: ENROLMENT_SKIPPED_ARCHIVED_NOTICE });
  assert.match(upResult.notice, /account is active, but you weren't added to the batch in your invitation because its course has been deactivated/);
  assert.match(upResult.notice, /contact your Super Admin to be assigned to an available batch/);
  assert.doesNotMatch(upResult.notice, /[0-9a-f]{8}-[0-9a-f]{4}|course_archived|error|sql/i, "no ids, codes or database wording");
  assert.equal(await db.admin(`select account_status from public.profiles where id = '${upInvitee.uid}'`), "active");
  assert.equal(await db.admin(`select role from public.profiles where id = '${upInvitee.uid}'`), "student");
  assert.equal(await rowOf(W.ca_BU, upInvitee.uid), null, "not enrolled");
  assert.equal(await db.admin(`select status from public.user_invitations where id = '${INV.up}'`), "accepted");
  assert.deepEqual(
    await db.admin(`select detail from public.user_admin_events where invitation_id = '${INV.up}' and event_type = 'invitation_accepted'`),
    { role: "student", enrolled: false, enrolment_skipped: "course_archived" },
    "the audit records why the enrolment was skipped"
  );

  // The ongoing batch still enrols, and no notice is shown.
  const onInvitee = await deliver(INV.on);
  assert.deepEqual(await acceptThroughService(onInvitee), { ok: true, home: "/student" });
  assert.equal(await rowOf(W.ca_BO, onInvitee.uid), "enrolled");
  assert.deepEqual(
    await db.admin(`select detail from public.user_admin_events where invitation_id = '${INV.on}' and event_type = 'invitation_accepted'`),
    { role: "student", enrolled: true },
    "nothing extra in the audit when enrolment happened"
  );
});

test("re-publishing the course re-opens its upcoming batch for enrolment (the rule follows the course status)", async () => {
  assert.equal((await admin().setCourseStatus(C, "published")).ok, true);
  assert.equal((await enrol(W.ca_BU, W.ca_S6)).data?.ok, true);
  assert.equal((await admin().setCourseStatus(C, "archived")).ok, true);
  assert.deepEqual((await enrol(W.ca_BU, W.ca_S3)).data, { ok: false, reason: "course_archived" });
  assert.equal(await rowOf(W.ca_BU, W.ca_S6), "enrolled", "archiving again leaves existing enrolments alone");
});

test("archived: attendance, a test and an assignment can still be recorded in its ongoing batch (trainer's own session)", async () => {
  const cls = await db.admin(`select id from public.classes where batch_id = '${W.ca_BO}' limit 1`);
  // class_attendance is keyed by (class, student): a plain insert on the trainer's own session (RLS + triggers apply).
  const att = await as(W.ca_T).execute(`insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by)
    values ('${cls}', '${W.ca_S1}', '${W.ca_BO}', 'present', '${W.ca_T}')`);
  assert.equal(att.error, null, JSON.stringify(att.error));
  assert.equal(await db.admin(`select count(*) from public.class_attendance where batch_id = '${W.ca_BO}'`), 1);

  const quiz = await insertAs(W.ca_T, "tests", { class_id: cls, batch_id: W.ca_BO, test_type: "quiz", title: "Quiz after archiving", created_by: W.ca_T, updated_by: W.ca_T });
  assert.equal(quiz.error, null, JSON.stringify(quiz.error));
  const task = await insertAs(W.ca_T, "class_assignments", { class_id: cls, batch_id: W.ca_BO, title: "Assignment after archiving", created_by: W.ca_T, updated_by: W.ca_T });
  assert.equal(task.error, null, JSON.stringify(task.error));
});

test("archived: completion is decided exactly as for a published course (course status plays no part)", async () => {
  // Control: an identical ongoing batch of a PUBLISHED course, same student state.
  const ctl = await admin().createCourse({ title: uniq("Control course"), description: "", level: "foundation", durationHours: 20, status: "published" });
  const ctlBatch = await db.admin("select gen_random_uuid()");
  await db.exec(`insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
    values ('${ctlBatch}', '${uniq("CA-CTL")}', '${ctl.courseId}', '${W.ca_T}', 'Control', '2026-09-01', '2027-02-28', 'ongoing', 10);`);
  assert.equal((await enrol(ctlBatch, W.ca_S3)).data?.ok, true);
  assert.equal((await enrol(W.ca_BO, W.ca_S3)).data?.ok, true, "late enrolment into the archived course's ongoing batch");

  const onArchived = await as(ids.A).rpc("recommend_completion", { p_batch_id: W.ca_BO, p_student_id: W.ca_S3, p_note: null });
  const onPublished = await as(ids.A).rpc("recommend_completion", { p_batch_id: ctlBatch, p_student_id: W.ca_S3, p_note: null });
  assert.equal(onArchived.error, null, JSON.stringify(onArchived.error));
  assert.equal(onArchived.data?.reason, onPublished.data?.reason, "same answer for an archived and a published course");
  assert.deepEqual(onArchived.data?.eligibility?.batch_completed, onPublished.data?.eligibility?.batch_completed);
  // The trainer's own path is the same (assigned trainer of the archived course's batch).
  const byTrainer = await as(W.ca_T).rpc("recommend_completion", { p_batch_id: W.ca_BO, p_student_id: W.ca_S3, p_note: null });
  assert.equal(byTrainer.error, null, JSON.stringify(byTrainer.error));

  // No completion / certificate / class / test / assignment function looks at the course status (issue_certificate only
  // copies code + title). Enrolment and invitations DO, by design (0030 section 7) — tested above.
  const offenders = await db.admin(`select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('completion_eligibility', 'recommend_completion', 'decide_completion', 'issue_certificate',
      'classes_enforce_batch_trainer', 'tests_validate', 'class_assignments_validate')
      and (p.prosrc ~* 'course_status' or p.prosrc ~* '''archived''' or p.prosrc ~* 'co\.status')`);
  assert.deepEqual(offenders, []);
  // Positive control: the same pattern does find a function that reads the course status.
  assert.equal(await db.admin(`select count(*) from pg_proc where proname = 'admin_set_course_status' and prosrc ~* '''archived'''`), 1);
});

test("archived: the course page reflects it — history locked, nothing deleted, publish again restores new batches", async () => {
  const usage = await createCourseManagementRepository(async () => as(ids.A)).getUsage(C);
  assert.equal(usage.batchCount, 2);
  assert.equal(usage.hasHistory, true, "attendance and the completion record are history");
  assert.equal(usage.canDelete, false);
  // A trainer or student can't change the course status.
  assert.equal((await as(W.ca_T).rpc("admin_set_course_status", { p_course_id: C, p_status: "published" })).error?.code, "42501");
  assert.equal((await as(W.ca_S1).rpc("admin_set_course_status", { p_course_id: C, p_status: "published" })).error?.code, "42501");
  // Publishing again re-opens the course for new batches (audited).
  assert.equal((await admin().setCourseStatus(C, "published")).ok, true);
  const again = await as(ids.A).execute(`insert into public.batches (batch_code, course_id, name, start_date, end_date, max_seats) values ('${uniq("CA-AGAIN")}', '${C}', 'Again', '2027-08-01', '2027-09-01', 5)`);
  assert.equal(again.error, null, JSON.stringify(again.error));
  assert.deepEqual(
    await db.admin(`select json_agg(detail->>'to' order by id) from public.course_events where course_id = '${C}' and event_type = 'course_status_changed'`),
    ["archived", "published", "archived", "published"],
    "every status change is audited (archive, re-publish, archive again, publish)"
  );
});
