// Reports — the real reports repository + service against the local database, each caller on their OWN session
// (RLS applies; never the service role). Proves that:
//   - every figure equals the same figure computed independently in SQL from the source tables, with the
//     Performance page's definitions (attendance = non-absent / marked; released tests only; returned scores);
//   - the exported CSV and Excel files contain exactly the rows shown;
//   - a trainer reports only on their CURRENT batches (other batches are ignored, never shown), students and
//     signed-out callers are refused before any read, and RLS alone also hides other people's rows.
// Own fixtures only (rp_*), dated relative to the database's India today.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ExcelJS, db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createReportsRepository } = await import(`${build}/repositories/reports.repository.core.mjs`);
const { createReportsService, ReportsAuthorizationError } = await import(`${build}/services/reports.service.core.mjs`);
const R = await import(`${build}/lib/reports/reports.mjs`);
const { toCsvText, toXlsxBytes } = await import(`${build}/lib/question-import/export.mjs`);

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
let T;

const session = (uid) => db.client({ role: "authenticated", userId: uid });
const repoAs = (uid) => createReportsRepository(async () => (uid ? session(uid) : db.client({ role: "anon" })));
const userOf = (uid, role) => ({ id: uid, email: "x@rp.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" });
const serviceAs = (uid, role) => createReportsService({ repository: repoAs(uid), getCurrentUser: async () => (uid ? userOf(uid, role) : null) });
const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};
/** One row per (batch code, student code) → the named columns. */
const byPerson = (report, cols) => {
  const h = report.table.headers;
  const out = {};
  for (const row of report.table.rows) {
    const key = `${row[h.indexOf("Batch code")]}|${row[h.indexOf("Student code")]}`;
    out[key] = Object.fromEntries(cols.map((c) => [c, row[h.indexOf(c)]]));
  }
  return out;
};
const summary = (report) => Object.fromEntries(report.summary.map((s) => [s.label, s.value]));
const pctText = (v) => (v === null ? "—" : `${Math.round(Number(v) * 100) / 100}%`);

