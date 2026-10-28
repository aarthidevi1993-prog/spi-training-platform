/**
 * Exam monitoring service — staff review of exam-integrity signals.
 *
 * Identity always comes from getCurrentUser (never a client argument).
 * Super Admin: every batch. Trainer: only batches they CURRENTLY teach
 * (assigned trainer, upcoming/ongoing) — the same rule as the 0009 RLS
 * (is_current_batch_trainer), which still decides every row. Filter ids
 * from the URL are only used after they are found inside that scope; a
 * filter outside it shows nothing instead of being widened.
 *
 * Output is labels, times and short privacy-safe facts: no answers,
 * answer keys, scores, session ids or raw event detail. Nothing is
 * scored or judged here — events are prompts for review.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; exam-monitoring.service.ts wires the real session.
 */
import type { AuthUser } from "@/types/auth";
import type {
  ActiveAttempt,
  AttemptTimeline,
  ExamMonitoringData,
  IntegrityEvent,
  IntegrityEventCategory,
  MonitoredAttempt,
} from "@/types/exam-monitoring";
import {
  EVENT_TYPES,
  dayRange,
  eventMeta,
  parseMonitoringFilters,
  summarizeEventDetail,
  typesForCategory,
} from "@/lib/exam-monitoring/events";
import type {
  ExamMonitoringRepository,
  MonitoringAttemptRecord,
  MonitoringEventRecord,
} from "@/repositories/exam-monitoring.repository.core";

export class ExamMonitoringAuthorizationError extends Error {
  constructor(message = "Only Super Admins and trainers can review exam activity.") {
    super(message);
    this.name = "ExamMonitoringAuthorizationError";
  }
}

export const EVENT_LIMIT = 300;
const ACTIVE_LIMIT = 200;
const REVIEW_TYPES = typesForCategory("review") ?? [];

export interface ExamMonitoringServiceDeps {
  repository: ExamMonitoringRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  now?: () => Date;
}

type SearchParams = Record<string, string | string[] | undefined>;

