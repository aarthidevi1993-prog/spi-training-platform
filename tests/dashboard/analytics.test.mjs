// Dashboard D2b-2A — src/lib/dashboard/analytics.ts (pure): response validation against the 0024 contract,
// the locked comparison rules (rates in percentage points; counts as % change / New / —), labels, topic
// bands (Healthy / Watch / Attention), the four analytics health indicators and the overall line
// (worst line wins, No data / Unavailable excluded, never a score), and the period-based read model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rawAnalytics } from "./analytics-fixture.mjs";

const build = process.env.DASHBOARD_BUILD;
const a = await import(`${build}/lib/dashboard/analytics.mjs`);
const lib = await import(`${build}/lib/dashboard/admin-dashboard.mjs`);

// ---------------------------------------------------------------- validation

test("validation: the 0024 response parses to typed values; nulls stay null", () => {
  const raw = a.parseAnalytics(rawAnalytics());
  assert.equal(raw.period.bucket, "week");
  assert.equal(raw.trend[1].test_avg, null, "a bucket without results keeps null");
  assert.equal(raw.totals.previous.assignment_avg, null);
  assert.equal(raw.topics[0].band, "attention");
  assert.equal(raw.batches[0].prev_attendance_pct, null);
  assert.equal(raw.health.reviews_waiting_over_7d, 2);
});

test("validation: anything outside the contract is rejected with AnalyticsShapeError naming the path — never cast", () => {
  const bad = (mutate, path) => {
    const r = rawAnalytics();
    mutate(r);
    assert.throws(() => a.parseAnalytics(r), (e) => e instanceof a.AnalyticsShapeError && e.path === path, path);
  };
  assert.throws(() => a.parseAnalytics(null), a.AnalyticsShapeError);
  assert.throws(() => a.parseAnalytics([]), a.AnalyticsShapeError);
  bad((r) => { r.period.bucket = "day"; }, "period.bucket");
  bad((r) => { r.period.from = "2026-02-30"; }, "period.from");
  bad((r) => { r.totals.current.results = -1; }, "totals.current.results");
  bad((r) => { r.totals.current.results = 1.5; }, "totals.current.results");
  bad((r) => { r.totals.current.test_avg = "78"; }, "totals.current.test_avg");
  bad((r) => { r.trend = {}; }, "trend");
  bad((r) => { r.topics[0].band = "weak"; }, "topics[0].band");
  bad((r) => { r.topics[1].percent = Number.NaN; }, "topics[1].percent");
  bad((r) => { delete r.health; }, "health");
  bad((r) => { r.students.top[0].id = 7; }, "students.top[0].id");
  bad((r) => { r.batches[0].students = null; }, "batches[0].students");
});

// ---------------------------------------------------------------- comparisons

test("rates: percentage-point difference (78 % → 82 % = +4 pp), never a percent change", () => {
  assert.deepEqual(a.ratePointChange(82, 78), { current: 82, previous: 78, points: 4, state: "change" });
  assert.equal(a.formatPoints(a.ratePointChange(82, 78)), "+4 pp", "not +5.13 %");
  assert.equal(a.formatPoints(a.ratePointChange(72, 78)), "−6 pp");
  assert.equal(a.formatPoints(a.ratePointChange(81.25, 88)), "−6.8 pp", "half away from zero");
  assert.equal(a.formatPoints(a.ratePointChange(80, 80)), "0 pp");
  assert.deepEqual(a.ratePointChange(80, null), { current: 80, previous: null, points: null, state: "no_comparison" });
  assert.equal(a.formatPoints(a.ratePointChange(80, null)), "No comparison data");
  assert.deepEqual(a.ratePointChange(null, 80), { current: null, previous: 80, points: null, state: "no_data" });
  assert.equal(a.formatPoints(a.ratePointChange(null, null)), "—");
});

test("counts: % change when previous > 0; 'New' from 0; '—' when both are 0", () => {
  assert.deepEqual(a.countChange(24, 12), { current: 24, previous: 12, percent: 100, display: "+100%" });
  assert.deepEqual(a.countChange(9, 12), { current: 9, previous: 12, percent: -25, display: "−25%" });
  assert.deepEqual(a.countChange(12, 12), { current: 12, previous: 12, percent: 0, display: "0%" });
  assert.deepEqual(a.countChange(5, 0), { current: 5, previous: 0, percent: null, display: "New" });
  assert.deepEqual(a.countChange(0, 0), { current: 0, previous: 0, percent: null, display: "—" });
  assert.equal(a.countChange(0, 4).display, "−100%");
  assert.throws(() => a.countChange(-1, 2), RangeError);
});

