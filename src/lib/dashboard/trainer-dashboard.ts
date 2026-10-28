/**
 * Trainer dashboard (P4.2) — the pure read model. Every figure is derived
 * here from rows the trainer's own session could read (RLS) in the
 * trainer dashboard repository; nothing is invented: no trends, no risk
 * score, no company-wide ranking. Pure (no server-only import) so the
 * rules are unit-tested directly.
 *
 * Scope: the trainer's CURRENT batches (upcoming / ongoing, the batches
 * they can still mark and review) and their own classes. "Today" is the
 * India calendar date (Asia/Kolkata), computed here — never the server's
 * UTC date.
 */
import { HEALTH_THRESHOLDS, INDIA_TIME_ZONE, indiaDate } from "@/lib/dashboard/admin-dashboard";
import { addDays } from "@/lib/dashboard/periods";
import { MODULE_WEAK_BELOW } from "@/types/performance";

export { indiaDate };

// ---------------------------------------------------------------- windows and thresholds

/** Look-back for attendance (overview, per-student attendance, classes still to mark): today and the 29 days before. */
export const ATTENDANCE_WINDOW_DAYS = 30;
/** Classes listed as upcoming: the next 7 days after today. */
export const UPCOMING_CLASS_DAYS = 7;
/** A test closed this recently (with results) is listed under "Results to review". */
export const RECENT_RESULTS_DAYS = 7;
/** A closed test this recent can still be the "current test" for the Top 3. */
export const CURRENT_TEST_LOOKBACK_DAYS = 30;
/** Minimum evidence before a student is flagged on a figure (conservative: one bad mark is not a pattern). */
export const MIN_ATTENDANCE_MARKS = 3;
export const MIN_RELEASED_RESULTS = 2;
/** Same product thresholds as the Super Admin training health (attendance 75 %, assessment 65 %). */
export const ATTENDANCE_LOW_BELOW = HEALTH_THRESHOLDS.attendance.watch;
export const PERFORMANCE_LOW_BELOW = HEALTH_THRESHOLDS.assessment.watch;
export const LIST_LIMIT = { attention: 8, upcomingClasses: 6, upcomingTests: 6, weakTopics: 5, top: 3, notifications: 4 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "HH:MM" wall-clock time in India. */
export function indiaClock(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: INDIA_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/** The India dates the dashboard reads classes for. */
export function dashboardWindow(now: Date): { today: string; from: string; to: string } {
  const today = indiaDate(now);
  return { today, from: addDays(today, -(ATTENDANCE_WINDOW_DAYS - 1)), to: addDays(today, UPCOMING_CLASS_DAYS) };
}

// ---------------------------------------------------------------- repository records (snake_case, as read)

export interface TrainerBatchRecord {
  id: string;
  batch_code: string;
  name: string;
  status: "upcoming" | "ongoing";
  course_title: string;
}

export interface EnrolmentRecord {
  batch_id: string;
  student_id: string;
  enrollment_status: "enrolled" | "completed" | "withdrawn";
  full_name: string | null;
  student_code: string | null;
}

export interface TrainerClassRecord {
  id: string;
  title: string;
  class_date: string;
  start_time: string;
  end_time: string;
  status: "scheduled" | "live" | "completed" | "cancelled";
  class_type: string;
  batch_id: string;
  batch_name: string;
  batch_code: string;
  course_title: string;
}

export interface AttendanceMarkRecord {
  class_id: string;
  student_id: string;
  batch_id: string;
  status: "present" | "absent" | "late" | "excused";
}

export interface PendingSubmissionRecord {
  assignment_id: string;
  batch_id: string;
  class_id: string | null;
}

export interface TrainerTestRecord {
  id: string;
  title: string;
  test_type: string;
  status: "draft" | "scheduled" | "active" | "closed";
  available_from: string | null;
  available_until: string | null;
  batch_id: string;
  class_id: string;
  batch_name: string;
  course_title: string;
}

export interface BestResultRecord {
  test_id: string;
  batch_id: string;
  student_id: string;
  percentage: number;
  passed: boolean;
  finalized_at: string;
}

export interface WeakTopicInput {
  title: string;
  percent: number;
  answers: number;
}

// ---------------------------------------------------------------- read model

export type Section<T> = { status: "ok"; data: T } | { status: "error" };

export interface TrainerKpis {
  currentBatches: number;
  ongoingBatches: number;
  upcomingBatches: number;
  activeStudents: number;
  classesToday: number;
  classesTodayCompleted: number;
  averagePerformance: number | null;
  releasedResults: number;
}

export type PendingActionKey = "attendance" | "assignments" | "tests" | "results";

export interface PendingAction {
  key: PendingActionKey;
  title: string;
  count: number;
  explanation: string;
  href: string;
  linkLabel: string;
}

export type AttentionPriority = "critical" | "attention" | "monitor";

export interface AttentionStudent {
  studentId: string;
  batchId: string;
  name: string;
  studentCode: string | null;
  batchName: string;
  /** Mean of the student's released best results in this batch; null when there are none. */
  performance: number | null;
  releasedResults: number;
  /** (present + late + excused) / marked over the attendance window; null when nothing was marked. */
  attendance: number | null;
  attendanceMarked: number;
  /** The lowest released result (test title + %), the most concrete weak spot the data shows. */
  weakArea: { title: string; percent: number } | null;
  priority: AttentionPriority;
  reasons: string[];
  href: string;
}

export interface DashboardClassRow {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  status: TrainerClassRecord["status"];
  batchName: string;
  courseTitle: string;
  needsAttendance: boolean;
}

export interface DashboardTestRow {
  id: string;
  title: string;
  testType: string;
  batchName: string;
  courseTitle: string;
  availableFrom: string | null;
  availableUntil: string | null;
  effectiveStatus: "scheduled" | "active";
}

export interface TopStudent {
  rank: number;
  name: string;
  studentCode: string | null;
  percentage: number;
  passed: boolean;
}

export interface CurrentTestTop {
  testId: string;
  title: string;
  batchName: string;
  courseTitle: string;
  effectiveStatus: "active" | "closed";
  availableUntil: string | null;
  resultCount: number;
  top: TopStudent[];
}

export interface AttendanceOverview {
  present: number;
  late: number;
  absent: number;
  excused: number;
  marked: number;
  /** (present + late + excused) / marked × 100 — the Performance page's definition; null when nothing was marked. */
  rate: number | null;
  classesHeld: number;
}

export interface PerformanceOverview {
  average: number | null;
  releasedResults: number;
  passRate: number | null;
}

export interface WeakTopic {
  title: string;
  percent: number;
  answers: number;
}

/** Input from the existing notification service (the signed-in user's own feed). */
export interface NotificationFeedInput {
  unreadCount: number;
  notifications: { id: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }[];
}

export interface NotificationSummary {
  unreadCount: number;
  latest: NotificationFeedInput["notifications"];
}

export interface TrainerDashboardData {
  today: string;
  windowFrom: string;
  /** The trainer has no upcoming / ongoing batch: the page says so once, above the sections. */
  noCurrentBatches: boolean;
  kpis: Section<TrainerKpis>;
  pending: Section<PendingAction[]>;
  attention: Section<{ rows: AttentionStudent[]; total: number }>;
  todayClasses: Section<DashboardClassRow[]>;
  upcomingClasses: Section<DashboardClassRow[]>;
  upcomingTests: Section<DashboardTestRow[]>;
  currentTest: Section<CurrentTestTop | null>;
  attendance: Section<AttendanceOverview>;
  performance: Section<PerformanceOverview>;
  weakTopics: Section<WeakTopic[]>;
  notifications: Section<NotificationSummary>;
}

// ---------------------------------------------------------------- helpers

const round1 = (v: number) => Math.round(v * 10) / 10;
const mean = (values: number[]) => (values.length === 0 ? null : round1(values.reduce((s, v) => s + v, 0) / values.length));
const time = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
const hhmm = (t: string) => t.slice(0, 5);

/** Mirror of test_effective_status (0008) / testsService: where a test is at `now`. */
export function effectiveTestStatus(t: Pick<TrainerTestRecord, "status" | "available_from" | "available_until">, now: Date): TrainerTestRecord["status"] {
  if (t.status === "draft" || t.status === "closed") return t.status;
  const n = now.getTime();
  if (t.available_until && n >= time(t.available_until)) return "closed";
  if (t.available_from && n >= time(t.available_from)) return "active";
  return "scheduled";
}

/** Results are released once a test is effectively closed (as on the Performance page and for students). */
export function isReleased(t: Pick<TrainerTestRecord, "status" | "available_from" | "available_until">, now: Date): boolean {
  return effectiveTestStatus(t, now) === "closed";
}

function toClassRow(c: TrainerClassRecord, needsAttendance: boolean): DashboardClassRow {
  return {
    id: c.id,
    title: c.title,
    date: c.class_date,
    startTime: hhmm(c.start_time),
    endTime: hhmm(c.end_time),
    status: c.status,
    batchName: c.batch_name,
    courseTitle: c.course_title,
    needsAttendance,
  };
}

function byClassTime(a: TrainerClassRecord, b: TrainerClassRecord): number {
  return a.class_date.localeCompare(b.class_date) || a.start_time.localeCompare(b.start_time) || a.title.localeCompare(b.title);
}

const classHref = (id: string) => `/trainer/classes/${encodeURIComponent(id)}`;
const testHref = (id: string) => `/trainer/tests/${encodeURIComponent(id)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- classes and attendance

/**
 * Held classes of the trainer's current batches with no attendance recorded at all: dated within the
 * window and not after today, not cancelled, in a batch with enrolled students, and — for today — the
 * class has started (or is already marked live / completed). Future classes can't be marked yet.
 */
export function classesNeedingAttendance(input: {
  classes: TrainerClassRecord[];
  marks: AttendanceMarkRecord[];
  currentBatchIds: Set<string>;
  enrolledByBatch: Map<string, number>;
  today: string;
  windowFrom: string;
  clock: string;
}): TrainerClassRecord[] {
  const marked = new Set(input.marks.map((m) => m.class_id));
  return input.classes
    .filter(
      (c) =>
        c.status !== "cancelled" &&
        c.class_date >= input.windowFrom &&
        c.class_date <= input.today &&
        (c.class_date < input.today || c.status === "live" || c.status === "completed" || hhmm(c.start_time) <= input.clock) &&
        input.currentBatchIds.has(c.batch_id) &&
        (input.enrolledByBatch.get(c.batch_id) ?? 0) > 0 &&
        !marked.has(c.id)
    )
    .sort(byClassTime);
}

export function todayClasses(classes: TrainerClassRecord[], today: string, needing: Set<string>): DashboardClassRow[] {
  return classes.filter((c) => c.class_date === today).sort(byClassTime).map((c) => toClassRow(c, needing.has(c.id)));
}

export function upcomingClasses(classes: TrainerClassRecord[], today: string): DashboardClassRow[] {
  return classes
    .filter((c) => c.class_date > today && c.status !== "cancelled")
    .sort(byClassTime)
    .slice(0, LIST_LIMIT.upcomingClasses)
    .map((c) => toClassRow(c, false));
}

/** Marks of held classes in the window (current batches), by status. */
export function attendanceOverview(marks: AttendanceMarkRecord[]): AttendanceOverview {
  const o = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const m of marks) o[m.status] += 1;
  const marked = marks.length;
  return { ...o, marked, rate: marked === 0 ? null : round1(((marked - o.absent) / marked) * 100), classesHeld: new Set(marks.map((m) => m.class_id)).size };
}

// ---------------------------------------------------------------- tests and results

export function upcomingTests(tests: TrainerTestRecord[], now: Date): DashboardTestRow[] {
  return tests
    .map((t) => ({ t, eff: effectiveTestStatus(t, now) }))
    .filter((x): x is { t: TrainerTestRecord; eff: "scheduled" | "active" } => x.eff === "scheduled" || x.eff === "active")
    .sort(
      (a, b) =>
        (a.eff === "active" ? 0 : 1) - (b.eff === "active" ? 0 : 1) ||
        (a.t.available_from ?? "9999").localeCompare(b.t.available_from ?? "9999") ||
        a.t.title.localeCompare(b.t.title)
    )
    .slice(0, LIST_LIMIT.upcomingTests)
    .map(({ t, eff }) => ({
      id: t.id,
      title: t.title,
      testType: t.test_type,
      batchName: t.batch_name,
      courseTitle: t.course_title,
      availableFrom: t.available_from,
      availableUntil: t.available_until,
      effectiveStatus: eff,
    }));
}

/**
 * The most relevant test for a Top 3: a test open right now with finished attempts (latest opening first),
 * otherwise the most recently closed test with results in the last CURRENT_TEST_LOOKBACK_DAYS. Ranking is
 * within that one test only (one batch) — never across batches or the company. Ties: earlier finish first.
 */
export function currentTestTop(input: {
  tests: TrainerTestRecord[];
  results: BestResultRecord[];
  enrolments: EnrolmentRecord[];
  now: Date;
}): CurrentTestTop | null {
  const byTest = new Map<string, BestResultRecord[]>();
  for (const r of input.results) byTest.set(r.test_id, [...(byTest.get(r.test_id) ?? []), r]);
  const withResults = input.tests.filter((t) => (byTest.get(t.id)?.length ?? 0) > 0);
  const n = input.now.getTime();

  const active = withResults
    .filter((t) => effectiveTestStatus(t, input.now) === "active")
    .sort((a, b) => (b.available_from ?? "").localeCompare(a.available_from ?? ""));
  const closed = withResults
    .filter((t) => effectiveTestStatus(t, input.now) === "closed" && t.available_until && n - time(t.available_until) <= CURRENT_TEST_LOOKBACK_DAYS * DAY_MS)
    .sort((a, b) => (b.available_until ?? "").localeCompare(a.available_until ?? ""));
  const test = active[0] ?? closed[0];
  if (!test) return null;

  const names = new Map(
    input.enrolments.filter((e) => e.batch_id === test.batch_id && e.enrollment_status !== "withdrawn").map((e) => [e.student_id, e])
  );
  // Only students still in the batch (enrolled / completed): staff RLS on attempts is batch-wide, so a
  // withdrawn student's attempt is readable but must neither be ranked nor counted.
  const current = (byTest.get(test.id) ?? []).filter((r) => names.has(r.student_id));
  const ranked = [...current]
    .sort((a, b) => Number(b.percentage) - Number(a.percentage) || a.finalized_at.localeCompare(b.finalized_at))
    .slice(0, LIST_LIMIT.top)
    .map((r, i) => {
      const e = names.get(r.student_id)!;
      return { rank: i + 1, name: e.full_name ?? "Student", studentCode: e.student_code, percentage: round1(Number(r.percentage)), passed: r.passed };
    });
  return {
    testId: test.id,
    title: test.title,
    batchName: test.batch_name,
    courseTitle: test.course_title,
    effectiveStatus: active[0] ? "active" : "closed",
    availableUntil: test.available_until,
    resultCount: current.length,
    top: ranked,
  };
}

/** Average of released best results (current batches) — the Performance page's test average. */
export function performanceOverview(results: BestResultRecord[], tests: TrainerTestRecord[], now: Date): PerformanceOverview {
  const released = releasedResults(results, tests, now);
  const passed = released.filter((r) => r.passed).length;
  return {
    average: mean(released.map((r) => Number(r.percentage))),
    releasedResults: released.length,
    passRate: released.length === 0 ? null : round1((passed / released.length) * 100),
  };
}

function releasedResults(results: BestResultRecord[], tests: TrainerTestRecord[], now: Date): BestResultRecord[] {
  const released = new Set(tests.filter((t) => isReleased(t, now)).map((t) => t.id));
  return results.filter((r) => released.has(r.test_id));
}

export function weakTopics(modules: WeakTopicInput[]): WeakTopic[] {
  return modules
    .filter((m) => m.answers > 0 && m.percent < MODULE_WEAK_BELOW)
    .sort((a, b) => a.percent - b.percent || a.title.localeCompare(b.title))
    .slice(0, LIST_LIMIT.weakTopics)
    .map((m) => ({ title: m.title, percent: round1(m.percent), answers: m.answers }));
}

// ---------------------------------------------------------------- pending actions

export function pendingActions(input: {
  needingAttendance: TrainerClassRecord[];
  submissions: PendingSubmissionRecord[];
  tests: TrainerTestRecord[];
  results: BestResultRecord[];
  now: Date;
}): PendingAction[] {
  const out: PendingAction[] = [];

  const att = input.needingAttendance;
  if (att.length > 0) {
    out.push({
      key: "attendance",
      title: "Attendance to mark",
      count: att.length,
      explanation: `${plural(att.length, "class", "classes")} held in the last ${ATTENDANCE_WINDOW_DAYS} days with no attendance recorded.`,
      href: att.length === 1 ? classHref(att[0]!.id) : "/trainer/classes",
      linkLabel: att.length === 1 ? "Open the class" : "Open your classes",
    });
  }

  const subs = input.submissions;
  if (subs.length > 0) {
    const classIds = Array.from(new Set(subs.map((s) => s.class_id).filter((id): id is string => Boolean(id))));
    out.push({
      key: "assignments",
      title: "Assignments to review",
      count: subs.length,
      explanation: `${plural(subs.length, "submission")} waiting for your review${classIds.length > 1 ? ` across ${classIds.length} classes` : ""}.`,
      href: classIds.length === 1 ? classHref(classIds[0]!) : "/trainer/classes",
      linkLabel: classIds.length === 1 ? "Review in the class" : "Open your classes",
    });
  }

  const open = input.tests.filter((t) => effectiveTestStatus(t, input.now) === "active");
  if (open.length > 0) {
    out.push({
      key: "tests",
      title: "Tests to monitor",
      count: open.length,
      explanation: `${plural(open.length, "test")} open for attempts right now.`,
      href: "/trainer/exam-monitoring",
      linkLabel: "Open exam monitoring",
    });
  }

  const withResults = new Set(input.results.map((r) => r.test_id));
  const n = input.now.getTime();
  const recent = input.tests.filter(
    (t) =>
      withResults.has(t.id) &&
      effectiveTestStatus(t, input.now) === "closed" &&
      t.available_until !== null &&
      n - time(t.available_until) <= RECENT_RESULTS_DAYS * DAY_MS
  );
  if (recent.length > 0) {
    out.push({
      key: "results",
      title: "Results to review",
      count: recent.length,
      explanation: `${plural(recent.length, "test")} closed in the last ${RECENT_RESULTS_DAYS} days with finished attempts.`,
      href: recent.length === 1 ? testHref(recent[0]!.id) : "/trainer/tests",
      linkLabel: recent.length === 1 ? "View the results" : "Open your tests",
    });
  }
  return out;
}

// ---------------------------------------------------------------- students needing attention

const PRIORITY_RANK: Record<AttentionPriority, number> = { critical: 0, attention: 1, monitor: 2 };

/**
 * Enrolled students of the current batches whose EXISTING figures fall below the product thresholds —
 * no score of our own, no prediction:
 *   critical  — test average AND attendance both low (two independent signals agree);
 *   attention — test average OR attendance low;
 *   monitor   — failed their most recent released test, nothing else low.
 * A figure counts only with enough evidence (MIN_RELEASED_RESULTS results / MIN_ATTENDANCE_MARKS marks).
 */
export function studentsNeedingAttention(input: {
  enrolments: EnrolmentRecord[];
  batches: TrainerBatchRecord[];
  results: BestResultRecord[];
  tests: TrainerTestRecord[];
  marks: AttendanceMarkRecord[];
  now: Date;
}): { rows: AttentionStudent[]; total: number } {
  const testsById = new Map(input.tests.map((t) => [t.id, t]));
  const released = releasedResults(input.results, input.tests, input.now);
  const batchName = new Map(input.batches.map((b) => [b.id, b.batch_code ? `${b.batch_code} — ${b.name}` : b.name]));
  const key = (batchId: string, studentId: string) => `${batchId}|${studentId}`;

  const resultsBy = new Map<string, BestResultRecord[]>();
  for (const r of released) resultsBy.set(key(r.batch_id, r.student_id), [...(resultsBy.get(key(r.batch_id, r.student_id)) ?? []), r]);
  const marksBy = new Map<string, { marked: number; attended: number }>();
  for (const m of input.marks) {
    const k = key(m.batch_id, m.student_id);
    const a = marksBy.get(k) ?? { marked: 0, attended: 0 };
    a.marked += 1;
    if (m.status !== "absent") a.attended += 1;
    marksBy.set(k, a);
  }

  const rows: AttentionStudent[] = [];
  for (const e of input.enrolments) {
    if (e.enrollment_status !== "enrolled" || !batchName.has(e.batch_id)) continue;
    const k = key(e.batch_id, e.student_id);
    const results = resultsBy.get(k) ?? [];
    const att = marksBy.get(k) ?? { marked: 0, attended: 0 };
    const performance = mean(results.map((r) => Number(r.percentage)));
    const attendance = att.marked === 0 ? null : round1((att.attended / att.marked) * 100);

    const lowPerf = performance !== null && results.length >= MIN_RELEASED_RESULTS && performance < PERFORMANCE_LOW_BELOW;
    const lowAtt = attendance !== null && att.marked >= MIN_ATTENDANCE_MARKS && attendance < ATTENDANCE_LOW_BELOW;
    const byDate = [...results].sort((a, b) => (testsById.get(b.test_id)?.available_until ?? "").localeCompare(testsById.get(a.test_id)?.available_until ?? ""));
    const latest = byDate[0];
    const failedLatest = latest !== undefined && latest.passed === false;

    const priority: AttentionPriority | null = lowPerf && lowAtt ? "critical" : lowPerf || lowAtt ? "attention" : failedLatest ? "monitor" : null;
    if (!priority) continue;

    const reasons: string[] = [];
    if (lowPerf) reasons.push(`Test average ${performance}% over ${plural(results.length, "released result")}`);
    if (lowAtt) reasons.push(`Attendance ${attendance}% (${att.attended} of ${att.marked} marked classes)`);
    if (failedLatest) reasons.push(`Did not pass the latest test (${testsById.get(latest.test_id)?.title ?? "test"})`);

    const lowest = [...results].sort((a, b) => Number(a.percentage) - Number(b.percentage))[0];
    rows.push({
      studentId: e.student_id,
      batchId: e.batch_id,
      name: e.full_name ?? "Student",
      studentCode: e.student_code,
      batchName: batchName.get(e.batch_id)!,
      performance,
      releasedResults: results.length,
      attendance,
      attendanceMarked: att.marked,
      weakArea: lowest ? { title: testsById.get(lowest.test_id)?.title ?? "Test", percent: round1(Number(lowest.percentage)) } : null,
      priority,
      reasons,
      href: `/trainer/performance?batch=${encodeURIComponent(e.batch_id)}&student=${encodeURIComponent(e.student_id)}`,
    });
  }
  rows.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      (a.performance ?? 101) - (b.performance ?? 101) ||
      (a.attendance ?? 101) - (b.attendance ?? 101) ||
      a.name.localeCompare(b.name)
  );
  return { rows: rows.slice(0, LIST_LIMIT.attention), total: rows.length };
}

// ---------------------------------------------------------------- KPIs

export function trainerKpis(input: {
  batches: TrainerBatchRecord[];
  enrolments: EnrolmentRecord[];
  todayRows: DashboardClassRow[];
  performance: PerformanceOverview;
}): TrainerKpis {
  const held = input.todayRows.filter((c) => c.status !== "cancelled");
  return {
    currentBatches: input.batches.length,
    ongoingBatches: input.batches.filter((b) => b.status === "ongoing").length,
    upcomingBatches: input.batches.filter((b) => b.status === "upcoming").length,
    activeStudents: new Set(input.enrolments.filter((e) => e.enrollment_status === "enrolled").map((e) => e.student_id)).size,
    classesToday: held.length,
    classesTodayCompleted: held.filter((c) => c.status === "completed").length,
    averagePerformance: input.performance.average,
    releasedResults: input.performance.releasedResults,
  };
}

// ---------------------------------------------------------------- notifications

/** A compact summary of the existing notification feed: the unread total and the newest few (no new data). */
export function notificationSummary(feed: NotificationFeedInput): NotificationSummary {
  return { unreadCount: Math.max(0, feed.unreadCount), latest: feed.notifications.slice(0, LIST_LIMIT.notifications) };
}