export function createExamMonitoringService(deps: ExamMonitoringServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const repo = deps.repository;

  async function requireStaff(): Promise<AuthUser & { role: "admin" | "trainer" }> {
    const user = await deps.getCurrentUser();
    if (!user) throw new ExamMonitoringAuthorizationError("You need to be signed in.");
    if (user.role !== "admin" && user.role !== "trainer") throw new ExamMonitoringAuthorizationError();
    return user as AuthUser & { role: "admin" | "trainer" };
  }

  return {
    async getMonitoring(params: SearchParams): Promise<ExamMonitoringData> {
      const user = await requireStaff();
      const isAdmin = user.role === "admin";
      const filters = parseMonitoringFilters(params);
      const generatedAt = now();

      // Scope: what this viewer may monitor.
      const batches = await repo.listBatches(isAdmin ? { kind: "all" } : { kind: "trainer", trainerId: user.id });
      const scopeBatchIds = isAdmin ? null : batches.map((b) => b.id);
      const [tests, students] = await Promise.all([repo.listTests(scopeBatchIds), repo.listStudents(scopeBatchIds)]);
      const batchById = new Map(batches.map((b) => [b.id, b]));
      const testById = new Map(tests.map((t) => [t.id, t]));
      const studentById = new Map(students.map((s) => [s.id, s]));

      const outOfScope =
        (filters.batchId !== null && !batchById.has(filters.batchId)) ||
        (filters.testId !== null && !testById.has(filters.testId)) ||
        (filters.studentId !== null && !studentById.has(filters.studentId));

      const batchLabel = (id: string | null) => {
        const b = id ? batchById.get(id) : undefined;
        return b ? `${b.batch_code} — ${b.name}` : "—";
      };
      const options: ExamMonitoringData["options"] = {
        batches: batches.map((b) => ({ value: b.id, label: `${b.batch_code} — ${b.name}` })),
        tests: tests
          .map((t) => ({ value: t.id, label: `${t.title} (${batchById.get(t.batch_id)?.batch_code ?? "batch"})` }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        students: students
          .map((s) => ({ value: s.id, label: `${s.full_name} (${s.student_code})` }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        eventTypes: EVENT_TYPES.map((t) => ({ value: t, label: eventMeta(t).label, category: eventMeta(t).category })),
      };
      const empty = (): ExamMonitoringData => ({
        role: user.role,
        filters,
        outOfScope,
        options,
        activeAttempts: [],
        timelines: [],
        eventsTruncated: false,
        eventLimit: EVENT_LIMIT,
        generatedAt: generatedAt.toISOString(),
      });

      const queryBatchIds = filters.batchId ? [filters.batchId] : scopeBatchIds;
      if (outOfScope || (queryBatchIds !== null && queryBatchIds.length === 0)) return empty();

      const base = { batchIds: queryBatchIds, testId: filters.testId, studentId: filters.studentId, attemptId: filters.attemptId };
      const categoryTypes = typesForCategory(filters.category);
      const types = filters.eventType
        ? categoryTypes === null || categoryTypes.includes(filters.eventType)
          ? [filters.eventType]
          : []
        : categoryTypes;
      const { fromIso, toIso } = dayRange(filters);

      const [active, eventRows] = await Promise.all([
        repo.listActiveAttempts({ ...base, limit: ACTIVE_LIMIT }),
        types && types.length === 0
          ? Promise.resolve([] as MonitoringEventRecord[])
          : repo.listEvents({ ...base, attemptIds: null, types, fromIso, toIso, limit: EVENT_LIMIT + 1 }),
      ]);
      const eventsTruncated = eventRows.length > EVENT_LIMIT;
      const events = eventRows.slice(0, EVENT_LIMIT);

      // Review-signal counts for the active attempts (independent of the event filters).
      const activeIds = active.map((a) => a.id);
      const reviewRows = activeIds.length
        ? await repo.listEvents({ batchIds: queryBatchIds, testId: null, studentId: null, attemptId: null, attemptIds: activeIds, types: REVIEW_TYPES, fromIso: null, toIso: null, limit: 5000 })
        : [];
      const reviewCount = new Map<string, number>();
      reviewRows.forEach((e) => e.attempt_id && reviewCount.set(e.attempt_id, (reviewCount.get(e.attempt_id) ?? 0) + 1));

      // Attempt headers for the timelines, and names for anything not already in scope lists (super admin only).
      const attemptIds = Array.from(new Set(events.map((e) => e.attempt_id).filter((id): id is string => Boolean(id))));
      const known = new Map<string, MonitoringAttemptRecord>(active.map((a) => [a.id, a]));
      const missing = attemptIds.filter((id) => !known.has(id));
      (await repo.attemptsByIds(missing)).forEach((a) => known.set(a.id, a));
      const unknownStudents = Array.from(
        new Set([...events.map((e) => e.student_id), ...Array.from(known.values()).map((a) => a.student_id)].filter((id): id is string => Boolean(id) && !studentById.has(id as string)))
      );
      (await repo.studentsByIds(unknownStudents)).forEach((s) => studentById.set(s.id, s));

      const describe = (attempt: MonitoringAttemptRecord): MonitoredAttempt => {
        const student = studentById.get(attempt.student_id);
        return {
          attemptId: attempt.id,
          attemptNumber: attempt.attempt_number,
          status: attempt.status,
          studentName: student?.full_name ?? "Student",
          studentCode: student?.student_code ?? null,
          testTitle: testById.get(attempt.test_id)?.title ?? "Test",
          batchLabel: batchLabel(attempt.batch_id),
        };
      };

      const activeAttempts: ActiveAttempt[] = active.map((a) => {
        const until = testById.get(a.test_id)?.available_until ?? null;
        const deadline = until && new Date(until).getTime() < new Date(a.deadline_at).getTime() ? until : a.deadline_at;
        return {
          ...describe(a),
          startedAt: a.started_at,
          effectiveDeadline: new Date(deadline).toISOString(),
          minutesLeft: Math.max(0, Math.floor((new Date(deadline).getTime() - generatedAt.getTime()) / 60_000)),
          reviewSignals: reviewCount.get(a.id) ?? 0,
        };
      });

      const toEvent = (e: MonitoringEventRecord): IntegrityEvent => {
        const meta = eventMeta(e.event_type);
        return { id: Number(e.id), occurredAt: e.occurred_at, type: e.event_type, label: meta.label, category: meta.category, facts: summarizeEventDetail(e.event_type, e.detail) };
      };
      const groups = new Map<string, MonitoringEventRecord[]>();
      for (const e of events) {
        const key = e.attempt_id ?? "none";
        groups.set(key, [...(groups.get(key) ?? []), e]);
      }
      // Most recent activity first; events within an attempt oldest first.
      const timelines: AttemptTimeline[] = Array.from(groups.entries()).map(([key, rows]) => {
        const attempt = key === "none" ? null : known.get(key);
        const ordered = rows.slice().sort((a, b) => Number(a.id) - Number(b.id)).map(toEvent);
        const counts: Record<IntegrityEventCategory, number> = { server: 0, browser: 0, info: 0 };
        ordered.forEach((e) => counts[e.category]++);
        let header: MonitoredAttempt | null = attempt ? describe(attempt) : null;
        if (!header && key !== "none" && rows[0]) {
          const r = rows[0];
          const student = r.student_id ? studentById.get(r.student_id) : undefined;
          header = { attemptId: key, attemptNumber: null, status: null, studentName: student?.full_name ?? "Student", studentCode: student?.student_code ?? null, testTitle: (r.test_id && testById.get(r.test_id)?.title) || "Test", batchLabel: batchLabel(r.batch_id) };
        }
        return { attempt: header, counts, events: ordered };
      });

      return { ...empty(), activeAttempts, timelines, eventsTruncated };
    },
  };
}

export type ExamMonitoringService = ReturnType<typeof createExamMonitoringService>;