before(async () => {
  T = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  const people = ["TR", "TR2", "S1", "S2", "S3", "SW", "S4", "SC", "SX"];
  const students = people.filter((k) => k.startsWith("S"));
  for (const k of people) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${people.map((k) => `(${q(X[k])}, '${k.toLowerCase()}@rp.test')`).join(", ")};
    update public.profiles set account_status = 'active', role = 'student' where id in (${students.map((k) => q(X[k])).join(", ")});
    update public.profiles set account_status = 'active', role = 'trainer' where id in (${q(X.TR)}, ${q(X.TR2)});
    insert into public.trainers (id, trainer_code, full_name) values (${q(X.TR)}, 'RP-TR', 'RP Trainer'), (${q(X.TR2)}, 'RP-TR2', 'RP Other');
    insert into public.students (id, student_code, full_name) values ${students.map((k) => `(${q(X[k])}, 'RP-${k}', 'RP ${k}')`).join(", ")};`, ids.A);

  const cls = (k, batch, trainer, offset) => `(${q(id(k))}, ${q(X.C)}, ${q(X[batch])}, ${q(X[trainer])}, 'RP ${k}', date '${T}' + ${offset}, '09:00', '10:00', 'completed')`;
  const att = (c, s, status, batch = "BO") => `(${q(X[c])}, ${q(X[s])}, ${q(X[batch])}, '${status}', ${q(X.TR)})`;
  const tst = (k, batch, c, status, from, until) =>
    `(${q(id(k))}, ${q(X[c])}, ${q(X[batch])}, 'quiz', 'RP ${k}', '${status}', 60, 30, 2, ${from}, ${until}, ${q(ids.A)}, ${q(ids.A)})`;
  const attempt = (t, s, pct, batch = "BO") =>
    `(gen_random_uuid(), ${q(X[t])}, ${q(X[batch])}, ${q(X[s])}, 1, 'submitted', now() - interval '20 days', now() - interval '20 days' + interval '1 hour', 5, 100, now() - interval '20 days' + interval '30 minutes', 'student_submit', ${pct}, ${pct}, ${pct >= 60}, now() - interval '20 days' + interval '30 minutes')`;

  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values (${q(id("C"))}, 'RP-101', 'RP Course', 'foundation'), (${q(id("C2"))}, 'RP-202', 'RP Course Two', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (${q(id("BO"))}, 'RP-BO', ${q(X.C)},  ${q(X.TR)},  'RP ongoing',   date '${T}' - 60, date '${T}' + 60, 'ongoing',   30),
      (${q(id("BU"))}, 'RP-BU', ${q(X.C2)}, ${q(X.TR)},  'RP upcoming',  date '${T}' + 10, date '${T}' + 90, 'upcoming',  30),
      (${q(id("BC"))}, 'RP-BC', ${q(X.C)},  ${q(X.TR)},  'RP completed', date '${T}' - 200, date '${T}' - 100, 'completed', 30),
      (${q(id("BX"))}, 'RP-BX', ${q(X.C)},  ${q(X.TR2)}, 'RP other',     date '${T}' - 60, date '${T}' + 60, 'ongoing',   30);
    insert into public.batch_students (batch_id, student_id, enrollment_status, completed_at) values
      (${q(X.BO)}, ${q(X.S1)}, 'enrolled', null), (${q(X.BO)}, ${q(X.S2)}, 'enrolled', null), (${q(X.BO)}, ${q(X.S3)}, 'enrolled', null),
      (${q(X.BO)}, ${q(X.SW)}, 'withdrawn', null), (${q(X.BU)}, ${q(X.S4)}, 'enrolled', null),
      (${q(X.BC)}, ${q(X.SC)}, 'completed', now()), (${q(X.BX)}, ${q(X.SX)}, 'enrolled', null);
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      ${[cls("K1", "BO", "TR", -20), cls("K2", "BO", "TR", -10), cls("K3", "BO", "TR", -2), cls("KC", "BC", "TR", -150), cls("KX", "BX", "TR2", -3)].join(",\n      ")};
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values
      ${[
        att("K1", "S1", "present"), att("K2", "S1", "present"), att("K3", "S1", "late"),
        att("K1", "S2", "absent"), att("K2", "S2", "excused"), att("K3", "S2", "absent"),
        att("K1", "S3", "present"), att("K2", "S3", "absent"),
        att("K1", "SW", "present"),
        att("KC", "SC", "absent", "BC"),
      ].join(", ")};
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values (${q(X.KX)}, ${q(X.SX)}, ${q(X.BX)}, 'present', ${q(X.TR2)});
    insert into public.class_assignments (id, class_id, batch_id, title, status, max_score, due_at, created_by, updated_by) values
      (${q(id("A1"))}, ${q(X.K1)}, ${q(X.BO)}, 'RP published', 'published', 10, (date '${T}' - 15)::timestamptz, ${q(X.TR)}, ${q(X.TR)}),
      (${q(id("A2"))}, ${q(X.K2)}, ${q(X.BO)}, 'RP closed', 'closed', 20, (date '${T}' - 5)::timestamptz, ${q(X.TR)}, ${q(X.TR)}),
      (${q(id("AD"))}, ${q(X.K3)}, ${q(X.BO)}, 'RP draft', 'draft', 10, null, ${q(X.TR)}, ${q(X.TR)}),
      (${q(id("AX"))}, ${q(X.KX)}, ${q(X.BX)}, 'RP other', 'published', 10, null, ${q(X.TR2)}, ${q(X.TR2)});
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at, score, reviewed_by, reviewed_at) values
      (${q(X.A1)}, ${q(X.S1)}, ${q(X.BO)}, 'https://example.com/1', 'returned', (date '${T}' - 16)::timestamptz, 8, ${q(X.TR)}, now()),
      (${q(X.A1)}, ${q(X.S2)}, ${q(X.BO)}, 'https://example.com/2', 'submitted', (date '${T}' - 14)::timestamptz, null, null, null),
      (${q(X.A2)}, ${q(X.S1)}, ${q(X.BO)}, 'https://example.com/3', 'returned', (date '${T}' - 6)::timestamptz, 15, ${q(X.TR)}, now()),
      (${q(X.A2)}, ${q(X.S3)}, ${q(X.BO)}, 'https://example.com/4', 'returned', (date '${T}' - 6)::timestamptz, 5, ${q(X.TR)}, now()),
      (${q(X.AX)}, ${q(X.SX)}, ${q(X.BX)}, 'https://example.com/x', 'returned', now(), 10, ${q(X.TR2)}, now());
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ${[
        tst("TCL1", "BO", "K1", "closed", "now() - interval '25 days'", "now() - interval '19 days'"),
        tst("TCL2", "BO", "K2", "active", "now() - interval '12 days'", "now() - interval '9 days'"),
        tst("TOPEN", "BO", "K3", "active", "now() - interval '1 hour'", "now() + interval '2 hours'"),
        tst("TX", "BX", "KX", "closed", "now() - interval '5 days'", "now() - interval '4 days'"),
      ].join(",\n      ")};
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at) values
      ${[
        attempt("TCL1", "S1", 80), attempt("TCL1", "S2", 40), attempt("TCL1", "S3", 65),
        attempt("TCL2", "S1", 90), attempt("TCL2", "S3", 30),
        attempt("TOPEN", "S1", 99), attempt("TOPEN", "S2", 10),
        attempt("TX", "SX", 100, "BX"),
      ].join(",\n      ")};
    set session_replication_role = origin;`);
});

