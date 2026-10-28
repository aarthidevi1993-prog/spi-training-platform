// Super Admin dashboard (D1) — the dashboard repository's row reads against the real schema with
// 0001–0023, through the Super Admin's own session client (RLS applies). This stand-in resolves
// resource embeds from the real foreign keys and refuses a missing relationship, exactly like
// PostgREST (PGRST200) — the D1 Dev failure: `tests` has no foreign key to `batches` (its batch_id
// is only part of the composite key to classes), so the batch name must come through `classes`.
// Count queries (head: true) are not covered here; the fake-client unit tests cover their shape.
// Own fixtures only (ad_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createDashboardRepository, DashboardPermissionError, DashboardValidationError } = await import(`${build}/repositories/dashboard.repository.core.mjs`);
const lib = await import(`${build}/lib/dashboard/admin-dashboard.mjs`);
const analytics = await import(`${build}/lib/dashboard/analytics.mjs`);
const periods = await import(`${build}/lib/dashboard/periods.mjs`);

let U = {};
const TEST_SCHEDULED = randomUUID();
const TEST_OPEN = randomUUID();
const repoAs = (userId) => createDashboardRepository(async () => db.client({ role: "authenticated", userId }));
const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = saved; }
};

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'ad_' || k, gen_random_uuid() from unnest(array['TR','C','B','CL1','CL2']) k;
    insert into auth.users (id, email) values (t.id('ad_TR'), 'ad_tr@ad.test');
    update public.profiles set account_status = 'active', role = 'trainer' where id = t.id('ad_TR');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ad_TR'), 'AD-TR', 'AD Trainer');
    insert into public.courses (id, course_code, title, level) values (t.id('ad_C'), 'AD-101', 'Dashboard Course', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values (t.id('ad_B'), 'AD-B', t.id('ad_C'), t.id('ad_TR'), 'AD Batch', '2026-01-01', '2099-12-31', 'ongoing', 10);
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time) values
      (t.id('ad_CL1'), t.id('ad_C'), t.id('ad_B'), t.id('ad_TR'), 'AD class today', current_date, '09:00', '10:00'),
      (t.id('ad_CL2'), t.id('ad_C'), t.id('ad_B'), t.id('ad_TR'), 'AD class later', '2099-06-01', '11:00', '12:00');
    insert into t.ids values ('ad_q1', public.save_question(t.p(t.id('ad_C'), 'true_false', 1, t.opts('True*','False'), 'AD: dashboards read real data.')));
    select public.set_question_status(t.id('ad_q1'), 'active');`, ids.A);
  // One test opening in the future (scheduled) and one already open; both published, window not ended.
  await db.exec(`
    insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ('${TEST_SCHEDULED}', t.id('ad_CL2'), t.id('ad_B'), 'quiz', 'AD scheduled test', 50, 30, 1, now() + interval '2 days', now() + interval '3 days', t.id('ad_TR'), t.id('ad_TR')),
      ('${TEST_OPEN}', t.id('ad_CL1'), t.id('ad_B'), 'module_test', 'AD open test', 50, 30, 1, now() - interval '1 minute', now() + interval '2 hours', t.id('ad_TR'), t.id('ad_TR'));
    select public.add_test_questions('${TEST_SCHEDULED}', array[t.id('ad_q1')]);
    select public.add_test_questions('${TEST_OPEN}', array[t.id('ad_q1')]);
    update public.tests set status = 'scheduled' where id = '${TEST_SCHEDULED}';
    update public.tests set status = 'active' where id = '${TEST_OPEN}';`, U.ad_TR ?? (await db.admin("select t.id('ad_TR')")));
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("upcoming tests: the published tests read through the Super Admin's session with the batch name (via classes), bounded", async () => {
  const rows = await quiet(() => repoAs(ids.A).listUpcomingTests(new Date().toISOString(), 50));
  const mine = rows.filter((r) => r.id === TEST_SCHEDULED || r.id === TEST_OPEN);
  assert.deepEqual(
    mine.map((r) => [r.title, r.status, r.test_type, r.batch_name]).sort(),
    [["AD open test", "active", "module_test", "AD Batch"], ["AD scheduled test", "scheduled", "quiz", "AD Batch"]],
    "both tests, each with its batch name"
  );
  assert.ok(rows.every((r) => r.status === "scheduled" || r.status === "active"), "published only");
  assert.ok(rows.every((r) => r.available_until && new Date(r.available_until).getTime() > Date.now()), "window not ended");
  assert.ok((await repoAs(ids.A).listUpcomingTests(new Date().toISOString(), 1)).length <= 1, "bounded");
});

test("the other embedded dashboard reads resolve against the real schema too (classes → batches, batches → courses / trainers / enrolments)", async () => {
  const repo = repoAs(ids.A);
  const today = await db.admin("select to_char(current_date, 'YYYY-MM-DD')");
  assert.ok((await repo.listClassesOn(today, 50)).some((c) => c.title === "AD class today" && c.batch_name === "AD Batch"));
  assert.ok((await repo.listUpcomingClasses(today, 50)).some((c) => c.title === "AD class later" && c.batch_name === "AD Batch"));
  const current = await repo.listCurrentBatches();
  const b = current.find((x) => x.id === U.ad_B);
  assert.deepEqual([b?.course, b?.trainerStatus, b?.trainerRole, b?.trainerAccountStatus, b?.seatsUsed], ["Dashboard Course", "active", "trainer", "active", 0]);
});

// ---------------------------------------------------------------- D2a: comparisons and health inputs

test("D2a counts: Super Admin head counts equal the database's own counts (no 1000-row cap, nothing transferred)", async () => {
  const repo = repoAs(ids.A);
  const today = await db.admin("select to_char(current_date, 'YYYY-MM-DD')");
  const lastWeek = periods.addDays(today, -7);
  const truth = (date) => db.admin(`select count(*) from public.classes where class_date = '${date}' and status <> 'cancelled'`);
  assert.equal(await repo.countClassesOn(today), await truth(today));
  assert.equal(await repo.countClassesOn(lastWeek), await truth(lastWeek));
  assert.equal(await repo.countCompletionsAwaitingApproval(), await db.admin("select count(*) from public.completion_records where status = 'recommended'"));
  assert.equal(await repo.countActiveAccounts("student"), await db.admin("select count(*) from public.profiles where role = 'student' and account_status = 'active'"));
  const current = await repo.listCurrentBatches();
  assert.equal(current.find((x) => x.id === U.ad_B)?.startDate, "2026-01-01", "start date for the capacity rule");
});

const DAY_MS = 24 * 60 * 60 * 1000;

test("D2a pending approvals 7 days ago: rebuilt from the real completion_events log (recommendations, decisions, a withdrawal, a re-recommendation)", async () => {
  const repo = repoAs(ids.A);
  const T = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const measure = async () => {
    const [now_, events] = await Promise.all([repo.countCompletionsAwaitingApproval(), repo.listCompletionStatusEventsAfter(T)]);
    return { now: now_, atT: lib.pendingApprovalsAt(now_, events) };
  };
  const before = await measure();

  await db.exec(`
    insert into t.ids (k, v) select 'ad_' || k, gen_random_uuid() from unnest(array['S1','S2','S3','S4','S5','S6','S7','R1','R2','R3','R4','R5','R6','R7']) k;
    insert into auth.users (id, email) select v, lower(k) || '@ad.test' from t.ids where k in ('ad_S1','ad_S2','ad_S3','ad_S4','ad_S5','ad_S6','ad_S7');
    update public.profiles set account_status = 'active' where id in (select v from t.ids where k in ('ad_S1','ad_S2','ad_S3','ad_S4','ad_S5','ad_S6','ad_S7'));
    insert into public.students (id, student_code, full_name) select v, upper(k), 'AD ' || k from t.ids where k in ('ad_S1','ad_S2','ad_S3','ad_S4','ad_S5','ad_S6','ad_S7');
    insert into public.batch_students (batch_id, student_id) select t.id('ad_B'), v from t.ids where k in ('ad_S1','ad_S2','ad_S3','ad_S4','ad_S5','ad_S6','ad_S7');`, ids.A);
  // Controlled times: superuser, this psql session only (the replication role skips the triggers that stamp now()).
  await db.exec(`
    set session_replication_role = replica;
    insert into public.completion_records (id, batch_id, student_id, status, recommended_by, recommended_at, eligibility_at_recommendation, decided_by, decided_at, decision_note, eligibility_at_decision, completion_date) values
      (t.id('ad_R1'), t.id('ad_B'), t.id('ad_S1'), 'recommended', t.id('ad_TR'), now() - interval '10 days', '{}', null, null, null, null, null),
      (t.id('ad_R2'), t.id('ad_B'), t.id('ad_S2'), 'recommended', t.id('ad_TR'), now() - interval '1 day',   '{}', null, null, null, null, null),
      (t.id('ad_R3'), t.id('ad_B'), t.id('ad_S3'), 'approved',    t.id('ad_TR'), now() - interval '10 days', '{}', t.id('A'), now() - interval '2 days', null, '{}', current_date),
      (t.id('ad_R4'), t.id('ad_B'), t.id('ad_S4'), 'rejected',    t.id('ad_TR'), now() - interval '10 days', '{}', t.id('A'), now() - interval '8 days', 'Not yet', null, null),
      (t.id('ad_R5'), t.id('ad_B'), t.id('ad_S5'), 'withdrawn',   t.id('ad_TR'), now() - interval '10 days', '{}', null, null, null, null, null),
      (t.id('ad_R6'), t.id('ad_B'), t.id('ad_S6'), 'recommended', t.id('ad_TR'), now() - interval '1 day',   '{}', null, null, null, null, null),
      (t.id('ad_R7'), t.id('ad_B'), t.id('ad_S7'), 'approved',    t.id('ad_TR'), now() - interval '10 days', '{}', t.id('A'), now() - interval '6 days', null, '{}', current_date);
    insert into public.completion_events (occurred_at, event_type, actor_id, batch_id, student_id, completion_id, detail)
    select now() - e.ago, e.kind::public.completion_event_type, t.id(e.actor), t.id('ad_B'), t.id(e.s), t.id(e.r),
           jsonb_build_object('status', e.st, 'previous_status', e.prev)
      from (values
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S1', 'ad_R1', 'recommended', null),
        (interval '1 day',   'recommended', 'ad_TR', 'ad_S2', 'ad_R2', 'recommended', null),
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S3', 'ad_R3', 'recommended', null),
        (interval '2 days',  'approved',    'A',     'ad_S3', 'ad_R3', 'approved',    'recommended'),
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S4', 'ad_R4', 'recommended', null),
        (interval '8 days',  'rejected',    'A',     'ad_S4', 'ad_R4', 'rejected',    'recommended'),
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S5', 'ad_R5', 'recommended', null),
        (interval '3 days',  'recommendation_withdrawn', 'ad_TR', 'ad_S5', 'ad_R5', 'withdrawn', 'recommended'),
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S6', 'ad_R6', 'recommended', null),
        (interval '9 days',  'rejected',    'A',     'ad_S6', 'ad_R6', 'rejected',    'recommended'),
        (interval '1 day',   'recommended', 'ad_TR', 'ad_S6', 'ad_R6', 'recommended', 'rejected'),
        (interval '10 days', 'recommended', 'ad_TR', 'ad_S7', 'ad_R7', 'recommended', null),
        (interval '6 days',  'approved',    'A',     'ad_S7', 'ad_R7', 'approved',    'recommended')
      ) as e(ago, kind, actor, s, r, st, prev)
     order by e.ago desc;
    set session_replication_role = origin;`);
  U = await db.admin("select json_object_agg(k, v) from t.ids");

  const after = await measure();
  // Pending now: R1, R2, R6 (re-recommended). Pending at T: R1, R3 (approved since), R5 (withdrawn since), R7 (approved since);
  // not R2 (recommended after T), R4 (rejected before T) or R6 (rejected at T).
  assert.equal(after.now - before.now, 3, "pending now");
  assert.equal(after.atT - before.atT, 4, "pending 7 days ago");
});

test("D2a RLS: the same reads under a student's or an unrelated trainer's session see none of these completions (no leakage)", async () => {
  await db.exec(`
    insert into t.ids (k, v) values ('ad_TR2', gen_random_uuid());
    insert into auth.users (id, email) values (t.id('ad_TR2'), 'ad_tr2@ad.test');
    update public.profiles set account_status = 'active', role = 'trainer' where id = t.id('ad_TR2');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('ad_TR2'), 'AD-TR2', 'AD Other Trainer');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
  const T = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const fixtureIds = [U.ad_R1, U.ad_R2, U.ad_R3, U.ad_R4, U.ad_R5, U.ad_R6, U.ad_R7];
  for (const who of ["ad_S1", "ad_TR2"]) {
    const repo = repoAs(U[who]);
    assert.ok(!(await repo.listCompletionStatusEventsAfter(T)).some((e) => fixtureIds.includes(e.completionId)), `${who}: no fixture events`);
    assert.equal(await repo.countCompletionsAwaitingApproval(), 0, `${who}: no batches of their own → nothing visible`);
  }
  // The batch's own trainer sees them (RLS decides, not the dashboard; the dashboard service itself is Super Admin only).
  assert.ok((await repoAs(U.ad_TR).listCompletionStatusEventsAfter(T)).some((e) => e.completionId === U.ad_R1));
});

