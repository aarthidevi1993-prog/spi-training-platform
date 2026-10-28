/**
 * Reports — pure logic: URL filter validation, the four report tables
 * (attendance, student performance, test results, assignment
 * completion) built from records the caller's own session could read,
 * and the conversion to an export table. No database, no session, no
 * `server-only`: tested directly by tests/reports and the local database
 * tests.
 *
 * Every figure is a factual summary of stored data, computed with the
 * same rules as the Performance pages (performance.service.ts):
 *   - attendance % = (present + late + excused) / marked records × 100
 *     (unmarked classes are not counted as absent);
 *   - test results = the best finished attempt per test × student, only
 *     for RELEASED tests (effectively closed), never re-graded;
 *   - assignment average = returned submissions with a score and a max
 *     score, each as a percentage.
 * The table shown on the page and the exported file are the SAME table.
 *
 * Authorization is NOT decided here: reportsService admits only Super
 * Admins and trainers, scopes the batches, and RLS decides every row.
 */

export type ReportType = "attendance" | "performance" | "test_results" | "assignments";

export const REPORT_TYPES: readonly { value: ReportType; label: string; description: string }[] = [
  { value: "attendance", label: "Attendance", description: "Marked classes per student and batch: present, late, excused, absent and attendance %." },
  { value: "performance", label: "Student performance", description: "Per student and batch: released test results, attendance and returned assignment scores." },
  { value: "test_results", label: "Test results", description: "Best finished attempt per released test and student." },
  { value: "assignments", label: "Assignment completion", description: "Every published assignment × enrolled student: submitted, returned or not submitted." },
];

export interface ReportFilters {
  type: ReportType;
  courseId: string | null;
  batchId: string | null;
  studentId: string | null;
  /** Inclusive YYYY-MM-DD bounds (class date / test date / assignment due date). */
  from: string | null;
  to: string | null;
}

/** A filter value that was ignored, and why (shown to the user). */
export interface IgnoredFilter {
  param: "type" | "course" | "batch" | "student" | "from" | "to";
  reason: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = REPORT_TYPES.map((t) => t.value);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is refused). */
