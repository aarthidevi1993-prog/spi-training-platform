/**
 * Student Dashboard (Phase 1) — the KPI row, built only from the
 * student's own metrics as calculated by performanceService (student
 * scope: student_available_tests() for released results, and the
 * student's own attendance and returned assignment rows under RLS).
 * Pure functions: nothing here queries the database or recalculates a
 * metric; the definitions are the Performance page's (src/types/performance.ts).
 *
 *   value null → "—" with a "nothing yet" hint (missing data, never 0)
 *   service unavailable (demo mode) → "unavailable" state, no numbers
 *   service failure → "error" state, no numbers (never shown as 0)
 *
 * No trends: there is no verified period-over-period calculation, and no
 * course progress: it has no data source in the database.
 */
import type { PerformanceData, PerformanceMetrics } from "@/types/performance";

export interface StudentDashboardKpi {
  key: "attendance" | "testAverage" | "passRate" | "assignmentAverage";
  label: string;
  /** "—" when there is nothing to calculate from. */
  value: string;
  /** What the number is based on (or why there is none). */
  hint: string;
}

export type StudentDashboardKpiState =
  | { kind: "ready"; kpis: StudentDashboardKpi[] }
  /** Metrics need a database (demo mode) — show no numbers. */
  | { kind: "unavailable" }
  /** The metrics could not be loaded — show no numbers. */
  | { kind: "error" };

export const STUDENT_KPI_UNAVAILABLE = "Your attendance and results appear here when you sign in with your training account.";
export const STUDENT_KPI_ERROR = "We couldn't load your attendance and results right now. Please try again later.";

const pct = (value: number | null) => (value === null ? "—" : `${value}%`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function studentDashboardKpis(m: PerformanceMetrics): StudentDashboardKpi[] {
  return [
    {
      key: "attendance",
      label: "Attendance",
      value: pct(m.attendancePercent),
      hint: m.attendancePercent === null ? "No attendance marked yet" : `${m.attendanceAttended} of ${plural(m.attendanceMarked, "class", "classes")} attended`,
    },
    {
      key: "testAverage",
      label: "Test Average",
      value: pct(m.testAverage),
      hint: m.testAverage === null ? "No released results yet" : `Across ${plural(m.releasedResults, "released result", "released results")}`,
    },
    {
      key: "passRate",
      label: "Tests Passed",
      value: pct(m.passRate),
      hint: m.passRate === null ? "No released results yet" : `${m.passedResults} of ${plural(m.releasedResults, "result", "results")} passed`,
    },
    {
      key: "assignmentAverage",
      label: "Assignment Average",
      value: pct(m.assignmentAverage),
      hint: m.assignmentAverage === null ? "No returned assignments yet" : `Across ${plural(m.assignmentsScored, "returned assignment", "returned assignments")}`,
    },
  ];
}

/**
 * Load the KPI row through the student-scoped performance service. A failure is
 * reported as "error" (logged by the caller's logger, never as zeros); null (demo
 * mode) as "unavailable"; anything but a student result as "error".
 */
export async function loadStudentDashboardKpis(
  getPerformance: () => Promise<PerformanceData | null>,
  log: (message: string) => void = () => undefined
): Promise<StudentDashboardKpiState> {
  let data: PerformanceData | null;
  try {
    data = await getPerformance();
  } catch (err) {
    log(err instanceof Error ? err.name : "unknown error");
    return { kind: "error" };
  }
  if (data === null) return { kind: "unavailable" };
  if (data.role !== "student") {
    log("unexpected performance scope");
    return { kind: "error" };
  }
  return { kind: "ready", kpis: studentDashboardKpis(data.metrics) };
}

// -------------------------------------------------------------------
// Phase 2 — Upcoming classes and pending assignments (read-only lists)
// -------------------------------------------------------------------

/** How many items each dashboard list shows (the full lists live on the Classes page). */
export const STUDENT_DASHBOARD_LIST_LIMIT = 5;

export type StudentDashboardList<T> =
  | { kind: "ready"; items: T[]; total: number }
  /** Needs a database (demo mode for assignments) — no items shown. */
  | { kind: "unavailable" }
  /** Could not be loaded — no items shown (never an empty list pretending to be real). */
  | { kind: "error" };

/** The class fields the dashboard needs (from classesService, already scoped to the student). */
export interface UpcomingClassSource {
  id: string;
  title: string;
  courseTitle: string;
  classDate: string;
  startTime: string;
  status: string;
}

export interface UpcomingClassItem {
  id: string;
  title: string;
  courseTitle: string;
  classDate: string;
  /** "HH:MM" */
  startTime: string;
  status: string;
  href: string;
}

/**
 * The next classes, soonest first. "Upcoming" is the existing Classes definition
 * (class date today or later, not cancelled — classes.repository "upcoming"); it is
 * re-applied here so a mis-scoped input can never show a past or cancelled class.
 */
export function pickUpcomingClasses(classes: UpcomingClassSource[], today: string, limit = STUDENT_DASHBOARD_LIST_LIMIT) {
  const upcoming = classes
    .filter((c) => c.classDate >= today && c.status !== "cancelled")
    .sort((a, b) => a.classDate.localeCompare(b.classDate) || a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title));
  const items: UpcomingClassItem[] = upcoming.slice(0, limit).map((c) => ({
    id: c.id,
    title: c.title,
    courseTitle: c.courseTitle,
    classDate: c.classDate,
    startTime: c.startTime.slice(0, 5),
    status: c.status,
    href: `/student/classes/${encodeURIComponent(c.id)}`,
  }));
  return { items, total: upcoming.length };
}

