/**
 * Super Admin dashboard (D1) — pure rules and read models. No imports of
 * server code, no I/O: the service fills these from the repository and the
 * existing services; the page only renders them.
 *
 * Every number is a stored fact (database counts or existing service
 * results). Nothing here invents trends, scores or "at-risk" rules.
 */
import { isTrainerAvailable } from "@/lib/batches/assign-trainer";
import { addDays, type Comparison, type PeriodKey } from "@/lib/dashboard/periods";

// -------------------------------------------------------------------
// Time: the platform's day is India time (Asia/Kolkata), as for
// attendance, assignments and notifications.
// -------------------------------------------------------------------

export const INDIA_TIME_ZONE = "Asia/Kolkata";

/** The calendar date (YYYY-MM-DD) in India time at `now`. */
export function indiaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: INDIA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// -------------------------------------------------------------------
// Bounds for the dashboard's lists (never whole tables)
// -------------------------------------------------------------------

export const TODAY_CLASS_LIMIT = 10;
export const UPCOMING_CLASS_LIMIT = 8;
export const UPCOMING_TEST_LIMIT = 8;
export const ACTIVITY_LIMIT = 8;
export const COURSE_ACTIVITY_LIMIT = 6;
export const PENDING_APPROVAL_LIMIT = 5;

// -------------------------------------------------------------------
// Sections: each loads independently; one failure never hides the rest
// -------------------------------------------------------------------

export type DashboardSection<T> = { status: "ok"; data: T } | { status: "error" };

export const BATCH_STATUS_ORDER = ["upcoming", "ongoing", "completed", "cancelled"] as const;
export type DashboardBatchStatus = (typeof BATCH_STATUS_ORDER)[number];
export type BatchStatusCounts = Record<DashboardBatchStatus, number>;

export interface DashboardMetrics {
  activeStudents: number;
  activeTrainers: number;
  ongoingBatches: number;
  upcomingBatches: number;
  classesToday: number;
  completionsAwaitingApproval: number;
  /**
   * Real comparisons only (D2a); null when the comparison couldn't be read.
   * Active students/trainers and ongoing/upcoming batches stay current-state
   * (no history exists to compare against — product decision Q5).
   */
  comparisons: {
    classesToday: Comparison | null;
    completionsAwaitingApproval: Comparison | null;
  };
}

// -------------------------------------------------------------------
// Training health (D2a: trainer coverage and batch capacity; D2b-2A: the
// four analytics indicators — see src/lib/dashboard/analytics.ts)
// -------------------------------------------------------------------

export type HealthStatus = "healthy" | "watch" | "attention";
/** A line's status: a judgement, "No data" (nothing to judge) or "Unavailable" (its source could not be read). */
export type HealthLineStatus = HealthStatus | "no_data" | "unavailable";
export type HealthKey = "trainer_coverage" | "batch_capacity" | "attendance" | "assessment" | "assignments" | "students";

export interface HealthLine {
  key: HealthKey;
  label: string;
  status: HealthLineStatus;
  /** The database fact behind the status, in words. */
  reason: string;
  href: string;
  linkLabel: string;
}

export const HEALTH_LABEL: Record<HealthLineStatus, string> = {
  healthy: "Healthy",
  watch: "Watch",
  attention: "Attention",
  no_data: "No data",
  unavailable: "Unavailable",
};
const HEALTH_RANK: Record<HealthStatus, number> = { healthy: 0, watch: 1, attention: 2 };

/** Product decision Q2 — percentage thresholds (attendance 85 / 75; assessment and assignments 80 / 65). */
export const HEALTH_THRESHOLDS = {
  attendance: { healthy: 85, watch: 75 },
  assessment: { healthy: 80, watch: 65 },
  assignments: { healthy: 80, watch: 65 },
} as const;

/** A percentage against its thresholds: ≥ healthy → healthy, ≥ watch → watch, otherwise attention. */
export function percentHealth(value: number, t: { healthy: number; watch: number }): HealthStatus {
  if (!Number.isFinite(value)) throw new RangeError("A health percentage must be a number.");
  return value >= t.healthy ? "healthy" : value >= t.watch ? "watch" : "attention";
}

/** "Worst line wins" — only over lines that were actually calculated; null when there are none. */
export function worstHealth(statuses: HealthStatus[]): HealthStatus | null {
  return statuses.reduce<HealthStatus | null>((worst, s) => (worst === null || HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst), null);
}

