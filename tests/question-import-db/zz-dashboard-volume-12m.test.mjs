// 0026 — dashboard_analytics over 1 / 3 / 6 / 12 months, as the Super Admin (RLS on), with the real function.
// Two years of data at the density of the existing 6-month volume test (zz-dashboard-analytics): 4 cohorts ×
// 40 batches × 25 students, 20 classes, 10 released tests × 10 questions and 2 assignments per batch, each
// cohort over 6 months — so every window AND its comparison window are full (~400k graded answers).
// Target: 12 months ≈ ≤ 2 s on this environment; the hard limit below (3 s) only guards against regressions
// (timings vary with the machine). Historical rows are inserted by the superuser with session_replication_role
// = replica (this psql session only); removed afterwards. Own fixtures only (dv_*).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const C = randomUUID();
const TR = randomUUID();
const COHORTS = ["2022-03-01", "2022-09-01", "2023-03-01", "2023-09-01"];
const WINDOWS = {
  "1 month": ["2024-02-01", "2024-02-29"],
  "3 months": ["2023-12-01", "2024-02-29"],
  "6 months": ["2023-09-01", "2024-02-29"],
  "12 months": ["2023-03-01", "2024-02-29"],
};
let seeded = false;

test("volume: 1 / 3 / 6 / 12 months over two years of data (~40k results, ~400k graded answers, ~80k attendance) — 12 months within the target", { timeout: 1_800_000 }, async () => {
  await db.exec(`
    insert into auth.users (id, email) values ('${TR}', 'dv_tr@dv.test');
    update public.profiles set account_status = 'active', role = 'trainer' where id = '${TR}';
    insert into public.trainers (id, trainer_code, full_name) values ('${TR}', 'DV-TR', 'DV Volume Trainer');
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values ('${C}', 'DV-VOL', 'DV Volume Course', 'foundation');
    insert into public.modules (id, course_id, module_code, title, sequence)
      select gen_random_uuid(), '${C}', 'DV-M' || g, 'DV Module ' || g, g from generate_series(1, 5) g;
    create temp table vq as select gen_random_uuid() as id, g from generate_series(1, 10) g;
    insert into public.questions (id, course_id, module_id, question_text, question_type, marks, status, revision, created_by, updated_by)
      select vq.id, '${C}', (select m.id from public.modules m where m.course_id = '${C}' and m.sequence = 1 + (vq.g % 5)), 'DV q' || vq.g, 'true_false', 1, 'active', 1, '${ids.A}', '${ids.A}' from vq;
    create temp table vb as select gen_random_uuid() as id, k, g, (array[${COHORTS.map((d) => `date '${d}'`).join(", ")}])[k] as d0
      from generate_series(1, ${COHORTS.length}) k, generate_series(1, 40) g;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      select vb.id, 'DV-' || vb.k || '-' || vb.g, '${C}', '${TR}', 'DV Volume ' || vb.k || '-' || vb.g, vb.d0, vb.d0 + 183, 'completed', 30 from vb;
    create temp table vs as select gen_random_uuid() as id, vb.id as batch_id, s from vb, generate_series(1, 25) s;
    insert into public.students (id, student_code, full_name) select id, 'DV-VS-' || substr(id::text, 1, 8), 'DV Volume Student' from vs;
    insert into public.batch_students (batch_id, student_id, enrollment_status, completed_at) select batch_id, id, 'completed', '2024-03-01' from vs;
    create temp table vc as select gen_random_uuid() as id, vb.id as batch_id, c, vb.d0 + (c * 9) as d from vb, generate_series(1, 20) c;
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status)
      select id, '${C}', batch_id, '${TR}', 'DV class', d, '09:00', '10:00', 'completed' from vc;
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by, marked_at)
      select vc.id, vs.id, vc.batch_id, (array['present','present','present','late','absent','excused'])[1 + (abs(hashtext(vc.id::text || vs.id::text)) % 6)]::public.attendance_status, '${TR}', vc.d
        from vc join vs on vs.batch_id = vc.batch_id;
    create temp table vt as select gen_random_uuid() as id, vc.batch_id, vc.id as class_id, (vc.d + time '17:00') at time zone 'Asia/Kolkata' as until from vc where vc.c % 2 = 0;
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
      select id, class_id, batch_id, 'quiz', 'DV test', 'closed', 60, 30, 1, until - interval '1 day', until, '${ids.A}', '${ids.A}' from vt;
    create temp table vtq as select gen_random_uuid() as id, vt.id as test_id, vq.id as qid, vq.g from vt, vq;
    insert into public.test_questions (id, test_id, position, source_question_id, source_revision, question_text, question_type, marks, added_by)
      select id, test_id, g, qid, 1, 'DV tq', 'true_false', 1, '${ids.A}' from vtq;
    create temp table va as select gen_random_uuid() as id, vt.id as test_id, vt.batch_id, vs.id as student_id, (abs(hashtext(vt.id::text || vs.id::text)) % 11) * 10 as pct
      from vt join vs on vs.batch_id = vt.batch_id;
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at)
      select id, test_id, batch_id, student_id, 1, 'submitted', '2023-03-01T10:00:00Z', '2023-03-01T11:00:00Z', 10, 100, '2023-03-01T10:30:00Z', 'student_submit', pct, pct, pct >= 60, '2023-03-01T10:30:00Z' from va;
    insert into public.test_attempt_answers (attempt_id, test_question_id, is_correct, marks_awarded)
      select va.id, vtq.id, (vtq.g * 10 <= va.pct), case when vtq.g * 10 <= va.pct then 1 else 0 end from va join vtq on vtq.test_id = va.test_id;
    create temp table vasg as select gen_random_uuid() as id, vc.batch_id, vc.id as class_id from vc where vc.c in (5, 15);
    insert into public.class_assignments (id, class_id, batch_id, title, due_at, max_score, status, created_by, updated_by)
      select id, class_id, batch_id, 'DV work', null, 10, 'published', '${TR}', '${TR}' from vasg;
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at, score, reviewed_by, reviewed_at)
      select vasg.id, vs.id, vs.batch_id, 'https://dv.test/v', 'returned', '2023-05-01', abs(hashtext(vasg.id::text || vs.id::text)) % 11, '${TR}', '2023-05-02'
        from vasg join vs on vs.batch_id = vasg.batch_id;
    set session_replication_role = origin;
    analyze;`);
  seeded = true;
  const counts = await db.admin(`select json_build_object(
      'results', (select count(*) from public.test_attempts a join public.batches b on b.id = a.batch_id where b.course_id = '${C}'),
      'answers', (select count(*) from public.test_attempt_answers ans join public.test_attempts a on a.id = ans.attempt_id join public.batches b on b.id = a.batch_id where b.course_id = '${C}'),
      'attendance', (select count(*) from public.class_attendance x join public.batches b on b.id = x.batch_id where b.course_id = '${C}'),
      'submissions', (select count(*) from public.assignment_submissions s join public.batches b on b.id = s.batch_id where b.course_id = '${C}'))`);
  assert.ok(counts.results >= 40000 && counts.answers >= 400000 && counts.attendance >= 80000, JSON.stringify(counts));

  const claims = JSON.stringify({ sub: ids.A }).replace(/'/g, "''");
  const asAdmin = `set role authenticated; select set_config('request.jwt.claims', '${claims}', false);`;
  const timeOnce = async (sql) => {
    const r = await db.run(`${asAdmin} explain (analyze, timing off, summary on) ${sql};`);
    if (r.code) throw new Error(r.stderr);
    return Number(/Execution Time: ([\d.]+) ms/.exec(r.stdout)?.[1]);
  };
  const median3 = async (sql) => {
    const xs = [];
    for (let i = 0; i < 3; i++) xs.push(await timeOnce(sql));
    xs.sort((a, b) => a - b);
    return { median: xs[1], runs: xs };
  };
  const results = {};
  for (const [label, [from, to]] of Object.entries(WINDOWS)) {
    const { data, error } = await db.client({ role: "authenticated", userId: ids.A }).rpc("dashboard_analytics", { p_from: from, p_to: to });
    assert.equal(error, null, `${label}: accepted by the real function`);
    // The volume rows in the window (other test files' historical fixtures may add a few more).
    assert.ok(data.totals.current.results >= { "1 month": 2000, "3 months": 5000, "6 months": 10000, "12 months": 20000 }[label], `${label}: ${data.totals.current.results} results`);
    const t = await median3(`select public.dashboard_analytics('${from}', '${to}', 10)`);
    results[label] = { days: data.period.days, bucket: data.period.bucket, buckets: data.trend.length, results: data.totals.current.results, comparison_results: data.totals.previous.results, median_ms: t.median, runs_ms: t.runs };
  }
  console.log(`[volume-12m] data: ${JSON.stringify(counts)}`);
  for (const [label, r] of Object.entries(results)) console.log(`[volume-12m] dashboard_analytics, ${label}, Super Admin (RLS on), median of 3: ${r.median_ms} ms ${JSON.stringify(r)}`);

  assert.deepEqual([results["12 months"].days, results["12 months"].bucket, results["12 months"].buckets], [366, "month", 12]);
  assert.ok(results["12 months"].results > 0 && results["12 months"].comparison_results > 0, "both 12-month windows are full");
  assert.ok(results["6 months"].median_ms <= 2000, `6 months: ${results["6 months"].median_ms} ms (target ≤ 2000 ms)`);
  assert.ok(results["12 months"].median_ms <= 3000, `12 months: ${results["12 months"].median_ms} ms (target ≈ ≤ 2000 ms; regression limit 3000 ms)`);
});

after(async () => {
  if (!seeded) return;
  // Remove the volume rows (this psql session only, triggers skipped) so later test files see the usual data.
  await db.exec(`
    set session_replication_role = replica;
    delete from public.assignment_submissions s using public.batches b where b.id = s.batch_id and b.course_id = '${C}';
    delete from public.class_assignments x using public.batches b where b.id = x.batch_id and b.course_id = '${C}';
    delete from public.test_attempt_answers ans using public.test_attempts a, public.batches b where a.id = ans.attempt_id and b.id = a.batch_id and b.course_id = '${C}';
    delete from public.test_attempts a using public.batches b where b.id = a.batch_id and b.course_id = '${C}';
    delete from public.test_questions tq using public.tests t, public.batches b where t.id = tq.test_id and b.id = t.batch_id and b.course_id = '${C}';
    delete from public.tests t using public.batches b where b.id = t.batch_id and b.course_id = '${C}';
    delete from public.class_attendance x using public.batches b where b.id = x.batch_id and b.course_id = '${C}';
    delete from public.classes c where c.course_id = '${C}';
    delete from public.batch_students bs using public.batches b where b.id = bs.batch_id and b.course_id = '${C}';
    delete from public.students s where s.student_code like 'DV-VS-%';
    delete from public.batches where course_id = '${C}';
    delete from public.questions where course_id = '${C}';
    delete from public.modules where course_id = '${C}';
    delete from public.courses where id = '${C}';
    set session_replication_role = origin;`);
});
