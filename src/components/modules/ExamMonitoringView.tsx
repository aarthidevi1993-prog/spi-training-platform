import Link from "next/link";
import { Activity, Clock, Filter, Info, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { CATEGORY_FILTER_LABEL, CATEGORY_LABEL } from "@/lib/exam-monitoring/events";
import { formatDateTime } from "@/utils/format";
import type {
  ActiveAttempt,
  AttemptTimeline,
  ExamMonitoringData,
  IntegrityCategoryFilter,
  IntegrityEventCategory,
  MonitoredAttempt,
} from "@/types/exam-monitoring";

const CATEGORY_TONE: Record<IntegrityEventCategory, "blue" | "amber" | "neutral"> = {
  server: "blue",
  browser: "amber",
  info: "neutral",
};

const STATUS_LABEL: Record<NonNullable<MonitoredAttempt["status"]>, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  finalized: "Finalized",
};

function timeLeft(a: ActiveAttempt): string {
  if (a.minutesLeft <= 0) return "Time limit reached";
  if (a.minutesLeft < 60) return `${a.minutesLeft} min left`;
  return `${Math.floor(a.minutesLeft / 60)} h ${a.minutesLeft % 60} min left`;
}

function studentLabel(a: MonitoredAttempt): string {
  return a.studentCode ? `${a.studentName} (${a.studentCode})` : a.studentName;
}