test("progress percentages: null without a denominator (never 0 %)", () => {
  assert.equal(a.progressPercent(3, 5), 60);
  assert.equal(a.progressPercent(1, 3), 33.3);
  assert.equal(a.progressPercent(0, 0), null);
  assert.equal(a.progressPercent(2, 0), null);
  assert.equal(a.formatPercent(null), "—");
  assert.equal(a.formatPercent(81.25), "81.3%");
});

// ---------------------------------------------------------------- labels and periods

test("labels: India calendar dates printed as written (no time-zone shift); week and month buckets", () => {
  assert.equal(a.formatDateRange("2026-10-01", "2026-10-06"), "01 Oct – 06 Oct 2026");
  assert.equal(a.formatDateRange("2025-12-28", "2026-01-03"), "28 Dec 2025 – 03 Jan 2026");
  assert.equal(a.formatDateRange("2026-10-01", "2026-10-01"), "01 Oct 2026");
  assert.equal(a.bucketLabel("2026-03-04", "2026-03-10", "week"), "04–10 Mar");
  assert.equal(a.bucketLabel("2026-02-26", "2026-03-03", "week"), "26 Feb – 03 Mar");
  assert.equal(a.bucketLabel("2026-03-01", "2026-03-01", "week"), "01 Mar");
  assert.equal(a.bucketLabel("2026-03-01", "2026-03-31", "month"), "Mar 2026");
});

test("period key: the four supported values; anything else (missing, unknown, injected, repeated) → this_month or the first value", () => {
  for (const k of ["this_month", "previous_month", "last_3_months", "last_6_months"]) assert.equal(a.resolvePeriodKey(k), k);
  for (const v of [undefined, null, "", "all_time", "This_Month", "this_month' or 1=1", 3]) assert.equal(a.resolvePeriodKey(v), "this_month");
  assert.equal(a.resolvePeriodKey(["last_3_months", "this_month"]), "last_3_months");
});

// ---------------------------------------------------------------- read model

test("read model: four management-level figures with pp comparisons and their evidence; trend with gaps; topics with the locked bands", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month");
  assert.deepEqual(p.period, { key: "this_month", label: "This month", from: "2026-10-01", to: "2026-10-06", prevFrom: "2026-09-25", prevTo: "2026-09-30", bucket: "week", rangeText: "01 Oct – 06 Oct 2026", prevRangeText: "25 Sept – 30 Sept 2026" }, "en-IN month names, as everywhere else in the app");
  assert.deepEqual(p.performance.map((m) => [m.label, a.formatPoints(m.comparison), m.evidence.display, m.evidenceNoun]), [
    ["Test average", "+6 pp", "+100%", "released results"],
    ["Pass rate", "+5 pp", "+100%", "released results"],
    ["Attendance", "−6.8 pp", "−20%", "attendance records"],
    ["Assignment average", "No comparison data", "New", "scored submissions"],
  ]);
  assert.deepEqual(p.trend.map((t) => [t.label, t.testAvg, t.results]), [["01–04 Oct", 76.5, 9], ["05–06 Oct", null, 0]], "a bucket without results is a gap, not 0");
  assert.deepEqual(p.topics.map((t) => [t.title, t.percent, t.answers, t.band]), [
    ["Control Valve Sizing", 33.33, 6, "attention"], ["Loop Identification", 70, 5, "watch"], ["P&ID Reading", 91.67, 6, "healthy"],
  ]);
  assert.deepEqual(Object.values(a.TOPIC_BAND_LABEL), ["Healthy", "Watch", "Attention"], "no Weak / Developing / Strong");
  assert.equal(p.hasActivity, true);
  assert.equal(p.hasComparison, true);
  assert.equal(p.resultsInPeriod, 24);
  assert.deepEqual(Object.keys(p.datasets).sort(), ["batches", "batches_total", "courses", "courses_total", "delivery", "delivery_total", "enrolment", "enrolment_total", "students"]);
  const j = JSON.stringify(p);
  assert.doesNotMatch(j, /module_performance|strongModules|weakModules|studentResults|filters/, "no Performance-page detail duplicated");
});

