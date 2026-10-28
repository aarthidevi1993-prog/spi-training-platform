import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AlertTriangle, Inbox, ArrowDown, ArrowRight, ArrowUp, Award, CalendarDays, CalendarPlus, FileQuestion, Layers, Minus, ShieldCheck, UserPlus, Bell, BookOpen, CalendarClock, CalendarRange, FileCheck2, GraduationCap, HeartPulse, LayoutGrid, LineChart, ListChecks, Target, UserCheck, Users, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { formatDateTime } from "@/utils/format";
import {
  BATCH_STATUS_LABEL,
  BATCH_STATUS_ORDER,
  CLASS_TYPE_LABEL,
  TEST_TYPE_LABEL,
  type AdminDashboardData,
  type AttentionItem,
  type DashboardClass,
  type DashboardMetrics,
  type DashboardPeriod,
  type DashboardSection,
  type DashboardTest,
  type HealthKey,
  type HealthLine,
  type TrainingOverview,
  HEALTH_LABEL,
} from "@/lib/dashboard/admin-dashboard";
import { PERIOD_KEYS, PERIOD_LABEL, type Comparison } from "@/lib/dashboard/periods";
import {
  TOPIC_BAND_LABEL,
  formatDateRange,
  formatPercent,
  formatPoints,
  type AnalyticsPeriod,
  type DashboardAnalyticsResult,
  type EvidenceFigure,
  type FigureChange,
  type RateComparison,
  type StudentPerformanceRow,
  type CourseProgressRow,
  ATTENDANCE_DEFINITION_NOTE,
} from "@/lib/dashboard/analytics";

/**
 * Super Admin dashboard (D1). A server component that only renders the
 * dashboard service's read model: database counts, bounded lists and the
 * existing performance / notification services. No mock data, no
 * invented trends, no mutations — every action is a link to an existing
 * workflow. Each section shows its own empty or error state.
 */

/** A calendar date (YYYY-MM-DD) as text, independent of the server's time zone. */
function calendarDate(isoDate: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "short" }): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }).format(d);
}