/** Days before an upcoming batch's start within which a full batch needs attention. */
export const CAPACITY_ATTENTION_DAYS = 7;

export interface AttentionItem {
  key: "unavailable_trainer" | "full_upcoming" | "pending_completions" | "invited_accounts" | "suspended_accounts" | "missing_records";
  count: number;
  title: string;
  reason: string;
  href: string;
  linkLabel: string;
}

export interface DashboardClass {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  classType: string;
  batchName: string;
}

export interface DashboardTest {
  id: string;
  title: string;
  testType: string;
  /** "open" once the availability window has started (as the database computes it), otherwise "scheduled". */
  state: "open" | "scheduled";
  availableFrom: string | null;
  availableUntil: string | null;
  batchName: string;
}

export interface CourseActivity {
  courseId: string;
  course: string;
  currentBatches: number;
}

export interface TrainingOverview {
  batches: BatchStatusCounts;
  /** Courses with upcoming/ongoing batches, most batches first. */
  courses: CourseActivity[];
  coursesWithCurrentBatches: number;
}

/** The selected reporting period (D2b-2A): India dates, both ends included. */
export interface DashboardPeriod {
  key: PeriodKey;
  label: string;
  from: string;
  to: string;
  /** The comparison period: the same number of India days immediately before (Q1). */
  prevFrom: string;
  prevTo: string;
}

/** A batch with completion recommendations waiting for a Super Admin decision. */
export interface PendingApprovalBatch {
  batchId: string;
  batchCode: string;
  batchName: string;
  course: string;
  trainerName: string | null;
  recommended: number;
}

export interface PendingApprovals {
  /** Database count of recommendations awaiting approval (all batches). */
  total: number;
  /** Batches with pending recommendations, most first (at most PENDING_APPROVAL_LIMIT). */
  batches: PendingApprovalBatch[];
  batchesWithPending: number;
}

export interface DashboardActivity {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  link: string | null;
  unread: boolean;
}

export interface AdminDashboardData {
  /** India-time date the dashboard was computed for (YYYY-MM-DD). */
  today: string;
  generatedAt: string;
  /** The reporting period the analytics panels use (current-state sections ignore it). */
  period: DashboardPeriod;
  metrics: DashboardSection<DashboardMetrics>;
  attention: DashboardSection<AttentionItem[]>;
  todayClasses: DashboardSection<{ total: number; classes: DashboardClass[] }>;
  upcomingClasses: DashboardSection<DashboardClass[]>;
  upcomingTests: DashboardSection<DashboardTest[]>;
  overview: DashboardSection<TrainingOverview>;
  activity: DashboardSection<{ unreadCount: number; items: DashboardActivity[] }>;
  approvals: DashboardSection<PendingApprovals>;
}

// -------------------------------------------------------------------
// Repository records → read models
// -------------------------------------------------------------------

/** A current (upcoming / ongoing) batch, as the repository reads it. */
export interface CurrentBatchRecord {
  id: string;
  status: string;
  maxSeats: number;
  /** India calendar date (YYYY-MM-DD). */
  startDate: string;
  trainerId: string | null;
  courseId: string;
  course: string;
  trainerStatus: unknown;
  trainerRole: unknown;
  trainerAccountStatus: unknown;
  /** Seats in use: distinct non-withdrawn enrolments (the capacity trigger's rule). */
  seatsUsed: number;
}

export interface CurrentBatchFacts {
  unavailableTrainer: number;
  fullUpcoming: number;
  courses: CourseActivity[];
  coursesWithCurrentBatches: number;
}

/** Facts derived from the current batches: trainer availability (same rule as the batches page), full upcoming batches, course activity. */
export function summarizeCurrentBatches(rows: CurrentBatchRecord[]): CurrentBatchFacts {
  let unavailableTrainer = 0;
  let fullUpcoming = 0;
  const byCourse = new Map<string, CourseActivity>();
  for (const b of rows) {
    if (b.trainerId !== null && !isTrainerAvailable({ status: b.trainerStatus, role: b.trainerRole, accountStatus: b.trainerAccountStatus })) {
      unavailableTrainer += 1;
    }
    if (b.status === "upcoming" && b.seatsUsed >= b.maxSeats) fullUpcoming += 1;
    const c = byCourse.get(b.courseId) ?? { courseId: b.courseId, course: b.course || "Untitled course", currentBatches: 0 };
    c.currentBatches += 1;
    byCourse.set(b.courseId, c);
  }
  const courses = [...byCourse.values()].sort((a, b) => b.currentBatches - a.currentBatches || a.course.localeCompare(b.course));
  return { unavailableTrainer, fullUpcoming, courses: courses.slice(0, COURSE_ACTIVITY_LIMIT), coursesWithCurrentBatches: courses.length };
}

