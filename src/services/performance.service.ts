import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { studentTestsService } from "./student-tests.service";
import {
  performanceRepository,
  PerformanceRepositoryError,
  type RowFilter,
  type TestMetaRecord,
} from "@/repositories/performance.repository";
import type { BestResultRecord } from "@/repositories/results.repository";
import type { AttendanceStatusColumn } from "@/lib/supabase/types";
import type { AuthUser } from "@/types/auth";
import {
  MODULE_STRONG_MIN,
  MODULE_WEAK_BELOW,
  type ModulePerformance,
  type PerformanceData,
  type PerformanceFilterOption,
  type PerformanceMetrics,
  type PerformanceTrendPoint,
} from "@/types/performance";

/**
 * Performance service — identity and scope always come from
 * authService (never from the URL): Super Admin sees every batch;
 * a trainer only their CURRENT (upcoming/ongoing) batches; a student
 * only themselves. Filters from the URL are accepted only when they
 * fall inside that scope.
 *
 * Every number is a factual summary of stored data — scores are read
 * exactly as the database graded them (best released result per test ×
 * student) and never re-graded. There is no combined "overall" score.
 */

export class PerformanceAuthorizationError extends Error {
  constructor(message = "You don't have permission to view performance.") {
    super(message);
    this.name = "PerformanceAuthorizationError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many released tests the trend line shows (most recent). */
const TREND_POINTS = 10;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round2(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** Display mirror of test_effective_status (0008): results are released once a test is effectively closed. */
function isReleased(test: Pick<TestMetaRecord, "status" | "available_until">, now: number): boolean {
  if (test.status === "draft") return false;
  if (test.status === "closed") return true;
  return Boolean(test.available_until && now >= new Date(test.available_until).getTime());
}

function testMetrics(results: { percentage: number; passed: boolean }[]): Pick<
  PerformanceMetrics,
  "testAverage" | "releasedResults" | "passedResults" | "passRate"
> {
  const passed = results.filter((r) => r.passed).length;
  return {
    testAverage: mean(results.map((r) => r.percentage)),
    releasedResults: results.length,
    passedResults: passed,
    passRate: results.length > 0 ? round2((passed / results.length) * 100) : null,
  };
}

/** (present + late + excused) / marked records × 100 — unmarked classes are not counted as absent. */
function attendanceMetrics(statuses: AttendanceStatusColumn[]): Pick<
  PerformanceMetrics,
  "attendancePercent" | "attendanceMarked" | "attendanceAttended"
> {
  const attended = statuses.filter((s) => s !== "absent").length;
  return {
    attendancePercent: statuses.length > 0 ? round2((attended / statuses.length) * 100) : null,
    attendanceMarked: statuses.length,
    attendanceAttended: attended,
  };
}

/** Returned submissions with a numeric score and a max score, each normalised to a percentage. */
async function assignmentMetrics(filter: RowFilter): Promise<Pick<PerformanceMetrics, "assignmentAverage" | "assignmentsScored">> {
  const rows = await performanceRepository.listScoredSubmissions(filter);
  const percentages: number[] = [];
  for (const r of rows) {
    const score = r.score === null ? NaN : Number(r.score);
    const max = r.class_assignments?.max_score === null || r.class_assignments?.max_score === undefined ? NaN : Number(r.class_assignments.max_score);
    if (Number.isFinite(score) && Number.isFinite(max) && max > 0) percentages.push((score / max) * 100);
  }
  return { assignmentAverage: mean(percentages), assignmentsScored: percentages.length };
}

function sortDate(test: Pick<TestMetaRecord, "available_until" | "available_from"> & { classDate: string | null }): string | null {
  return test.available_until ?? test.available_from ?? test.classDate;
}

function byDateAsc(a: { date: string | null }, b: { date: string | null }): number {
  return (a.date ?? "").localeCompare(b.date ?? "");
}

/**
 * Marks earned / marks available per module, over the best released
 * attempts in scope. Questions without a module (or whose bank question
 * the caller can't read) are left out of the module view.
 */
async function modulePerformance(best: BestResultRecord[], testIds: string[]): Promise<ModulePerformance[]> {
  if (best.length === 0) return [];
  const [answers, frozen] = await Promise.all([
    performanceRepository.listGradedAnswers(best.map((b) => b.best_attempt_id)),
    performanceRepository.listFrozenQuestionSources(testIds),
  ]);
  const frozenById = new Map(frozen.map((q) => [q.id, q]));
  const sources = await performanceRepository.listQuestionModules(Array.from(new Set(frozen.map((q) => q.source_question_id))));
  const moduleBySource = new Map(sources.filter((s) => s.modules).map((s) => [s.id, s.modules!]));

  const tally = new Map<string, { title: string; sequence: number; earned: number; available: number; answers: number }>();
  for (const a of answers) {
    const q = frozenById.get(a.test_question_id);
    const mod = q ? moduleBySource.get(q.source_question_id) : undefined;
    if (!q || !mod) continue;
    const t = tally.get(mod.id) ?? { title: mod.title, sequence: mod.sequence, earned: 0, available: 0, answers: 0 };
    t.earned += Number(a.marks_awarded ?? 0);
    t.available += Number(q.marks);
    t.answers += 1;
    tally.set(mod.id, t);
  }

  return Array.from(tally.entries())
    .filter(([, t]) => t.available > 0)
    .map(([moduleId, t]) => ({ moduleId, t, percent: round2((t.earned / t.available) * 100) }))
    .sort((a, b) => b.percent - a.percent || a.t.sequence - b.t.sequence)
    .map(({ moduleId, t, percent }) => ({ moduleId, title: t.title, percent, answers: t.answers }));
}

async function staffPerformance(user: AuthUser, batchParam: string | null, studentParam: string | null): Promise<PerformanceData> {
  const role = user.role === "admin" ? "admin" : "trainer";
  const batches = await performanceRepository.listScopeBatches(
    role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id }
  );

  // URL filters are honoured only inside the caller's scope.
  const batch = batchParam && UUID_PATTERN.test(batchParam) ? batches.find((b) => b.id === batchParam) ?? null : null;
  const studentOptions: PerformanceFilterOption[] = batch
    ? (await performanceRepository.listBatchStudents(batch.id))
        .map((s) => ({
          value: s.student_id,
          label: s.students ? `${s.students.full_name}${s.students.student_code ? ` (${s.students.student_code})` : ""}` : "Unknown student",
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const student = studentParam && UUID_PATTERN.test(studentParam) ? studentOptions.find((s) => s.value === studentParam) ?? null : null;

  const batchIds = batch ? [batch.id] : batches.map((b) => b.id);
  const studentId = student?.value ?? null;
  const filter: RowFilter = { batchIds, studentId };

  const [allBest, attendance, assignments] = await Promise.all([
    performanceRepository.listBestResults(batchIds, studentId),
    batchIds.length > 0 ? performanceRepository.listAttendanceStatuses(filter) : Promise.resolve([]),
    batchIds.length > 0 ? assignmentMetrics(filter) : Promise.resolve({ assignmentAverage: null, assignmentsScored: 0 }),
  ]);

  // Released results only (test effectively closed), matching what students see.
  const meta = await performanceRepository.listTestMeta(Array.from(new Set(allBest.map((b) => b.test_id))));
  const now = Date.now();
  const releasedTests = new Map(meta.filter((t) => isReleased(t, now)).map((t) => [t.id, t]));
  const best = allBest.filter((b) => releasedTests.has(b.test_id));

  const perTest = new Map<string, number[]>();
  for (const b of best) {
    const list = perTest.get(b.test_id) ?? [];
    list.push(Number(b.percentage));
    perTest.set(b.test_id, list);
  }
  const trend: PerformanceTrendPoint[] = Array.from(perTest.entries())
    .map(([testId, values]) => {
      const t = releasedTests.get(testId);
      return {
        testId,
        title: t?.title ?? "Test",
        date: t ? sortDate({ ...t, classDate: t.classes?.class_date ?? null }) : null,
        averagePercent: mean(values) ?? 0,
      };
    })
    .sort(byDateAsc)
    .slice(-TREND_POINTS);

  const modules = await modulePerformance(best, Array.from(releasedTests.keys()));

  const scopeLabel = batch
    ? `${batch.batch_code ? `${batch.batch_code} — ` : ""}${batch.name}${student ? ` · ${student.label}` : ""}`
    : role === "admin"
      ? "All batches"
      : "Your current batches (upcoming and ongoing)";

  return {
    role,
    metrics: {
      ...testMetrics(best.map((b) => ({ percentage: Number(b.percentage), passed: b.passed }))),
      ...attendanceMetrics(attendance),
      ...assignments,
    },
    trend,
    modules,
    strongModules: modules.filter((m) => m.percent >= MODULE_STRONG_MIN).map((m) => m.title),
    weakModules: modules.filter((m) => m.percent < MODULE_WEAK_BELOW).map((m) => m.title),
    studentResults: null,
    filters: {
      batches: batches.map((b) => ({ value: b.id, label: b.batch_code ? `${b.batch_code} — ${b.name}` : b.name })),
      students: studentOptions,
      batchId: batch?.id ?? null,
      studentId,
    },
    scopeLabel,
  };
}

async function studentPerformance(user: AuthUser): Promise<PerformanceData | null> {
  // Released results only, straight from student_available_tests().
  const tests = await studentTestsService.listTests();
  if (tests === null) return null;
  const released = tests.filter((t) => t.resultsAvailable && t.bestResult);

  const own: RowFilter = { ownStudentId: user.id };
  const [attendance, assignments] = await Promise.all([
    performanceRepository.listAttendanceStatuses(own),
    assignmentMetrics(own),
  ]);

  const dated = released
    .map((t) => ({
      testId: t.testId,
      title: t.title,
      date: t.availableUntil ?? t.availableFrom ?? t.classDate,
      percentage: t.bestResult?.percentage ?? 0,
      passed: t.bestResult?.passed ?? false,
    }))
    .sort(byDateAsc);

  return {
    role: "student",
    metrics: {
      ...testMetrics(dated),
      ...attendanceMetrics(attendance),
      ...assignments,
    },
    trend: dated.slice(-TREND_POINTS).map((t) => ({ testId: t.testId, title: t.title, date: t.date, averagePercent: t.percentage })),
    modules: null,
    strongModules: [],
    weakModules: [],
    studentResults: [...dated].reverse().map(({ testId, title, percentage, passed }) => ({ testId, title, percentage, passed })),
    filters: null,
    scopeLabel: "Your released test results, attendance and returned assignments",
  };
}

export const performanceService = {
  /**
   * Performance for the signed-in user. `batchId` / `studentId` are
   * optional URL filters (staff only; ignored when outside scope).
   * null in demo mode.
   */
  async getPerformance(filters: { batchId?: string | null; studentId?: string | null } = {}): Promise<PerformanceData | null> {
    if (authConfig.mode === "demo") return null;
    const user = await authService.getCurrentUser();
    if (!user) throw new PerformanceAuthorizationError("You need to be signed in.");
    if (user.role === "admin" || user.role === "trainer") {
      return staffPerformance(user, filters.batchId ?? null, filters.studentId ?? null);
    }
    if (user.role === "student") return studentPerformance(user);
    throw new PerformanceAuthorizationError();
  },
};

export { PerformanceRepositoryError };
