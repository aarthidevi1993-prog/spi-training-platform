/**
 * Dashboard analytics (D2b-2A / 2B / 2C) — the read side of public.dashboard_analytics
 * (migration 0024). Pure: no I/O, no server imports.
 *
 *   parseAnalytics()      runtime validation of the RPC's JSON (no blind casts)
 *   buildAnalyticsPanels() the period-based read models the page renders
 *   batch / course comparison (D2b-2B): name order as returned, evidence, pp change
 *   student performance (D2b-2C): students.current (0027) in database rank order, trend arrows at ±1 pp
 *   course progress (D2b-2D): delivery / enrolment (current state) joined by course_id, never re-sorted
 *   comparison helpers    rates in percentage points; counts as % change
 *   health indicators     attendance / assessment / assignments / students
 *                         (Q2 thresholds) and the overall worst-line-wins
 *
 * Every figure comes from the database. No figure is invented: no data is
 * null ("—"), never 0 %.
 */
import {
  HEALTH_THRESHOLDS,
  percentHealth,
  worstHealth,
  type DashboardSection,
  type HealthLine,
  type HealthStatus,
} from "@/lib/dashboard/admin-dashboard";
import { isCalendarDate, isPeriodKey, PERIOD_LABEL, type PeriodKey } from "@/lib/dashboard/periods";

// -------------------------------------------------------------------
// Raw response (exactly the 0024 contract)
// -------------------------------------------------------------------

export interface RawTotals {
  test_avg: number | null;
  pass_rate: number | null;
  results: number;
  attendance_pct: number | null;
  attendance_marked: number;
  assignment_avg: number | null;
  assignments_scored: number;
}

export interface RawTrendBucket extends RawTotals {
  bucket_start: string;
  bucket_end: string;
}

export interface RawBatch {
  id: string;
  code: string;
  name: string;
  course_id: string;
  course: string;
  students: number;
  attendance_pct: number | null;
  attendance_n: number;
  test_avg: number | null;
  pass_rate: number | null;
  results_n: number;
  assignment_avg: number | null;
  assignments_n: number;
  completion_pct: number | null;
  prev_test_avg: number | null;
  prev_results_n: number;
  prev_attendance_pct: number | null;
  prev_attendance_n: number;
}

export interface RawCourse {
  id: string;
  code: string;
  title: string;
  test_avg: number | null;
  pass_rate: number | null;
  results_n: number;
  attendance_pct: number | null;
  attendance_n: number;
  assignment_avg: number | null;
  assignments_n: number;
  prev_test_avg: number | null;
  prev_results_n: number;
}

export interface RawTopStudent {
  id: string;
  code: string;
  name: string;
  average: number;
  results: number;
}

export interface RawTrendStudent {
  id: string;
  code: string;
  name: string;
  earlier_avg: number;
  later_avg: number;
  change: number;
  results: number;
}

/** 0027: one row of the CURRENT ranking (trailing 366 days, independent of the period) with its period trend. */
export interface RawCurrentStudent {
  rank: number;
  id: string;
  code: string;
  name: string;
  average: number;
  results: number;
  period_average: number | null;
  period_results: number;
  previous_average: number | null;
  previous_results: number;
  /** pp: period_average − previous_average; null without a comparison. */
  trend: number | null;
}

export type TopicHealthBand = "healthy" | "watch" | "attention";

export interface RawTopic {
  module_id: string;
  title: string;
  percent: number;
  answers: number;
  band: TopicHealthBand;
}

export interface RawDelivery {
  course_id: string;
  course: string;
  planned: number;
  delivered: number;
  overdue: number;
}

export interface RawEnrolment {
  course_id: string;
  course: string;
  completed: number;
  active: number;
}

export interface RawHealth {
  attendance_n: number;
  attendance_pct: number | null;
  results_n: number;
  test_avg: number | null;
  assignments_n: number;
  assignment_avg: number | null;
  students_assessed: number;
  students_below_75: number;
  reviews_waiting_over_7d: number;
}

export interface DashboardAnalyticsRaw {
  period: { from: string; to: string; prev_from: string; prev_to: string; bucket: "week" | "month"; days: number };
  trend: RawTrendBucket[];
  totals: { current: RawTotals; previous: RawTotals };
  batches: RawBatch[];
  batches_total: number;
  courses: RawCourse[];
  courses_total: number;
  students: { top: RawTopStudent[]; improving: RawTrendStudent[]; declining: RawTrendStudent[]; ranked: number; current: RawCurrentStudent[]; current_window: { from: string; to: string } };
  topics: RawTopic[];
  delivery: RawDelivery[];
  delivery_total: number;
  enrolment: RawEnrolment[];
  enrolment_total: number;
  health: RawHealth;
}

// -------------------------------------------------------------------
// Runtime validation
// -------------------------------------------------------------------

export class AnalyticsShapeError extends Error {
  constructor(public readonly path: string) {
    super(`Unexpected dashboard analytics response at ${path}.`);
    this.name = "AnalyticsShapeError";
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AnalyticsShapeError(path);
  return v as Obj;
}
function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new AnalyticsShapeError(path);
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AnalyticsShapeError(path);
  return v;
}
function numOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : num(v, path);
}
function count(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n) || n < 0) throw new AnalyticsShapeError(path);
  return n;
}
function text(v: unknown, path: string): string {
  if (typeof v !== "string") throw new AnalyticsShapeError(path);
  return v;
}
function date(v: unknown, path: string): string {
  if (!isCalendarDate(v)) throw new AnalyticsShapeError(path);
  return v;
}

