/**
 * Super Admin dashboard service (D1 / D2a / D2b-2A). The signed-in user comes
 * from the session, never from the browser; only a Super Admin gets the data
 * (RoleGuard and middleware check the same before the page renders, and
 * RLS decides every row the repository reads).
 *
 * Two independent results per request:
 *   core       current-state sections (D1/D2a): database counts and bounded
 *              reads, the Users page totals, the Super Admin's notification
 *              feed, completion approvals.
 *   analytics  the period-based panels (D2b-2A) from ONE call to
 *              public.dashboard_analytics (0024), validated before use, plus
 *              the six-line Training health. If the analytics fail, only the
 *              analytics panels show their error state; health keeps its
 *              current-state lines and marks the analytics lines Unavailable.
 * Sections load in parallel and independently: one failure shows that
 * section's error state, never a raw error, and never hides the others.
 */
import {
  ACTIVITY_LIMIT,
  TODAY_CLASS_LIMIT,
  UPCOMING_CLASS_LIMIT,
  UPCOMING_TEST_LIMIT,
  buildAttentionItems,
  indiaDate,
  batchCapacityHealth,
  pendingApprovalBatches,
  pendingApprovalsAt,
  shortTime,
  trainerCoverageHealth,
  summarizeCurrentBatches,
  testState,
  type AdminDashboardData,
  type CurrentBatchRecord,
  type DashboardClass,
  type DashboardPeriod,
  type DashboardSection,
  type DashboardTest,
  type HealthLine,
} from "@/lib/dashboard/admin-dashboard";
import { PERIOD_LABEL, addDays, compare, periodRange, previousComparable, type Comparison, type PeriodKey } from "@/lib/dashboard/periods";
import {
  ANALYTICS_LIST_LIMIT,
  analyticsHealth,
  buildAnalyticsPanels,
  parseAnalytics,
  resolvePeriodKey,
  trainingHealth,
  unavailableAnalyticsHealth,
  type AnalyticsPanels,
  type DashboardAnalyticsResult,
  type TrainingHealthView,
} from "@/lib/dashboard/analytics";

/** The look-back for "pending approvals vs 7 days ago" (an instant, 7 × 24 h before now). */
const APPROVALS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
import type { AuthUser } from "@/types/auth";
import type { NotificationFeed } from "@/types/notification";
import type { CompletionBatchSummary } from "@/types/certificate";
import { DashboardValidationError, type ClassRecord, type DashboardRepository, type TestRecord } from "@/repositories/dashboard.repository.core";

export type { DashboardAnalyticsResult };

/** Both halves, started together; each resolves independently and never rejects. */
export interface DashboardLoad {
  core: Promise<AdminDashboardData>;
  analytics: Promise<DashboardAnalyticsResult>;
}

export class DashboardAuthorizationError extends Error {
  constructor(message = "Only Super Admins can view this dashboard.") {
    super(message);
    this.name = "DashboardAuthorizationError";
  }
}

/** The account totals the Users page shows (invited / suspended / missing record). */
export interface AccountTotals {
  invited: number;
  suspended: number;
  missingRecord: number;
}

export interface AdminDashboardServiceDeps {
  repository: Pick<
    DashboardRepository,
    | "countActiveAccounts"
    | "countBatchesByStatus"
    | "countClassesOn"
    | "countCompletionsAwaitingApproval"
    | "listCurrentBatches"
    | "listCompletionStatusEventsAfter"
    | "listClassesOn"
    | "listUpcomingClasses"
    | "listUpcomingTests"
    | "getAnalytics"
  >;
  getCurrentUser: () => Promise<AuthUser | null>;
  getAccountTotals: () => Promise<AccountTotals>;
  getNotifications: (limit: number) => Promise<NotificationFeed | null>;
  /** Batches with completion counts (the Certificates page's list). */
  getCompletionBatches: () => Promise<CompletionBatchSummary[] | null>;
  now?: () => Date;
}

function toClass(r: ClassRecord): DashboardClass {
  return {
    id: r.id,
    title: r.title,
    date: r.class_date,
    startTime: shortTime(r.start_time),
    endTime: shortTime(r.end_time),
    status: r.status,
    classType: r.class_type,
    batchName: r.batch_name,
  };
}

function toTest(r: TestRecord, now: Date): DashboardTest {
  return {
    id: r.id,
    title: r.title,
    testType: r.test_type,
    state: testState(r.status, r.available_from, now),
    availableFrom: r.available_from,
    availableUntil: r.available_until,
    batchName: r.batch_name,
  };
}