const batchesWord = (n: number) => (n === 1 ? "batch" : "batches");

/** Trainer coverage (Q2.1): attention when any upcoming/ongoing batch has no trainer or an unavailable trainer. */
export function trainerCoverageHealth(rows: CurrentBatchRecord[]): HealthLine {
  let unassigned = 0;
  let unavailable = 0;
  for (const b of rows) {
    if (b.trainerId === null) unassigned += 1;
    else if (!isTrainerAvailable({ status: b.trainerStatus, role: b.trainerRole, accountStatus: b.trainerAccountStatus })) unavailable += 1;
  }
  const base = { key: "trainer_coverage" as const, label: "Trainer coverage", href: "/admin/batches", linkLabel: "Review batch trainers" };
  if (rows.length === 0) return { ...base, status: "healthy", reason: "No upcoming or ongoing batches." };
  if (unassigned + unavailable === 0) {
    return { ...base, status: "healthy", reason: `All ${rows.length} upcoming and ongoing ${batchesWord(rows.length)} have an available trainer.` };
  }
  const parts: string[] = [];
  if (unassigned > 0) parts.push(`${unassigned} ${batchesWord(unassigned)} without a trainer`);
  if (unavailable > 0) parts.push(`${unavailable} with an unavailable trainer`);
  return { ...base, status: "attention", reason: `${parts.join(" and ")} (of ${rows.length} upcoming and ongoing).` };
}

/** Batch capacity (Q2.2): watch when any upcoming batch is full; attention when a full one starts within 7 India days (or is past its start date). */
export function batchCapacityHealth(rows: CurrentBatchRecord[], today: string): HealthLine {
  const fullUpcoming = rows.filter((b) => b.status === "upcoming" && b.seatsUsed >= b.maxSeats);
  const soon = fullUpcoming.filter((b) => b.startDate <= addDays(today, CAPACITY_ATTENTION_DAYS));
  const base = { key: "batch_capacity" as const, label: "Batch capacity", href: "/admin/batches", linkLabel: "Review upcoming batches" };
  if (soon.length > 0) {
    return { ...base, status: "attention", reason: `${soon.length} full upcoming ${batchesWord(soon.length)} ${soon.length === 1 ? "starts" : "start"} within ${CAPACITY_ATTENTION_DAYS} days.` };
  }
  if (fullUpcoming.length > 0) {
    return { ...base, status: "watch", reason: `${fullUpcoming.length} upcoming ${batchesWord(fullUpcoming.length)} ${fullUpcoming.length === 1 ? "is" : "are"} full (starting in more than ${CAPACITY_ATTENTION_DAYS} days).` };
  }
  return { ...base, status: "healthy", reason: "No upcoming batch is full." };
}

/** A completion status event from the append-only completion_events log (0011). */
export interface CompletionStatusEvent {
  id: number;
  completionId: string;
  /** detail.status: the record's status after this change. */
  status: string | null;
  /** detail.previous_status: its status before (null for the first recommendation). */
  previousStatus: string | null;
}

/**
 * Recommendations awaiting approval at an earlier instant T, rebuilt exactly
 * from the current count and the status events after T (every insert/update
 * of completion_records writes one, from a trigger, for any writer):
 *   for a completion with events after T, its state at T is the first such
 *   event's previous status and its state now is the last such event's status;
 *   any other completion is in the same state as now.
 * `eventsAfterT` must be every status event after T (in any order).
 */
export function pendingApprovalsAt(currentPending: number, eventsAfterT: CompletionStatusEvent[]): number {
  const byCompletion = new Map<string, { first: CompletionStatusEvent; last: CompletionStatusEvent }>();
  for (const e of eventsAfterT) {
    const seen = byCompletion.get(e.completionId);
    if (!seen) byCompletion.set(e.completionId, { first: e, last: e });
    else {
      if (e.id < seen.first.id) seen.first = e;
      if (e.id > seen.last.id) seen.last = e;
    }
  }
  let pending = currentPending;
  for (const { first, last } of byCompletion.values()) {
    if (last.status === "recommended") pending -= 1; // pending now, counted in currentPending
    if (first.previousStatus === "recommended") pending += 1; // was pending at T
  }
  if (pending < 0) throw new RangeError("The completion history is inconsistent with the current count.");
  return pending;
}

