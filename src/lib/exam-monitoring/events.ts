/**
 * Exam-integrity event presentation for staff: neutral labels, the three
 * categories (server security event / browser activity signal /
 * informational) and a privacy-safe summary of each event's detail.
 *
 * Only whitelisted, human-readable facts leave this module: never
 * session ids, question ids, option ids, client sequence numbers,
 * requested ids, scores or anything else in the stored detail.
 */
import { sanitizeClientEventDetail, isReportedClientEventKind } from "@/lib/student-tests/client-events";
import type {
  ExamMonitoringFilters,
  IntegrityCategoryFilter,
  IntegrityEventCategory,
  IntegrityEventFact,
} from "@/types/exam-monitoring";

interface EventMeta {
  label: string;
  category: IntegrityEventCategory;
}

export const EVENT_META: Record<string, EventMeta> = {
  // Server security events (recorded by the database itself).
  concurrent_session: { label: "Concurrent session detected", category: "server" },
  invalid_attempt_access: { label: "Attempt access refused", category: "server" },
  suspicious_repeated_access: { label: "Repeated-request review signal", category: "server" },
  repeated_start: { label: "Attempt reopened while in progress", category: "server" },
  blocked_start: { label: "Start refused", category: "server" },
  blocked_answer_save: { label: "Answer save refused", category: "server" },
  blocked_submission: { label: "Submission refused", category: "server" },
  // Browser activity signals (reported by the student's browser; lower trust).
  client_hidden: { label: "Page hidden (tab or window switched)", category: "browser" },
  client_offline: { label: "Browser went offline", category: "browser" },
  client_online: { label: "Browser back online", category: "browser" },
  client_copy: { label: "Copy in the test area", category: "browser" },
  client_paste: { label: "Paste in the test area", category: "browser" },
  client_print: { label: "Print started", category: "browser" },
  client_multiple_tabs: { label: "Test open in another tab", category: "browser" },
  client_fullscreen_exit: { label: "Left full screen", category: "browser" },
  // Informational (the normal attempt lifecycle).
  attempt_started: { label: "Attempt started", category: "info" },
  answer_saved: { label: "Answer saved", category: "info" },
  submit: { label: "Submitted", category: "info" },
  auto_submit: { label: "Submitted automatically (time limit)", category: "info" },
  deadline_reached: { label: "Time limit reached", category: "info" },
  test_closed_finalization: { label: "Finalized (test closed)", category: "info" },
  cancellation_finalization: { label: "Finalized (class or batch cancelled)", category: "info" },
  withdrawal_finalization: { label: "Finalized (enrolment ended)", category: "info" },
};

export const EVENT_TYPES = Object.keys(EVENT_META);

export const CATEGORY_LABEL: Record<IntegrityEventCategory, string> = {
  server: "Server security event",
  browser: "Browser activity signal",
  info: "Informational",
};

export const CATEGORY_FILTER_LABEL: Record<IntegrityCategoryFilter, string> = {
  review: "Review signals (server + browser)",
  server: "Server security events",
  browser: "Browser activity signals",
  info: "Informational",
  all: "All events",
};

export function eventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? { label: "Other event", category: "info" };
}

/** Event types for a category filter (null = every type). */
export function typesForCategory(category: IntegrityCategoryFilter): string[] | null {
  if (category === "all") return null;
  return EVENT_TYPES.filter((t) =>
    category === "review" ? eventMeta(t).category !== "info" : eventMeta(t).category === category
  );
}

const REASON_TEXT: Record<string, string> = {
  not_found: "not found or not theirs",
  not_in_batch: "not in this batch",
  not_enrolled: "not enrolled",
  cancelled: "class or batch cancelled",
  test_not_open: "test not open",
  attempt_limit: "attempt limit reached",
  no_questions: "test has no questions",
  attempt_finished: "attempt already finished",
  deadline: "time limit passed",
  test_closed: "test closed",
  class_cancelled: "class cancelled",
  batch_cancelled: "batch cancelled",
  withdrawn: "student withdrawn",
  enrollment_ended: "enrolment ended",
  invalid_question: "question not in this attempt",
  invalid_options: "answer not valid for the question",
  invalid_request: "invalid request",
  student_submit: "submitted by the student",
};