test("read model: an empty period has no activity and no invented figures; the comparison period is reported separately", () => {
  const empty = { test_avg: null, pass_rate: null, results: 0, attendance_pct: null, attendance_marked: 0, assignment_avg: null, assignments_scored: 0 };
  const r = rawAnalytics({ totals: { current: { ...empty }, previous: { ...empty } }, topics: [] });
  const p = a.buildAnalyticsPanels(a.parseAnalytics(r), "previous_month");
  assert.equal(p.period.label, "Previous month");
  assert.equal(p.hasActivity, false);
  assert.equal(p.hasComparison, false);
  assert.ok(p.performance.every((m) => m.comparison.state === "no_data" && m.comparison.current === null && m.evidence.display === "—"));
  assert.deepEqual(p.topics, [], "insufficient topic evidence → none listed (the panel says Insufficient data)");
});

// ---------------------------------------------------------------- health

const H = (o = {}) => ({ attendance_n: 40, attendance_pct: 90, results_n: 20, test_avg: 85, assignments_n: 10, assignment_avg: 85, students_assessed: 12, students_below_75: 0, reviews_waiting_over_7d: 0, ...o });
const status = (line) => line.status;

test("attendance indicator: Healthy ≥ 85, Watch ≥ 75, Attention < 75; No data below 5 records", () => {
  assert.deepEqual([85, 84.99, 75, 74.99].map((v) => status(a.attendanceHealth(H({ attendance_pct: v })))), ["healthy", "watch", "watch", "attention"]);
  assert.equal(status(a.attendanceHealth(H({ attendance_pct: null, attendance_n: 3 }))), "no_data");
  assert.match(a.attendanceHealth(H({ attendance_pct: null, attendance_n: 3 })).reason, /n = 3/);
  assert.match(a.attendanceHealth(H({ attendance_pct: null, attendance_n: 0 })).reason, /No attendance recorded/);
});

test("assessment indicator: Healthy ≥ 80, Watch ≥ 65, Attention < 65; No data without 5 results", () => {
  assert.deepEqual([80, 79.99, 65, 64.99].map((v) => status(a.assessmentHealth(H({ test_avg: v })))), ["healthy", "watch", "watch", "attention"]);
  assert.equal(status(a.assessmentHealth(H({ test_avg: null, results_n: 4 }))), "no_data");
});

test("assignments indicator: Healthy ≥ 80, Watch ≥ 65, Attention < 65; at least Watch while reviews wait > 7 days", () => {
  assert.deepEqual([80, 79.99, 65, 64.99].map((v) => status(a.assignmentsHealth(H({ assignment_avg: v })))), ["healthy", "watch", "watch", "attention"]);
  assert.equal(status(a.assignmentsHealth(H({ assignment_avg: 90, reviews_waiting_over_7d: 1 }))), "watch", "healthy average + waiting → Watch");
  assert.equal(status(a.assignmentsHealth(H({ assignment_avg: 50, reviews_waiting_over_7d: 3 }))), "attention", "worse band wins");
  assert.match(a.assignmentsHealth(H({ assignment_avg: 90, reviews_waiting_over_7d: 2 })).reason, /2 submissions have waited more than 7 days/);
  assert.equal(status(a.assignmentsHealth(H({ assignment_avg: null, assignments_n: 2, reviews_waiting_over_7d: 1 }))), "watch", "waiting is a fact even without an average");
  assert.equal(status(a.assignmentsHealth(H({ assignment_avg: null, assignments_n: 0, reviews_waiting_over_7d: 0 }))), "no_data");
});

test("students indicator: Attention when any assessed enrolled student is below 75 %, with the count; No data when none assessed", () => {
  const att = a.studentsHealth(H({ students_assessed: 12, students_below_75: 2 }));
  assert.deepEqual([att.status, att.reason], ["attention", "2 of 12 enrolled students below 75% attendance in this period."]);
  assert.equal(status(a.studentsHealth(H())), "healthy");
  assert.equal(status(a.studentsHealth(H({ students_assessed: 0 }))), "no_data");
});