export interface AttentionFacts {
  unavailableTrainer: number;
  fullUpcoming: number;
  pendingCompletions: number;
  invitedAccounts: number;
  suspendedAccounts: number;
  missingRecords: number;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Only items with something to act on, in a fixed order; empty when nothing needs attention. */
export function buildAttentionItems(f: AttentionFacts): AttentionItem[] {
  const items: AttentionItem[] = [
    {
      key: "unavailable_trainer",
      count: f.unavailableTrainer,
      title: plural(f.unavailableTrainer, "Batch without an available trainer", "Batches without an available trainer"),
      reason: "The assigned trainer is inactive, no longer a trainer, or their account is not active. Reassign the batch.",
      href: "/admin/batches",
      linkLabel: "Review batches",
    },
    {
      key: "full_upcoming",
      count: f.fullUpcoming,
      title: plural(f.fullUpcoming, "Upcoming batch is full", "Upcoming batches are full"),
      reason: "Every seat is taken before the batch starts; no further students can be enrolled.",
      href: "/admin/batches",
      linkLabel: "Review batches",
    },
    {
      key: "pending_completions",
      count: f.pendingCompletions,
      title: plural(f.pendingCompletions, "Completion awaiting approval", "Completions awaiting approval"),
      reason: "Recommended by a trainer; a Super Admin decision is needed before a certificate can be issued.",
      href: "/admin/certificates",
      linkLabel: "Review completions",
    },
    {
      key: "invited_accounts",
      count: f.invitedAccounts,
      title: plural(f.invitedAccounts, "Invited account not yet active", "Invited accounts not yet active"),
      reason: "The invitation has not been accepted yet.",
      href: "/admin/users?status=invited",
      linkLabel: "View invited accounts",
    },
    {
      key: "suspended_accounts",
      count: f.suspendedAccounts,
      title: plural(f.suspendedAccounts, "Suspended account", "Suspended accounts"),
      reason: "These people cannot sign in until reactivated.",
      href: "/admin/users?status=suspended",
      linkLabel: "View suspended accounts",
    },
    {
      key: "missing_records",
      count: f.missingRecords,
      title: plural(f.missingRecords, "Account without its student/trainer record", "Accounts without their student/trainer record"),
      reason: "The account's role needs a matching student or trainer record.",
      href: "/admin/users?record=missing",
      linkLabel: "View accounts with a missing record",
    },
  ];
  return items.filter((i) => Number.isFinite(i.count) && i.count > 0);
}

/** Batches with pending completion recommendations, most first, bounded. */
export function pendingApprovalBatches(
  rows: { id: string; batchCode: string; name: string; courseTitle: string; trainerName: string | null; counts: { recommended: number } }[]
): { batches: PendingApprovalBatch[]; batchesWithPending: number } {
  const pending = rows
    .filter((r) => r.counts.recommended > 0)
    .sort((a, b) => b.counts.recommended - a.counts.recommended || a.name.localeCompare(b.name))
    .map((r) => ({ batchId: r.id, batchCode: r.batchCode, batchName: r.name, course: r.courseTitle, trainerName: r.trainerName, recommended: r.counts.recommended }));
  return { batches: pending.slice(0, PENDING_APPROVAL_LIMIT), batchesWithPending: pending.length };
}

/** "HH:MM" from a database time ("HH:MM:SS"). */
export function shortTime(value: string | null | undefined): string {
  return typeof value === "string" && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : "";
}

/** Mirror of test_effective_status (0008) for a published test: open once available_from has passed. */
export function testState(status: string, availableFrom: string | null, now: Date): "open" | "scheduled" {
  if (status === "active") return "open";
  return availableFrom !== null && now.getTime() >= new Date(availableFrom).getTime() ? "open" : "scheduled";
}

export const CLASS_TYPE_LABEL: Record<string, string> = { online: "Online", offline: "Classroom", hybrid: "Hybrid" };
export const TEST_TYPE_LABEL: Record<string, string> = { quiz: "Quiz", module_test: "Module test", final_exam: "Final exam", practical: "Practical" };
export const BATCH_STATUS_LABEL: Record<DashboardBatchStatus, string> = { upcoming: "Upcoming", ongoing: "Ongoing", completed: "Completed", cancelled: "Cancelled" };