function totals(v: unknown, path: string): RawTotals {
  const o = obj(v, path);
  return {
    test_avg: numOrNull(o.test_avg, `${path}.test_avg`),
    pass_rate: numOrNull(o.pass_rate, `${path}.pass_rate`),
    results: count(o.results, `${path}.results`),
    attendance_pct: numOrNull(o.attendance_pct, `${path}.attendance_pct`),
    attendance_marked: count(o.attendance_marked, `${path}.attendance_marked`),
    assignment_avg: numOrNull(o.assignment_avg, `${path}.assignment_avg`),
    assignments_scored: count(o.assignments_scored, `${path}.assignments_scored`),
  };
}

function currentStudent(v: unknown, i: number): RawCurrentStudent {
  const path = `students.current[${i}]`;
  const o = obj(v, path);
  const rank = count(o.rank, `${path}.rank`);
  if (rank !== i + 1) throw new AnalyticsShapeError(`${path}.rank`); // ranked by the database: 1, 2, 3 … in order
  return {
    rank,
    id: text(o.id, `${path}.id`),
    code: text(o.code, `${path}.code`),
    name: text(o.name, `${path}.name`),
    average: num(o.average, `${path}.average`),
    results: count(o.results, `${path}.results`),
    period_average: numOrNull(o.period_average, `${path}.period_average`),
    period_results: count(o.period_results, `${path}.period_results`),
    previous_average: numOrNull(o.previous_average, `${path}.previous_average`),
    previous_results: count(o.previous_results, `${path}.previous_results`),
    trend: numOrNull(o.trend, `${path}.trend`),
  };
}

function trendStudent(v: unknown, path: string): RawTrendStudent {
  const o = obj(v, path);
  return {
    id: text(o.id, `${path}.id`),
    code: text(o.code, `${path}.code`),
    name: text(o.name, `${path}.name`),
    earlier_avg: num(o.earlier_avg, `${path}.earlier_avg`),
    later_avg: num(o.later_avg, `${path}.later_avg`),
    change: num(o.change, `${path}.change`),
    results: count(o.results, `${path}.results`),
  };
}