test("overall: worst line wins (Attention > Watch > Healthy); No data and Unavailable excluded; 'Based on X of 6'; never a score", () => {
  const line = (key, s) => ({ key, label: key, status: s, reason: "r", href: "/admin", linkLabel: "l" });
  const keys = ["trainer_coverage", "batch_capacity", "attendance", "assessment", "assignments", "students"];
  const six = (...ss) => keys.map((k, i) => line(k, ss[i]));
  assert.deepEqual(a.overallHealth(six("healthy", "healthy", "healthy", "healthy", "healthy", "healthy")), { status: "healthy", basedOn: 6, total: 6, drivers: [] });
  assert.deepEqual(a.overallHealth(six("healthy", "watch", "healthy", "watch", "healthy", "healthy")), { status: "watch", basedOn: 6, total: 6, drivers: ["batch_capacity", "assessment"] });
  assert.deepEqual(a.overallHealth(six("watch", "healthy", "attention", "no_data", "watch", "unavailable")), { status: "attention", basedOn: 4, total: 6, drivers: ["attendance"] }, "partial No data");
  assert.deepEqual(a.overallHealth(six("no_data", "no_data", "no_data", "no_data", "no_data", "no_data")), { status: "no_data", basedOn: 0, total: 6, drivers: [] }, "all No data → No data, not a failure");
  assert.ok(Object.values(a.overallHealth(six("watch", "watch", "watch", "watch", "watch", "watch"))).every((v) => typeof v !== "number" || Number.isInteger(v)), "counts only — no score");
  assert.equal(a.HEALTH_INDICATOR_COUNT, 6);
  assert.deepEqual(a.analyticsHealth(H()).map((l) => l.key), ["attendance", "assessment", "assignments", "students"]);
  assert.deepEqual(a.unavailableAnalyticsHealth().map((l) => l.status), ["unavailable", "unavailable", "unavailable", "unavailable"]);
  assert.deepEqual(Object.keys(lib.HEALTH_LABEL), ["healthy", "watch", "attention", "no_data", "unavailable"], "one health vocabulary");
});

// ---------------------------------------------------------------- D2b-2B: batch / course comparison

const batchRow = (o = {}) => ({
  id: "b1", code: "B-1", name: "Batch One", course_id: "c1", course: "Valves", students: 5,
  attendance_pct: 80, attendance_n: 15, test_avg: 73.75, pass_rate: 90, results_n: 20, assignment_avg: 78.57, assignments_n: 7,
  completion_pct: 20, prev_test_avg: 60, prev_results_n: 5, prev_attendance_pct: null, prev_attendance_n: 2, ...o,
});
const courseRow = (o = {}) => ({
  id: "c1", code: "C-1", title: "Valves", test_avg: 74.57, pass_rate: 91.3, results_n: 23, attendance_pct: 80, attendance_n: 15,
  assignment_avg: 78.57, assignments_n: 7, prev_test_avg: 60, prev_results_n: 5, ...o,
});

test("batch comparison read model: figures with their evidence, pp change only with a previous figure, completion as a CURRENT figure, existing links", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month");
  assert.equal(p.batches.total, 1);
  assert.equal(p.batches.shownText, null, "all rows shown → no 'Showing X of N'");
  const [b] = p.batches.rows;
  assert.deepEqual([b.id, b.code, b.name, b.course, b.students], ["b1", "B-1", "Batch One", "Valves", 5]);
  assert.deepEqual(b.testAvg, { value: 73.75, evidence: 20, display: "73.8%" });
  assert.equal(b.testAvgChange.display, "+13.8 pp");
  assert.equal(b.testAvgChange.comparison.previous, 60);
  assert.equal(b.testAvgChange.previousEvidence, 5);
  assert.deepEqual(b.passRate, { value: 90, evidence: 20, display: "90%" });
  assert.deepEqual(b.attendance, { value: 80, evidence: 15, display: "80%" });
  assert.equal(b.attendanceChange.display, "No comparison data", "previous attendance below the evidence minimum");
  assert.equal(b.attendanceChange.comparison.points, null, "never an invented 0 pp");
  assert.equal(b.attendanceChange.previousEvidence, 2);
  assert.deepEqual(b.assignmentAvg, { value: 78.57, evidence: 7, display: "78.6%" });
  assert.equal(b.completionPct, 20);
  assert.equal(b.completionDisplay, "20%");
  assert.equal(b.href, "/admin/batches/b1");
  assert.equal(b.performanceHref, "/admin/performance?batch=b1");
  assert.ok(!("band" in b) && !("status" in b), "no Healthy / Watch / Attention on a batch");
});