// ---------------------------------------------------------------- D2b-2A: the real dashboard_analytics response through the repository

test("D2b-2A / 2B / 2C: getAnalytics returns the real 0024 response through the Super Admin's session, and it passes the app's validator; batch / course / student rows keep its order", async () => {
  const today = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  const currentRankings = {};
  const progressByPeriod = {};
  for (const key of periods.PERIOD_KEYS) {
    const range = periods.periodRange(key, today);
    const json = await repoAs(ids.A).getAnalytics(range.from, range.to, analytics.ANALYTICS_LIST_LIMIT);
    const raw = analytics.parseAnalytics(json);
    assert.deepEqual([raw.period.from, raw.period.to], [range.from, range.to], key);
    const prev = periods.previousComparable(range);
    assert.deepEqual([raw.period.prev_from, raw.period.prev_to], [prev.from, prev.to], `${key}: the database derives the same comparison period as the app`);
    const panels = analytics.buildAnalyticsPanels(raw, key);
    assert.equal(panels.performance.length, 4);
    assert.ok(panels.trend.length >= 1);
    assert.equal(analytics.analyticsHealth(raw.health).length, 4);
    // D2b-2B: batch / course comparison from the same response — the function's order kept, bounded, totals from the database
    for (const [list, rawRows, total, idOf, nameOf] of [
      [panels.batches, raw.batches, raw.batches_total, (r) => r.id, (r) => r.name],
      [panels.courses, raw.courses, raw.courses_total, (r) => r.id, (r) => r.title],
    ]) {
      assert.ok(list.rows.length <= analytics.ANALYTICS_LIST_LIMIT, `${key}: at most ${analytics.ANALYTICS_LIST_LIMIT} rows`);
      assert.deepEqual(list.rows.map(idOf), rawRows.map(idOf), `${key}: rows in the function's order, never re-ranked`);
      const names = rawRows.map(nameOf);
      assert.deepEqual(names, [...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), `${key}: the function returns name order`);
      assert.equal(list.total, total);
      assert.equal(list.shownText, total > list.rows.length ? `Showing ${list.rows.length} of ${total}` : null);
    }
    assert.ok(raw.batches_total >= 1, `${key}: the ongoing AD Batch is always in scope`);
    assert.ok(raw.batches.some((b) => b.id === U.ad_B) || raw.batches_total > raw.batches.length, `${key}: AD Batch listed or beyond the limit`);
    for (const b of panels.batches.rows) {
      assert.equal(b.href, `/admin/batches/${b.id}`);
      assert.equal(b.performanceHref, `/admin/performance?batch=${b.id}`);
      assert.ok(b.testAvg.value !== null || b.testAvg.display === `Insufficient data (${b.testAvg.evidence})`);
    }
    for (const c of panels.courses.rows) assert.equal(c.href, `/admin/courses/${c.id}`);
    // D2b-2C: Student Performance — the real 0027 students.current passes the parser; database order, at most 5, ≥ 3 results
    const st = panels.students;
    assert.ok(raw.students.current.length <= analytics.STUDENT_PERFORMANCE_LIMIT, `${key}: at most 5`);
    assert.deepEqual(st.rows.map((r) => [r.rank, r.id]), raw.students.current.map((r, i) => [i + 1, r.id]), `${key}: the database's rank order`);
    assert.ok(raw.students.current.every((r) => r.results >= 3), `${key}: 3 or more released results`);
    assert.equal(st.insufficient, raw.students.current.length === 0);
    assert.equal(st.caption, `Current ranking: last 366 days · trend: ${periods.PERIOD_LABEL[key]} vs previous`);
    for (const r of st.rows) assert.equal(r.trendDirection, analytics.trendDirection(r.trend));
    assert.deepEqual(raw.students.current_window, { from: periods.addDays(today, -365), to: today }, `${key}: the trailing 366-day window`);
    currentRankings[key] = raw.students.current.map((r) => [r.rank, r.id, r.average, r.results]);
    // D2b-2D: Course Progress — the real delivery / enrolment lists parse, join by course id and keep every course
    const pr = panels.progress;
    const courseIds = [...raw.delivery.map((d) => d.course_id), ...raw.enrolment.map((e) => e.course_id).filter((id) => !raw.delivery.some((d) => d.course_id === id))];
    assert.deepEqual(pr.rows.map((r) => r.courseId), courseIds, `${key}: delivery order, then enrolment-only courses; none dropped`);
    for (const r of pr.rows) {
      const d = raw.delivery.find((x) => x.course_id === r.courseId);
      const e = raw.enrolment.find((x) => x.course_id === r.courseId);
      assert.deepEqual(r.delivery && [r.delivery.planned, r.delivery.delivered, r.delivery.overdue, r.delivery.percent], d ? [d.planned, d.delivered, d.overdue, analytics.progressPercent(d.delivered, d.planned)] : null);
      assert.deepEqual(r.enrolment && [r.enrolment.completed, r.enrolment.active, r.enrolment.percent], e ? [e.completed, e.active, analytics.progressPercent(e.completed, e.active)] : null);
    }
    assert.deepEqual([pr.deliveryTotal, pr.enrolmentTotal], [raw.delivery_total, raw.enrolment_total]);
    progressByPeriod[key] = pr;
  }
  // Course Progress is current state: identical for every dashboard period.
  for (const key of periods.PERIOD_KEYS) assert.deepEqual(progressByPeriod[key], progressByPeriod.this_month, `${key}: same Course Progress as this_month`);
  // The current ranking is the same for every dashboard period (only the trend follows the period).
  for (const key of periods.PERIOD_KEYS) assert.deepEqual(currentRankings[key], currentRankings.this_month, `${key}: same current ranking as this_month`);
});

test("D2b-2A: the database's refusals map to the repository's typed errors — trainer → permission, future end date → validation", async () => {
  const today = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  await quiet(async () => {
    await assert.rejects(repoAs(U.ad_TR).getAnalytics(periods.monthStart(today), today, 10), DashboardPermissionError);
    await assert.rejects(repoAs(ids.A).getAnalytics(today, periods.addDays(today, 1), 10), DashboardValidationError, "the midnight-edge error the service retries");
  });
});