/** Validates the RPC's JSON against the 0024 contract; throws AnalyticsShapeError on anything else. */
export function parseAnalytics(json: unknown): DashboardAnalyticsRaw {
  const root = obj(json, "$");
  const p = obj(root.period, "period");
  const bucket = text(p.bucket, "period.bucket");
  if (bucket !== "week" && bucket !== "month") throw new AnalyticsShapeError("period.bucket");
  const t = obj(root.totals, "totals");
  const s = obj(root.students, "students");
  const h = obj(root.health, "health");
  return {
    period: {
      from: date(p.from, "period.from"),
      to: date(p.to, "period.to"),
      prev_from: date(p.prev_from, "period.prev_from"),
      prev_to: date(p.prev_to, "period.prev_to"),
      bucket,
      days: count(p.days, "period.days"),
    },
    trend: list(root.trend, "trend").map((b, i) => {
      const o = obj(b, `trend[${i}]`);
      return { bucket_start: date(o.bucket_start, `trend[${i}].bucket_start`), bucket_end: date(o.bucket_end, `trend[${i}].bucket_end`), ...totals(o, `trend[${i}]`) };
    }),
    totals: { current: totals(t.current, "totals.current"), previous: totals(t.previous, "totals.previous") },
    batches: list(root.batches, "batches").map((b, i) => {
      const o = obj(b, `batches[${i}]`);
      const at = (k: string) => `batches[${i}].${k}`;
      return {
        id: text(o.id, at("id")),
        code: text(o.code, at("code")),
        name: text(o.name, at("name")),
        course_id: text(o.course_id, at("course_id")),
        course: text(o.course, at("course")),
        students: count(o.students, at("students")),
        attendance_pct: numOrNull(o.attendance_pct, at("attendance_pct")),
        attendance_n: count(o.attendance_n, at("attendance_n")),
        test_avg: numOrNull(o.test_avg, at("test_avg")),
        pass_rate: numOrNull(o.pass_rate, at("pass_rate")),
        results_n: count(o.results_n, at("results_n")),
        assignment_avg: numOrNull(o.assignment_avg, at("assignment_avg")),
        assignments_n: count(o.assignments_n, at("assignments_n")),
        completion_pct: numOrNull(o.completion_pct, at("completion_pct")),
        prev_test_avg: numOrNull(o.prev_test_avg, at("prev_test_avg")),
        prev_results_n: count(o.prev_results_n, at("prev_results_n")),
        prev_attendance_pct: numOrNull(o.prev_attendance_pct, at("prev_attendance_pct")),
        prev_attendance_n: count(o.prev_attendance_n, at("prev_attendance_n")),
      };
    }),
    batches_total: count(root.batches_total, "batches_total"),
    courses: list(root.courses, "courses").map((c, i) => {
      const o = obj(c, `courses[${i}]`);
      const at = (k: string) => `courses[${i}].${k}`;
      return {
        id: text(o.id, at("id")),
        code: text(o.code, at("code")),
        title: text(o.title, at("title")),
        test_avg: numOrNull(o.test_avg, at("test_avg")),
        pass_rate: numOrNull(o.pass_rate, at("pass_rate")),
        results_n: count(o.results_n, at("results_n")),
        attendance_pct: numOrNull(o.attendance_pct, at("attendance_pct")),
        attendance_n: count(o.attendance_n, at("attendance_n")),
        assignment_avg: numOrNull(o.assignment_avg, at("assignment_avg")),
        assignments_n: count(o.assignments_n, at("assignments_n")),
        prev_test_avg: numOrNull(o.prev_test_avg, at("prev_test_avg")),
        prev_results_n: count(o.prev_results_n, at("prev_results_n")),
      };
    }),
    courses_total: count(root.courses_total, "courses_total"),
    students: {
      top: list(s.top, "students.top").map((v, i) => {
        const o = obj(v, `students.top[${i}]`);
        return {
          id: text(o.id, `students.top[${i}].id`),
          code: text(o.code, `students.top[${i}].code`),
          name: text(o.name, `students.top[${i}].name`),
          average: num(o.average, `students.top[${i}].average`),
          results: count(o.results, `students.top[${i}].results`),
        };
      }),
      improving: list(s.improving, "students.improving").map((v, i) => trendStudent(v, `students.improving[${i}]`)),
      declining: list(s.declining, "students.declining").map((v, i) => trendStudent(v, `students.declining[${i}]`)),
      ranked: count(s.ranked, "students.ranked"),
      current: (() => {
        const rows = list(s.current, "students.current");
        if (rows.length > STUDENT_PERFORMANCE_LIMIT) throw new AnalyticsShapeError("students.current");
        return rows.map((v, i) => currentStudent(v, i));
      })(),
      current_window: (() => {
        const w = obj(s.current_window, "students.current_window");
        return { from: date(w.from, "students.current_window.from"), to: date(w.to, "students.current_window.to") };
      })(),
    },
    topics: list(root.topics, "topics").map((v, i) => {
      const o = obj(v, `topics[${i}]`);
      const band = text(o.band, `topics[${i}].band`);
      if (band !== "healthy" && band !== "watch" && band !== "attention") throw new AnalyticsShapeError(`topics[${i}].band`);
      return {
        module_id: text(o.module_id, `topics[${i}].module_id`),
        title: text(o.title, `topics[${i}].title`),
        percent: num(o.percent, `topics[${i}].percent`),
        answers: count(o.answers, `topics[${i}].answers`),
        band,
      };
    }),
    delivery: list(root.delivery, "delivery").map((v, i) => {
      const o = obj(v, `delivery[${i}]`);
      return {
        course_id: text(o.course_id, `delivery[${i}].course_id`),
        course: text(o.course, `delivery[${i}].course`),
        planned: count(o.planned, `delivery[${i}].planned`),
        delivered: count(o.delivered, `delivery[${i}].delivered`),
        overdue: count(o.overdue, `delivery[${i}].overdue`),
      };
    }),
    delivery_total: count(root.delivery_total, "delivery_total"),
    enrolment: list(root.enrolment, "enrolment").map((v, i) => {
      const o = obj(v, `enrolment[${i}]`);
      return {
        course_id: text(o.course_id, `enrolment[${i}].course_id`),
        course: text(o.course, `enrolment[${i}].course`),
        completed: count(o.completed, `enrolment[${i}].completed`),
        active: count(o.active, `enrolment[${i}].active`),
      };
    }),
    enrolment_total: count(root.enrolment_total, "enrolment_total"),
    health: {
      attendance_n: count(h.attendance_n, "health.attendance_n"),
      attendance_pct: numOrNull(h.attendance_pct, "health.attendance_pct"),
      results_n: count(h.results_n, "health.results_n"),
      test_avg: numOrNull(h.test_avg, "health.test_avg"),
      assignments_n: count(h.assignments_n, "health.assignments_n"),
      assignment_avg: numOrNull(h.assignment_avg, "health.assignment_avg"),
      students_assessed: count(h.students_assessed, "health.students_assessed"),
      students_below_75: count(h.students_below_75, "health.students_below_75"),
      reviews_waiting_over_7d: count(h.reviews_waiting_over_7d, "health.reviews_waiting_over_7d"),
    },
  };
}

// -------------------------------------------------------------------
// Comparisons (locked rules)
// -------------------------------------------------------------------

/** One decimal, half away from zero (as PostgreSQL rounds): −6.75 → −6.8, 6.75 → 6.8. */
const round1 = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 10)) / 10;

/** A rate / average against the comparison period, as a percentage-point difference (78 % → 82 % = +4 pp). */
export interface RateComparison {
  current: number | null;
  previous: number | null;
  /** current − previous in percentage points (1 decimal); null when either side has no data. */
  points: number | null;
  /** "change": both sides have data; "no_comparison": only the current period has data; "no_data": the current period has none. */
  state: "change" | "no_comparison" | "no_data";
}

export function ratePointChange(current: number | null, previous: number | null): RateComparison {
  if (current === null) return { current, previous, points: null, state: "no_data" };
  if (previous === null) return { current, previous, points: null, state: "no_comparison" };
  return { current, previous, points: round1(current - previous), state: "change" };
}

