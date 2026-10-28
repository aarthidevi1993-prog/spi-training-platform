// D2b-1 — migration 0024: public.dashboard_analytics(p_from, p_to, p_limit) against the real schema.
// Security (Super Admin only, INVOKER, STABLE, empty search_path, exact grants), validation, the
// comparison period, India-time boundaries, buckets, released / best results, batch and course
// aggregation with evidence minimums, student rankings (3-result rule, half split, ±5 thresholds),
// period-aware weak topics, class delivery, enrolment completion, assignments, health inputs,
// zero data, caps, no private data — plus a seeded volume run with its execution time.
//
// The fixture is historical (March 2024 and its comparison window), so data created "now" by the
// other test files never reaches these periods. Historical rows are inserted by the superuser with
// session_replication_role = replica (this psql session only: the workflow triggers that stamp now()
// and enforce live rules are skipped; check constraints still apply). Own fixtures only (dx_*).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const rows = (list) => list.map((r) => `(${r.map(q).join(", ")})`).join(",\n");

const call = async (userId, args) => {
  const client = userId === null ? db.client({ role: "anon" }) : db.client({ role: "authenticated", userId });
  return client.rpc("dashboard_analytics", args);
};
const run = async (args, userId = ids.A) => {
  const { data, error } = await call(userId, args);
  if (error) throw Object.assign(new Error(`${error.code} ${error.message}`), { code: error.code });
  return data;
};
const MARCH = { p_from: "2024-03-01", p_to: "2024-03-31" };
const mine = (list, key = "id") => list.filter((r) => Object.values(X).includes(r[key]));