test("course comparison read model: figures with their evidence; only the test average has a comparison; course detail link", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month");
  assert.equal(p.courses.total, 1);
  assert.equal(p.courses.shownText, null);
  const [c] = p.courses.rows;
  assert.deepEqual([c.id, c.code, c.title], ["c1", "C-1", "Valves"]);
  assert.deepEqual(c.testAvg, { value: 74.57, evidence: 23, display: "74.6%" });
  assert.equal(c.testAvgChange.display, "+14.6 pp");
  assert.deepEqual(c.passRate, { value: 91.3, evidence: 23, display: "91.3%" });
  assert.deepEqual(c.attendance, { value: 80, evidence: 15, display: "80%" });
  assert.deepEqual(c.assignmentAvg, { value: 78.57, evidence: 7, display: "78.6%" });
  assert.ok(!("attendanceChange" in c) && !("passRateChange" in c), "0024 has no previous course attendance / pass rate");
  assert.equal(c.href, "/admin/courses/c1");
  assert.ok(!("band" in c) && !("status" in c));
});

test("comparison: insufficient evidence → 'Insufficient data (n)'; missing previous → 'No comparison data'; ids are URL-encoded", () => {
  const b = a.batchComparison([batchRow({ id: "a/b?c", test_avg: null, pass_rate: null, results_n: 3, attendance_pct: null, attendance_n: 0, assignment_avg: null, assignments_n: 4, completion_pct: null, prev_test_avg: null })], 1).rows[0];
  assert.deepEqual(b.testAvg, { value: null, evidence: 3, display: "Insufficient data (3)" });
  assert.equal(b.passRate.display, "Insufficient data (3)");
  assert.equal(b.attendance.display, "Insufficient data (0)", "no records is not 0 %");
  assert.equal(b.assignmentAvg.display, "Insufficient data (4)");
  assert.equal(b.testAvgChange.display, "No comparison data");
  assert.equal(b.testAvgChange.comparison.points, null);
  assert.equal(b.completionDisplay, "—", "no enrolments → '—', never 0 %");
  assert.equal(b.href, "/admin/batches/a%2Fb%3Fc");
  assert.equal(b.performanceHref, "/admin/performance?batch=a%2Fb%3Fc");
  // current present, previous missing; current missing, previous present — both 'No comparison data'
  assert.equal(a.figureChange(70, null, 0).display, "No comparison data");
  assert.equal(a.figureChange(null, 70, 9).display, "No comparison data");
  assert.equal(a.figureChange(70, 70, 9).display, "0 pp", "a real zero change only when both sides exist");
  assert.equal(a.figureChange(61.25, 70, 9).display, "−8.8 pp");
  const c = a.courseComparison([courseRow({ test_avg: null, results_n: 4, prev_test_avg: 50 })], 1).rows[0];
  assert.equal(c.testAvg.display, "Insufficient data (4)");
  assert.equal(c.testAvgChange.display, "No comparison data");
});

test("comparison: name / title order preserved exactly as returned (never re-ranked); 'Showing X of N' when the total is larger; empty lists", () => {
  const rows = [batchRow({ id: "b1", name: "Alpha", test_avg: 40 }), batchRow({ id: "b2", name: "Bravo", test_avg: 95 }), batchRow({ id: "b3", name: "Charlie", test_avg: 70 })];
  const list = a.batchComparison(rows, 14);
  assert.deepEqual(list.rows.map((r) => r.name), ["Alpha", "Bravo", "Charlie"], "not sorted by any figure");
  assert.equal(list.total, 14);
  assert.equal(list.shownText, "Showing 3 of 14");
  const ten = a.batchComparison(Array.from({ length: 10 }, (_, i) => batchRow({ id: `b${i}`, name: `B${i}` })), 23);
  assert.equal(ten.shownText, "Showing 10 of 23");
  assert.equal(a.batchComparison(rows, 3).shownText, null);
  const courses = a.courseComparison([courseRow({ id: "c2", title: "Zeta", test_avg: 99 }), courseRow({ id: "c1", title: "Alpha", test_avg: 10 })], 12);
  assert.deepEqual(courses.rows.map((r) => r.id), ["c2", "c1"], "the function's order is kept as is");
  assert.equal(courses.shownText, "Showing 2 of 12");
  assert.deepEqual(a.batchComparison([], 0), { rows: [], total: 0, shownText: null });
  assert.deepEqual(a.courseComparison([], 0), { rows: [], total: 0, shownText: null });
  const empty = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics({ batches: [], batches_total: 0, courses: [], courses_total: 0 })), "this_month");
  assert.deepEqual([empty.batches.rows.length, empty.courses.rows.length], [0, 0]);
});