// ---------------------------------------------------------------- SQL ground truth (Performance definitions)
const RELEASED = `(t.status = 'closed' or (t.status <> 'draft' and t.available_until is not null and t.available_until <= now()))`;
const sqlTruth = (batchIds) => {
  const inB = `(${batchIds.map(q).join(", ")})`;
  return db.admin(`select json_build_object(
    'attendance', (select json_build_object('marked', count(*), 'attended', count(*) filter (where status <> 'absent')) from public.class_attendance where batch_id in ${inB}),
    'tests', (select json_build_object('n', count(*), 'avg', round(avg(r.percentage)::numeric, 2), 'passed', count(*) filter (where r.passed))
              from public.test_best_results r join public.tests t on t.id = r.test_id where r.batch_id in ${inB} and ${RELEASED}),
    'assign', (select json_build_object('n', count(*), 'avg', round(avg(s.score::numeric / a.max_score * 100), 2))
              from public.assignment_submissions s join public.class_assignments a on a.id = s.assignment_id
              where s.batch_id in ${inB} and s.status = 'returned' and s.score is not null and a.max_score > 0))`);
};

test("attendance: per-student counts and the scope total equal the SQL truth (non-absent / marked)", async () => {
  const report = await serviceAs(ids.A, "admin").getReport({ type: "attendance", batch: X.BO });
  assert.deepEqual(report.ignored, []);
  const rows = byPerson(report, ["Enrolment", "Classes marked", "Present", "Late", "Excused", "Absent", "Attendance %"]);
  assert.deepEqual(rows["RP-BO|RP-S1"], { Enrolment: "Enrolled", "Classes marked": 3, Present: 2, Late: 1, Excused: 0, Absent: 0, "Attendance %": 100 });
  assert.deepEqual(rows["RP-BO|RP-S2"], { Enrolment: "Enrolled", "Classes marked": 3, Present: 0, Late: 0, Excused: 1, Absent: 2, "Attendance %": 33.33 });
  assert.deepEqual(rows["RP-BO|RP-S3"], { Enrolment: "Enrolled", "Classes marked": 2, Present: 1, Late: 0, Excused: 0, Absent: 1, "Attendance %": 50 });
  assert.equal(rows["RP-BO|RP-SW"].Enrolment, "Withdrawn", "a withdrawn student's records stay visible");
  assert.equal(Object.keys(rows).length, 4);
  const truth = await sqlTruth([X.BO]);
  const s = summary(report);
  assert.equal(s["Attendance records"], String(truth.attendance.marked));
  assert.equal(s.Attended, String(truth.attendance.attended));
  assert.equal(s.Attendance, pctText((truth.attendance.attended / truth.attendance.marked) * 100));
});