// ---------------------------------------------------------------- fixture
const STUDENTS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"];
const ENROL = [ // batch, student, status (current state)
  ["B1", "S1", "enrolled"], ["B1", "S2", "enrolled"], ["B1", "S3", "enrolled"], ["B1", "S4", "withdrawn"], ["B1", "S5", "enrolled"], ["B1", "S6", "completed"],
  ["B2", "S7", "completed"], ["B2", "S8", "completed"], ["B2", "S9", "completed"],
  ["B3", "S11", "enrolled"], ["B4", "S10", "enrolled"], ["B5", "S12", "enrolled"],
];
const CLASSES = [ // key, batch, course, date, status
  ["K0", "B1", "C1", "2024-02-15", "completed"], ["K1", "B1", "C1", "2024-03-04", "completed"], ["K2", "B1", "C1", "2024-03-11", "completed"],
  ["K3", "B1", "C1", "2024-03-18", "completed"], ["K4", "B1", "C1", "2024-03-25", "completed"], ["K5", "B1", "C1", "2024-03-20", "cancelled"],
  ["K6", "B2", "C1", "2024-03-09", "completed"],
  ["L1", "B3", "C2", "2099-01-01", "scheduled"], ["L2", "B3", "C2", "2024-03-05", "cancelled"], ["L3", "B3", "C2", "2024-03-01", "scheduled"],
  ["L4", "B3", "C2", "2024-03-02", "completed"], ["L5", "B3", "C2", "2024-03-03", "scheduled"],
  ["L6", "B4", "C2", "2024-02-28", "completed"],
];
const TESTS = [ // key, class, batch, status, available_until (released_at)
  ["T0", "K0", "B1", "closed", "2024-02-20T10:00:00+05:30"],
  ["T1", "K1", "B1", "active", "2024-03-05T10:00:00+05:30"], ["T2", "K2", "B1", "active", "2024-03-12T10:00:00+05:30"],
  ["T3", "K3", "B1", "closed", "2024-03-19T10:00:00+05:30"], ["T4", "K4", "B1", "closed", "2024-03-26T10:00:00+05:30"],
  ["T5", "K4", "B1", "closed", "2024-03-30T10:00:00+05:30"],
  ["T7", "K3", "B1", "draft", "2024-03-20T10:00:00+05:30"], // not released (draft)
  ["T8", "K4", "B1", "closed", "2024-04-05T10:00:00+05:30"], // released after the period (no leakage)
  ["T9", "K6", "B2", "closed", "2024-03-10T10:00:00+05:30"],
  ["TB", "L6", "B4", "closed", "2024-02-29T18:30:00Z"],     // = 01 Mar 2024 00:00 in India → March
  ["TC", "L6", "B4", "closed", "2024-02-29T18:29:59Z"],     // = 29 Feb 2024 23:59:59 in India → comparison period
];
// key, test, student, attempt number, percentage (null = in progress)
const ATTEMPTS = [
  ["T0S1", "T0", "S1", 1, 40], ["T0S2", "T0", "S2", 1, 60], ["T0S3", "T0", "S3", 1, 50], ["T0S4", "T0", "S4", 1, 70], ["T0S5", "T0", "S5", 1, 80],
  ["T1S1a", "T1", "S1", 1, 40], ["T1S1", "T1", "S1", 2, 50], ["T1S2", "T1", "S2", 1, 90], ["T1S3", "T1", "S3", 1, 70], ["T1S4", "T1", "S4", 1, 80], ["T1S5", "T1", "S5", 1, 60], ["T1S6", "T1", "S6", 1, 100],
  ["T2S1", "T2", "S1", 1, 55], ["T2S2", "T2", "S2", 1, 85], ["T2S3", "T2", "S3", 1, 72], ["T2S4", "T2", "S4", 1, 77], ["T2S5", "T2", "S5", 1, 62], ["T2S6", "T2", "S6", 1, 100],
  ["T3S1", "T3", "S1", 1, 60], ["T3S2", "T3", "S2", 1, 80], ["T3S3", "T3", "S3", 1, 75], ["T3S4", "T3", "S4", 1, 75], ["T3S5", "T3", "S5", 1, 64],
  ["T4S1", "T4", "S1", 1, 70], ["T4S2", "T4", "S2", 1, 70],
  ["T5S1", "T5", "S1", 1, 80], ["T5S2", "T5", "S2", 1, null],
  ["T7S3", "T7", "S3", 1, 0],
  ["T8S1", "T8", "S1", 1, 100],
  ["T9S7", "T9", "S7", 1, 70], ["T9S8", "T9", "S8", 1, 80], ["T9S9", "T9", "S9", 1, 90],
  ["TBS10", "TB", "S10", 1, 65], ["TCS10", "TC", "S10", 1, 55],
];
const ATTENDANCE = [ // class, student, status
  ["K0", "S1", "present"], ["K0", "S2", "present"], ["K0", "S3", "present"], ["K0", "S4", "present"], ["K0", "S5", "present"],
  ["K1", "S1", "present"], ["K1", "S2", "present"], ["K1", "S3", "absent"], ["K1", "S4", "present"], ["K1", "S5", "present"],
  ["K2", "S1", "present"], ["K2", "S2", "late"], ["K2", "S3", "absent"], ["K2", "S4", "present"], ["K2", "S5", "present"],
  ["K3", "S1", "present"], ["K3", "S2", "absent"], ["K3", "S3", "present"], ["K3", "S4", "present"],
  ["K4", "S1", "present"], ["K4", "S2", "excused"],
  ["K5", "S5", "present"], // cancelled class: excluded
  ["L3", "S11", "present"],
];
// key, class, batch, due_at, max_score
const ASSIGNMENTS = [
  ["A1", "K1", "B1", "2024-03-08T10:00:00+05:30", 10], ["A2", "K2", "B1", null, 20], ["A3", "K4", "B1", "2024-04-02T10:00:00+05:30", 10],
  ["A4", "K1", "B1", "2024-02-29T18:30:00Z", 10], ["A5", "K0", "B1", "2024-02-29T18:29:59Z", 10],
];
// assignment, student, status, score, submitted_at (SQL expression)
const SUBMISSIONS = [
  ["A1", "S1", "returned", 9, "'2024-03-07T10:00:00+05:30'"], ["A1", "S2", "returned", 8, "'2024-03-07T10:00:00+05:30'"],
  ["A1", "S3", "returned", 7, "'2024-03-07T10:00:00+05:30'"], ["A1", "S4", "returned", 6, "'2024-03-07T10:00:00+05:30'"],
  ["A1", "S5", "returned", 5, "'2024-03-07T10:00:00+05:30'"], ["A1", "S6", "submitted", null, "'2024-03-09T10:00:00+05:30'"],
  ["A2", "S1", "returned", 20, "'2024-03-12T10:00:00+05:30'"],
  ["A2", "S5", "submitted", null, "now() - interval '2 days'"],
  ["A2", "S2", "submitted", null, "(((now() at time zone 'Asia/Kolkata')::date - 7) + time '12:00') at time zone 'Asia/Kolkata'"], // exactly 7 days: not waiting
  ["A2", "S3", "submitted", null, "(((now() at time zone 'Asia/Kolkata')::date - 8) + time '12:00') at time zone 'Asia/Kolkata'"], // 8 days: waiting
  ["A3", "S1", "returned", 10, "'2024-04-01T10:00:00+05:30'"],
  ["A4", "S2", "returned", 10, "'2024-03-01T10:00:00+05:30'"],
  ["A5", "S3", "returned", 5, "'2024-02-28T10:00:00+05:30'"],
];
// Topics on T1 (current) and T0 (comparison): key, test, question key, marks
const TEST_QUESTIONS = [["tq1", "T1", "Q1", 2], ["tq2", "T1", "Q2", 2], ["tq3", "T1", "Q3", 1], ["tq4", "T1", "Q4", 1], ["tq5", "T1", "Q5", 10], ["tq0", "T0", "Q1", 2]];
const QUESTIONS = [["Q1", "M1"], ["Q2", "M2"], ["Q3", "M3"], ["Q4", null], ["Q5", "M4"]];
const ANSWERS = [ // attempt, test question, marks (null = ungraded)
  ["T1S1", "tq1", 0], ["T1S2", "tq1", 0], ["T1S3", "tq1", 0], ["T1S4", "tq1", 0], ["T1S5", "tq1", 2], ["T1S6", "tq1", 2],
  ["T1S1", "tq2", 2], ["T1S2", "tq2", 2], ["T1S3", "tq2", 2], ["T1S4", "tq2", 2], ["T1S5", "tq2", 2], ["T1S6", "tq2", 1],
  ["T1S1", "tq3", 1], ["T1S2", "tq3", 1], ["T1S3", "tq3", 1], ["T1S4", "tq3", 1],
  ["T1S1", "tq4", 1], ["T1S2", "tq4", 1], ["T1S3", "tq4", 1], ["T1S4", "tq4", 1], ["T1S5", "tq4", 1], ["T1S6", "tq4", 1],
  ["T1S1", "tq5", 7], ["T1S2", "tq5", 7], ["T1S3", "tq5", 7], ["T1S4", "tq5", 7], ["T1S5", "tq5", 7], ["T1S6", "tq5", null],
  ["T1S1a", "tq1", 2], // a non-best attempt: never counted
  ["T0S1", "tq0", 2], ["T0S2", "tq0", 2], ["T0S3", "tq0", 2], ["T0S4", "tq0", 2], ["T0S5", "tq0", 2], // comparison period: not counted
];
const BATCHES = [["B1", "0-DX Batch A", "C1", "ongoing"], ["B2", "0-DX Batch B", "C1", "completed"], ["B3", "0-DX Batch C", "C2", "upcoming"], ["B4", "0-DX Batch D", "C2", "ongoing"], ["B5", "0-DX Batch E", "C2", "cancelled"]];

