/**
 * Staff exam-integrity review (0009 security events + 0015 session and
 * browser signals). Everything here is a prompt for review — never a
 * score, verdict or penalty.
 */

/** Where an event comes from. */
export type IntegrityEventCategory = "server" | "browser" | "info";

/** Category filter: "review" = server + browser (the default). */
export type IntegrityCategoryFilter = "review" | IntegrityEventCategory | "all";

export interface ExamMonitoringFilters {
  batchId: string | null;
  testId: string | null;
  studentId: string | null;
  attemptId: string | null;
  eventType: string | null;
  category: IntegrityCategoryFilter;
  /** YYYY-MM-DD, India time. */
  from: string | null;
  to: string | null;
}

export interface MonitoringOption {
  value: string;
  label: string;
}

/** One short, privacy-safe fact about an event (no ids, session tokens, answers or scores). */
export interface IntegrityEventFact {
  label: string;
  value: string;
}

export interface IntegrityEvent {
  id: number;
  occurredAt: string;
  type: string;
  label: string;
  category: IntegrityEventCategory;
  facts: IntegrityEventFact[];
}

export interface MonitoredAttempt {
  attemptId: string;
  attemptNumber: number | null;
  status: "in_progress" | "submitted" | "finalized" | null;
  studentName: string;
  studentCode: string | null;
  testTitle: string;
  batchLabel: string;
}

export interface ActiveAttempt extends MonitoredAttempt {
  startedAt: string;
  /** The server's effective deadline: min(attempt deadline, test closing time). */
  effectiveDeadline: string;
  /** Whole minutes left at page load (0 when past; the database finalizes it on the next request). */
  minutesLeft: number;
  /** Review signals (server + browser) recorded for this attempt, among the loaded events. */
  reviewSignals: number;
}

export interface AttemptTimeline {
  attempt: MonitoredAttempt | null;
  counts: Record<IntegrityEventCategory, number>;
  /** Oldest first. */
  events: IntegrityEvent[];
}

export interface ExamMonitoringData {
  role: "admin" | "trainer";
  filters: ExamMonitoringFilters;
  /** A filter value outside the viewer's scope was dropped (nothing from it is shown). */
  outOfScope: boolean;
  options: {
    batches: MonitoringOption[];
    tests: MonitoringOption[];
    students: MonitoringOption[];
    eventTypes: { value: string; label: string; category: IntegrityEventCategory }[];
  };
  activeAttempts: ActiveAttempt[];
  timelines: AttemptTimeline[];
  /** More events matched than were loaded (the most recent are shown). */
  eventsTruncated: boolean;
  eventLimit: number;
  generatedAt: string;
}