test("attendance: the date range keeps only classes on those dates", async () => {
  const from = await db.admin(`select to_char(date '${T}' - 12, 'YYYY-MM-DD')`);
  const report = await serviceAs(ids.A, "admin").getReport({ type: "attendance", batch: X.BO, from, to: T });
  const rows = byPerson(report, ["Classes marked", "Absent"]);
  assert.deepEqual(rows["RP-BO|RP-S1"], { "Classes marked": 2, Absent: 0 }, "K1 (20 days ago) is outside the range");
  assert.deepEqual(rows["RP-BO|RP-S2"], { "Classes marked": 2, Absent: 1 });
  const marked = await db.admin(`select count(*) from public.class_attendance a join public.classes c on c.id = a.class_id
                                  where a.batch_id = ${q(X.BO)} and c.class_date between date '${from}' and date '${T}'`);
  assert.equal(summary(report)["Attendance records"], String(marked));
});

test("performance: scope figures equal the Performance definitions computed in SQL; per-student values exact", async () => {
  const report = await serviceAs(ids.A, "admin").getReport({ type: "performance", batch: X.BO });
  const truth = await sqlTruth([X.BO]);
  const s = summary(report);
  assert.equal(s["Average test score"], pctText(truth.tests.avg), "released tests only (TOPEN excluded)");
  assert.equal(s["Pass rate"], pctText((truth.tests.passed / truth.tests.n) * 100));
  assert.equal(s.Attendance, pctText((truth.attendance.attended / truth.attendance.marked) * 100));
  assert.equal(s["Assignment average"], pctText(truth.assign.avg));
  const rows = byPerson(report, ["Released tests", "Average test %", "Tests passed", "Pass rate %", "Classes marked", "Attendance %", "Scored assignments", "Assignment average %"]);
  assert.deepEqual(rows["RP-BO|RP-S1"], {
    "Released tests": 2, "Average test %": 85, "Tests passed": 2, "Pass rate %": 100,
    "Classes marked": 3, "Attendance %": 100, "Scored assignments": 2, "Assignment average %": 77.5,
  });
  assert.deepEqual(rows["RP-BO|RP-S2"], {
    "Released tests": 1, "Average test %": 40, "Tests passed": 0, "Pass rate %": 0,
    "Classes marked": 3, "Attendance %": 33.33, "Scored assignments": 0, "Assignment average %": null,
  });
});

test("test results: released tests only, values exactly as test_best_results; draft/open tests never appear", async () => {
  const report = await serviceAs(ids.A, "admin").getReport({ type: "test_results", batch: X.BO });
  const h = report.table.headers;
  const got = report.table.rows.map((r) => `${r[h.indexOf("Test")]}|${r[h.indexOf("Student code")]}|${r[h.indexOf("Percentage")]}|${r[h.indexOf("Passed")]}`).sort();
  const expected = await db.admin(`select coalesce(json_agg(x order by x), '[]') from (
      select t.title || '|' || s.student_code || '|' || round(r.percentage::numeric, 2)::float8 || '|' || case when r.passed then 'Yes' else 'No' end as x
        from public.test_best_results r join public.tests t on t.id = r.test_id join public.students s on s.id = r.student_id
       where r.batch_id = ${q(X.BO)} and ${RELEASED}) y`);
  assert.deepEqual(got, expected);
  assert.ok(!got.some((g) => g.startsWith("RP TOPEN")), "an open test's results are not released");
  assert.equal(summary(report).Results, String(expected.length));
});

test("assignment completion: published/closed assignments × enrolled students; drafts and withdrawn students excluded", async () => {
  const report = await serviceAs(ids.A, "admin").getReport({ type: "assignments", batch: X.BO });
  const h = report.table.headers;
  const got = report.table.rows.map((r) => `${r[h.indexOf("Assignment")]}|${r[h.indexOf("Student code")]}|${r[h.indexOf("Status")]}|${r[h.indexOf("On time")] ?? "-"}|${r[h.indexOf("Score")] ?? "-"}`).sort();
  assert.deepEqual(got, [
    "RP closed|RP-S1|Returned|Yes|15",
    "RP closed|RP-S2|Not submitted|-|-",
    "RP closed|RP-S3|Returned|Yes|5",
    "RP published|RP-S1|Returned|Yes|8",
    "RP published|RP-S2|Submitted|No|-",
    "RP published|RP-S3|Not submitted|-|-",
  ]);
  const s = summary(report);
  assert.deepEqual([s.Assignments, s["Expected submissions"], s.Submitted, s.Completion, s.Returned], ["2", "6", "4", "66.67%", "3"]);
});

