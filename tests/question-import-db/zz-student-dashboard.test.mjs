// Student Dashboard Phase 2, against the throwaway local database (never Supabase): the EXACT query
// assignmentsRepository.findPublishedInBatches sends, and the submissions read, on each student's OWN
// session — so RLS (not the batch list passed in) decides what a student sees — then the pure
// pending-assignment rules. Own fixtures only (sd_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { db, ids } from "./harness.mjs";

const { pickPendingAssignments } = await import(`${process.env.QI_BUILD}/lib/dashboard/student-dashboard.mjs`);

let W;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
/** The repository's query, verbatim (select / in / eq / order / limit). */
const publishedInBatches = (uid, batchIds) =>
  as(uid)
    .from("class_assignments")
    .select("id, class_id, title, due_at, status, classes ( title, status )")
    .in("batch_id", batchIds)
    .eq("status", "published")
    .order("due_at")
    .limit(500);
const toSource = (a) => {
  const cls = Array.isArray(a.classes) ? a.classes[0] ?? null : a.classes;
  return { id: a.id, classId: a.class_id, title: a.title, dueAt: a.due_at, status: a.status, classTitle: cls?.title ?? "", classStatus: cls?.status ?? "cancelled" };
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'sd_' || k, gen_random_uuid()
      from unnest(array['T','S1','S2','S3','B1','B2','K1','K2','K3','A_PUB','A_DRAFT','A_CLOSED','A_CANCEL','A_OTHER']) k;
    insert into auth.users (id, email) select v, lower(k) || '@sd.test' from t.ids where k in ('sd_T','sd_S1','sd_S2','sd_S3');
    update public.profiles set role = 'trainer', account_status = 'active' where id = t.id('sd_T');
    update public.profiles set role = 'student', account_status = 'active' where id in (t.id('sd_S1'), t.id('sd_S2'), t.id('sd_S3'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('sd_T'), 'SD-T', 'SD Trainer');
    insert into public.students (id, student_code, full_name) select v, upper(replace(k, '_', '-')), k from t.ids where k in ('sd_S1','sd_S2','sd_S3');
    set session_replication_role = replica;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('sd_B1'), 'SD-B1', t.id('C1'), t.id('sd_T'), 'SD one', '2026-01-01', '2027-12-31', 'ongoing', 10),
      (t.id('sd_B2'), 'SD-B2', t.id('C1'), t.id('sd_T'), 'SD two', '2026-01-01', '2027-12-31', 'ongoing', 10);
    insert into public.batch_students (batch_id, student_id, enrollment_status) values
      (t.id('sd_B1'), t.id('sd_S1'), 'enrolled'), (t.id('sd_B2'), t.id('sd_S2'), 'enrolled'), (t.id('sd_B1'), t.id('sd_S3'), 'withdrawn');
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      (t.id('sd_K1'), t.id('C1'), t.id('sd_B1'), t.id('sd_T'), 'SD class one', '2027-01-10', '09:00', '10:00', 'scheduled'),
      (t.id('sd_K2'), t.id('C1'), t.id('sd_B1'), t.id('sd_T'), 'SD cancelled class', '2027-01-11', '09:00', '10:00', 'cancelled'),
      (t.id('sd_K3'), t.id('C1'), t.id('sd_B2'), t.id('sd_T'), 'SD other batch class', '2027-01-12', '09:00', '10:00', 'scheduled');
    insert into public.class_assignments (id, class_id, batch_id, title, due_at, status, created_by, updated_by) values
      (t.id('sd_A_PUB'),    t.id('sd_K1'), t.id('sd_B1'), 'SD published',        '2027-01-20T10:00:00Z', 'published', t.id('sd_T'), t.id('sd_T')),
      (t.id('sd_A_DRAFT'),  t.id('sd_K1'), t.id('sd_B1'), 'SD draft',            '2027-01-20T10:00:00Z', 'draft',     t.id('sd_T'), t.id('sd_T')),
      (t.id('sd_A_CLOSED'), t.id('sd_K1'), t.id('sd_B1'), 'SD closed',           '2027-01-20T10:00:00Z', 'closed',    t.id('sd_T'), t.id('sd_T')),
      (t.id('sd_A_CANCEL'), t.id('sd_K2'), t.id('sd_B1'), 'SD on cancelled class', null,                 'published', t.id('sd_T'), t.id('sd_T')),
      (t.id('sd_A_OTHER'),  t.id('sd_K3'), t.id('sd_B2'), 'SD other batch',      '2027-01-21T10:00:00Z', 'published', t.id('sd_T'), t.id('sd_T'));
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url) values
      (t.id('sd_A_OTHER'), t.id('sd_S2'), t.id('sd_B2'), 'https://example.sharepoint.com/sd2');
    set session_replication_role = origin;`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("RLS decides: a student sees only published assignments of their own batch, even when another batch's id is passed", async () => {
  const r = await publishedInBatches(W.sd_S1, [W.sd_B1, W.sd_B2]);
  assert.equal(r.error, null, JSON.stringify(r.error));
  assert.deepEqual(r.data.map((a) => a.id).sort(), [W.sd_A_PUB, W.sd_A_CANCEL].sort(), "no draft, no closed, nothing from the other batch");
  const pub = r.data.find((a) => a.id === W.sd_A_PUB);
  assert.deepEqual(toSource(pub).classTitle, "SD class one", "the class embed resolves");
});

test("pending = published, class not cancelled, not yet submitted (end to end on the student's own rows)", async () => {
  const s1 = (await publishedInBatches(W.sd_S1, [W.sd_B1])).data;
  const subs1 = (await as(W.sd_S1).from("assignment_submissions").select("assignment_id, student_id").in("assignment_id", s1.map((a) => a.id))).data;
  const r1 = pickPendingAssignments(s1.map(toSource), new Set(subs1.filter((s) => s.student_id === W.sd_S1).map((s) => s.assignment_id)), new Date("2027-01-15T00:00:00Z"));
  assert.deepEqual(r1.items.map((a) => [a.id, a.href]), [[W.sd_A_PUB, `/student/classes/${W.sd_K1}`]], "the cancelled-class assignment is not pending");

  const s2 = (await publishedInBatches(W.sd_S2, [W.sd_B2])).data;
  const subs2 = (await as(W.sd_S2).from("assignment_submissions").select("assignment_id, student_id").in("assignment_id", [W.sd_A_OTHER, W.sd_A_PUB])).data;
  assert.deepEqual(subs2.map((s) => s.student_id), [W.sd_S2], "only the student's own submission is visible");
  assert.equal(pickPendingAssignments(s2.map(toSource), new Set(subs2.map((s) => s.assignment_id)), new Date("2027-01-15T00:00:00Z")).total, 0, "submitted → not pending");
});

test("a withdrawn student and another student's batch: nothing visible; a trainer gets nothing from a student read", async () => {
  assert.deepEqual((await publishedInBatches(W.sd_S3, [W.sd_B1])).data, [], "withdrawn: no assignments");
  assert.deepEqual((await publishedInBatches(W.sd_S2, [W.sd_B1])).data, [], "another batch: nothing");
  const others = (await as(W.sd_S1).from("assignment_submissions").select("assignment_id, student_id").in("assignment_id", [W.sd_A_OTHER])).data;
  assert.deepEqual(others, [], "another student's submission is invisible");
  assert.ok(ids.A, "seed loaded");
});