/** "+4 pp", "−2.5 pp", "0 pp"; "No comparison data" / "—" when there is nothing to compare. */
export function formatPoints(c: RateComparison): string {
  if (c.state === "no_data") return "—";
  if (c.state === "no_comparison" || c.points === null) return "No comparison data";
  if (c.points === 0) return "0 pp";
  return `${c.points > 0 ? "+" : "−"}${Math.abs(c.points)} pp`;
}

/** A count against the comparison period: % change when previous > 0; "New" from 0; "—" when both are 0. */
export interface CountComparison {
  current: number;
  previous: number;
  /** Percentage change (1 decimal) when previous > 0, otherwise null. */
  percent: number | null;
  display: string;
}

export function countChange(current: number, previous: number): CountComparison {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous < 0) {
    throw new RangeError("Count comparisons need two non-negative counts.");
  }
  if (previous > 0) {
    const percent = round1(((current - previous) / previous) * 100);
    return { current, previous, percent, display: percent === 0 ? "0%" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%` };
  }
  return { current, previous, percent: null, display: current > 0 ? "New" : "—" };
}

/** A progress share in % (1 decimal); null when there is nothing to measure against. */
export function progressPercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || part < 0 || whole <= 0) return null;
  return round1((part / whole) * 100);
}

/** "81.3%" or "—". */
export function formatPercent(v: number | null): string {
  return v === null ? "—" : `${round1(v)}%`;
}

// -------------------------------------------------------------------
// Dates and labels (India calendar dates, printed without a time zone shift)
// -------------------------------------------------------------------

function dateParts(d: string): { day: string; month: string; year: string } {
  const t = new Date(`${d}T00:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { ...o, timeZone: "UTC" }).format(t);
  return { day: f({ day: "2-digit" }), month: f({ month: "short" }), year: f({ year: "numeric" }) };
}