// ---------------------------------------------------------------- D2b-2C: Student Performance (Top 5) — students.current (0027)

const cur = (rank, o = {}) => ({
  rank, id: `c${rank}`, code: `C-${rank}`, name: `Current ${rank}`, average: 100 - rank, results: 3 + rank,
  period_average: 90, period_results: 2, previous_average: 88, previous_results: 1, trend: 2, ...o,
});
const withCurrent = (current, current_window = { from: "2025-10-06", to: "2026-10-06" }) => {
  const r = rawAnalytics();
  r.students = { ...r.students, current, current_window };
  return r;
};

test("student performance parser: students.current and current_window read with the strict 0027 contract; malformed data rejected (never cast or substituted)", () => {
  const raw = a.parseAnalytics(rawAnalytics());
  assert.deepEqual(raw.students.current[0], { rank: 1, id: "s2", code: "S-2", name: "Student Two", average: 96, results: 4, period_average: 96, period_results: 2, previous_average: 88, previous_results: 1, trend: 8 });
  assert.equal(raw.students.current[2].trend, null, "no comparison stays null");
  assert.deepEqual(raw.students.current_window, { from: "2025-10-06", to: "2026-10-06" });
  const bad = (mutate, path) => {
    const r = rawAnalytics();
    mutate(r);
    assert.throws(() => a.parseAnalytics(r), (e) => e instanceof a.AnalyticsShapeError && e.path === path, path);
  };
  bad((r) => { delete r.students.current; }, "students.current");
  bad((r) => { r.students.current = {}; }, "students.current");
  bad((r) => { delete r.students.current_window; }, "students.current_window");
  bad((r) => { r.students.current_window.to = "2026-02-30"; }, "students.current_window.to");
  bad((r) => { r.students.current[0].rank = 2; }, "students.current[0].rank");                 // database order is 1, 2, 3 …
  bad((r) => { [r.students.current[0], r.students.current[1]] = [r.students.current[1], r.students.current[0]]; }, "students.current[0].rank");
  bad((r) => { r.students.current[1].average = "92"; }, "students.current[1].average");
  bad((r) => { r.students.current[1].results = 2.5; }, "students.current[1].results");
  bad((r) => { r.students.current[0].trend = "8"; }, "students.current[0].trend");
  bad((r) => { delete r.students.current[0].previous_results; }, "students.current[0].previous_results");
  bad((r) => { r.students.current[0].id = 7; }, "students.current[0].id");
  bad((r) => { r.students.current = [1, 2, 3, 4, 5, 6].map((n) => cur(n)); }, "students.current");     // at most 5
});

test("student performance read model: database rank order kept (never re-ranked), at most 5, Test Avg with one decimal", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month").students;
  assert.deepEqual(p.rows.map((r) => [r.rank, r.name, r.code, r.averageDisplay, r.results]), [
    [1, "Student Two", "S-2", "96.0%", 4],
    [2, "Student One", "S-1", "92.3%", 5],   // 92.25 → 92.3 (half away from zero)
    [3, "Student Three", "S-3", "88.0%", 3],
  ]);
  // Ranked by the database even when the averages would sort differently (the application never re-ranks).
  const odd = a.buildAnalyticsPanels(a.parseAnalytics(withCurrent([cur(1, { average: 70 }), cur(2, { average: 95 }), cur(3, { average: 80 })])), "this_month").students;
  assert.deepEqual(odd.rows.map((r) => [r.rank, r.id]), [[1, "c1"], [2, "c2"], [3, "c3"]]);
  const five = a.buildAnalyticsPanels(a.parseAnalytics(withCurrent([1, 2, 3, 4, 5].map((n) => cur(n)))), "this_month").students;
  assert.equal(five.rows.length, 5);
  assert.equal(a.STUDENT_PERFORMANCE_LIMIT, 5);
  assert.deepEqual(["96.0%", "99.9%", "100.0%", "0.0%", "66.7%"], [96, 99.94, 100, 0, 66.65].map(a.formatAverage));
  assert.deepEqual(p.window, { from: "2025-10-06", to: "2026-10-06" });
  assert.equal(p.caption, "Current ranking: last 366 days · trend: This month vs previous");
  assert.equal(a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "last_12_months").students.caption, "Current ranking: last 366 days · trend: Last 12 months vs previous");
  for (const r of p.rows) assert.ok(!("band" in r) && !("status" in r) && !("href" in r), "no status band or per-student link");
});

