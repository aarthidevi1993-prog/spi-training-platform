/**
 * Trainer dashboard service (P4.2) — answers "what do I need to know and
 * do as a trainer today?" for the signed-in trainer only. Identity comes
 * from the session (never the URL); every read goes through the trainer
 * dashboard repository on the trainer's own session (RLS), scoped to
 * their current batches. Classes come from the existing Classes service
 * (trainer-scoped on the server, India-date range filtered in SQL), weak
 * topics from the existing Performance service and the notification
 * summary from the existing Notifications service — each checks the
 * caller again on its own.
 *
 * Reads run in parallel (one round of independent reads, then the
 * attendance marks of the window's classes); a failed read fails only the
 * sections that depend on it. Read-only: nothing here writes.
 */
import type { AuthUser } from "@/types/auth";
import type { TrainerDashboardRepository } from "@/repositories/trainer-dashboard.repository.core";
import {
  attendanceOverview,
  classesNeedingAttendance,
  currentTestTop,
  dashboardWindow,
  indiaClock,
  notificationSummary,
  pendingActions,
  performanceOverview,
  studentsNeedingAttention,
  todayClasses,
  trainerKpis,
  upcomingClasses,
  upcomingTests,
  weakTopics,
  LIST_LIMIT,
  type NotificationFeedInput,
  type Section,
  type TrainerClassRecord,
  type TrainerDashboardData,
  type WeakTopicInput,
} from "@/lib/dashboard/trainer-dashboard";

export class TrainerDashboardAuthorizationError extends Error {
  constructor(message = "Only trainers can view this dashboard.") {
    super(message);
    this.name = "TrainerDashboardAuthorizationError";
  }
}

export interface TrainerDashboardServiceDeps {
  repository: TrainerDashboardRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** The signed-in trainer's own classes on India dates [from, to] (the existing Classes service). */
  listClasses: (from: string, to: string) => Promise<TrainerClassRecord[]>;
  /** The signed-in user's own notification feed (the existing Notifications service); null when unavailable. */
  getNotifications: (limit: number) => Promise<NotificationFeedInput | null>;
  /** Module results of the trainer's current batches (the Performance page's topic analysis); null when unavailable. */
  getModulePerformance: () => Promise<WeakTopicInput[] | null>;
  now?: () => Date;
}

type Settled<T> = { ok: true; value: T } | { ok: false };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const })
  );
}

/** A section from its inputs: ok only when every input loaded. */
function section<T>(inputs: Settled<unknown>[], build: () => T): Section<T> {
  if (inputs.some((i) => !i.ok)) return { status: "error" };
  try {
    return { status: "ok", data: build() };
  } catch (err) {
    console.error("[trainer-dashboard] section failed:", err instanceof Error ? err.name : "unknown");
    return { status: "error" };
  }
}

const value = <T>(s: Settled<T>): T => (s as { ok: true; value: T }).value;

export function createTrainerDashboardService(deps: TrainerDashboardServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    /**
     * The whole dashboard for the signed-in trainer. Throws when the caller isn't an active trainer, or
     * when even their current batches can't be read (the page then shows its error state).
     */
    async load(): Promise<TrainerDashboardData> {
      const user = await deps.getCurrentUser();
      if (!user || user.role !== "trainer" || user.isActive === false) throw new TrainerDashboardAuthorizationError();

      const at = now();
      const { today, from, to } = dashboardWindow(at);
      const repo = deps.repository;

      // Starts before the batches are known: it reads its own trainer scope.
      const modulesP = settle(deps.getModulePerformance());
      const classesP = settle(deps.listClasses(from, to));
      const notificationsP = settle(deps.getNotifications(LIST_LIMIT.notifications));

      const batches = await repo.listCurrentBatches(user.id);
      const batchIds = batches.map((b) => b.id);
      const currentBatchIds = new Set(batchIds);

      const [enrolments, classes, submissions, tests, results, modules, notifications] = await Promise.all([
        settle(repo.listEnrolments(batchIds)),
        classesP,
        settle(repo.listPendingSubmissions(batchIds)),
        settle(repo.listTests(batchIds)),
        settle(repo.listBestResults(batchIds)),
        modulesP,
        notificationsP,
      ]);

      // Attendance: only the window's held (not future, not cancelled) classes of the current batches.
      const heldClassIds = classes.ok
        ? value(classes)
            .filter((c) => c.class_date <= today && c.status !== "cancelled" && currentBatchIds.has(c.batch_id))
            .map((c) => c.id)
        : [];
      const marks = classes.ok ? await settle(repo.listAttendance(heldClassIds)) : ({ ok: false } as const);

      const enrolledByBatch = new Map<string, number>();
      if (enrolments.ok) {
        for (const e of value(enrolments)) {
          if (e.enrollment_status === "enrolled") enrolledByBatch.set(e.batch_id, (enrolledByBatch.get(e.batch_id) ?? 0) + 1);
        }
      }
      const needing = () =>
        classesNeedingAttendance({
          classes: value(classes),
          marks: value(marks),
          currentBatchIds,
          enrolledByBatch,
          today,
          windowFrom: from,
          clock: indiaClock(at),
        });
      const needingIds = () => new Set(needing().map((c) => c.id));
      const perf = () => performanceOverview(value(results), value(tests), at);

      const todayRows = section([classes, marks, enrolments], () => todayClasses(value(classes), today, needingIds()));
      return {
        today,
        windowFrom: from,
        noCurrentBatches: batches.length === 0,
        kpis: section([enrolments, classes, results, tests], () =>
          trainerKpis({
            batches,
            enrolments: value(enrolments),
            todayRows: todayClasses(value(classes), today, new Set()),
            performance: perf(),
          })
        ),
        pending: section([classes, marks, enrolments, submissions, tests, results], () =>
          pendingActions({ needingAttendance: needing(), submissions: value(submissions), tests: value(tests), results: value(results), now: at })
        ),
        attention: section([enrolments, results, tests, marks], () =>
          studentsNeedingAttention({ enrolments: value(enrolments), batches, results: value(results), tests: value(tests), marks: value(marks), now: at })
        ),
        todayClasses: todayRows,
        upcomingClasses: section([classes], () => upcomingClasses(value(classes), today)),
        upcomingTests: section([tests], () => upcomingTests(value(tests), at)),
        currentTest: section([tests, results, enrolments], () =>
          currentTestTop({ tests: value(tests), results: value(results), enrolments: value(enrolments), now: at })
        ),
        attendance: section([marks], () => attendanceOverview(value(marks))),
        performance: section([results, tests], perf),
        weakTopics: section([modules], () => {
          const m = value(modules);
          if (m === null) throw new Error("unavailable");
          return weakTopics(m);
        }),
        notifications: section([notifications], () => {
          const feed = value(notifications);
          if (feed === null) throw new Error("unavailable");
          return notificationSummary(feed);
        }),
      };
    },
  };
}

export type TrainerDashboardService = ReturnType<typeof createTrainerDashboardService>;