/** "01 Oct – 06 Oct 2026"; years shown on both ends when they differ. */
export function formatDateRange(from: string, to: string): string {
  const a = dateParts(from);
  const b = dateParts(to);
  if (from === to) return `${a.day} ${a.month} ${a.year}`;
  return a.year === b.year ? `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}` : `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
}

/** Trend bucket label: weeks "04–10 Mar" / "26 Feb – 03 Mar"; months "Mar 2024". */
export function bucketLabel(start: string, end: string, bucket: "week" | "month"): string {
  const a = dateParts(start);
  const b = dateParts(end);
  if (bucket === "month") return `${a.month} ${a.year}`;
  if (start === end) return `${a.day} ${a.month}`;
  return a.month === b.month ? `${a.day}–${b.day} ${b.month}` : `${a.day} ${a.month} – ${b.day} ${b.month}`;
}

// -------------------------------------------------------------------
// Training health — the four analytics indicators and the overall line
// -------------------------------------------------------------------

const p = (v: number) => `${round1(v)}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function attendanceHealth(h: RawHealth): HealthLine {
  const base = { key: "attendance" as const, label: "Attendance", href: "/admin/attendance", linkLabel: "Review attendance" };
  if (h.attendance_pct === null) {
    return { ...base, status: "no_data", reason: h.attendance_n === 0 ? "No attendance recorded in this period." : `Fewer than 5 attendance records in this period (n = ${h.attendance_n}).` };
  }
  return {
    ...base,
    status: percentHealth(h.attendance_pct, HEALTH_THRESHOLDS.attendance),
    reason: `${p(h.attendance_pct)} attended across ${plural(h.attendance_n, "record", "records")} (Healthy ≥ 85%, Watch ≥ 75%).`,
  };
}

export function assessmentHealth(h: RawHealth): HealthLine {
  const base = { key: "assessment" as const, label: "Assessment", href: "/admin/performance", linkLabel: "Review performance" };
  if (h.test_avg === null) {
    return { ...base, status: "no_data", reason: h.results_n === 0 ? "No released test results in this period." : `Fewer than 5 released results in this period (n = ${h.results_n}).` };
  }
  return {
    ...base,
    status: percentHealth(h.test_avg, HEALTH_THRESHOLDS.assessment),
    reason: `Test average ${p(h.test_avg)} across ${plural(h.results_n, "released result", "released results")} (Healthy ≥ 80%, Watch ≥ 65%).`,
  };
}

/** Assignment average bands, plus Watch (at least) while submissions wait more than 7 days for review. */
export function assignmentsHealth(h: RawHealth): HealthLine {
  const base = { key: "assignments" as const, label: "Assignments", href: "/admin/classes", linkLabel: "Review class assignments" };
  const waiting = h.reviews_waiting_over_7d;
  const waitingText = waiting > 0 ? ` ${plural(waiting, "submission has", "submissions have")} waited more than 7 days for review.` : "";
  if (h.assignment_avg === null) {
    if (waiting === 0) {
      return { ...base, status: "no_data", reason: h.assignments_n === 0 ? "No scored assignments in this period." : `Fewer than 5 scored submissions in this period (n = ${h.assignments_n}).` };
    }
    return { ...base, status: "watch", reason: `Not enough scored submissions to judge the average (n = ${h.assignments_n}).${waitingText}` };
  }
  const band = percentHealth(h.assignment_avg, HEALTH_THRESHOLDS.assignments);
  const status = waiting > 0 ? (worstHealth([band, "watch"]) as HealthStatus) : band;
  return { ...base, status, reason: `Assignment average ${p(h.assignment_avg)} across ${plural(h.assignments_n, "scored submission", "scored submissions")} (Healthy ≥ 80%, Watch ≥ 65%).${waitingText}` };
}

/** Attention when any currently enrolled student (with ≥ 3 attendance records in the period) is below 75 %. */
export function studentsHealth(h: RawHealth): HealthLine {
  const base = { key: "students" as const, label: "Students", href: "/admin/attendance", linkLabel: "Review student attendance" };
  if (h.students_assessed === 0) return { ...base, status: "no_data", reason: "No enrolled student has 3 or more attendance records in this period." };
  if (h.students_below_75 > 0) {
    return { ...base, status: "attention", reason: `${h.students_below_75} of ${plural(h.students_assessed, "enrolled student", "enrolled students")} below 75% attendance in this period.` };
  }
  return { ...base, status: "healthy", reason: `All ${plural(h.students_assessed, "enrolled student", "enrolled students")} with 3 or more records are at or above 75% attendance.` };
}

export const HEALTH_INDICATOR_COUNT = 6;

const ANALYTICS_HEALTH = [
  { key: "attendance", label: "Attendance", href: "/admin/attendance", linkLabel: "Review attendance" },
  { key: "assessment", label: "Assessment", href: "/admin/performance", linkLabel: "Review performance" },
  { key: "assignments", label: "Assignments", href: "/admin/classes", linkLabel: "Review class assignments" },
  { key: "students", label: "Students", href: "/admin/attendance", linkLabel: "Review student attendance" },
] as const;

/** The four analytics lines when the analytics could not be read: "Unavailable", never a judgement. */
export function unavailableAnalyticsHealth(): HealthLine[] {
  return ANALYTICS_HEALTH.map((b) => ({ ...b, status: "unavailable" as const, reason: "Advanced analytics are temporarily unavailable." }));
}

export function analyticsHealth(h: RawHealth): HealthLine[] {
  return [attendanceHealth(h), assessmentHealth(h), assignmentsHealth(h), studentsHealth(h)];
}

export interface HealthOverall {
  /** Worst line wins (Attention > Watch > Healthy); "no_data" when no line has a judgement. */
  status: HealthStatus | "no_data";
  /** Lines with a judgement (No data and Unavailable are excluded). */
  basedOn: number;
  total: number;
  /** Labels of the lines that decide the status (empty when Healthy or No data). */
  drivers: string[];
}

export function overallHealth(lines: HealthLine[]): HealthOverall {
  const judged = lines.filter((l): l is HealthLine & { status: HealthStatus } => l.status === "healthy" || l.status === "watch" || l.status === "attention");
  const worst = worstHealth(judged.map((l) => l.status));
  if (worst === null) return { status: "no_data", basedOn: 0, total: lines.length, drivers: [] };
  return { status: worst, basedOn: judged.length, total: lines.length, drivers: worst === "healthy" ? [] : judged.filter((l) => l.status === worst).map((l) => l.label) };
}

export interface TrainingHealthView {
  lines: HealthLine[];
  overall: HealthOverall;
}

export function trainingHealth(lines: HealthLine[]): TrainingHealthView {
  return { lines, overall: overallHealth(lines) };
}

// -------------------------------------------------------------------
// Period-based read models
// -------------------------------------------------------------------

export interface AnalyticsPeriod {
  key: PeriodKey;
  label: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  bucket: "week" | "month";
  rangeText: string;
  prevRangeText: string;
}

export interface PerformanceMetric {
  key: "test_avg" | "pass_rate" | "attendance" | "assignment_avg";
  label: string;
  comparison: RateComparison;
  /** The records behind the figure (results / attendance records / scored submissions) in each period. */
  evidence: CountComparison;
  evidenceNoun: string;
}

export interface TrendPoint {
  from: string;
  to: string;
  label: string;
  testAvg: number | null;
  passRate: number | null;
  attendancePct: number | null;
  assignmentAvg: number | null;
  results: number;
  attendanceMarked: number;
  assignmentsScored: number;
}

export interface AnalyticsTopic {
  moduleId: string;
  title: string;
  percent: number;
  answers: number;
  band: TopicHealthBand;
}

export interface AnalyticsPanels {
  period: AnalyticsPeriod;
  /** Any released result, attendance record or scored submission in the period. */
  hasActivity: boolean;
  /** The same for the comparison period. */
  hasComparison: boolean;
  performance: PerformanceMetric[];
  trend: TrendPoint[];
  topics: AnalyticsTopic[];
  /** Released results in the period (context for the weak-topic evidence). */
  resultsInPeriod: number;
  /** D2b-2B: batch comparison (name order, as returned — never re-ranked). */
  batches: ComparisonList<BatchComparisonRow>;
  /** D2b-2B: course comparison (title order, as returned — never re-ranked). */
  courses: ComparisonList<CourseComparisonRow>;
  /** D2b-2C: Student Performance (Top 5) — the current ranking (0027), database order, with the selected period's trend. */
  students: StudentPerformance;
  /** D2b-2D: Course Progress — current-state class delivery and enrolment completion per course (independent of the period). */
  progress: CourseProgress;
  /** The raw lists behind the panels (kept for reference; the view renders the read models above). */
  datasets: Pick<DashboardAnalyticsRaw, "batches" | "batches_total" | "courses" | "courses_total" | "students" | "delivery" | "delivery_total" | "enrolment" | "enrolment_total">;
}

// -------------------------------------------------------------------
// Batch / course comparison (D2b-2B) — the batches[] / courses[] rows of 0024
// -------------------------------------------------------------------

/**
 * One period figure with the records behind it. 0024 returns null below its
 * evidence minimum (5 records), so null is "Insufficient data (n)" — never 0 %.
 */
export interface EvidenceFigure {
  value: number | null;
  /** Records behind the figure in the period. */
  evidence: number;
  /** "81.3%" or "Insufficient data (3)". */
  display: string;
}

export function evidenceFigure(value: number | null, evidence: number): EvidenceFigure {
  return { value, evidence, display: value === null ? `Insufficient data (${evidence})` : formatPercent(value) };
}

/** Against the comparison period, only where 0024 returns a previous value; otherwise "No comparison data". */
export interface FigureChange {
  comparison: RateComparison;
  /** Records behind the previous figure. */
  previousEvidence: number;
  /** "+4 pp" or "No comparison data" — never an invented 0 pp. */
  display: string;
}

export function figureChange(current: number | null, previous: number | null, previousEvidence: number): FigureChange {
  const comparison = ratePointChange(current, previous);
  return { comparison, previousEvidence, display: comparison.state === "change" ? formatPoints(comparison) : "No comparison data" };
}

export interface ComparisonList<T> {
  /** In the order 0024 returns them (by name / title) — not a ranking. */
  rows: T[];
  /** All batches / courses in scope (0024 *_total). */
  total: number;
  /** "Showing 10 of 14" when there are more than the rows shown; otherwise null. */
  shownText: string | null;
}

function comparisonList<T>(rows: T[], total: number): ComparisonList<T> {
  return { rows, total, shownText: total > rows.length ? `Showing ${rows.length} of ${total}` : null };
}

export interface BatchComparisonRow {
  id: string;
  code: string;
  name: string;
  course: string;
  students: number;
  testAvg: EvidenceFigure;
  testAvgChange: FigureChange;
  passRate: EvidenceFigure;
  attendance: EvidenceFigure;
  attendanceChange: FigureChange;
  assignmentAvg: EvidenceFigure;
  /** Completed vs non-withdrawn enrolments now (a CURRENT figure, not the period's); null without enrolments. */
  completionPct: number | null;
  completionDisplay: string;
  /** /admin/batches/[id] */
  href: string;
  /** /admin/performance?batch=<id> */
  performanceHref: string;
}

export interface CourseComparisonRow {
  id: string;
  code: string;
  title: string;
  testAvg: EvidenceFigure;
  testAvgChange: FigureChange;
  passRate: EvidenceFigure;
  attendance: EvidenceFigure;
  assignmentAvg: EvidenceFigure;
  /** /admin/courses/[id] */
  href: string;
}

export function batchComparison(batches: RawBatch[], total: number): ComparisonList<BatchComparisonRow> {
  return comparisonList(
    batches.map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      course: b.course,
      students: b.students,
      testAvg: evidenceFigure(b.test_avg, b.results_n),
      testAvgChange: figureChange(b.test_avg, b.prev_test_avg, b.prev_results_n),
      passRate: evidenceFigure(b.pass_rate, b.results_n),
      attendance: evidenceFigure(b.attendance_pct, b.attendance_n),
      attendanceChange: figureChange(b.attendance_pct, b.prev_attendance_pct, b.prev_attendance_n),
      assignmentAvg: evidenceFigure(b.assignment_avg, b.assignments_n),
      completionPct: b.completion_pct,
      completionDisplay: formatPercent(b.completion_pct),
      href: `/admin/batches/${encodeURIComponent(b.id)}`,
      performanceHref: `/admin/performance?batch=${encodeURIComponent(b.id)}`,
    })),
    total
  );
}