before(async () => {
  for (const k of [...STUDENTS, "TR", "SUSP"]) id(k);
  // Accounts through the normal path (profiles come from the auth trigger).
  await db.exec(`
    insert into auth.users (id, email) values ${rows([...STUDENTS, "TR", "SUSP"].map((k) => [id(k), `${k.toLowerCase()}@dx.test`]))};
    update public.profiles set account_status = 'active' where id in (${[...STUDENTS, "TR"].map((k) => q(id(k))).join(", ")});
    update public.profiles set role = 'trainer' where id = ${q(id("TR"))};
    update public.profiles set role = 'super_admin', account_status = 'suspended' where id = ${q(id("SUSP"))};
    insert into public.trainers (id, trainer_code, full_name) values (${q(id("TR"))}, 'DX-TR', 'DX Trainer');
    insert into public.students (id, student_code, full_name) values ${rows(STUDENTS.map((k) => [id(k), `DX-${k}`, `DX Student ${k}`]))};`, ids.A);
  // Historical training data.
  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values (${q(id("C1"))}, 'DX-C1', '0-DX Course One', 'foundation'), (${q(id("C2"))}, 'DX-C2', '0-DX Course Two', 'foundation');
    insert into public.modules (id, course_id, module_code, title, sequence) values
      ${rows(["M1", "M2", "M3", "M4"].map((m, i) => [id(m), id("C1"), `DX-${m}`, `DX Module ${m}`, i + 1]))};
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      ${rows(BATCHES.map(([k, name, c, status]) => [id(k), `DX-${k}`, id(c), id("TR"), name, "2024-01-01", "2024-12-31", status, 30]))};
    insert into public.batch_students (batch_id, student_id, enrollment_status, completed_at) values
      ${rows(ENROL.map(([b, s, st]) => [id(b), id(s), st, st === "completed" ? "2024-04-01T00:00:00Z" : null]))};
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      ${rows(CLASSES.map(([k, b, c, d, st]) => [id(k), id(c), id(b), id("TR"), `DX class ${k}`, d, "09:00", "10:00", st]))};
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ${rows(TESTS.map(([k, c, b, st, until]) => [id(k), id(c), id(b), "quiz", `DX test ${k}`, st, 60, 30, 3, "2024-01-01T00:00:00Z", until, ids.A, ids.A]))};
    insert into public.questions (id, course_id, module_id, question_text, question_type, marks, status, revision, created_by, updated_by) values
      ${rows(QUESTIONS.map(([k, m]) => [id(k), id("C1"), m ? id(m) : null, `DX question ${k}`, "true_false", 1, "active", 1, ids.A, ids.A]))};
    insert into public.test_questions (id, test_id, position, source_question_id, source_revision, question_text, question_type, marks, added_by) values
      ${rows(TEST_QUESTIONS.map(([k, t, qk, marks], i) => [id(k), id(t), i + 1, id(qk), 1, `DX ${k}`, "true_false", marks, ids.A]))};
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at) values
      ${rows(ATTEMPTS.map(([k, t, s, n, pct]) => {
        const b = TESTS.find((x) => x[0] === t)[2];
        return pct === null
          ? [id(k), id(t), id(b), id(s), n, "in_progress", "2024-03-29T10:00:00Z", "2024-03-29T11:00:00Z", 5, 100, null, null, null, null, null, null]
          : [id(k), id(t), id(b), id(s), n, "submitted", "2024-01-01T10:00:00Z", "2024-01-01T11:00:00Z", 5, 100, "2024-01-01T10:30:00Z", "student_submit", pct, pct, pct >= 60, "2024-01-01T10:30:00Z"];
      }))};
    insert into public.test_attempt_answers (attempt_id, test_question_id, is_correct, marks_awarded) values
      ${rows(ANSWERS.map(([a, tq, m]) => [id(a), id(tq), m === null ? null : m > 0, m]))};
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by, marked_at) values
      ${rows(ATTENDANCE.map(([c, s, st]) => [id(c), id(s), id(CLASSES.find((x) => x[0] === c)[1]), st, id("TR"), "2024-03-01T00:00:00Z"]))};
    insert into public.class_assignments (id, class_id, batch_id, title, due_at, max_score, status, created_by, updated_by) values
      ${rows(ASSIGNMENTS.map(([k, c, b, due, max]) => [id(k), id(c), id(b), `DX ${k}`, due, max, "published", id("TR"), id("TR")]))};
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at, score, reviewed_by, reviewed_at)
    select a, s, b, 'https://dx.test/work', st, sub, sc, case when st = 'returned' then ${q(id("TR"))}::uuid end, case when st = 'returned' then sub end
      from (values ${SUBMISSIONS.map(([a, s, st, sc, sub]) => `(${q(id(a))}::uuid, ${q(id(s))}::uuid, ${q(id("B1"))}::uuid, ${q(st)}::public.submission_status, (${sub})::timestamptz,${sc === null ? "null" : sc}::numeric)`).join(",\n")})
           as v(a, s, b, st, sub, sc);
    set session_replication_role = origin;`);
});

// ---------------------------------------------------------------- security

test("security: an active Super Admin may run it; anon, trainer, student and a suspended Super Admin are refused (42501)", async () => {
  assert.equal(typeof (await run(MARCH)).period, "object");
  for (const [who, uid] of [["anon", null], ["trainer", X.TR], ["student", X.S1], ["suspended super admin", X.SUSP]]) {
    const { data, error } = await call(uid, MARCH);
    assert.equal(data, null, who);
    assert.equal(error?.code, "42501", who);
  }
});

test("security: SECURITY INVOKER, STABLE, empty search_path, exact EXECUTE grants, no dynamic SQL or writes", async () => {
  const p = await db.admin(`select json_build_object('definer', prosecdef, 'volatility', provolatile, 'config', proconfig, 'src', prosrc,
      'anon', has_function_privilege('anon', oid, 'execute'), 'authenticated', has_function_privilege('authenticated', oid, 'execute'),
      'public', exists (select 1 from aclexplode(proacl) a where a.grantee = 0),
      'grantees', (select json_agg(distinct pg_get_userbyid(a.grantee)) from aclexplode(proacl) a where a.privilege_type = 'EXECUTE'))
    from pg_proc where oid = 'public.dashboard_analytics(date, date, integer)'::regprocedure`);
  assert.equal(p.definer, false, "SECURITY INVOKER");
  assert.equal(p.volatility, "s", "STABLE");
  assert.deepEqual(p.config, ['search_path=""']);
  assert.equal(p.anon, false);
  assert.equal(p.public, false, "no PUBLIC execute");
  assert.equal(p.authenticated, true);
  // Supabase's default privileges also give service_role EXECUTE on new public functions; 0024 revokes exactly what
  // was specified (PUBLIC, anon). The service role is still refused inside: it is never an active Super Admin.
  assert.deepEqual(p.grantees.filter((g) => g !== "postgres").sort(), ["authenticated", "service_role"], "no anon / PUBLIC");
  assert.equal((await db.client({ role: "service_role" }).rpc("dashboard_analytics", MARCH)).error?.code, "42501", "service role refused");
  assert.doesNotMatch(p.src, /\bexecute\s|format\(|\binsert\s+into|\bupdate\s+public\.|\bdelete\s+from|security\s+definer/i);
  assert.match(p.src, /if not public\.is_super_admin\(\) then\s+raise exception .* using errcode = '42501'/);
});

// ---------------------------------------------------------------- validation and periods

test("validation: dates required, start ≤ end, no future end (India today), at most 366 days (0026), limit 1–50 (22023)", async () => {
  const today = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  const tomorrow = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD')");
  const bad = [
    { p_from: null, p_to: "2024-03-31" }, { p_from: "2024-03-01", p_to: null },
    { p_from: "2024-03-02", p_to: "2024-03-01" },
    { p_from: today, p_to: tomorrow },
    { p_from: "2024-01-01", p_to: "2025-01-01" }, // 367 days
    { p_from: "2023-03-01", p_to: "2024-03-01" }, // 367 days across a leap day
    { ...MARCH, p_limit: 0 }, { ...MARCH, p_limit: 51 }, { ...MARCH, p_limit: null },
  ];
  for (const args of bad) assert.equal((await call(ids.A, args)).error?.code, "22023", JSON.stringify(args));
  const tooLong = (await call(ids.A, { p_from: "2024-01-01", p_to: "2025-01-01" })).error;
  assert.match(tooLong?.message ?? "", /^The period can be at most 366 days\.$/, "the 0026 cap and its message");
  for (const args of [
    { p_from: today, p_to: today },
    { p_from: "2024-01-01", p_to: "2024-12-31" }, // 366 days (leap year) — the maximum
    { p_from: "2023-03-01", p_to: "2024-02-29" }, // a 12-month period ending on a leap day (366 days)
    { p_from: "2024-01-01", p_to: "2024-07-19" }, // 201 days: refused before 0026
    { ...MARCH, p_limit: 1 }, { ...MARCH, p_limit: 50 },
  ]) {
    assert.equal((await call(ids.A, args)).error, null, JSON.stringify(args));
  }
  const year = await run({ p_from: "2024-01-01", p_to: "2024-12-31" });
  assert.deepEqual([year.period.days, year.period.bucket, year.trend.length, year.period.prev_from, year.period.prev_to], [366, "month", 12, "2022-12-31", "2023-12-31"],
    "a year: 12 monthly buckets; the comparison period is the 366 days before");
});

test("comparison period: the same number of India days immediately before (partial month vs the same days, leap February)", async () => {
  assert.deepEqual((await run({ p_from: "2024-10-01", p_to: "2024-10-06" })).period,
    { from: "2024-10-01", to: "2024-10-06", prev_from: "2024-09-25", prev_to: "2024-09-30", bucket: "week", days: 6 });
  assert.deepEqual((await run(MARCH)).period, { from: "2024-03-01", to: "2024-03-31", prev_from: "2024-01-30", prev_to: "2024-02-29", bucket: "week", days: 31 });
  assert.deepEqual((await run({ p_from: "2024-01-01", p_to: "2024-03-31" })).period,
    { from: "2024-01-01", to: "2024-03-31", prev_from: "2023-10-02", prev_to: "2023-12-31", bucket: "month", days: 91 });
});

test("buckets: ISO weeks clipped to the period for ≤ 31 days; calendar months beyond; India-time boundary decides the bucket", async () => {
  const d = await run(MARCH);
  assert.deepEqual(d.trend.map((b) => [b.bucket_start, b.bucket_end, b.results]),
    [["2024-03-01", "2024-03-03", 1], ["2024-03-04", "2024-03-10", 9], ["2024-03-11", "2024-03-17", 6], ["2024-03-18", "2024-03-24", 5], ["2024-03-25", "2024-03-31", 3]]);
  // TB (18:30 UTC on 29 Feb = 00:00 on 1 Mar in India) is March; TC (18:29:59 UTC) is February.
  assert.equal(d.trend[0].test_avg, 65);
  assert.deepEqual(d.trend.map((b) => b.test_avg), [65, 76.67, 75.17, 70.8, 73.33]);
  assert.deepEqual(d.trend.map((b) => [b.attendance_marked, b.attendance_pct]), [[1, 100], [5, 80], [5, 80], [4, 75], [1, 100]]);
  assert.deepEqual(d.trend.map((b) => [b.assignments_scored, b.assignment_avg]), [[1, 100], [5, 70], [1, 100], [0, null], [0, null]], "no data → null, never 0 %");
  const m = await run({ p_from: "2024-01-01", p_to: "2024-03-31" });
  assert.deepEqual(m.trend.map((b) => [b.bucket_start, b.bucket_end, b.results]), [["2024-01-01", "2024-01-31", 0], ["2024-02-01", "2024-02-29", 6], ["2024-03-01", "2024-03-31", 24]]);
});

// ---------------------------------------------------------------- results, batches, courses

test("results: released only (draft excluded), best attempt per student × test, in-progress ignored, nothing after p_to", async () => {
  const d = await run(MARCH);
  assert.deepEqual(d.totals.current, { test_avg: 74.17, pass_rate: 91.67, results: 24, attendance_pct: 81.25, attendance_marked: 16, assignment_avg: 78.57, assignments_scored: 7 });
  assert.deepEqual(d.totals.previous, { test_avg: 59.17, pass_rate: 50, results: 6, attendance_pct: 100, attendance_marked: 5, assignment_avg: 50, assignments_scored: 1 });
  // Best-result selection matches the test_best_results view (0009) for the same tests.
  const viaView = await db.admin(`select json_agg(percentage order by percentage) from public.test_best_results where test_id = '${X.T1}'`);
  assert.deepEqual(viaView.map(Number), [50, 60, 70, 80, 90, 100], "S1's best is 50 (not the 40 attempt)");
});

test("batches: each figure separately, evidence minimums (null below 5, counts kept), current-state completion, comparison figures", async () => {
  const d = await run(MARCH);
  const b = Object.fromEntries(mine(d.batches).map((x) => [x.code, x]));
  assert.deepEqual(Object.keys(b).sort(), ["DX-B1", "DX-B2", "DX-B3", "DX-B4"], "activity in the period + ongoing; the cancelled batch without activity is out");
  assert.deepEqual(b["DX-B1"], {
    id: X.B1, code: "DX-B1", name: "0-DX Batch A", course_id: X.C1, course: "0-DX Course One", students: 5,
    attendance_pct: 80, attendance_n: 15, test_avg: 73.75, pass_rate: 90, results_n: 20, assignment_avg: 78.57, assignments_n: 7,
    completion_pct: 20, prev_test_avg: 60, prev_results_n: 5, prev_attendance_pct: 100, prev_attendance_n: 5,
  }, "S4 is withdrawn today but its March results still count (no filtering by today's enrolment)");
  assert.deepEqual([b["DX-B2"].test_avg, b["DX-B2"].pass_rate, b["DX-B2"].results_n, b["DX-B2"].completion_pct], [null, null, 3, 100], "3 results < 5 → null with the count");
  assert.deepEqual([b["DX-B3"].attendance_pct, b["DX-B3"].attendance_n, b["DX-B3"].completion_pct], [null, 1, 0]);
  assert.deepEqual([b["DX-B4"].results_n, b["DX-B4"].test_avg, b["DX-B4"].prev_results_n], [1, null, 1]);
  assert.ok(d.batches_total >= 4);
});

test("courses: aggregated over all records of the course's batches (not an average of batch averages), with minimums", async () => {
  const d = await run(MARCH);
  const c = Object.fromEntries(mine(d.courses).map((x) => [x.code, x]));
  assert.deepEqual(c["DX-C1"], {
    id: X.C1, code: "DX-C1", title: "0-DX Course One", test_avg: 74.57, pass_rate: 91.3, results_n: 23,
    attendance_pct: 80, attendance_n: 15, assignment_avg: 78.57, assignments_n: 7, prev_test_avg: 60, prev_results_n: 5,
  });
  assert.deepEqual([c["DX-C2"].test_avg, c["DX-C2"].results_n, c["DX-C2"].attendance_pct, c["DX-C2"].attendance_n], [null, 1, null, 1]);
});

// ---------------------------------------------------------------- students

test("students: top by average (≥ 3 released results), half-split trend with ±5 thresholds, stable excluded, 2-result student excluded", async () => {
  const s = (await run(MARCH)).students;
  const name = (x) => x.code;
  assert.deepEqual(s.top.map((x) => [name(x), x.average, x.results]), [["DX-S2", 81.25, 4], ["DX-S4", 77.33, 3], ["DX-S3", 72.33, 3], ["DX-S1", 63, 5], ["DX-S5", 62, 3]],
    "S6 (2 results, 100 %) is not ranked; S7–S10 have 1 result each");
  assert.equal(s.ranked, 5);
  // S1 (5 results: 50 55 | 60 | 70 80) +22.5; S3 (3 results: 70 | 72 | 75) exactly +5 → improving.
  assert.deepEqual(s.improving.map((x) => [name(x), x.earlier_avg, x.later_avg, x.change, x.results]), [["DX-S1", 52.5, 75, 22.5, 5], ["DX-S3", 70, 75, 5, 3]]);
  // S2 (4 results: 90 85 | 80 70) −12.5; S4 (3 results: 80 | 77 | 75) exactly −5 → declining. S5 (+4) is stable.
  assert.deepEqual(s.declining.map((x) => [name(x), x.earlier_avg, x.later_avg, x.change, x.results]), [["DX-S2", 87.5, 75, -12.5, 4], ["DX-S4", 80, 75, -5, 3]]);
  assert.ok(![...s.improving, ...s.declining].some((x) => x.code === "DX-S5"), "+4 is stable");
  for (const x of [...s.top, ...s.improving, ...s.declining]) {
    assert.deepEqual(Object.keys(x).filter((k) => !["average", "results", "earlier_avg", "later_avg", "change"].includes(k)).sort(), ["code", "id", "name"], "identity: id, code, name only");
  }
});

// ---------------------------------------------------------------- topics

test("weak topics: best attempts of tests released in the period only; ≥ 5 graded answers; weakest first with the existing bands", async () => {
  const t = (await run(MARCH)).topics;
  assert.deepEqual(t.map((x) => [x.title, x.percent, x.answers, x.band]), [
    ["DX Module M1", 33.33, 6, "attention"], // 4 / 12 — the non-best attempt (2 marks) and February's answers are not counted
    ["DX Module M4", 70, 5, "watch"],        // 35 / 50 — the ungraded answer is not counted (exactly 5 → included)
    ["DX Module M2", 91.67, 6, "healthy"],
  ], "M3 (4 answers) and the question without a module are left out");
  assert.deepEqual(Object.keys(t[0]).sort(), ["answers", "band", "module_id", "percent", "title"]);
  // Option A regression: identical to the original shape (every best-attempt answer joined to its question).
  assert.deepEqual(t.map((x) => [x.module_id, x.percent, x.answers]), await topicsByAnswerJoin("2024-03-01", "2024-03-31"));
});

/** The pre-optimisation topic query (answers joined one by one), as the database owner: the reference result. */
async function topicsByAnswerJoin(from, to) {
  const rows = await db.admin(`select coalesce(json_agg(json_build_array(module_id, percent, answers) order by percent, answers desc, title), '[]') from (
      select q.module_id, m.title, round(sum(ans.marks_awarded) / nullif(sum(tq.marks), 0) * 100, 2) as percent, count(*) as answers
        from public.test_best_results b
        join public.tests t on t.id = b.test_id
        join public.test_attempt_answers ans on ans.attempt_id = b.best_attempt_id
        join public.test_questions tq on tq.id = ans.test_question_id
        join public.questions q on q.id = tq.source_question_id
        join public.modules m on m.id = q.module_id
       where public.test_effective_status(t.status, t.available_from, t.available_until) = 'closed'
         and (t.available_until at time zone 'Asia/Kolkata')::date between date '${from}' and date '${to}'
         and ans.marks_awarded is not null
       group by q.module_id, m.title
      having count(*) >= 5 and sum(tq.marks) > 0
       order by percent, answers desc, m.title
       limit 5) x`);
  return rows.map(([id, pct, n]) => [id, Number(pct), Number(n)]);
}

// ---------------------------------------------------------------- progress, assignments, health

test("class delivery (upcoming/ongoing batches): completed status or attendance evidence; overdue = past, not delivered; cancelled excluded", async () => {
  const d = await run(MARCH);
  const c = Object.fromEntries(mine(d.delivery, "course_id").map((x) => [x.course, x]));
  assert.deepEqual(c["0-DX Course One"], { course_id: X.C1, course: "0-DX Course One", planned: 5, delivered: 5, overdue: 0 }, "the completed batch B2 is out");
  assert.deepEqual(c["0-DX Course Two"], { course_id: X.C2, course: "0-DX Course Two", planned: 5, delivered: 3, overdue: 1 },
    "L3 (attendance), L4 (completed), L6 (completed) delivered; L5 overdue; L1 future; L2 cancelled; B5 cancelled batch out");
});

test("enrolment completion (current state, cancelled batches excluded): completed vs non-withdrawn enrolments", async () => {
  const d = await run(MARCH);
  const c = Object.fromEntries(mine(d.enrolment, "course_id").map((x) => [x.course, x]));
  assert.deepEqual(c["0-DX Course One"], { course_id: X.C1, course: "0-DX Course One", completed: 4, active: 8 });
  assert.deepEqual(c["0-DX Course Two"], { course_id: X.C2, course: "0-DX Course Two", completed: 0, active: 2 });
});

test("health inputs: attendance, assessment and assignment figures with minimums; students below 75 % (enrolled now, ≥ 3 records); waiting reviews", async () => {
  const h = (await run(MARCH)).health;
  assert.deepEqual(
    [h.attendance_n, h.attendance_pct, h.results_n, h.test_avg, h.assignments_n, h.assignment_avg, h.students_assessed, h.students_below_75],
    [16, 81.25, 24, 74.17, 7, 78.57, 3, 2],
    "assessed: S1, S2, S3 (S4 withdrawn now, S5 and S11 too few records); below 75 %: S2 (2/3), S3 (1/3)"
  );
  const waitingRule = (extra) => db.admin(`select count(*) from public.assignment_submissions s where s.status = 'submitted' and s.reviewed_at is null
    and (s.submitted_at at time zone 'Asia/Kolkata')::date < (now() at time zone 'Asia/Kolkata')::date - 7 ${extra}`);
  assert.equal(h.reviews_waiting_over_7d, await waitingRule(""));
  const mineWaiting = await db.admin(`select json_agg(st.student_code order by st.student_code) from public.assignment_submissions s join public.students st on st.id = s.student_id
     where s.batch_id = '${X.B1}' and s.status = 'submitted' and (s.submitted_at at time zone 'Asia/Kolkata')::date < (now() at time zone 'Asia/Kolkata')::date - 7`);
  assert.deepEqual(mineWaiting, ["DX-S3", "DX-S6"], "8 days and 2024 wait; exactly 7 days and 2 days do not; returned never");
});

// ---------------------------------------------------------------- zero data, caps, privacy

test("zero data: a period without activity returns counts of 0 and null figures — never 0 %", async () => {
  const d = await run({ p_from: "2020-01-01", p_to: "2020-01-31" });
  assert.deepEqual(d.totals.current, { test_avg: null, pass_rate: null, results: 0, attendance_pct: null, attendance_marked: 0, assignment_avg: null, assignments_scored: 0 });
  assert.ok(d.trend.every((b) => b.test_avg === null && b.results === 0 && b.attendance_pct === null && b.assignment_avg === null));
  assert.deepEqual([d.topics, d.students.top, d.students.improving, d.students.declining], [[], [], [], []]);
  assert.deepEqual([d.health.attendance_pct, d.health.test_avg, d.health.assignment_avg, d.health.students_assessed, d.health.students_below_75], [null, null, null, 0, 0]);
  const b1 = d.batches.find((x) => x.id === X.B1);
  assert.deepEqual([b1?.results_n, b1?.test_avg, b1?.attendance_pct], [0, null, null], "an ongoing batch is listed with no figures");
});

test("caps: every list is bounded by p_limit (topics by 5); totals report the full size", async () => {
  const d = await run({ ...MARCH, p_limit: 2 });
  assert.equal(d.batches.length, 2);
  assert.ok(d.batches_total >= 4);
  assert.ok(d.courses.length <= 2 && d.delivery.length <= 2 && d.enrolment.length <= 2);
  assert.deepEqual(d.students.top.map((x) => x.code), ["DX-S2", "DX-S4"]);
  assert.equal(d.students.improving.length, 2);
  assert.deepEqual(d.topics.map((x) => x.title), ["DX Module M1", "DX Module M4"]);
  assert.ok((await run(MARCH)).topics.length <= 5);
});

test("privacy: no email, phone, account or auth data anywhere in the output", async () => {
  const json = JSON.stringify(await run(MARCH));
  assert.doesNotMatch(json, /@dx\.test|email|phone|account|password|auth|role|marked_by|reviewed_by|created_by/i);
});

// ---------------------------------------------------------------- volume

test("volume: ~10k results, ~100k graded answers, ~20k attendance records, ~2k submissions in a 6-month window — executes well under 2 s", async () => {
  // 40 completed batches × 25 students in their own course, 10 released tests with 10 questions each, 20 classes, 2 assignments.
  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values ('${id("VC")}', 'DX-VOL', 'DX Volume Course', 'foundation');
    insert into public.modules (id, course_id, module_code, title, sequence)
      select gen_random_uuid(), '${id("VC")}', 'DX-VM' || g, 'DX Volume Module ' || g, g from generate_series(1, 5) g;
    create temp table vq as select gen_random_uuid() as id, g from generate_series(1, 10) g;
    insert into public.questions (id, course_id, module_id, question_text, question_type, marks, status, revision, created_by, updated_by)
      select vq.id, '${id("VC")}', (select m.id from public.modules m where m.course_id = '${id("VC")}' and m.sequence = 1 + (vq.g % 5)), 'DX volume q' || vq.g, 'true_false', 1, 'active', 1, '${ids.A}', '${ids.A}' from vq;
    create temp table vb as select gen_random_uuid() as id, g from generate_series(1, 40) g;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      select vb.id, 'DX-V' || vb.g, '${id("VC")}', '${id("TR")}', 'DX Volume ' || vb.g, '2023-03-01', '2023-08-31', 'completed', 30 from vb;
    create temp table vs as select gen_random_uuid() as id, vb.id as batch_id, s from vb, generate_series(1, 25) s;
    insert into public.students (id, student_code, full_name) select id, 'DX-VS-' || substr(id::text, 1, 8), 'DX Volume Student' from vs;
    insert into public.batch_students (batch_id, student_id, enrollment_status, completed_at) select batch_id, id, 'completed', '2023-09-01' from vs;
    create temp table vc as select gen_random_uuid() as id, vb.id as batch_id, c, date '2023-03-01' + (c * 9) as d from vb, generate_series(1, 20) c;
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status)
      select id, '${id("VC")}', batch_id, '${id("TR")}', 'DX volume class', d, '09:00', '10:00', 'completed' from vc;
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by, marked_at)
      select vc.id, vs.id, vc.batch_id, (array['present','present','present','late','absent','excused'])[1 + (abs(hashtext(vc.id::text || vs.id::text)) % 6)]::public.attendance_status, '${id("TR")}', '2023-03-01'
        from vc join vs on vs.batch_id = vc.batch_id;
    create temp table vt as select gen_random_uuid() as id, vc.batch_id, vc.id as class_id, vc.c, (vc.d + time '17:00') at time zone 'Asia/Kolkata' as until from vc where vc.c % 2 = 0;
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
      select id, class_id, batch_id, 'quiz', 'DX volume test', 'closed', 60, 30, 1, until - interval '1 day', until, '${ids.A}', '${ids.A}' from vt;
    create temp table vtq as select gen_random_uuid() as id, vt.id as test_id, vq.id as qid, vq.g from vt, vq;
    insert into public.test_questions (id, test_id, position, source_question_id, source_revision, question_text, question_type, marks, added_by)
      select id, test_id, g, qid, 1, 'DX volume tq', 'true_false', 1, '${ids.A}' from vtq;
    create temp table va as select gen_random_uuid() as id, vt.id as test_id, vt.batch_id, vs.id as student_id, (abs(hashtext(vt.id::text || vs.id::text)) % 11) * 10 as pct
      from vt join vs on vs.batch_id = vt.batch_id;
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at)
      select id, test_id, batch_id, student_id, 1, 'submitted', '2023-03-01T10:00:00Z', '2023-03-01T11:00:00Z', 10, 100, '2023-03-01T10:30:00Z', 'student_submit', pct, pct, pct >= 60, '2023-03-01T10:30:00Z' from va;
    insert into public.test_attempt_answers (attempt_id, test_question_id, is_correct, marks_awarded)
      select va.id, vtq.id, (vtq.g * 10 <= va.pct), case when vtq.g * 10 <= va.pct then 1 else 0 end from va join vtq on vtq.test_id = va.test_id;
    create temp table vasg as select gen_random_uuid() as id, vc.batch_id, vc.id as class_id from vc where vc.c in (5, 15);
    insert into public.class_assignments (id, class_id, batch_id, title, due_at, max_score, status, created_by, updated_by)
      select id, class_id, batch_id, 'DX volume work', null, 10, 'published', '${id("TR")}', '${id("TR")}' from vasg;
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at, score, reviewed_by, reviewed_at)
      select vasg.id, vs.id, vs.batch_id, 'https://dx.test/v', 'returned', '2023-05-01', abs(hashtext(vasg.id::text || vs.id::text)) % 11, '${id("TR")}', '2023-05-02'
        from vasg join vs on vs.batch_id = vasg.batch_id;
    set session_replication_role = origin;`);
  const counts = await db.admin(`select json_build_object(
      'answers', (select count(*) from public.test_attempt_answers ans join public.test_attempts a on a.id = ans.attempt_id join public.batches b on b.id = a.batch_id where b.course_id = '${X.VC}'),
      'results', (select count(*) from public.test_attempts a join public.batches b on b.id = a.batch_id where b.course_id = '${X.VC}'),
      'attendance', (select count(*) from public.class_attendance x join public.batches b on b.id = x.batch_id where b.course_id = '${X.VC}'))`);
  assert.ok(counts.answers >= 100000 && counts.results >= 10000 && counts.attendance >= 20000, JSON.stringify(counts));

  const claims = JSON.stringify({ sub: ids.A }).replace(/'/g, "''");
  const timeAs = async (rls, sql) => {
    const r = await db.run(`${rls ? `set role authenticated; select set_config('request.jwt.claims', '${claims}', false);` : ""}
      explain (analyze, timing off, summary on) ${sql};`);
    if (r.code) throw new Error(r.stderr);
    return Number(/Execution Time: ([\d.]+) ms/.exec(r.stdout)?.[1]);
  };
  await db.exec("analyze;");
  const median3 = async (sql) => {
    const xs = [];
    for (let i = 0; i < 3; i++) xs.push(await timeAs(true, sql));
    xs.sort((a, b) => a - b);
    return { median: xs[1], runs: xs };
  };
  const six = await median3("select public.dashboard_analytics('2023-03-01', '2023-08-31', 10)");
  const one = await median3("select public.dashboard_analytics('2023-06-01', '2023-06-30', 10)");
  const ms = six.median;
  const oneMonth = one.median;
  console.log(`[volume] 6-month runs: ${JSON.stringify(six.runs)}; 1-month runs: ${JSON.stringify(one.runs)}`);

  // The function's parts, as the Super Admin (RLS on) and as the database owner (RLS bypassed).
  const W = "date '2023-03-01' and date '2023-08-31'";
  const released = `public.tests t where (t.available_until at time zone 'Asia/Kolkata')::date between ${W}
    and public.test_effective_status(t.status, t.available_from, t.available_until) = 'closed'`;
  const parts = {
    weak_topics_optimised: `with ta as (select ans.test_question_id, sum(ans.marks_awarded) as earned, count(*) as n
        from ${released.replace("public.tests t", "public.tests t join public.test_attempts a on a.test_id = t.id and a.status <> 'in_progress' join public.test_attempt_answers ans on ans.attempt_id = a.id")}
         and ans.marks_awarded is not null group by ans.test_question_id)
      select q.module_id, sum(ta.earned), sum(tq.marks * ta.n), sum(ta.n) from ta
        join public.test_questions tq on tq.id = ta.test_question_id join public.questions q on q.id = tq.source_question_id
       where q.module_id is not null group by q.module_id`,
    weak_topics_previous_shape: `select q.module_id, sum(ans.marks_awarded), sum(tq.marks), count(*)
        from ${released.replace("public.tests t", "public.tests t join public.test_attempts a on a.test_id = t.id and a.status <> 'in_progress' join public.test_attempt_answers ans on ans.attempt_id = a.id join public.test_questions tq on tq.id = ans.test_question_id join public.questions q on q.id = tq.source_question_id")}
         and ans.marks_awarded is not null and q.module_id is not null group by q.module_id`,
    classes: `select count(*) from public.classes c where c.class_date between ${W} and c.status <> 'cancelled'`,
    attendance: `select count(*), count(*) filter (where ca.status in ('present', 'late')) from public.classes c join public.class_attendance ca on ca.class_id = c.id
       where c.class_date between ${W} and c.status <> 'cancelled' and ca.status <> 'excused'`,
    best_results: `select count(*) from (select distinct on (a.test_id, a.student_id) a.id
        from public.test_attempts a join ${released.replace("public.tests t where", "public.tests t on t.id = a.test_id where")} and a.status <> 'in_progress'
       order by a.test_id, a.student_id, a.percentage desc, a.score desc, a.finalized_at) x`,
    assignments: `select count(*), avg(s.score / ca.max_score) from public.assignment_submissions s join public.class_assignments ca on ca.id = s.assignment_id
        join public.classes c on c.id = ca.class_id where s.status = 'returned' and s.score is not null and ca.max_score > 0
         and coalesce((ca.due_at at time zone 'Asia/Kolkata')::date, c.class_date) between ${W}`,
    delivery: `select count(*) from public.classes cl join public.batches b on b.id = cl.batch_id where cl.status <> 'cancelled'
         and exists (select 1 from public.class_attendance x where x.class_id = cl.id)`,
  };
  const timings = {};
  for (const [k, sql] of Object.entries(parts)) timings[k] = { rls_on_ms: await timeAs(true, sql), rls_bypassed_ms: await timeAs(false, sql) };
  console.log(`[volume] data: ${JSON.stringify(counts)}`);
  console.log(`[volume] dashboard_analytics, 6 months, Super Admin (RLS on), median of 3: ${ms} ms; 1 month: ${oneMonth} ms`);
  console.log(`[volume] parts: ${JSON.stringify(timings)}`);

  // Same weak topics as the original per-answer join, at volume.
  const vol = await run({ p_from: "2023-03-01", p_to: "2023-08-31" });
  assert.deepEqual(vol.topics.map((x) => [x.module_id, x.percent, x.answers]), await topicsByAnswerJoin("2023-03-01", "2023-08-31"));
  assert.ok(vol.topics.length > 0);

  assert.ok(Number.isFinite(ms) && ms <= 2000, `execution time ${ms} ms (target ≤ 2000 ms)`);

  // The narrowing the function relies on, as the Super Admin (RLS on): released tests → their attempts → answers.
  const plan = await db.run(`set role authenticated; select set_config('request.jwt.claims', '${claims}', false);
    explain (analyze, costs off, timing off, summary on)
    select q.module_id, count(*) from public.tests t
      join public.test_attempts a on a.test_id = t.id and a.status <> 'in_progress'
      join public.test_attempt_answers ans on ans.attempt_id = a.id
      join public.test_questions tq on tq.id = ans.test_question_id
      join public.questions q on q.id = tq.source_question_id
     where (t.available_until at time zone 'Asia/Kolkata')::date between date '2023-06-01' and date '2023-06-30'
       and public.test_effective_status(t.status, t.available_from, t.available_until) = 'closed'
     group by q.module_id;`);
  const lines = plan.stdout.split(/\r?\n/).filter((l) => /Index|Seq Scan|Execution Time|Hash Join|Nested Loop/.test(l));
  console.log(`[volume] narrowing plan:\n${lines.join("\n")}`);
  assert.match(plan.stdout, /test_attempt_answers_pkey|test_attempts_test_status_idx/, "answers and attempts are reached by index from the period's tests");
});