export function isIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * URL → filters. Only well-formed values survive; anything else is ignored and listed in `ignored`
 * so the page can say so. Scope (is this batch/student/course the caller's?) is checked by the service.
 */
export function parseReportFilters(params: SearchParams | null | undefined): { filters: ReportFilters; ignored: IgnoredFilter[] } {
  const p = params ?? {};
  const ignored: IgnoredFilter[] = [];
  const raw = (key: string) => {
    const v = first(p[key])?.trim();
    return v ? v : null;
  };

  const rawType = raw("type");
  let type: ReportType = "attendance";
  if (rawType) {
    if ((TYPES as string[]).includes(rawType)) type = rawType as ReportType;
    else ignored.push({ param: "type", reason: "Unknown report type — showing Attendance." });
  }

  const id = (key: "course" | "batch" | "student") => {
    const v = raw(key);
    if (v === null) return null;
    if (UUID_PATTERN.test(v)) return v.toLowerCase();
    ignored.push({ param: key, reason: `The ${key} filter isn't valid and was ignored.` });
    return null;
  };
  const date = (key: "from" | "to") => {
    const v = raw(key);
    if (v === null) return null;
    if (isIsoDate(v)) return v;
    ignored.push({ param: key, reason: `The "${key}" date isn't a valid date (YYYY-MM-DD) and was ignored.` });
    return null;
  };

  const courseId = id("course");
  const batchId = id("batch");
  const studentId = id("student");
  let from = date("from");
  let to = date("to");
  if (from && to && from > to) {
    ignored.push({ param: "to", reason: 'The "to" date is before the "from" date, so both dates were ignored.' });
    from = null;
    to = null;
  }
  return { filters: { type, courseId, batchId, studentId, from, to }, ignored };
}

/** The page URL for these filters (empty values omitted). */
export function reportsHref(basePath: string, filters: Partial<ReportFilters>): string {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.courseId) params.set("course", filters.courseId);
  if (filters.batchId) params.set("batch", filters.batchId);
  if (filters.studentId) params.set("student", filters.studentId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

// -------------------------------------------------------------------
// Records (as read under the caller's own session — reports.repository.core.ts)
// -------------------------------------------------------------------
export interface ReportBatchRecord {
  id: string;
  batch_code: string;
  name: string;
  status: string;
  course_id: string;
  courses: { course_code: string; title: string } | null;
}
export interface ReportEnrolmentRecord {
  batch_id: string;
  student_id: string;
  enrollment_status: string;
  students: { full_name: string; student_code: string } | null;
}
export interface ReportClassRecord {
  id: string;
  batch_id: string;
  class_date: string;
}
export interface ReportAttendanceRecord {
  class_id: string;
  student_id: string;
  batch_id: string;
  status: string;
}
export interface ReportBestResultRecord {
  test_id: string;
  batch_id: string;
  student_id: string;
  score: number | string;
  max_score: number | string;
  percentage: number | string;
  passed: boolean;
  finalized_at: string | null;
}
export interface ReportTestRecord {
  id: string;
  batch_id: string;
  title: string;
  status: string;
  available_from: string | null;
  available_until: string | null;
  classes: { class_date: string } | null;
}
export interface ReportAssignmentRecord {
  id: string;
  batch_id: string;
  title: string;
  due_at: string | null;
  max_score: number | string | null;
  status: string;
}
export interface ReportSubmissionRecord {
  assignment_id: string;
  student_id: string;
  batch_id: string;
  status: string;
  submitted_at: string | null;
  score: number | string | null;
}

/** Everything one report needs, already restricted to the caller's scope and the chosen batches/student. */
export interface ReportSource {
  batches: ReportBatchRecord[];
  enrolments: ReportEnrolmentRecord[];
  classes: ReportClassRecord[];
  attendance: ReportAttendanceRecord[];
  bestResults: ReportBestResultRecord[];
  tests: ReportTestRecord[];
  assignments: ReportAssignmentRecord[];
  submissions: ReportSubmissionRecord[];
}

// -------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------
export type ReportCell = string | number | null;

export interface ReportTable {
  headers: string[];
  rows: ReportCell[][];
}

export interface ReportSummaryItem {
  label: string;
  value: string;
}

export interface BuiltReport {
  table: ReportTable;
  summary: ReportSummaryItem[];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round2(values.reduce((sum, v) => sum + v, 0) / values.length);
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? round2((part / whole) * 100) : null);
const show = (value: number | null, suffix = "%"): string => (value === null ? "—" : `${value}${suffix}`);
const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Display mirror of test_effective_status (0008), as performance.service.ts: released once effectively closed. */
export function isReleased(test: Pick<ReportTestRecord, "status" | "available_until">, now: number): boolean {
  if (test.status === "draft") return false;
  if (test.status === "closed") return true;
  return Boolean(test.available_until && now >= new Date(test.available_until).getTime());
}

/** The date a test is reported under: its close, else its opening, else its class date (performance.service.ts). */
export function testDate(test: Pick<ReportTestRecord, "available_until" | "available_from" | "classes">): string | null {
  return test.available_until ?? test.available_from ?? test.classes?.class_date ?? null;
}

/** India calendar date (the platform's day, as the dashboards' "India today"), formatted YYYY-MM-DD. */
const INDIA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * YYYY-MM-DD of a date or timestamp. A plain date (class_date) is kept as stored; a timestamp is converted to its
 * India calendar date — never cut from the text, whose offset depends on the server (Supabase returns UTC, so
 * 00:00–05:30 IST would otherwise land on the previous day).
 */
export function day(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : INDIA_DATE.format(t);
}

export function inRange(value: string | null, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  const d = day(value);
  if (!d) return false;
  return (!from || d >= from) && (!to || d <= to);
}

interface Context {
  batchById: Map<string, ReportBatchRecord>;
  studentName: Map<string, { name: string; code: string }>;
  enrolment: Map<string, string>;
}

function context(source: ReportSource): Context {
  const studentName = new Map<string, { name: string; code: string }>();
  const enrolment = new Map<string, string>();
  for (const e of source.enrolments) {
    if (e.students) studentName.set(e.student_id, { name: e.students.full_name, code: e.students.student_code });
    enrolment.set(`${e.batch_id}|${e.student_id}`, e.enrollment_status);
  }
  return { batchById: new Map(source.batches.map((b) => [b.id, b])), studentName, enrolment };
}

const ENROLMENT_LABEL: Record<string, string> = { enrolled: "Enrolled", completed: "Completed", withdrawn: "Withdrawn" };

function personCells(ctx: Context, batchId: string, studentId: string): ReportCell[] {
  const b = ctx.batchById.get(batchId);
  const s = ctx.studentName.get(studentId);
  return [b?.courses?.course_code ?? "", b?.batch_code ?? "", b?.name ?? "", s?.code ?? "", s?.name ?? "Unknown student"];
}

/** Stable order: course code, batch code, student name, student code (then ids). */
function sortKeyed<T extends { batchId: string; studentId: string }>(ctx: Context, items: T[], extra: (a: T, b: T) => number = () => 0): T[] {
  return [...items].sort((a, b) => {
    const ba = ctx.batchById.get(a.batchId);
    const bb = ctx.batchById.get(b.batchId);
    const sa = ctx.studentName.get(a.studentId);
    const sb = ctx.studentName.get(b.studentId);
    return (
      (ba?.courses?.course_code ?? "").localeCompare(bb?.courses?.course_code ?? "") ||
      (ba?.batch_code ?? "").localeCompare(bb?.batch_code ?? "") ||
      extra(a, b) ||
      (sa?.name ?? "").localeCompare(sb?.name ?? "") ||
      (sa?.code ?? "").localeCompare(sb?.code ?? "") ||
      a.batchId.localeCompare(b.batchId) ||
      a.studentId.localeCompare(b.studentId)
    );
  });
}

/** Attendance records within the date range (by their class date). */
function attendanceInRange(source: ReportSource, from: string | null, to: string | null): ReportAttendanceRecord[] {
  if (!from && !to) return source.attendance;
  const classDate = new Map(source.classes.map((c) => [c.id, c.class_date]));
  return source.attendance.filter((a) => inRange(classDate.get(a.class_id) ?? null, from, to));
}

/** Best results of RELEASED tests within the date range (by test date). */
function releasedResults(source: ReportSource, from: string | null, to: string | null, now: number) {
  const tests = new Map(source.tests.filter((t) => isReleased(t, now) && inRange(testDate(t), from, to)).map((t) => [t.id, t]));
  return { tests, results: source.bestResults.filter((r) => tests.has(r.test_id)) };
}

/** Returned, scored submissions of assignments due within the range, as percentages (performance.service.ts rule). */
function scoredPercentages(source: ReportSource, from: string | null, to: string | null): { batchId: string; studentId: string; percent: number }[] {
  const assignments = new Map(source.assignments.filter((a) => inRange(a.due_at, from, to)).map((a) => [a.id, a]));
  const out: { batchId: string; studentId: string; percent: number }[] = [];
  for (const s of source.submissions) {
    const a = assignments.get(s.assignment_id);
    if (!a || s.status !== "returned") continue;
    const score = num(s.score);
    const max = num(a.max_score);
    if (score !== null && max !== null && max > 0) out.push({ batchId: s.batch_id, studentId: s.student_id, percent: (score / max) * 100 });
  }
  return out;
}

// ---------------------------------------------------------------- attendance
export const ATTENDANCE_HEADERS = [
  "Course code", "Batch code", "Batch", "Student code", "Student", "Enrolment",
  "Classes marked", "Present", "Late", "Excused", "Absent", "Attendance %",
];

export function buildAttendanceReport(source: ReportSource, filters: Pick<ReportFilters, "from" | "to">): BuiltReport {
  const ctx = context(source);
  const tally = new Map<string, { batchId: string; studentId: string; present: number; late: number; excused: number; absent: number }>();
  const key = (b: string, s: string) => `${b}|${s}`;
  // Every enrolment appears (0 marked is a fact), plus anyone with records.
  for (const e of source.enrolments) tally.set(key(e.batch_id, e.student_id), { batchId: e.batch_id, studentId: e.student_id, present: 0, late: 0, excused: 0, absent: 0 });
  const records = attendanceInRange(source, filters.from, filters.to);
  for (const a of records) {
    const k = key(a.batch_id, a.student_id);
    const t = tally.get(k) ?? { batchId: a.batch_id, studentId: a.student_id, present: 0, late: 0, excused: 0, absent: 0 };
    if (a.status === "present" || a.status === "late" || a.status === "excused" || a.status === "absent") t[a.status] += 1;
    tally.set(k, t);
  }
  const rows = sortKeyed(ctx, Array.from(tally.values())).map((t) => {
    const marked = t.present + t.late + t.excused + t.absent;
    return [
      ...personCells(ctx, t.batchId, t.studentId),
      ENROLMENT_LABEL[ctx.enrolment.get(key(t.batchId, t.studentId)) ?? ""] ?? "Not enrolled",
      marked, t.present, t.late, t.excused, t.absent,
      pct(t.present + t.late + t.excused, marked),
    ];
  });
  const attended = records.filter((r) => r.status !== "absent").length;
  return {
    table: { headers: ATTENDANCE_HEADERS, rows },
    summary: [
      { label: "Students", value: String(rows.length) },
      { label: "Attendance records", value: String(records.length) },
      { label: "Attended", value: String(attended) },
      { label: "Attendance", value: show(pct(attended, records.length)) },
    ],
  };
}

// ---------------------------------------------------------------- student performance
export const PERFORMANCE_HEADERS = [
  "Course code", "Batch code", "Batch", "Student code", "Student", "Enrolment",
  "Released tests", "Average test %", "Tests passed", "Pass rate %",
  "Classes marked", "Attendance %", "Scored assignments", "Assignment average %",
];

export function buildPerformanceReport(source: ReportSource, filters: Pick<ReportFilters, "from" | "to">, now: number): BuiltReport {
  const ctx = context(source);
  const key = (b: string, s: string) => `${b}|${s}`;
  type Acc = { batchId: string; studentId: string; tests: number[]; passed: number; marked: number; attended: number; assignments: number[] };
  const acc = new Map<string, Acc>();
  const get = (b: string, s: string): Acc => {
    const k = key(b, s);
    let a = acc.get(k);
    if (!a) {
      a = { batchId: b, studentId: s, tests: [], passed: 0, marked: 0, attended: 0, assignments: [] };
      acc.set(k, a);
    }
    return a;
  };
  for (const e of source.enrolments) get(e.batch_id, e.student_id);

  const { results } = releasedResults(source, filters.from, filters.to, now);
  for (const r of results) {
    const a = get(r.batch_id, r.student_id);
    a.tests.push(Number(r.percentage));
    if (r.passed) a.passed += 1;
  }
  const attendance = attendanceInRange(source, filters.from, filters.to);
  for (const r of attendance) {
    const a = get(r.batch_id, r.student_id);
    a.marked += 1;
    if (r.status !== "absent") a.attended += 1;
  }
  const scored = scoredPercentages(source, filters.from, filters.to);
  for (const s of scored) get(s.batchId, s.studentId).assignments.push(s.percent);

  const rows = sortKeyed(ctx, Array.from(acc.values())).map((a) => [
    ...personCells(ctx, a.batchId, a.studentId),
    ENROLMENT_LABEL[ctx.enrolment.get(key(a.batchId, a.studentId)) ?? ""] ?? "Not enrolled",
    a.tests.length,
    mean(a.tests),
    a.passed,
    pct(a.passed, a.tests.length),
    a.marked,
    pct(a.attended, a.marked),
    a.assignments.length,
    mean(a.assignments),
  ]);

  // Scope-wide figures with the Performance page's exact formulas (all records, not an average of averages).
  const allTests = results.map((r) => Number(r.percentage));
  const allPassed = results.filter((r) => r.passed).length;
  const attended = attendance.filter((r) => r.status !== "absent").length;
  return {
    table: { headers: PERFORMANCE_HEADERS, rows },
    summary: [
      { label: "Students", value: String(rows.length) },
      { label: "Average test score", value: show(mean(allTests)) },
      { label: "Pass rate", value: show(pct(allPassed, allTests.length)) },
      { label: "Attendance", value: show(pct(attended, attendance.length)) },
      { label: "Assignment average", value: show(mean(scored.map((s) => s.percent))) },
    ],
  };
}

// ---------------------------------------------------------------- test results
export const TEST_RESULTS_HEADERS = [
  "Course code", "Batch code", "Batch", "Student code", "Student",
  "Test", "Test date", "Score", "Max score", "Percentage", "Passed", "Finalized at",
];

export function buildTestResultsReport(source: ReportSource, filters: Pick<ReportFilters, "from" | "to">, now: number): BuiltReport {
  const ctx = context(source);
  const { tests, results } = releasedResults(source, filters.from, filters.to, now);
  const items = results.map((r) => ({ batchId: r.batch_id, studentId: r.student_id, r, test: tests.get(r.test_id)! }));
  const byTest = (a: (typeof items)[number], b: (typeof items)[number]) =>
    (testDate(a.test) ?? "").localeCompare(testDate(b.test) ?? "") || a.test.title.localeCompare(b.test.title) || a.test.id.localeCompare(b.test.id);
  const rows = sortKeyed(ctx, items, byTest).map(({ batchId, studentId, r, test }) => [
    ...personCells(ctx, batchId, studentId),
    test.title,
    day(testDate(test)),
    num(r.score),
    num(r.max_score),
    round2(Number(r.percentage)),
    r.passed ? "Yes" : "No",
    r.finalized_at,
  ]);
  const passed = results.filter((r) => r.passed).length;
  return {
    table: { headers: TEST_RESULTS_HEADERS, rows },
    summary: [
      { label: "Tests with results", value: String(new Set(results.map((r) => r.test_id)).size) },
      { label: "Results", value: String(results.length) },
      { label: "Average score", value: show(mean(results.map((r) => Number(r.percentage)))) },
      { label: "Pass rate", value: show(pct(passed, results.length)) },
    ],
  };
}

// ---------------------------------------------------------------- assignment completion
export const ASSIGNMENT_HEADERS = [
  "Course code", "Batch code", "Batch", "Student code", "Student",
  "Assignment", "Due", "Status", "Submitted at", "On time", "Score", "Max score",
];

const SUBMISSION_LABEL: Record<string, string> = { submitted: "Submitted", returned: "Returned" };

export function buildAssignmentReport(source: ReportSource, filters: Pick<ReportFilters, "from" | "to">): BuiltReport {
  const ctx = context(source);
  // Published or closed assignments only (a draft isn't visible to students), due within the range.
  const assignments = source.assignments.filter((a) => (a.status === "published" || a.status === "closed") && inRange(a.due_at, filters.from, filters.to));
  const submissions = new Map(source.submissions.map((s) => [`${s.assignment_id}|${s.student_id}`, s]));
  // Expected: students currently enrolled or completed in the assignment's batch; plus anyone who submitted.
  const expected = new Map<string, string[]>();
  for (const e of source.enrolments) {
    if (e.enrollment_status === "withdrawn") continue;
    expected.set(e.batch_id, [...(expected.get(e.batch_id) ?? []), e.student_id]);
  }
  const items: { batchId: string; studentId: string; a: ReportAssignmentRecord; s: ReportSubmissionRecord | null }[] = [];
  for (const a of assignments) {
    const students = new Set(expected.get(a.batch_id) ?? []);
    for (const s of source.submissions) if (s.assignment_id === a.id) students.add(s.student_id);
    for (const studentId of students) items.push({ batchId: a.batch_id, studentId, a, s: submissions.get(`${a.id}|${studentId}`) ?? null });
  }
  const byAssignment = (x: (typeof items)[number], y: (typeof items)[number]) =>
    (x.a.due_at ?? "").localeCompare(y.a.due_at ?? "") || x.a.title.localeCompare(y.a.title) || x.a.id.localeCompare(y.a.id);
  const rows = sortKeyed(ctx, items, byAssignment).map(({ batchId, studentId, a, s }) => {
    // Compared as instants (timestamps may carry different offsets), never as text.
    const onTime = s && s.submitted_at && a.due_at ? (Date.parse(s.submitted_at) <= Date.parse(a.due_at) ? "Yes" : "No") : null;
    return [
      ...personCells(ctx, batchId, studentId),
      a.title,
      a.due_at,
      s ? SUBMISSION_LABEL[s.status] ?? s.status : "Not submitted",
      s?.submitted_at ?? null,
      onTime,
      s && s.status === "returned" ? num(s.score) : null,
      num(a.max_score),
    ];
  });
  const submitted = items.filter((i) => i.s !== null).length;
  const returned = items.filter((i) => i.s?.status === "returned").length;
  return {
    table: { headers: ASSIGNMENT_HEADERS, rows },
    summary: [
      { label: "Assignments", value: String(assignments.length) },
      { label: "Expected submissions", value: String(items.length) },
      { label: "Submitted", value: String(submitted) },
      { label: "Completion", value: show(pct(submitted, items.length)) },
      { label: "Returned", value: String(returned) },
    ],
  };
}

export function buildReport(type: ReportType, source: ReportSource, filters: Pick<ReportFilters, "from" | "to">, now: number): BuiltReport {
  switch (type) {
    case "attendance":
      return buildAttendanceReport(source, filters);
    case "performance":
      return buildPerformanceReport(source, filters, now);
    case "test_results":
      return buildTestResultsReport(source, filters, now);
    case "assignments":
      return buildAssignmentReport(source, filters);
  }
}

// -------------------------------------------------------------------
// Export
// -------------------------------------------------------------------

/** Text cells starting with = + - or @ get a leading apostrophe (formula-injection protection, as the question export). */
export function escapeCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** The exported table: the same rows as shown, null as an empty cell, every text cell escaped. Numbers stay numbers. */
export function toExportTable(table: ReportTable): { headers: string[]; rows: Array<Array<string | number>> } {
  return {
    headers: [...table.headers],
    rows: table.rows.map((row) => row.map((c) => (c === null ? "" : typeof c === "number" ? c : escapeCell(c)))),
  };
}

export function reportFileName(type: ReportType, format: "csv" | "xlsx", date = new Date()): string {
  return `spi-report-${type.replace(/_/g, "-")}-${date.toISOString().slice(0, 10)}.${format}`;
}