function Panel({ id, title, description, action, icon: Icon, children, className }: { id: string; title: string; description?: string; action?: { href: string; label: string }; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={className}>
      <Card className="flex h-full flex-col">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-surface-border px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {Icon && (
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-600" aria-hidden="true">
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              <h2 id={id} className="text-sm font-semibold text-ink">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
            </div>
          </div>
          {action && (
            <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 pt-1 text-xs font-medium text-signal-blue hover:underline">
              {action.label} <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
        <CardContent className="flex-1 px-4 py-3">{children}</CardContent>
      </Card>
    </section>
  );
}

/** Compact section error (same visual language as the compact empty state); the page-level error stays in page.tsx. */
function SectionError() {
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-signal-redSoft px-3 py-2.5">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Unable to load this section.</p>
        <p className="text-xs text-ink-muted">Refresh to retry.</p>
      </div>
    </div>
  );
}

/** D2b-2F: a small empty state (icon, short title, one line of explanation) instead of a large empty box. */
function Compact({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-surface-sunken px-3 py-2.5">
      <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- key metrics

type MetricKey = Exclude<keyof DashboardMetrics, "comparisons">;

/** KPI icon tiles — theme tokens only; decorative (the label and the value carry the meaning). */
const METRIC_ICON: Record<MetricKey, { icon: LucideIcon; tile: string }> = {
  activeStudents: { icon: Users, tile: "bg-primary-50 text-primary-600" },
  activeTrainers: { icon: UserCheck, tile: "bg-signal-blueSoft text-signal-blue" },
  ongoingBatches: { icon: Layers, tile: "bg-brand-goldSoft text-signal-amber" },
  upcomingBatches: { icon: CalendarRange, tile: "bg-signal-tealSoft text-signal-teal" },
  classesToday: { icon: CalendarDays, tile: "bg-signal-blueSoft text-signal-blue" },
  completionsAwaitingApproval: { icon: Award, tile: "bg-brand-goldSoft text-signal-amber" },
};

const METRICS: { key: MetricKey; label: string; note?: string; href: string; linkText: string }[] = [
  { key: "activeStudents", label: "Active students", note: "Can sign in", href: "/admin/users?role=student&status=active", linkText: "View active student accounts" },
  { key: "activeTrainers", label: "Active trainers", note: "Can sign in", href: "/admin/users?role=trainer&status=active", linkText: "View active trainer accounts" },
  { key: "ongoingBatches", label: "Ongoing batches", href: "/admin/batches", linkText: "View batches" },
  { key: "upcomingBatches", label: "Upcoming batches", href: "/admin/batches", linkText: "View batches" },
  { key: "classesToday", label: "Classes today", note: "Not cancelled, India time", href: "/admin/classes", linkText: "View classes" },
  { key: "completionsAwaitingApproval", label: "Awaiting approval", note: "Completion recommendations", href: "/admin/certificates", linkText: "Review completions" },
];

/** "↑ 2 (+50%) vs same day last week" in words, for screen readers and the link label. */
function comparisonText(c: Comparison): string {
  if (c.direction === "same") return `No change ${c.label} (${c.previous})`;
  const change = `${c.direction === "up" ? "Up" : "Down"} ${Math.abs(c.difference)}`;
  return `${change}${c.percent !== null ? ` (${c.percent > 0 ? "+" : ""}${c.percent}%)` : ""} ${c.label} (${c.previous})`;
}

/** A real comparison: arrow + difference (+ % only when the previous value is above 0) + what it compares against. */
function ComparisonLine({ cmp }: { cmp: Comparison }) {
  const Icon = cmp.direction === "up" ? ArrowUp : cmp.direction === "down" ? ArrowDown : Minus;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-1 text-2xs text-ink-muted" title={comparisonText(cmp)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="font-mono">
        {cmp.direction === "same" ? "0" : `${cmp.difference > 0 ? "+" : "−"}${Math.abs(cmp.difference)}`}
        {cmp.percent !== null && cmp.direction !== "same" ? ` (${cmp.percent > 0 ? "+" : ""}${cmp.percent}%)` : ""}
      </span>
      <span className="text-ink-faint">{cmp.label}</span>
    </span>
  );
}

function Metrics({ section }: { section: DashboardSection<DashboardMetrics> }) {
  if (section.status === "error") {
    return (
      <section aria-labelledby="dash-metrics">
        <h2 id="dash-metrics" className="sr-only">
          Key metrics
        </h2>
        <SectionError />
      </section>
    );
  }
  return (
    <section aria-labelledby="dash-metrics">
      <h2 id="dash-metrics" className="sr-only">
        Key metrics
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {METRICS.map((m) => {
          const cmp = m.key === "classesToday" || m.key === "completionsAwaitingApproval" ? section.data.comparisons[m.key] : null;
          const { icon: Icon, tile } = METRIC_ICON[m.key];
          return (
          <li key={m.key}>
            <Link
              href={m.href}
              aria-label={`${m.label}: ${section.data[m.key]}.${cmp ? ` ${comparisonText(cmp)}.` : ""} ${m.linkText}`}
              className="flex h-full flex-col rounded-md border border-surface-border bg-surface-raised p-3 shadow-panel transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
            >
              <span className="flex min-h-8 items-start gap-2">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${tile}`} aria-hidden="true">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 pt-0.5 text-xs font-medium leading-tight text-ink-muted">{m.label}</span>
              </span>
              <span className="mt-2 block text-kpi text-ink">{section.data[m.key]}</span>
              {cmp ? <ComparisonLine cmp={cmp} /> : m.note && <span className="mt-1 block text-2xs text-ink-faint">{m.note}</span>}
            </Link>
          </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- attention required

/** Shorter on-screen wording for an item whose read-model reason restates its title. */
const ATTENTION_REASON: Partial<Record<AttentionItem["key"], string>> = { missing_records: "Role has no matching record." };

function Attention({ section }: { section: DashboardSection<AttentionItem[]> }) {
  if (section.status === "ok" && section.data.length === 0) return null; // nothing needs attention → no section
  return (
    <section aria-labelledby="dash-attention">
      <Card className="border-brand-gold/40 bg-brand-goldSoft/30">
        <div className="flex items-center gap-2 px-4 pt-2.5">
          <AlertTriangle className="h-4 w-4 text-signal-amber" aria-hidden />
          <h2 id="dash-attention" className="text-sm font-semibold text-signal-amber">
            Attention required
          </h2>
        </div>
        <CardContent className="px-4 pb-3 pt-2.5">
          {section.status === "error" ? (
            <SectionError />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {section.data.map((item) => (
                <li key={item.key} className="flex flex-col rounded-md border border-surface-border bg-surface-raised px-3 py-2.5">
                  <div className="flex items-start gap-3">
                    <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-brand-goldSoft px-1.5 font-mono text-sm font-semibold text-ink">{item.count}</span>
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-ink">{item.title}</p>
                      <p className="mt-0.5 text-xs text-ink-muted">{ATTENTION_REASON[item.key] ?? item.reason}</p>
                    </div>
                  </div>
                  <Link href={item.href} className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-signal-blue hover:underline">
                    {item.linkLabel} <ArrowRight className="h-3 w-3" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------- classes and tests

function ClassList({ classes, showDate }: { classes: DashboardClass[]; showDate: boolean }) {
  return (
    <ul className="divide-y divide-surface-border">
      {classes.map((c) => (
        <li key={c.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="font-mono text-xs text-ink-muted">
              {showDate ? `${calendarDate(c.date)} · ` : ""}
              {c.startTime}
              {c.endTime ? `–${c.endTime}` : ""}
            </p>
            <Link href={`/admin/classes/${encodeURIComponent(c.id)}`} className="block truncate text-sm font-medium text-ink hover:underline">
              {c.title}
            </Link>
            <p className="truncate text-xs text-ink-muted">
              {c.batchName || "—"}
              {CLASS_TYPE_LABEL[c.classType] ? ` · ${CLASS_TYPE_LABEL[c.classType]}` : ""}
            </p>
          </div>
          <StatusBadge status={c.status} className="shrink-0" />
        </li>
      ))}
    </ul>
  );
}

function TodayClasses({ section, today }: { section: AdminDashboardData["todayClasses"]; today: string }) {
  return (
    <Panel id="dash-today" icon={CalendarDays} title="Today's classes" description={calendarDate(today, { weekday: "long", day: "2-digit", month: "short" })} action={{ href: "/admin/classes", label: "View all classes" }}>
      {section.status === "error" ? (
        <SectionError />
      ) : section.data.classes.length === 0 ? (
        <Compact title="No classes today" />
      ) : (
        <>
          <ClassList classes={section.data.classes} showDate={false} />
          {section.data.total > section.data.classes.length && (
            <p className="mt-3 text-xs text-ink-muted">
              Showing {section.data.classes.length} of {section.data.total} classes today.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function UpcomingClasses({ section }: { section: AdminDashboardData["upcomingClasses"] }) {
  return (
    <Panel id="dash-upcoming-classes" icon={CalendarClock} title="Upcoming classes" description="Next scheduled, after today" action={{ href: "/admin/classes", label: "View all classes" }}>
      {section.status === "error" ? (
        <SectionError />
      ) : section.data.length === 0 ? (
        <Compact title="No upcoming classes" />
      ) : (
        <ClassList classes={section.data} showDate />
      )}
    </Panel>
  );
}

function testWindow(t: DashboardTest): string {
  if (t.state === "open") return t.availableUntil ? `Closes ${formatDateTime(t.availableUntil)}` : "Open";
  return t.availableFrom ? `Opens ${formatDateTime(t.availableFrom)}` : "Scheduled";
}

function UpcomingTests({ section }: { section: AdminDashboardData["upcomingTests"] }) {
  return (
    <Panel id="dash-tests" icon={FileCheck2} title="Upcoming tests" description="Open or opening soon" action={{ href: "/admin/tests", label: "View all tests" }}>
      {section.status === "error" ? (
        <SectionError />
      ) : section.data.length === 0 ? (
        <Compact title="No upcoming tests" />
      ) : (
        <ul className="divide-y divide-surface-border">
          {section.data.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <Link href={`/admin/tests/${encodeURIComponent(t.id)}`} className="block truncate text-sm font-medium text-ink hover:underline">
                  {t.title}
                </Link>
                <p className="truncate text-xs text-ink-muted">
                  {t.batchName || "—"}
                  {TEST_TYPE_LABEL[t.testType] ? ` · ${TEST_TYPE_LABEL[t.testType]}` : ""}
                </p>
                <p className="font-mono text-xs text-ink-faint">{testWindow(t)}</p>
              </div>
              <Badge tone={t.state === "open" ? "green" : "blue"} className="shrink-0">
                {t.state === "open" ? "Open" : "Scheduled"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- training overview

function Overview({ section }: { section: DashboardSection<TrainingOverview> }) {
  return (
    <Panel id="dash-overview" icon={LayoutGrid} title="Training overview" description="Batches by status">
      {section.status === "error" ? (
        <SectionError />
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-4 divide-x divide-surface-border rounded-md border border-surface-border">
            {BATCH_STATUS_ORDER.map((s) => (
              <div key={s} className="flex min-w-0 flex-col-reverse px-0.5 py-1.5 text-center">
                <dt className="break-words text-2xs text-ink-muted">{BATCH_STATUS_LABEL[s]}</dt>
                <dd className="font-mono text-base font-semibold text-ink">{section.data.batches[s]}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Courses with current batches</h3>
            {section.data.courses.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">No course has an upcoming or ongoing batch.</p>
            ) : (
              <>
                <ul className="mt-1 divide-y divide-surface-border">
                  {section.data.courses.map((c) => (
                    <li key={c.courseId} className="flex items-center justify-between gap-3 py-1 text-xs">
                      <span className="min-w-0 break-words text-ink">{c.course}</span>
                      <span className="shrink-0 font-mono text-xs text-ink-muted">
                        {c.currentBatches} {c.currentBatches === 1 ? "batch" : "batches"}
                      </span>
                    </li>
                  ))}
                </ul>
                {section.data.coursesWithCurrentBatches > section.data.courses.length && (
                  <p className="mt-2 text-xs text-ink-muted">
                    Showing {section.data.courses.length} of {section.data.coursesWithCurrentBatches} courses.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- analytics panels (D2b-2A: period-based, streamed)

/** A placeholder with the panel's heading while the analytics load (this panel only). */
function PanelLoading({ id, title, className }: { id: string; title: string; className?: string }) {
  return (
    <Panel id={id} title={title} className={className}>
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading {title.toLowerCase()}…</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-3 h-24 w-full" />
        <Skeleton className="mt-3 h-4 w-1/2" />
      </div>
    </Panel>
  );
}

/** An analytics panel whose data could not be loaded — the same compact message as any other section. */
function AnalyticsUnavailable() {
  return <SectionError />;
}

const periodText = (p: AnalyticsPeriod) => `${p.label} · ${p.rangeText} vs ${p.prevRangeText}`;
/** Panel subtitle: the period only — the exact dates are shown once, in the page header. */
const periodShort = (p: AnalyticsPeriod) => `${p.label} vs previous period`;

/** The change in pp (arrow + value); the previous figure is read out to screen readers, not repeated on screen. */
function ComparisonText({ c }: { c: RateComparison }) {
  if (c.state === "no_data") return <span className="text-ink-faint">No data</span>;
  if (c.state === "no_comparison") return <span className="text-ink-faint">No comparison</span>;
  const Icon = c.points === null || c.points === 0 ? Minus : c.points > 0 ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1 text-ink-muted">
      <Icon className="h-3 w-3" aria-hidden />
      <span className="font-mono">{formatPoints(c)}</span>
      <span className="sr-only">vs {formatPercent(c.previous)} before</span>
    </span>
  );
}

/** "1 released result" / "4 released results" — the nouns from the read model are plural. */
const countText = (n: number, pluralNoun: string) => `${n} ${n === 1 ? pluralNoun.replace(/s$/, "") : pluralNoun}`;

async function PerformancePanel({ analytics, className }: { analytics: Promise<DashboardAnalyticsResult>; className?: string }) {
  const { panels } = await analytics;
  return (
    <Panel
      id="dash-performance" icon={LineChart}
      title="Training performance"
      description={panels.status === "ok" ? periodShort(panels.data.period) : undefined}
      action={{ href: "/admin/performance", label: "View detailed performance" }}
      className={className}
    >
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : !panels.data.hasActivity ? (
        <Compact
          title="No activity in this period"
          description="No test results, attendance or scored assignments this period."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {panels.data.performance.map((m) => (
              <div key={m.key} className="rounded-md border border-surface-border px-3 py-2">
                <dt className="text-xs font-medium text-ink-muted">{m.label}</dt>
                <dd className="mt-0.5 font-mono text-2xl font-semibold leading-tight text-ink">{formatPercent(m.comparison.current)}</dd>
                <dd className="mt-1 text-2xs">
                  <ComparisonText c={m.comparison} />
                </dd>
                <dd className="text-2xs text-ink-faint">
                  {countText(m.evidence.current, m.evidenceNoun)}
                </dd>
              </div>
            ))}
          </dl>
          <figure aria-labelledby="dash-trend-caption">
            <figcaption id="dash-trend-caption" className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              {panels.data.period.bucket === "week" ? "Weekly" : "Monthly"} trend · gaps = no data
            </figcaption>
            <div className="mt-2">
              <TrendChart points={panels.data.trend} captionId="dash-trend-caption" />
            </div>
          </figure>
        </div>
      )}
    </Panel>
  );
}

const HEALTH_TONE = { healthy: "green", watch: "amber", attention: "red", no_data: "neutral", unavailable: "neutral" } as const;
/** Decorative scan aid beside each line; the Badge text carries the status. */
const HEALTH_DOT = { healthy: "bg-signal-green", watch: "bg-signal-amber", attention: "bg-signal-red", no_data: "bg-ink-faint", unavailable: "bg-ink-faint" } as const;

/**
 * Short on-screen reasons (D2b-2F follow-up). The status still comes from the read model unchanged; "No data" lines
 * get one plain phrase, and judged lines drop their parenthetical method detail (thresholds, n = …).
 */
const HEALTH_NO_DATA_REASON: Partial<Record<HealthKey, string>> = {
  attendance: "Not enough attendance data.",
  assessment: "Not enough released results.",
  assignments: "Not enough scored submissions.",
  students: "Not enough attendance per student.",
};
function healthReason(h: HealthLine): string {
  if (h.status === "no_data" && HEALTH_NO_DATA_REASON[h.key]) return HEALTH_NO_DATA_REASON[h.key] as string;
  return h.reason.replace(/\s*\([^)]*\)/g, "");
}

/**
 * "No data" (or "Unavailable") lines collapse into one row — "No data: Attendance, Assessment, Students" — instead of
 * one row each. Every indicator stays named on screen; its short reason is read out to screen readers.
 */
function HealthGroup({ status, lines, note }: { status: "no_data" | "unavailable"; lines: HealthLine[]; note?: string }) {
  const group = lines.filter((h) => h.status === status);
  if (group.length === 0) return null;
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <p className="flex min-w-0 items-start gap-2 text-sm text-ink">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[status]}`} aria-hidden="true" />
        <span className="min-w-0">
          <span className="font-medium">{HEALTH_LABEL[status]}:</span>{" "}
          {group.map((h, i) => (
            <span key={h.key}>
              {i > 0 && ", "}
              {h.label}
              {!note && <span className="sr-only"> ({healthReason(h).replace(/\.$/, "")})</span>}
            </span>
          ))}
        </span>
      </p>
      {note && <p className="mt-0.5 pl-4 text-xs text-ink-muted">{note}</p>}
    </li>
  );
}

async function TrainingHealthPanel({ analytics, className }: { analytics: Promise<DashboardAnalyticsResult>; className?: string }) {
  const { health } = await analytics;
  return (
    <Panel id="dash-health" icon={HeartPulse} title="Training health" className={className}>
      {health.status === "error" ? (
        <SectionError />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2">
            <span className="text-sm font-medium text-ink">
              Overall: {health.data.overall.status === "no_data" ? "No data" : HEALTH_LABEL[health.data.overall.status]}
              {health.data.overall.drivers.length > 0 && <span className="font-normal text-ink-muted"> — {health.data.overall.drivers.join(", ")}</span>}
            </span>
            <span className="text-2xs text-ink-faint">
              Based on {health.data.overall.basedOn} of {health.data.overall.total} indicators
            </span>
          </div>
          <ul className="divide-y divide-surface-border">
            {health.data.lines.filter((h) => h.status !== "no_data" && h.status !== "unavailable").map((h) => (
              <li key={h.key} className="py-2 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[h.status]}`} aria-hidden="true" />
                    {h.label}
                  </span>
                  <Badge tone={HEALTH_TONE[h.status]}>{HEALTH_LABEL[h.status]}</Badge>
                </div>
                <p className="mt-0.5 pl-4 text-xs text-ink-muted">{healthReason(h)}</p>
                {(h.status === "watch" || h.status === "attention") && (
                  <Link href={h.href} className="ml-4 mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-signal-blue hover:underline">
                    {h.linkLabel} <ArrowRight className="h-3 w-3" aria-hidden />
                  </Link>
                )}
              </li>
            ))}
            <HealthGroup status="no_data" lines={health.data.lines} />
            <HealthGroup status="unavailable" lines={health.data.lines} note="Unable to load this section. Refresh to retry." />
          </ul>
        </>
      )}
    </Panel>
  );
}

const BAND_TONE = { healthy: "green", watch: "amber", attention: "red" } as const;
const BAND_BAR = { healthy: "bg-signal-green", watch: "bg-signal-amber", attention: "bg-signal-red" } as const;

async function WeakTopicsPanel({ analytics, className }: { analytics: Promise<DashboardAnalyticsResult>; className?: string }) {
  const { panels } = await analytics;
  return (
    <Panel
      id="dash-topics" icon={Target}
      title="Weak Topics"
      description={panels.status === "ok" ? panels.data.period.label : undefined}
      action={{ href: "/admin/performance", label: "View module performance" }}
      className={className}
    >
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : panels.data.topics.length === 0 ? (
        <Compact title="Not enough data yet" description="Not enough graded answers this period." />
      ) : (
        <ul className="flex flex-col gap-3">
          {panels.data.topics.map((t) => (
            <li key={t.moduleId}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink">{t.title}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs text-ink">{formatPercent(t.percent)}</span>
                  <Badge tone={BAND_TONE[t.band]}>{TOPIC_BAND_LABEL[t.band]}</Badge>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-surface-sunken" aria-hidden="true">
                <div className={`h-full ${BAND_BAR[t.band]}`} style={{ width: `${Math.max(0, Math.min(100, t.percent))}%` }} />
              </div>
              <span className="sr-only">{countText(t.answers, "graded answers")}</span>
            </li>
          ))}
        </ul>
      )}
      {panels.status === "ok" && panels.data.topics.length > 0 && <p className="mt-3 text-2xs text-ink-faint">Healthy ≥ 80% · Watch ≥ 65% · Attention &lt; 65%</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------- course progress (D2b-2D: current state, streamed with the analytics)

/** "—" with a spoken equivalent. */
function NotAvailable() {
  return (
    <span>
      —<span className="sr-only"> not available</span>
    </span>
  );
}

/** One course: delivery progress (primary, with the counts behind it), overdue classes, enrolment completion (secondary). */
function CourseProgressItem({ row }: { row: CourseProgressRow }) {
  const d = row.delivery;
  const e = row.enrolment;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-sm font-medium text-ink">{row.course}</h3>
        <span className="shrink-0 font-mono text-sm font-semibold text-ink">
          <span className="sr-only">Delivery progress: </span>
          {d ? d.percentDisplay : <NotAvailable />}
        </span>
      </div>
      {d && d.percent !== null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-surface-sunken" aria-hidden="true">
          <div className="h-full bg-primary-500" style={{ width: `${Math.max(0, Math.min(100, d.percent))}%` }} />
        </div>
      )}
      <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 text-2xs sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="inline text-ink-muted">Delivered: </dt>
          <dd className="inline text-ink">{d ? `${d.delivered} / ${d.planned} classes` : <NotAvailable />}</dd>
        </div>
        <div className="min-w-0">
          <dt className="inline text-ink-muted">Overdue: </dt>
          <dd className={d && d.overdue > 0 ? "inline font-semibold text-ink" : "inline text-ink"}>{d ? d.overdue : <NotAvailable />}</dd>
        </div>
        <div className="min-w-0">
          <dt className="inline text-ink-muted">Enrolment completion: </dt>
          <dd className="inline text-ink">{e ? `${e.completed} / ${e.active} · ${e.percentDisplay}` : <NotAvailable />}</dd>
        </div>
      </dl>
    </li>
  );
}

async function CourseProgressPanel({ analytics }: { analytics: Promise<DashboardAnalyticsResult> }) {
  const { panels } = await analytics;
  return (
    <Panel id="dash-progress" icon={ListChecks} title="Course Progress" description="Current delivery and enrolment progress" action={{ href: "/admin/courses", label: "View all courses" }}>
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : panels.data.progress.empty ? (
        <Compact title="No course progress yet" description="No upcoming or ongoing batch has planned classes, and no batch has enrolments." />
      ) : (
        <>
          <ul className="divide-y divide-surface-border">
            {panels.data.progress.rows.map((r) => (
              <CourseProgressItem key={r.courseId} row={r} />
            ))}
          </ul>
          {panels.data.progress.deliveryShownText && <p className="mt-3 text-2xs text-ink-faint">{panels.data.progress.deliveryShownText}</p>}
          {panels.data.progress.enrolmentShownText && <p className="mt-1 text-2xs text-ink-faint">{panels.data.progress.enrolmentShownText}</p>}
          <p className="mt-2 text-2xs text-ink-faint">Current state — not affected by the reporting period. Delivery: upcoming and ongoing batches.</p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- student performance (D2b-2C: current ranking from 0027, streamed)

/** Arrow per trend direction — always paired with a text label and the pp value (never colour alone). */
const TREND_ARROW = { up: "↑", down: "↓", neutral: "→", none: "" } as const;
const TREND_TONE = { up: "text-signal-green", down: "text-signal-red", neutral: "text-ink-muted", none: "text-ink-faint" } as const;
const SP_HEAD = "px-2 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted";
/**
 * D2b-2F: the panel is one grid column (≈300–360px) below sm and from lg, too narrow for four columns — there the
 * trend sits under the average in the same row; the separate Trend column shows only where the panel is wide (sm–lg).
 */
const SP_TREND_COLUMN = "hidden sm:table-cell lg:hidden";
const SP_TREND_STACKED = "mt-0.5 block font-sans font-normal sm:hidden lg:block";

function TrendCell({ row }: { row: StudentPerformanceRow }) {
  if (row.trendDirection === "none") return <span className="text-xs text-ink-faint">{row.trendDisplay}</span>;
  return (
    <span className={`inline-flex items-center justify-end gap-1 font-mono text-xs ${TREND_TONE[row.trendDirection]}`}>
      <span aria-hidden="true">{TREND_ARROW[row.trendDirection]}</span>
      <span className="sr-only">{row.directionLabel}:</span>
      <span>{row.trendDisplay}</span>
    </span>
  );
}

/** Shorter on-screen caption; same facts as the read model's caption (ranking window 366 days, trend vs the previous period). */
const STUDENT_CAPTION = "Ranked over the last 366 days · trend vs previous period";

async function StudentPerformancePanel({ analytics }: { analytics: Promise<DashboardAnalyticsResult> }) {
  const { panels } = await analytics;
  return (
    <Panel id="dash-students" icon={GraduationCap} title="Student Performance (Top 5)" action={{ href: "/admin/performance", label: "View detailed performance" }}>
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : panels.data.students.insufficient ? (
        <Compact title="Insufficient data" description="Needs 3+ released results per student (last 366 days)" />
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">Student Performance (Top 5), by average score</caption>
            <colgroup>
              <col className="w-12" />
              <col />
              <col className="w-28 sm:w-24 lg:w-28" />
              <col className="w-0 sm:w-28 lg:w-0" />
            </colgroup>
            <thead className="border-b border-surface-border bg-surface-sunken">
              <tr>
                <th scope="col" className={SP_HEAD}>Rank</th>
                <th scope="col" className={SP_HEAD}>Student</th>
                <th scope="col" className={`${SP_HEAD} text-right`}>
                  Average score<span className="sm:hidden lg:inline"> / Trend</span>
                </th>
                <th scope="col" className={`${SP_HEAD} text-right ${SP_TREND_COLUMN}`}>Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {panels.data.students.rows.map((s) => (
                <tr key={s.id}>
                  <td className="px-2 py-2 align-top">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm border border-surface-border bg-surface-sunken font-mono text-2xs font-semibold text-ink">{s.rank}</span>
                  </td>
                  <td className="min-w-0 px-2 py-2 align-top">
                    <span className="block break-words font-medium text-ink">{s.name}</span>
                    {s.code && <span className="block break-words font-mono text-2xs text-ink-faint">{s.code}</span>}
                  </td>
                  <td className="px-2 py-2 text-right align-top font-mono text-sm font-semibold text-ink">
                    {s.averageDisplay}
                    <span className={SP_TREND_STACKED}>
                      <TrendCell row={s} />
                    </span>
                  </td>
                  <td className={`px-2 py-2 text-right align-top ${SP_TREND_COLUMN}`}>
                    <TrendCell row={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-2xs text-ink-faint">{STUDENT_CAPTION}</p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- batch / course comparison (D2b-2B: period-based, streamed)

/** pp change only where 0024 has a previous figure (never 0 pp); a missing comparison is read out, not printed in every cell. */
function ChangeText({ change }: { change: FigureChange }) {
  if (change.comparison.state !== "change") return <span className="sr-only">No comparison data</span>;
  return (
    <span>
      <ComparisonText c={change.comparison} />
      <span className="sr-only"> · {countText(change.previousEvidence, "records")} before</span>
    </span>
  );
}

/**
 * D2b-2F compact comparison tables: a real table from 900px; below that each row stacks into label / value pairs
 * (the label comes from data-label), so nothing scrolls sideways. 900px, not md: from 768px the sidebar takes
 * ~256px and the single-column panel (~450–560px) is narrower than the six-column batch table.
 */
const CMP_TABLE = "block w-full border-collapse text-sm min-[900px]:table";
const CMP_HEAD = "px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted";
const CMP_ROW = "block border-b border-surface-border py-2 last:border-b-0 min-[900px]:table-row min-[900px]:py-0";
const CMP_NAME = "block pb-1 min-[900px]:table-cell min-[900px]:px-2 min-[900px]:py-2 min-[900px]:align-top";
const CMP_FIGURE =
  "flex items-baseline justify-between gap-3 py-0.5 before:text-2xs before:text-ink-muted before:content-[attr(data-label)] min-[900px]:table-cell min-[900px]:px-2 min-[900px]:py-2 min-[900px]:text-right min-[900px]:align-top min-[900px]:before:content-none";

/**
 * One figure: the value and its change when there is one. Insufficient data shows "—" (the read model's
 * "Insufficient data (n)" and the record count are read out to screen readers, not printed in every cell).
 */
function FigureCell({ label, figure, noun, change }: { label: string; figure: EvidenceFigure; noun: string; change?: FigureChange }) {
  if (figure.value === null) {
    return (
      <td data-label={label} className={CMP_FIGURE}>
        <span className="text-right font-mono text-sm text-ink-faint">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Insufficient data, {countText(figure.evidence, noun)}</span>
        </span>
      </td>
    );
  }
  return (
    <td data-label={label} className={CMP_FIGURE}>
      <span className="min-w-0 text-right">
        <span className="block font-mono text-sm font-semibold text-ink">{figure.display}</span>
        <span className="sr-only">{countText(figure.evidence, noun)}</span>
        {change && (
          <span className="block text-2xs">
            <ChangeText change={change} />
          </span>
        )}
      </span>
    </td>
  );
}

function ShownText({ text, order }: { text: string | null; order: "name" | "title" }) {
  return text ? <p className="mt-2 text-2xs text-ink-faint">{text} · listed by {order}</p> : null;
}

const EVIDENCE_NOTE = "— = not enough data this period.";

async function BatchComparisonPanel({ analytics, className }: { analytics: Promise<DashboardAnalyticsResult>; className?: string }) {
  const { panels } = await analytics;
  return (
    <Panel
      id="dash-batches" icon={Layers}
      title="Batch comparison"
      description={panels.status === "ok" ? periodShort(panels.data.period) : undefined}
      action={{ href: "/admin/batches", label: "View all batches" }}
      className={className}
    >
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : panels.data.batches.rows.length === 0 ? (
        <Compact title="No batch activity in this period" description="No results, attendance or assignments this period." />
      ) : (
        <>
          <table className={CMP_TABLE}>
            <caption className="sr-only">Batch comparison, {periodText(panels.data.period)}</caption>
            <thead className="hidden border-b border-surface-border bg-surface-sunken min-[900px]:table-header-group">
              <tr>
                <th scope="col" className={`${CMP_HEAD} text-left`}>Batch</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Test average</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Pass rate</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Attendance</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Assignment average</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Completion (current)</th>
              </tr>
            </thead>
            <tbody className="block divide-surface-border min-[900px]:table-row-group min-[900px]:divide-y">
              {panels.data.batches.rows.map((b) => (
                <tr key={b.id} className={CMP_ROW}>
                  <td className={CMP_NAME}>
                    <Link href={b.href} className="break-words text-sm font-medium text-ink hover:underline">
                      {b.name}
                    </Link>
                    <span className="block break-words text-2xs text-ink-faint">
                      {b.code !== b.name && (
                        <>
                          <span className="font-mono">{b.code}</span> ·{" "}
                        </>
                      )}
                      {b.course} · {countText(b.students, "students")} enrolled (current)
                    </span>
                    <Link href={b.performanceHref} className="inline-flex items-center gap-1 text-2xs font-medium text-signal-blue hover:underline">
                      View performance<span className="sr-only"> of {b.name}</span> <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </td>
                  <FigureCell label="Test average" figure={b.testAvg} noun="released results" change={b.testAvgChange} />
                  <FigureCell label="Pass rate" figure={b.passRate} noun="released results" />
                  <FigureCell label="Attendance" figure={b.attendance} noun="attendance records" change={b.attendanceChange} />
                  <FigureCell label="Assignment average" figure={b.assignmentAvg} noun="scored submissions" />
                  <td data-label="Completion (current)" className={CMP_FIGURE}>
                    <span className="font-mono text-sm font-semibold text-ink">{b.completionDisplay}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ShownText text={panels.data.batches.shownText} order="name" />
          <p className="mt-2 text-2xs text-ink-faint">Completion (current) is of enrolments now, not this period. {EVIDENCE_NOTE}</p>
        </>
      )}
    </Panel>
  );
}

async function CourseComparisonPanel({ analytics, className }: { analytics: Promise<DashboardAnalyticsResult>; className?: string }) {
  const { panels } = await analytics;
  return (
    <Panel
      id="dash-courses" icon={BookOpen}
      title="Course comparison"
      description={panels.status === "ok" ? periodShort(panels.data.period) : undefined}
      action={{ href: "/admin/courses", label: "View all courses" }}
      className={className}
    >
      {panels.status === "error" ? (
        <AnalyticsUnavailable />
      ) : panels.data.courses.rows.length === 0 ? (
        <Compact title="No course activity in this period" description="No results, attendance or assignments this period." />
      ) : (
        <>
          <table className={CMP_TABLE}>
            <caption className="sr-only">Course comparison, {periodText(panels.data.period)}</caption>
            <thead className="hidden border-b border-surface-border bg-surface-sunken min-[900px]:table-header-group">
              <tr>
                <th scope="col" className={`${CMP_HEAD} text-left`}>Course</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Test average</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Pass rate</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Attendance</th>
                <th scope="col" className={`${CMP_HEAD} text-right`}>Assignment average</th>
              </tr>
            </thead>
            <tbody className="block divide-surface-border min-[900px]:table-row-group min-[900px]:divide-y">
              {panels.data.courses.rows.map((c) => (
                <tr key={c.id} className={CMP_ROW}>
                  <td className={CMP_NAME}>
                    <Link href={c.href} className="break-words text-sm font-medium text-ink hover:underline">
                      {c.title}
                    </Link>
                    <span className="block font-mono text-2xs text-ink-faint">{c.code}</span>
                  </td>
                  <FigureCell label="Test average" figure={c.testAvg} noun="released results" change={c.testAvgChange} />
                  <FigureCell label="Pass rate" figure={c.passRate} noun="released results" />
                  <FigureCell label="Attendance" figure={c.attendance} noun="attendance records" />
                  <FigureCell label="Assignment average" figure={c.assignmentAvg} noun="scored submissions" />
                </tr>
              ))}
            </tbody>
          </table>
          <ShownText text={panels.data.courses.shownText} order="title" />
          <p className="mt-2 text-2xs text-ink-faint">{EVIDENCE_NOTE}</p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- pending approvals (completion recommendations)

function PendingApprovalsPanel({ section, className }: { section: AdminDashboardData["approvals"]; className?: string }) {
  return (
    <Panel
      id="dash-approvals" icon={Award}
      title="Pending completion approvals"
      description="Trainer completion recommendations"
      action={{ href: "/admin/certificates", label: "Review all completions" }}
      className={className}
    >
      {section.status === "error" ? (
        <SectionError />
      ) : section.data.batches.length === 0 ? (
        <Compact title="Nothing awaiting approval" />
      ) : (
        <>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Batch</TableHeaderCell>
                <TableHeaderCell>Course</TableHeaderCell>
                <TableHeaderCell>Trainer</TableHeaderCell>
                <TableHeaderCell className="text-right">Awaiting approval</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  <span className="sr-only">Action</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {section.data.batches.map((b) => (
                <TableRow key={b.batchId}>
                  <TableCell>
                    <span className="block font-medium text-ink">{b.batchName}</span>
                    <span className="block font-mono text-2xs text-ink-muted">{b.batchCode}</span>
                  </TableCell>
                  <TableCell className="text-ink-muted">{b.course || "—"}</TableCell>
                  <TableCell className="text-ink-muted">{b.trainerName ?? "Trainer not assigned"}</TableCell>
                  <TableCell className="text-right font-mono">{b.recommended}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/certificates/${encodeURIComponent(b.batchId)}`} className="whitespace-nowrap text-xs font-medium text-signal-blue hover:underline">
                      Review {b.batchName}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {section.data.batchesWithPending > section.data.batches.length && (
            <p className="mt-3 text-xs text-ink-muted">
              Showing {section.data.batches.length} of {section.data.batchesWithPending} batches with pending recommendations.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- recent activity

function Activity({ section, className }: { section: AdminDashboardData["activity"]; className?: string }) {
  return (
    <Panel
      id="dash-activity" icon={Bell}
      title="Recent activity"
      description={section.status === "ok" && section.data.unreadCount > 0 ? `${section.data.unreadCount} unread notifications` : "Your latest notifications"}
      action={{ href: "/admin/notifications", label: "View all notifications" }}
      className={className}
    >
      {section.status === "error" ? (
        <SectionError />
      ) : section.data.items.length === 0 ? (
        <Compact title="No recent activity" description="Your notifications appear here." />
      ) : (
        <ul className="divide-y divide-surface-border">
          {section.data.items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                {n.link ? (
                  <Link href={n.link} className="line-clamp-2 break-words text-sm font-medium text-ink hover:underline">
                    {n.title}
                  </Link>
                ) : (
                  <p className="line-clamp-2 break-words text-sm font-medium text-ink">{n.title}</p>
                )}
                {n.body && <p className="line-clamp-1 break-words text-xs text-ink-muted">{n.body}</p>}
                <p className="font-mono text-2xs text-ink-faint">{formatDateTime(n.createdAt)}</p>
              </div>
              {n.unread && (
                <Badge tone="blue" className="shrink-0">
                  Unread
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- quick actions (links to existing workflows only)

const QUICK_ACTIONS = [
  { href: "/admin/users", label: "Invite user", icon: UserPlus },
  { href: "/admin/batches/new", label: "Create batch", icon: Layers },
  { href: "/admin/classes", label: "Classes", icon: CalendarDays },
  { href: "/admin/classes/new", label: "Schedule class", icon: CalendarPlus },
  { href: "/admin/tests", label: "Tests", icon: FileQuestion },
  { href: "/admin/exam-monitoring", label: "Exam monitoring", icon: ShieldCheck },
  { href: "/admin/certificates", label: "Certificates", icon: Award },
] as const;

function QuickActions({ className }: { className?: string }) {
  return (
    <Panel id="dash-actions" icon={Zap} title="Quick actions" className={className}>
      <ul className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="flex h-full items-center gap-2 rounded-md border border-surface-border px-2.5 py-2 hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500">
              <a.icon className="h-3.5 w-3.5 shrink-0 text-primary-500" aria-hidden />
              <span className="min-w-0 break-words text-xs font-medium leading-tight text-ink">{a.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- page

export const DASHBOARD_TITLE = "Training Intelligence & Operations";
export const DASHBOARD_SUBTITLE = "Track performance, manage operations, and ensure successful training outcomes.";

/** Reporting-period selector: plain server links (`?period=`), no client state. */
function PeriodSelector({ period, today }: { period: DashboardPeriod; today: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 xl:items-end">
      <nav aria-label="Reporting period" className="max-w-full">
        <ul className="flex flex-wrap gap-1 rounded-md border border-surface-border bg-surface-raised p-1">
          {PERIOD_KEYS.map((key) => {
            const selected = key === period.key;
            return (
              <li key={key}>
                <Link
                  href={`/admin?period=${key}`}
                  aria-current={selected ? "page" : undefined}
                  className={
                    "block rounded px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 " +
                    (selected ? "bg-primary-500 text-white" : "text-ink-muted hover:bg-surface-sunken hover:text-ink")
                  }
                >
                  {PERIOD_LABEL[key]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="text-2xs text-ink-muted xl:text-right">
        <span className="font-medium text-ink">
          {period.label} · {formatDateRange(period.from, period.to)}
        </span>{" "}
        vs {formatDateRange(period.prevFrom, period.prevTo)} · As of{" "}
        <time dateTime={today}>{calendarDate(today, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</time> · India time
      </p>
    </div>
  );
}

export function AdminDashboard({ data, analytics }: { data: AdminDashboardData; analytics: Promise<DashboardAnalyticsResult> }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <PageHeader title={DASHBOARD_TITLE} description={DASHBOARD_SUBTITLE} className="min-w-0 pb-0" />
        <PeriodSelector period={data.period} today={data.today} />
      </div>
      <Attention section={data.attention} />
      <Metrics section={data.metrics} />
      <p role="note" className="-mt-3 text-2xs text-ink-faint">
        {ATTENDANCE_DEFINITION_NOTE}
      </p>
      {/* D2b-2F rows at xl (3 columns): performance + health · batches + course progress · courses + students ·
          weak topics + overview + quick actions · today + upcoming classes + upcoming tests · activity + approvals.
          grid-flow-row-dense back-fills the single gap the 2-column (lg) layout would otherwise leave; items-start keeps
          each panel at its own content height instead of stretching it to the tallest panel in its row. */}
      <div className="grid grid-flow-row-dense grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Suspense key={`performance-${data.period.key}`} fallback={<PanelLoading id="dash-performance" title="Training performance" className="lg:col-span-2" />}>
          <PerformancePanel analytics={analytics} className="lg:col-span-2" />
        </Suspense>
        <Suspense key={`health-${data.period.key}`} fallback={<PanelLoading id="dash-health" title="Training health" />}>
          <TrainingHealthPanel analytics={analytics} />
        </Suspense>
        <Suspense key={`batches-${data.period.key}`} fallback={<PanelLoading id="dash-batches" title="Batch comparison" className="lg:col-span-2" />}>
          <BatchComparisonPanel analytics={analytics} className="lg:col-span-2" />
        </Suspense>
        <Suspense key={`progress-${data.period.key}`} fallback={<PanelLoading id="dash-progress" title="Course Progress" />}>
          <CourseProgressPanel analytics={analytics} />
        </Suspense>
        <Suspense key={`courses-${data.period.key}`} fallback={<PanelLoading id="dash-courses" title="Course comparison" className="lg:col-span-2" />}>
          <CourseComparisonPanel analytics={analytics} className="lg:col-span-2" />
        </Suspense>
        <Suspense key={`students-${data.period.key}`} fallback={<PanelLoading id="dash-students" title="Student Performance (Top 5)" />}>
          <StudentPerformancePanel analytics={analytics} />
        </Suspense>
        <Suspense key={`topics-${data.period.key}`} fallback={<PanelLoading id="dash-topics" title="Weak Topics" />}>
          <WeakTopicsPanel analytics={analytics} />
        </Suspense>
        <Overview section={data.overview} />
        <QuickActions />
        <TodayClasses section={data.todayClasses} today={data.today} />
        <UpcomingClasses section={data.upcomingClasses} />
        <UpcomingTests section={data.upcomingTests} />
        <Activity section={data.activity} />
        <PendingApprovalsPanel section={data.approvals} className="lg:col-span-2" />
      </div>
    </div>
  );
}

/** Loading placeholder with the dashboard's shape (used as the page's Suspense fallback). */
export function AdminDashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the dashboard…</span>
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-80 max-w-full" />
        <Skeleton className="mt-3 h-8 w-96 max-w-full" />
      </div>
      <Skeleton className="h-24" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-72 lg:col-span-2" />
        <Skeleton className="h-72" />
        <Skeleton className="h-56 lg:col-span-2" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}