test("student performance trend: the database pp value exactly; ≥ +1 up, ≤ −1 down, in between neutral; null → 'No comparison'", () => {
  assert.equal(a.TREND_THRESHOLD_PP, 1);
  const cases = [
    [8, "up", "+8 pp", "Up"],
    [1, "up", "+1 pp", "Up"],                       // exactly +1 → up
    [0.99, "neutral", "+0.99 pp", "No meaningful change"],
    [0.5, "neutral", "+0.5 pp", "No meaningful change"],
    [0, "neutral", "0 pp", "No meaningful change"],
    [-0.99, "neutral", "−0.99 pp", "No meaningful change"],
    [-1, "down", "−1 pp", "Down"],                  // exactly −1 → down
    [-12.25, "down", "−12.25 pp", "Down"],
    [null, "none", "No comparison", "No comparison"],
  ];
  const rows = a.buildAnalyticsPanels(a.parseAnalytics(withCurrent(cases.map(([t], i) => cur(i + 1, { trend: t })).slice(0, 5))), "this_month").students.rows;
  const rows2 = a.buildAnalyticsPanels(a.parseAnalytics(withCurrent(cases.map(([t], i) => cur(i + 1, { trend: t })).slice(5).map((c, i) => ({ ...c, rank: i + 1 })))), "this_month").students.rows;
  assert.deepEqual([...rows, ...rows2].map((r) => [r.trend, r.trendDirection, r.trendDisplay, r.directionLabel]), cases);
  for (const [t, dir] of cases) assert.equal(a.trendDirection(t), dir, String(t));
  assert.equal(a.formatTrendPoints(-3.2), "−3.2 pp", "a real minus sign; the value as returned (no re-rounding)");
});

test("student performance: no student with 3 or more released results → the insufficient-data state, never invented rows", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(withCurrent([])), "last_3_months").students;
  assert.equal(p.insufficient, true);
  assert.deepEqual(p.rows, []);
  assert.equal(p.caption, "Current ranking: last 366 days · trend: Last 3 months vs previous");
  assert.equal(a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month").students.insufficient, false);
});

// ---------------------------------------------------------------- D2b-2D: Course Progress — delivery[] / enrolment[] (current state)

const del = (id, planned, delivered, overdue) => ({ course_id: id, course: `Course ${id}`, planned, delivered, overdue });
const enr = (id, completed, active) => ({ course_id: id, course: `Course ${id}`, completed, active });
const withProgress = (delivery, delivery_total, enrolment, enrolment_total) => ({ ...rawAnalytics(), delivery, delivery_total, enrolment, enrolment_total });

test("course progress read model: delivery and enrolment joined by course_id; delivered / planned and completed / active computed once from the counts", () => {
  const p = a.buildAnalyticsPanels(a.parseAnalytics(rawAnalytics()), "this_month").progress;
  assert.deepEqual(p.rows, [{
    courseId: "c1", course: "Valves",
    delivery: { planned: 5, delivered: 3, overdue: 1, percent: 60, percentDisplay: "60%" },
    enrolment: { completed: 4, active: 8, percent: 50, percentDisplay: "50%" },
  }]);
  assert.deepEqual([p.deliveryTotal, p.enrolmentTotal, p.deliveryShownText, p.enrolmentShownText, p.empty], [1, 1, null, null, false]);
  // one decimal, from the counts (2 / 3 → 66.7 %, 1 / 3 → 33.3 %)
  const x = a.courseProgress([del("a", 3, 2, 0)], 1, [enr("a", 1, 3)], 1).rows[0];
  assert.deepEqual([x.delivery.percent, x.delivery.percentDisplay, x.enrolment.percent, x.enrolment.percentDisplay], [66.7, "66.7%", 33.3, "33.3%"]);
});