/** A published assignment visible to the student (RLS: enrolled/completed batches), with its class. */
export interface StudentAssignmentSource {
  id: string;
  classId: string;
  title: string;
  dueAt: string | null;
  /** Only "published" assignments accept submissions (0006 validate trigger). */
  status: string;
  classTitle: string;
  classStatus: string;
}

export interface PendingAssignmentItem {
  id: string;
  title: string;
  classTitle: string;
  dueAt: string | null;
  /** The due date has passed (submissions are still accepted while the assignment is published). */
  pastDue: boolean;
  /** The class page holds the assignment and its submission form. */
  href: string;
}

/**
 * Pending = what the student can still submit, by the database's own rules (0006):
 * the assignment is published, its class isn't cancelled, and the student has no
 * submission yet. Ordered by due date (soonest first; no due date last).
 */
export function pickPendingAssignments(
  assignments: StudentAssignmentSource[],
  submittedAssignmentIds: ReadonlySet<string>,
  now: Date,
  limit = STUDENT_DASHBOARD_LIST_LIMIT
) {
  const pending = assignments
    .filter((a) => a.status === "published" && a.classStatus !== "cancelled" && !submittedAssignmentIds.has(a.id))
    .sort((a, b) => {
      if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return a.title.localeCompare(b.title);
    });
  const items: PendingAssignmentItem[] = pending.slice(0, limit).map((a) => ({
    id: a.id,
    title: a.title,
    classTitle: a.classTitle,
    dueAt: a.dueAt,
    pastDue: a.dueAt !== null && new Date(a.dueAt).getTime() < now.getTime(),
    href: `/student/classes/${encodeURIComponent(a.classId)}`,
  }));
  return { items, total: pending.length };
}

/**
 * Load one list section: a failure is "error" (only the error name is logged),
 * null (no database: demo mode) is "unavailable". Never a fabricated or empty "ready".
 */
export async function loadStudentDashboardList<T>(
  load: () => Promise<{ items: T[]; total: number } | null>,
  log: (message: string) => void = () => undefined
): Promise<StudentDashboardList<T>> {
  try {
    const result = await load();
    return result === null ? { kind: "unavailable" } : { kind: "ready", items: result.items, total: result.total };
  } catch (err) {
    log(err instanceof Error ? err.name : "unknown error");
    return { kind: "error" };
  }
}

// -------------------------------------------------------------------
// Phase 3 — Recent results (from the same student performance data as the KPIs)
// -------------------------------------------------------------------

export const STUDENT_RECENT_RESULTS_LIMIT = 3;

export interface RecentResultItem {
  testId: string;
  title: string;
  /** The released best percentage, exactly as the Performance and Tests pages show it. */
  percentage: number;
  passed: boolean;
  /** The student's own test page (best result and review, under the existing release rules). */
  href: string;
}

/**
 * The student's most recent RELEASED results — performanceService's studentResults
 * (student_available_tests(): own, released best results only, newest first). No new
 * calculation and no new query: the dashboard already loads this data for its KPIs.
 * null (demo mode) → null; anything but the student's own scope → an error, never shown.
 */
export function studentRecentResults(data: PerformanceData | null, limit = STUDENT_RECENT_RESULTS_LIMIT): { items: RecentResultItem[]; total: number } | null {
  if (data === null) return null;
  if (data.role !== "student") throw Object.assign(new Error("unexpected performance scope"), { name: "UnexpectedScopeError" });
  const results = data.studentResults ?? [];
  return {
    items: results.slice(0, limit).map((r) => ({
      testId: r.testId,
      title: r.title,
      percentage: r.percentage,
      passed: r.passed,
      href: `/student/tests/${encodeURIComponent(r.testId)}`,
    })),
    total: results.length,
  };
}