test("exports: the CSV and the Excel file contain exactly the rows shown, numbers as numbers, text escaped", async () => {
  const report = await serviceAs(ids.A, "admin").getReport({ type: "performance", batch: X.BO });
  const sheet = R.toExportTable(report.table);
  // CSV: BOM, quoted, CRLF — parse it back.
  const csv = toCsvText(sheet).replace(/^﻿/, "");
  const parsed = csv.split("\r\n").map((line) => Array.from(line.matchAll(/"((?:[^"]|"")*)"/g), (m) => m[1].replace(/""/g, '"')));
  assert.deepEqual(parsed[0], report.table.headers);
  assert.deepEqual(parsed.slice(1), report.table.rows.map((row) => row.map((c) => (c === null ? "" : String(c)))));
  // Excel: same cells, numbers stored as numbers.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await toXlsxBytes(sheet, "Report"));
  const ws = wb.getWorksheet("Report");
  assert.deepEqual(ws.getRow(1).values.slice(1), report.table.headers);
  report.table.rows.forEach((row, i) => {
    const cells = ws.getRow(i + 2).values.slice(1);
    // An empty cell may read back as undefined or ""; both mean "no value" (exported from null).
    row.forEach((c, j) => assert.deepEqual(cells[j] ?? "", c === null ? "" : c, `row ${i + 2} col ${j + 1}`));
  });
  // Formula-injection protection.
  assert.deepEqual(R.toExportTable({ headers: ["a"], rows: [["=HYPERLINK(1)"], [5], [null]] }).rows, [["'=HYPERLINK(1)"], [5], [""]]);
});