test("course progress: courses in both lists, only in delivery, only in enrolment — none discarded, never matched by position; authoritative order kept", () => {
  // Different course sets and different positions: b is 2nd in delivery but 1st in enrolment.
  const p = a.courseProgress([del("a", 4, 4, 0), del("b", 8, 6, 2), del("d", 2, 0, 1)], 3, [enr("b", 3, 10), enr("c", 5, 5), enr("a", 0, 7)], 3);
  assert.deepEqual(p.rows.map((r) => [r.courseId, r.delivery?.percentDisplay ?? null, r.delivery?.overdue ?? null, r.enrolment?.percentDisplay ?? null]), [
    ["a", "100%", 0, "0%"],   // both lists (enrolment matched by id, not by position); 0 / 7 is a real 0 %
    ["b", "75%", 2, "30%"],   // both lists
    ["d", "0%", 1, null],     // delivery only (0 of 2 delivered is a real 0 %)
    ["c", null, null, "100%"], // enrolment only — appended after the delivery order, in the enrolment order
  ]);
  assert.equal(p.rows.find((r) => r.courseId === "d").enrolment, null);
  assert.equal(p.rows.find((r) => r.courseId === "c").delivery, null);
});

test("course progress: no denominator → null and '—', never 0 %; empty lists → the empty state", () => {
  const p = a.courseProgress([del("a", 0, 0, 0)], 1, [enr("a", 0, 0)], 1);
  assert.deepEqual([p.rows[0].delivery.percent, p.rows[0].delivery.percentDisplay, p.rows[0].enrolment.percent, p.rows[0].enrolment.percentDisplay], [null, "—", null, "—"]);
  assert.deepEqual(a.courseProgress([], 0, [], 0), { rows: [], deliveryTotal: 0, enrolmentTotal: 0, deliveryShownText: null, enrolmentShownText: null, empty: true });
  const onlyEnrolment = a.courseProgress([], 0, [enr("a", 1, 2)], 1);
  assert.deepEqual([onlyEnrolment.empty, onlyEnrolment.rows[0].delivery, onlyEnrolment.rows[0].enrolment.percentDisplay], [false, null, "50%"]);
  const onlyDelivery = a.courseProgress([del("a", 2, 1, 0)], 1, [], 0);
  assert.deepEqual([onlyDelivery.empty, onlyDelivery.rows[0].enrolment, onlyDelivery.rows[0].delivery.percentDisplay], [false, null, "50%"]);
});

test("course progress: 'Showing X of N' from delivery_total / enrolment_total when a list is a subset", () => {
  const p = a.courseProgress([1, 2, 3].map((n) => del(`d${n}`, 4, 2, 0)), 14, [1, 2].map((n) => enr(`e${n}`, 1, 2)), 12);
  assert.equal(p.deliveryShownText, "Delivery: showing 3 of 14 courses");
  assert.equal(p.enrolmentShownText, "Enrolment: showing 2 of 12 courses");
  assert.deepEqual([p.deliveryTotal, p.enrolmentTotal], [14, 12]);
  assert.deepEqual([a.courseProgress([del("a", 1, 1, 0)], 1, [], 0).deliveryShownText, a.courseProgress([], 0, [enr("a", 1, 1)], 1).enrolmentShownText], [null, null]);
});

test("course progress is current state: identical for every dashboard period (the period never enters the read model); parser rejects malformed lists", () => {
  const raw = a.parseAnalytics(withProgress([del("a", 8, 6, 2)], 1, [enr("a", 3, 10), enr("b", 1, 4)], 2));
  const all = ["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months"].map((k) => a.buildAnalyticsPanels(raw, k).progress);
  for (const p of all) assert.deepEqual(p, all[0]);
  assert.equal(all[0].rows.length, 2);
  const bad = (mutate, path) => {
    const r = rawAnalytics();
    mutate(r);
    assert.throws(() => a.parseAnalytics(r), (e) => e instanceof a.AnalyticsShapeError && e.path === path, path);
  };
  bad((r) => { r.delivery[0].planned = -1; }, "delivery[0].planned");
  bad((r) => { r.enrolment[0].active = "8"; }, "enrolment[0].active");
  bad((r) => { r.delivery_total = 1.5; }, "delivery_total");
  assert.equal(a.ATTENDANCE_DEFINITION_NOTE, "Attendance on this dashboard excludes excused absences; the Performance Tracker counts excused absences as attended.");
});