export function courseComparison(courses: RawCourse[], total: number): ComparisonList<CourseComparisonRow> {
  return comparisonList(
    courses.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      testAvg: evidenceFigure(c.test_avg, c.results_n),
      testAvgChange: figureChange(c.test_avg, c.prev_test_avg, c.prev_results_n),
      passRate: evidenceFigure(c.pass_rate, c.results_n),
      attendance: evidenceFigure(c.attendance_pct, c.attendance_n),
      assignmentAvg: evidenceFigure(c.assignment_avg, c.assignments_n),
      href: `/admin/courses/${encodeURIComponent(c.id)}`,
    })),
    total
  );
}

// -------------------------------------------------------------------
// Student performance (D2b-2C) — students.current of 0027
// -------------------------------------------------------------------

/** Rows shown (0027 returns at most 5, already ranked). */
export const STUDENT_PERFORMANCE_LIMIT = 5;
/** Trend arrows: ≥ +1 pp up, ≤ −1 pp down, in between neutral (the database never hides small movements). */
export const TREND_THRESHOLD_PP = 1;

export type TrendDirection = "up" | "down" | "neutral" | "none";

/** ≥ +1 → up; ≤ −1 → down; otherwise neutral; null (no comparison) → none. */
export function trendDirection(points: number | null): TrendDirection {
  if (points === null) return "none";
  if (points >= TREND_THRESHOLD_PP) return "up";
  if (points <= -TREND_THRESHOLD_PP) return "down";
  return "neutral";
}