after(async () => {
  // Remove the volume rows (this psql session only, triggers skipped) so later test files see the usual data.
  if (!X.VC) return;
  await db.exec(`
    set session_replication_role = replica;
    delete from public.assignment_submissions s using public.batches b where b.id = s.batch_id and b.course_id = '${X.VC}';
    delete from public.class_assignments x using public.batches b where b.id = x.batch_id and b.course_id = '${X.VC}';
    delete from public.test_attempt_answers ans using public.test_attempts a, public.batches b where a.id = ans.attempt_id and b.id = a.batch_id and b.course_id = '${X.VC}';
    delete from public.test_attempts a using public.batches b where b.id = a.batch_id and b.course_id = '${X.VC}';
    delete from public.test_questions tq using public.tests t, public.batches b where t.id = tq.test_id and b.id = t.batch_id and b.course_id = '${X.VC}';
    delete from public.tests t using public.batches b where b.id = t.batch_id and b.course_id = '${X.VC}';
    delete from public.class_attendance x using public.batches b where b.id = x.batch_id and b.course_id = '${X.VC}';
    delete from public.classes c where c.course_id = '${X.VC}';
    delete from public.batch_students bs using public.batches b where b.id = bs.batch_id and b.course_id = '${X.VC}';
    delete from public.students s where s.student_code like 'DX-VS-%';
    delete from public.batches where course_id = '${X.VC}';
    delete from public.questions where course_id = '${X.VC}';
    delete from public.modules where course_id = '${X.VC}';
    delete from public.courses where id = '${X.VC}';
    set session_replication_role = origin;`);
});