/** The selected period and its comparison period (India dates), from the existing period utilities. */
function dashboardPeriod(key: PeriodKey, today: string): DashboardPeriod {
  const range = periodRange(key, today);
  const prev = previousComparable(range);
  return { key, label: PERIOD_LABEL[key], from: range.from, to: range.to, prevFrom: prev.from, prevTo: prev.to };
}

const CURRENT_STATE_HEALTH: Pick<HealthLine, "key" | "label" | "href" | "linkLabel">[] = [
  { key: "trainer_coverage", label: "Trainer coverage", href: "/admin/batches", linkLabel: "Review batch trainers" },
  { key: "batch_capacity", label: "Batch capacity", href: "/admin/batches", linkLabel: "Review upcoming batches" },
];

export function createAdminDashboardService(deps: AdminDashboardServiceDeps) {
  const now = deps.now ?? (() => new Date());

  /** A section's promise → ok / error; the error is logged by name only. */
  async function section<T>(name: string, run: () => Promise<T>): Promise<DashboardSection<T>> {
    try {
      return { status: "ok", data: await run() };
    } catch (err) {
      console.error(`[dashboard] ${name} failed:`, err instanceof Error ? err.name : "unknown error");
      return { status: "error" };
    }
  }

  /** An optional extra (a comparison): null on failure, logged by name; never fails its section. */
  async function optional<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      console.error(`[dashboard] ${name} failed:`, err instanceof Error ? err.name : "unknown error");
      return null;
    }
  }

  /**
   * One dashboard_analytics call for the period. Midnight edge: this server can reach the next India day
   * a moment before the database does; if the database then rejects an end date of "today" (22023),
   * retry ONCE with yesterday as the end. Any other error is not retried.
   */
  async function fetchAnalytics(period: DashboardPeriod, today: string): Promise<unknown> {
    try {
      return await deps.repository.getAnalytics(period.from, period.to, ANALYTICS_LIST_LIMIT);
    } catch (err) {
      if (!(err instanceof DashboardValidationError) || period.to !== today) throw err;
      const to = addDays(today, -1);
      return deps.repository.getAnalytics(period.from > to ? to : period.from, to, ANALYTICS_LIST_LIMIT);
    }
  }

  /** The period-based panels and the six-line health; never rejects. */
  async function loadAnalytics(period: DashboardPeriod, today: string, currentBatchRows: Promise<CurrentBatchRecord[]>): Promise<DashboardAnalyticsResult> {
    const raw = await section("analytics", async () => parseAnalytics(await fetchAnalytics(period, today)));
    const panels: DashboardSection<AnalyticsPanels> =
      raw.status === "ok" ? await section("analytics panels", async () => buildAnalyticsPanels(raw.data, period.key)) : { status: "error" };

    const rows = await section("health batches", () => currentBatchRows);
    const currentLines: HealthLine[] =
      rows.status === "ok"
        ? [trainerCoverageHealth(rows.data), batchCapacityHealth(rows.data, today)]
        : CURRENT_STATE_HEALTH.map((b) => ({ ...b, status: "unavailable" as const, reason: "Current batch data could not be loaded." }));
    const analyticsLines = raw.status === "ok" ? analyticsHealth(raw.data.health) : unavailableAnalyticsHealth();
    const health: DashboardSection<TrainingHealthView> =
      rows.status === "error" && raw.status === "error" ? { status: "error" } : { status: "ok", data: trainingHealth([...currentLines, ...analyticsLines]) };
    return { panels, health };
  }

  /** Starts both halves for a `?period=` value (validated; default this_month). Super Admin only. */
  async function load(periodParam?: unknown): Promise<DashboardLoad> {
    const user = await deps.getCurrentUser();
    if (!user || user.role !== "admin") throw new DashboardAuthorizationError();

    const at = now();
    const today = indiaDate(at);
    const period = dashboardPeriod(resolvePeriodKey(periodParam), today);
    const repo = deps.repository;

    // Shared reads (each runs once even when two sections use it).
    const batchCounts = repo.countBatchesByStatus();
    const classesToday = repo.countClassesOn(today);
    const pendingCompletions = repo.countCompletionsAwaitingApproval();
    const currentBatchRows = repo.listCurrentBatches();
    const currentBatches = currentBatchRows.then(summarizeCurrentBatches);
    // Unhandled-rejection safety: each shared promise is awaited by its sections below.
    for (const p of [batchCounts, classesToday, pendingCompletions, currentBatchRows, currentBatches]) p.catch(() => undefined);

    // The period-based half starts now, in parallel with the current-state half.
    const analytics = loadAnalytics(period, today, currentBatchRows);

    // D2a comparisons (real data only): classes on the same India weekday last week; recommendations
    // pending exactly 7 × 24 h ago, rebuilt from the completion status events since then.
    const lastWeekDay = addDays(today, -7);
    const lookback = new Date(at.getTime() - APPROVALS_LOOKBACK_MS).toISOString();
    const classesComparison = optional("classesToday comparison", async () =>
      compare(await classesToday, await repo.countClassesOn(lastWeekDay), "vs same day last week")
    );
    const approvalsComparison = optional("approvals comparison", async () => {
      const [now_, events] = await Promise.all([pendingCompletions, repo.listCompletionStatusEventsAfter(lookback)]);
      return compare(now_, pendingApprovalsAt(now_, events), "vs 7 days ago");
    });

    const core = (async (): Promise<AdminDashboardData> => {
      const [metrics, attention, todayClasses, upcomingClasses, upcomingTests, overview, activity, approvals] = await Promise.all([
        section("metrics", async () => {
          const [activeStudents, activeTrainers, batches, today_, pending, classesCmp, approvalsCmp] = await Promise.all([
            repo.countActiveAccounts("student"),
            repo.countActiveAccounts("trainer"),
            batchCounts,
            classesToday,
            pendingCompletions,
            classesComparison,
            approvalsComparison,
          ]);
          return {
            activeStudents,
            activeTrainers,
            ongoingBatches: batches.ongoing,
            upcomingBatches: batches.upcoming,
            classesToday: today_,
            completionsAwaitingApproval: pending,
            comparisons: { classesToday: classesCmp as Comparison | null, completionsAwaitingApproval: approvalsCmp as Comparison | null },
          };
        }),
        section("attention", async () => {
          const [facts, pending, accounts] = await Promise.all([currentBatches, pendingCompletions, deps.getAccountTotals()]);
          return buildAttentionItems({
            unavailableTrainer: facts.unavailableTrainer,
            fullUpcoming: facts.fullUpcoming,
            pendingCompletions: pending,
            invitedAccounts: accounts.invited,
            suspendedAccounts: accounts.suspended,
            missingRecords: accounts.missingRecord,
          });
        }),
        section("todayClasses", async () => {
          const [total, rows] = await Promise.all([classesToday, repo.listClassesOn(today, TODAY_CLASS_LIMIT)]);
          return { total, classes: rows.map(toClass) };
        }),
        section("upcomingClasses", async () => (await repo.listUpcomingClasses(today, UPCOMING_CLASS_LIMIT)).map(toClass)),
        section("upcomingTests", async () => (await repo.listUpcomingTests(at.toISOString(), UPCOMING_TEST_LIMIT)).map((t) => toTest(t, at))),
        section("overview", async () => {
          const [batches, facts] = await Promise.all([batchCounts, currentBatches]);
          return { batches, courses: facts.courses, coursesWithCurrentBatches: facts.coursesWithCurrentBatches };
        }),
        section("activity", async () => {
          const feed = await deps.getNotifications(ACTIVITY_LIMIT);
          if (!feed) throw new Error("notifications unavailable");
          return {
            unreadCount: feed.unreadCount,
            items: feed.notifications.slice(0, ACTIVITY_LIMIT).map((n) => ({
              id: n.id,
              title: n.title,
              body: n.body,
              createdAt: n.createdAt,
              link: n.link,
              unread: n.readAt === null,
            })),
          };
        }),
        section("approvals", async () => {
          const [total, rows] = await Promise.all([pendingCompletions, deps.getCompletionBatches()]);
          if (!rows) throw new Error("completion batches unavailable");
          return { total, ...pendingApprovalBatches(rows) };
        }),
      ]);
      return { today, generatedAt: at.toISOString(), period, metrics, attention, todayClasses, upcomingClasses, upcomingTests, overview, activity, approvals };
    })();

    return { core, analytics };
  }

  return {
    load,
    /** The current-state half only (convenience for callers that don't render analytics). */
    async getDashboard(periodParam?: unknown): Promise<AdminDashboardData> {
      return (await load(periodParam)).core;
    },
  };
}

export type AdminDashboardService = ReturnType<typeof createAdminDashboardService>;