/** The page URL with the given filters replaced (others kept). */
function hrefWith(basePath: string, data: ExamMonitoringData, changes: Record<string, string | null>): string {
  const f = data.filters;
  const current: Record<string, string | null> = {
    batch: f.batchId,
    test: f.testId,
    student: f.studentId,
    attempt: f.attemptId,
    type: f.eventType,
    category: f.category === "review" ? null : f.category,
    from: f.from,
    to: f.to,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...current, ...changes })) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function FilterForm({ data, basePath }: { data: ExamMonitoringData; basePath: string }) {
  const f = data.filters;
  const all = (label: string) => [{ value: "", label }];
  return (
    <Card>
      <CardContent>
        <form method="get" action={basePath} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filter exam activity">
          <Select name="batch" label="Batch" defaultValue={f.batchId ?? ""} options={[...all("All batches"), ...data.options.batches]} />
          <Select name="test" label="Test" defaultValue={f.testId ?? ""} options={[...all("All tests"), ...data.options.tests]} />
          <Select name="student" label="Student" defaultValue={f.studentId ?? ""} options={[...all("All students"), ...data.options.students]} />
          <Select
            name="category"
            label="Show"
            defaultValue={f.category}
            options={(Object.keys(CATEGORY_FILTER_LABEL) as IntegrityCategoryFilter[]).map((c) => ({ value: c, label: CATEGORY_FILTER_LABEL[c] }))}
          />
          <Select
            name="type"
            label="Event type"
            defaultValue={f.eventType ?? ""}
            options={[...all("Any event type"), ...data.options.eventTypes.map((t) => ({ value: t.value, label: `${t.label} · ${CATEGORY_LABEL[t.category]}` }))]}
          />
          <Input name="from" type="date" label="From (India time)" defaultValue={f.from ?? ""} />
          <Input name="to" type="date" label="To (India time)" defaultValue={f.to ?? ""} />
          {f.attemptId && <input type="hidden" name="attempt" value={f.attemptId} />}
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm">
              <Filter className="h-3.5 w-3.5" /> Apply
            </Button>
            <Link href={basePath} className="px-2 py-1.5 text-sm text-ink-muted hover:text-ink">
              Clear
            </Link>
          </div>
        </form>
        {f.attemptId && (
          <p className="mt-3 text-xs text-ink-muted">
            Showing one attempt.{" "}
            <Link className="text-signal-blue hover:underline" href={hrefWith(basePath, data, { attempt: null })}>
              Show all attempts
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ActiveAttempts({ data, basePath }: { data: ExamMonitoringData; basePath: string }) {
  return (
    <section aria-labelledby="active-attempts" className="flex flex-col gap-3">
      <h2 id="active-attempts" className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Activity className="h-4 w-4 text-ink-muted" /> Attempts in progress
        <Badge>{data.activeAttempts.length}</Badge>
      </h2>
      {data.activeAttempts.length === 0 ? (
        <EmptyState icon={Clock} title="No attempts in progress" description="Attempts appear here while students are taking a test that matches the filters." className="py-10" />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Student</TableHeaderCell>
              <TableHeaderCell>Test</TableHeaderCell>
              <TableHeaderCell>Batch</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
              <TableHeaderCell>Deadline</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Review signals</TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">Timeline</span>
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.activeAttempts.map((a) => (
              <TableRow key={a.attemptId} data-attempt={a.attemptId}>
                <TableCell>{studentLabel(a)}</TableCell>
                <TableCell>
                  {a.testTitle}
                  {a.attemptNumber !== null && <span className="text-ink-muted"> · Attempt {a.attemptNumber}</span>}
                </TableCell>
                <TableCell className="text-ink-muted">{a.batchLabel}</TableCell>
                <TableCell className="whitespace-nowrap text-ink-muted">{formatDateTime(a.startedAt)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(a.effectiveDeadline)}
                  <span className="block text-2xs text-ink-muted">{timeLeft(a)}</span>
                </TableCell>
                <TableCell>
                  <Badge tone="teal">{STATUS_LABEL.in_progress}</Badge>
                </TableCell>
                <TableCell>{a.reviewSignals > 0 ? <Badge tone="amber">{a.reviewSignals}</Badge> : <span className="text-xs text-ink-faint">0</span>}</TableCell>
                <TableCell>
                  <Link className="text-xs text-signal-blue hover:underline" href={hrefWith(basePath, data, { attempt: a.attemptId })}>
                    Timeline
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function TimelineCard({ timeline, data, basePath }: { timeline: AttemptTimeline; data: ExamMonitoringData; basePath: string }) {
  const a = timeline.attempt;
  return (
    <Card data-timeline={a?.attemptId ?? "none"}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-ink">{a ? studentLabel(a) : "Not linked to an attempt"}</p>
            <p className="text-xs text-ink-muted">
              {a ? (
                <>
                  {a.testTitle}
                  {a.attemptNumber !== null && ` · Attempt ${a.attemptNumber}`} · {a.batchLabel}
                  {a.status && ` · ${STATUS_LABEL[a.status]}`}
                </>
              ) : (
                "Requests that did not match an attempt (for example, an attempt that doesn't exist)."
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["server", "browser", "info"] as IntegrityEventCategory[]).map((c) =>
              timeline.counts[c] > 0 ? (
                <Badge key={c} tone={CATEGORY_TONE[c]}>
                  {CATEGORY_LABEL[c]}: {timeline.counts[c]}
                </Badge>
              ) : null
            )}
            {a && data.filters.attemptId !== a.attemptId && (
              <Link className="ml-1 text-xs text-signal-blue hover:underline" href={hrefWith(basePath, data, { attempt: a.attemptId })}>
                Only this attempt
              </Link>
            )}
          </div>
        </div>
        <ol className="flex flex-col border-l border-surface-border">
          {timeline.events.map((e) => (
            <li key={e.id} className="relative flex flex-col gap-1 py-2 pl-4" data-event-type={e.type} data-category={e.category}>
              <span className="absolute -left-[4.5px] top-3.5 h-2 w-2 rounded-full bg-surface-border" aria-hidden />
              <div className="flex flex-wrap items-center gap-2">
                <time dateTime={e.occurredAt} className="font-mono text-2xs text-ink-muted">
                  {formatDateTime(e.occurredAt)}
                </time>
                <span className="text-sm text-ink">{e.label}</span>
                <Badge tone={CATEGORY_TONE[e.category]}>{CATEGORY_LABEL[e.category]}</Badge>
              </div>
              {e.facts.length > 0 && (
                <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-muted">
                  {e.facts.map((fact) => (
                    <div key={fact.label} className="flex gap-1">
                      <dt className="text-ink-faint">{fact.label}:</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * Staff exam-integrity review. Server rendered from examMonitoringService
 * (RLS-scoped reads); filters are a plain GET form. Everything shown is a
 * prompt for review — there is no score, verdict or automatic action.
 */
export function ExamMonitoringView({ data, basePath }: { data: ExamMonitoringData; basePath: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-3 rounded-md border border-surface-border bg-surface-raised px-4 py-3 text-xs text-ink-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p>
            <span className="font-semibold text-ink">How to read this page.</span> <ShieldCheck className="inline h-3.5 w-3.5 align-text-bottom" />{" "}
            <strong className="font-medium text-ink">Server security events</strong> are recorded by the database itself.{" "}
            <MonitorSmartphone className="inline h-3.5 w-3.5 align-text-bottom" /> <strong className="font-medium text-ink">Browser activity signals</strong> are
            reported by the student&apos;s browser and can have ordinary causes (a class call, a brief network drop).
          </p>
          <p>They are review signals only: nothing here changes an attempt, a score or a result. Times are shown in India time.</p>
          {data.role === "trainer" && <p>You see the batches you currently teach.</p>}
        </div>
      </div>

      <FilterForm data={data} basePath={basePath} />

      {data.outOfScope && (
        <div role="status" className="rounded-md border border-surface-border bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          The selected batch, test or student isn&apos;t in your monitoring scope, so nothing is shown.
        </div>
      )}

      <ActiveAttempts data={data} basePath={basePath} />

      <section aria-labelledby="timelines" className="flex flex-col gap-3">
        <h2 id="timelines" className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldCheck className="h-4 w-4 text-ink-muted" /> Activity timelines
          <span className="text-xs font-normal text-ink-muted">· {CATEGORY_FILTER_LABEL[data.filters.category]}</span>
        </h2>
        {data.eventsTruncated && (
          <p className="text-xs text-ink-muted">Showing the {data.eventLimit} most recent matching events. Narrow the filters to see earlier activity.</p>
        )}
        {data.timelines.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No matching activity" description="No events match these filters. Try a wider date range or show all events." className="py-10" />
        ) : (
          data.timelines.map((t) => <TimelineCard key={t.attempt?.attemptId ?? "none"} timeline={t} data={data} basePath={basePath} />)
        )}
      </section>
    </div>
  );
}