/** The database value as returned (up to 2 decimals), signed: "+8 pp", "−3.25 pp", "+0.99 pp", "0 pp". */
export function formatTrendPoints(points: number): string {
  if (points === 0) return "0 pp";
  return `${points > 0 ? "+" : "−"}${Math.abs(points)} pp`;
}

/** One decimal, always shown: 96 → "96.0%". */
export function formatAverage(v: number): string {
  return `${round1(v).toFixed(1)}%`;
}

export interface StudentPerformanceRow {
  rank: number;
  id: string;
  code: string;
  name: string;
  average: number;
  /** "96.0%" */
  averageDisplay: string;
  /** Released results in the current window (≥ 3). */
  results: number;
  /** Selected period − comparison period, in pp; null without a comparison. */
  trend: number | null;
  trendDirection: TrendDirection;
  /** "+8 pp" / "−1 pp" / "+0.99 pp" / "No comparison" */
  trendDisplay: string;
  /** Text equivalent of the arrow (never colour alone): "Up", "Down", "No meaningful change", "No comparison". */
  directionLabel: string;
}

export interface StudentPerformance {
  /** In the database's rank order (never re-ranked), at most 5. */
  rows: StudentPerformanceRow[];
  /** No student has 3 or more released results in the current window. */
  insufficient: boolean;
  /** The current window (India today − 365 → today). */
  window: { from: string; to: string };
  /** "Current ranking: last 366 days · trend: This month vs previous" */
  caption: string;
}

const TREND_LABEL: Record<TrendDirection, string> = { up: "Up", down: "Down", neutral: "No meaningful change", none: "No comparison" };

export function studentPerformance(current: RawCurrentStudent[], window: { from: string; to: string }, periodLabel: string): StudentPerformance {
  const rows = current.slice(0, STUDENT_PERFORMANCE_LIMIT).map((s) => {
    const direction = trendDirection(s.trend);
    return {
      rank: s.rank,
      id: s.id,
      code: s.code,
      name: s.name,
      average: s.average,
      averageDisplay: formatAverage(s.average),
      results: s.results,
      trend: s.trend,
      trendDirection: direction,
      trendDisplay: s.trend === null ? "No comparison" : formatTrendPoints(s.trend),
      directionLabel: TREND_LABEL[direction],
    };
  });
  return { rows, insufficient: rows.length === 0, window, caption: `Current ranking: last 366 days · trend: ${periodLabel} vs previous` };
}


// -------------------------------------------------------------------
// Course progress (D2b-2D) — delivery[] / enrolment[] of 0024 (current state, not the period)
// -------------------------------------------------------------------

/** Dashboard attendance vs the Performance Tracker: both definitions stay as they are; the dashboard says so. */
export const ATTENDANCE_DEFINITION_NOTE =
  "Attendance on this dashboard excludes excused absences; the Performance Tracker counts excused absences as attended.";

/** Class delivery for one course, exactly as 0024 counts it (upcoming / ongoing batches, cancelled classes excluded). */
export interface CourseDelivery {
  planned: number;
  delivered: number;
  overdue: number;
  /** delivered / planned × 100 (one decimal); null when nothing is planned — never 0 %. */
  percent: number | null;
  /** "75%" or "—" */
  percentDisplay: string;
}

/** Enrolment completion for one course, exactly as 0024 counts it (completed vs non-withdrawn enrolments). */
export interface CourseEnrolment {
  completed: number;
  active: number;
  /** completed / active × 100 (one decimal); null without active enrolments — never 0 %. */
  percent: number | null;
  percentDisplay: string;
}

export interface CourseProgressRow {
  courseId: string;
  course: string;
  /** null: the course is not in the returned delivery list (none in scope, or beyond the list — see shownText). */
  delivery: CourseDelivery | null;
  /** null: the course is not in the returned enrolment list (none in scope, or beyond the list — see shownText). */
  enrolment: CourseEnrolment | null;
}

export interface CourseProgress {
  /** Delivery's order first (as 0024 returns it), then courses found only in the enrolment list, in its order. Never re-sorted. */
  rows: CourseProgressRow[];
  /** Courses with class delivery in scope (0024 delivery_total). */
  deliveryTotal: number;
  /** Courses with enrolments in scope (0024 enrolment_total). */
  enrolmentTotal: number;
  /** "Delivery: showing 10 of 14 courses" when the delivery list is a subset; otherwise null. */
  deliveryShownText: string | null;
  /** "Enrolment: showing 10 of 12 courses" when the enrolment list is a subset; otherwise null. */
  enrolmentShownText: string | null;
  /** Neither list has a course. */
  empty: boolean;
}