const OPERATION_TEXT: Record<string, string> = {
  paper: "opening the test",
  save: "saving an answer",
  submit: "submitting",
  result: "viewing a result",
  client_event: "a browser activity report",
};

const RULE_TEXT: Record<string, string> = {
  answer_saves_per_minute: "More than 120 answer saves within a minute",
  repeated_start: "Test reopened 10 times within a minute",
  audit_throttle: "Audit rate limit reached; further entries of this kind were summarised",
  audit_throttle_hourly: "Hourly audit limit reached; further routine entries were summarised",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** The privacy-safe facts shown for one stored event. */
export function summarizeEventDetail(type: string, detail: unknown): IntegrityEventFact[] {
  const d = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const facts: IntegrityEventFact[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) facts.push({ label, value });
  };

  if (isReportedClientEventKind(type) || type === "client_fullscreen_exit") {
    add("Source", "Reported by the browser");
    if (isReportedClientEventKind(type)) {
      const c = sanitizeClientEventDetail(type, d.client);
      if (c.phase === "hidden") add("State", "Page hidden");
      if (c.phase === "visible") add("State", c.hiddenSeconds !== undefined ? `Returned after about ${formatSeconds(c.hiddenSeconds)}` : "Returned");
      if (c.cut) add("Action", "Cut");
      if (c.otherTabs !== undefined) add("Other tabs", String(c.otherTabs));
    }
    return facts;
  }

  const reason = text(d.reason);
  if (reason) add("Reason", REASON_TEXT[reason] ?? reason.replace(/_/g, " "));
  const operation = text(d.operation);
  if (operation) add("During", OPERATION_TEXT[operation] ?? operation.replace(/_/g, " "));

  if (type === "concurrent_session") add("Detail", "Used from a different sign-in session than the one that started the attempt");
  if (type === "suspicious_repeated_access") {
    const rule = text(d.rule);
    if (rule) add("Rule", RULE_TEXT[rule] ?? rule.replace(/_/g, " "));
    const throttled = text(d.throttled_event);
    if (throttled) add("Entries", eventMeta(throttled).label);
    const perMinute = count(d.count_per_minute) ?? count(d.limit_per_minute);
    if (perMinute !== null) add("Per minute", String(perMinute));
    const perHour = count(d.limit_per_hour);
    if (perHour !== null) add("Per hour", String(perHour));
  }
  if (type === "attempt_started") {
    const n = count(d.attempt_number);
    if (n !== null) add("Attempt", String(n));
  }
  return facts;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ------------------------------------------------------------------ filters (from the URL)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_FILTERS = new Set<IntegrityCategoryFilter>(["review", "server", "browser", "info", "all"]);

function first(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function uuid(value: unknown): string | null {
  const v = first(value);
  return v && UUID.test(v) ? v.toLowerCase() : null;
}
function day(value: unknown): string | null {
  const v = first(value);
  if (!v || !DAY.test(v)) return null;
  return Number.isNaN(new Date(`${v}T00:00:00+05:30`).getTime()) ? null : v;
}

/** Parse untrusted URL search params into well-formed filters (anything malformed is ignored). */
export function parseMonitoringFilters(params: Record<string, string | string[] | undefined>): ExamMonitoringFilters {
  const type = first(params.type);
  const category = first(params.category) as IntegrityCategoryFilter | null;
  return {
    batchId: uuid(params.batch),
    testId: uuid(params.test),
    studentId: uuid(params.student),
    attemptId: uuid(params.attempt),
    eventType: type && EVENT_META[type] ? type : null,
    category: category && CATEGORY_FILTERS.has(category) ? category : "review",
    from: day(params.from),
    to: day(params.to),
  };
}

/** Start of `from` and end of `to` (India time) as ISO instants. */
export function dayRange(filters: Pick<ExamMonitoringFilters, "from" | "to">): { fromIso: string | null; toIso: string | null } {
  return {
    fromIso: filters.from ? new Date(`${filters.from}T00:00:00+05:30`).toISOString() : null,
    toIso: filters.to ? new Date(new Date(`${filters.to}T00:00:00+05:30`).getTime() + 86_400_000 - 1).toISOString() : null,
  };
}