test("dates: a timestamp is reported and filtered by its India calendar date, whatever offset the server returns", () => {
  // 2026-10-14 20:00 UTC = 2026-10-15 01:30 IST (Supabase returns UTC; the local stand-in returns +05:30).
  assert.equal(R.day("2026-10-14T20:00:00+00:00"), "2026-10-15");
  assert.equal(R.day("2026-10-15T01:30:00+05:30"), "2026-10-15");
  assert.equal(R.day("2026-10-14T18:29:59.999999+00:00"), "2026-10-14", "23:59:59 IST stays on its day");
  assert.equal(R.day("2026-10-15"), "2026-10-15", "a plain date is kept as stored");
  assert.equal(R.day("not a date"), null);
  assert.equal(R.day(null), null);
  const source = {
    batches: [{ id: "b", batch_code: "B", name: "B", status: "ongoing", course_id: "c", courses: { course_code: "C", title: "C" } }],
    enrolments: [{ batch_id: "b", student_id: "s", enrollment_status: "enrolled", students: { full_name: "S", student_code: "S1" } }],
    classes: [], attendance: [],
    bestResults: [{ test_id: "t", batch_id: "b", student_id: "s", score: 5, max_score: 10, percentage: 50, passed: false, finalized_at: null }],
    tests: [{ id: "t", batch_id: "b", title: "T", status: "closed", available_from: null, available_until: "2026-10-14T20:00:00+00:00", classes: null }],
    assignments: [{ id: "a", batch_id: "b", title: "A", due_at: "2026-10-14T19:00:00+00:00", max_score: 10, status: "published" }],
    submissions: [],
  };
  const tests = R.buildTestResultsReport(source, { from: "2026-10-15", to: "2026-10-15" }, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(tests.table.rows.length, 1, "the test closing at 01:30 IST belongs to 15 Oct");
  assert.equal(tests.table.rows[0][tests.table.headers.indexOf("Test date")], "2026-10-15");
  assert.equal(R.buildTestResultsReport(source, { from: "2026-10-14", to: "2026-10-14" }, Date.parse("2026-11-01T00:00:00Z")).table.rows.length, 0);
  assert.equal(R.buildAssignmentReport(source, { from: "2026-10-15", to: "2026-10-15" }).table.rows.length, 1, "due 00:30 IST on 15 Oct");
});

test("trainer scope: only their CURRENT batches; another trainer's or a completed batch is ignored, never shown", async () => {
  const svc = serviceAs(X.TR, "trainer");
  const all = await svc.getReport({ type: "attendance" });
  assert.deepEqual(all.options.batches.map((b) => b.label).sort(), ["RP-BO — RP ongoing", "RP-BU — RP upcoming"]);
  const codes = new Set(all.table.rows.map((r) => r[all.table.headers.indexOf("Batch code")]));
  assert.deepEqual([...codes].sort(), ["RP-BO", "RP-BU"]);
  for (const other of [X.BX, X.BC]) {
    const r = await svc.getReport({ type: "attendance", batch: other });
    assert.equal(r.filters.batchId, null);
    assert.ok(r.ignored.some((i) => i.param === "batch"), "reported as ignored");
    assert.ok(!r.table.rows.some((row) => ["RP-BX", "RP-BC"].includes(row[r.table.headers.indexOf("Batch code")])));
  }
  // A student of another trainer's batch is not a valid student filter either.
  const st = await svc.getReport({ type: "attendance", batch: X.BO, student: X.SX });
  assert.equal(st.filters.studentId, null);
  assert.ok(st.ignored.some((i) => i.param === "student"));
  // Course filter narrows within scope; the course list is the scope's courses.
  const c2 = await svc.getReport({ type: "attendance", course: X.C2 });
  assert.deepEqual(c2.options.batches.map((b) => b.label), ["RP-BU — RP upcoming"]);
  // The trainer's Performance figure equals SQL over their current batches only.
  const perf = await svc.getReport({ type: "performance" });
  const truth = await sqlTruth([X.BO, X.BU]);
  assert.equal(summary(perf)["Average test score"], pctText(truth.tests.avg));
  assert.equal(summary(perf).Attendance, pctText((truth.attendance.attended / truth.attendance.marked) * 100));
});

test("invalid filters are ignored and explained; nothing is trusted", async () => {
  const r = await serviceAs(ids.A, "admin").getReport({ type: "bogus", batch: "not-a-uuid", student: "x", from: "2026-02-30", to: "yesterday" });
  assert.equal(r.type, "attendance");
  assert.deepEqual(r.ignored.map((i) => i.param).sort(), ["batch", "from", "student", "to", "type"]);
  const swapped = await serviceAs(ids.A, "admin").getReport({ from: T, to: "2000-01-01" });
  assert.deepEqual([swapped.filters.from, swapped.filters.to], [null, null]);
  assert.ok(swapped.ignored.some((i) => i.param === "to"));
  const unknownBatch = await serviceAs(ids.A, "admin").getReport({ batch: randomUUID() });
  assert.equal(unknownBatch.filters.batchId, null);
  assert.ok(unknownBatch.ignored.some((i) => i.param === "batch"));
});

test("students and signed-out callers are refused before any read", async () => {
  for (const [uid, role] of [[X.S1, "student"], [null, null]]) {
    let reads = 0;
    const repository = new Proxy(repoAs(uid), { get: (t, k) => (typeof t[k] === "function" ? (...a) => (reads++, t[k](...a)) : t[k]) });
    const svc = createReportsService({ repository, getCurrentUser: async () => (uid ? userOf(uid, role) : null) });
    await assert.rejects(svc.getReport({ type: "attendance", batch: X.BO }), ReportsAuthorizationError);
    assert.equal(reads, 0, `${role ?? "anonymous"}: no read at all`);
  }
});

test("RLS: even calling the repository directly, students see only their own rows and other trainers nothing of RP-BO", async () => {
  const student = repoAs(X.S1);
  const own = await quiet(() => student.listAttendance([X.BO]).catch(() => []));
  assert.ok(own.length > 0 && own.every((a) => a.student_id === X.S1), "only the student's own attendance");
  assert.deepEqual(await quiet(() => student.listBestResults([X.BO]).catch(() => [])), [], "students never read test_best_results");
  const subs = await quiet(() => student.listSubmissions([X.BO]).catch(() => []));
  assert.ok(subs.every((s) => s.student_id === X.S1));
  const other = repoAs(X.TR2);
  assert.deepEqual(await quiet(() => other.listAttendance([X.BO]).catch(() => [])), []);
  assert.deepEqual(await quiet(() => other.listBestResults([X.BO]).catch(() => [])), []);
  const anon = repoAs(null);
  assert.deepEqual(await quiet(() => anon.listAttendance([X.BO]).catch(() => [])), []);
});