/** Joined by course_id (never by position); delivery and enrolment figures used exactly as returned. */
export function courseProgress(delivery: RawDelivery[], deliveryTotal: number, enrolment: RawEnrolment[], enrolmentTotal: number): CourseProgress {
  const toDelivery = (d: RawDelivery): CourseDelivery => {
    const percent = progressPercent(d.delivered, d.planned);
    return { planned: d.planned, delivered: d.delivered, overdue: d.overdue, percent, percentDisplay: formatPercent(percent) };
  };
  const toEnrolment = (e: RawEnrolment): CourseEnrolment => {
    const percent = progressPercent(e.completed, e.active);
    return { completed: e.completed, active: e.active, percent, percentDisplay: formatPercent(percent) };
  };
  const enrolmentById = new Map(enrolment.map((e) => [e.course_id, e]));
  const deliveryIds = new Set(delivery.map((d) => d.course_id));
  const rows: CourseProgressRow[] = [
    ...delivery.map((d) => {
      const e = enrolmentById.get(d.course_id);
      return { courseId: d.course_id, course: d.course, delivery: toDelivery(d), enrolment: e ? toEnrolment(e) : null };
    }),
    ...enrolment.filter((e) => !deliveryIds.has(e.course_id)).map((e) => ({ courseId: e.course_id, course: e.course, delivery: null, enrolment: toEnrolment(e) })),
  ];
  const shown = (label: string, n: number, total: number) => (total > n ? `${label}: showing ${n} of ${total} courses` : null);
  return {
    rows,
    deliveryTotal,
    enrolmentTotal,
    deliveryShownText: shown("Delivery", delivery.length, deliveryTotal),
    enrolmentShownText: shown("Enrolment", enrolment.length, enrolmentTotal),
    empty: rows.length === 0,
  };
}

const hasAny = (t: RawTotals) => t.results + t.attendance_marked + t.assignments_scored > 0;

export function buildAnalyticsPanels(raw: DashboardAnalyticsRaw, periodKey: string): AnalyticsPanels {
  const key: PeriodKey = isPeriodKey(periodKey) ? periodKey : "this_month";
  const { current: cur, previous: prev } = raw.totals;
  const metric = (k: PerformanceMetric["key"], label: string, c: number | null, pv: number | null, n: number, pn: number, noun: string): PerformanceMetric => ({
    key: k,
    label,
    comparison: ratePointChange(c, pv),
    evidence: countChange(n, pn),
    evidenceNoun: noun,
  });
  return {
    period: {
      key,
      label: PERIOD_LABEL[key],
      from: raw.period.from,
      to: raw.period.to,
      prevFrom: raw.period.prev_from,
      prevTo: raw.period.prev_to,
      bucket: raw.period.bucket,
      rangeText: formatDateRange(raw.period.from, raw.period.to),
      prevRangeText: formatDateRange(raw.period.prev_from, raw.period.prev_to),
    },
    hasActivity: hasAny(cur),
    hasComparison: hasAny(prev),
    performance: [
      metric("test_avg", "Test average", cur.test_avg, prev.test_avg, cur.results, prev.results, "released results"),
      metric("pass_rate", "Pass rate", cur.pass_rate, prev.pass_rate, cur.results, prev.results, "released results"),
      metric("attendance", "Attendance", cur.attendance_pct, prev.attendance_pct, cur.attendance_marked, prev.attendance_marked, "attendance records"),
      metric("assignment_avg", "Assignment average", cur.assignment_avg, prev.assignment_avg, cur.assignments_scored, prev.assignments_scored, "scored submissions"),
    ],
    trend: raw.trend.map((b) => ({
      from: b.bucket_start,
      to: b.bucket_end,
      label: bucketLabel(b.bucket_start, b.bucket_end, raw.period.bucket),
      testAvg: b.test_avg,
      passRate: b.pass_rate,
      attendancePct: b.attendance_pct,
      assignmentAvg: b.assignment_avg,
      results: b.results,
      attendanceMarked: b.attendance_marked,
      assignmentsScored: b.assignments_scored,
    })),
    topics: raw.topics.map((t) => ({ moduleId: t.module_id, title: t.title, percent: t.percent, answers: t.answers, band: t.band })),
    resultsInPeriod: cur.results,
    batches: batchComparison(raw.batches, raw.batches_total),
    courses: courseComparison(raw.courses, raw.courses_total),
    students: studentPerformance(raw.students.current, raw.students.current_window, PERIOD_LABEL[key]),
    progress: courseProgress(raw.delivery, raw.delivery_total, raw.enrolment, raw.enrolment_total),
    datasets: {
      batches: raw.batches,
      batches_total: raw.batches_total,
      courses: raw.courses,
      courses_total: raw.courses_total,
      students: raw.students,
      delivery: raw.delivery,
      delivery_total: raw.delivery_total,
      enrolment: raw.enrolment,
      enrolment_total: raw.enrolment_total,
    },
  };
}

export const TOPIC_BAND_LABEL: Record<TopicHealthBand, string> = { healthy: "Healthy", watch: "Watch", attention: "Attention" };

/** The period-based half of the dashboard (each part loads or fails on its own). */
export interface DashboardAnalyticsResult {
  panels: DashboardSection<AnalyticsPanels>;
  health: DashboardSection<TrainingHealthView>;
}

/** Rows per analytics list (dashboard_analytics accepts 1–50). */
export const ANALYTICS_LIST_LIMIT = 10;

/** The `?period=` value → a supported period; anything else (missing, repeated, unknown) → this_month. */
export function resolvePeriodKey(value: unknown): PeriodKey {
  const v = Array.isArray(value) ? value[0] : value;
  return isPeriodKey(v) ? v : "this_month";
}
