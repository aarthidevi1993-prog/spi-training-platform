import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  FileCheck2,
  GraduationCap,
  Inbox,
  Layers,
  LineChart,
  ListChecks,
  MonitorPlay,
  Trophy,
  UserCheck,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime } from "@/utils/format";
import { MODULE_WEAK_BELOW } from "@/types/performance";
import {
  ATTENDANCE_LOW_BELOW,
  ATTENDANCE_WINDOW_DAYS,
  PERFORMANCE_LOW_BELOW,
  UPCOMING_CLASS_DAYS,
  type AttentionPriority,
  type AttentionStudent,
  type DashboardClassRow,
  type PendingActionKey,
  type Section,
  type TrainerDashboardData,
} from "@/lib/dashboard/trainer-dashboard";

/**
 * Trainer dashboard (P4.2). A server component that only renders the
 * trainer dashboard service's read model — the trainer's own current
 * batches and classes, read through their session (RLS). No mock data,
 * no invented trends, no risk score, no mutations: every action is a link
 * to an existing trainer workflow. Each section has its own empty and
 * error state.
 */

export const TRAINER_DASHBOARD_TITLE = "Trainer Dashboard";
export const TRAINER_DASHBOARD_SUBTITLE = "Overview of your training activities";

/** A calendar date (YYYY-MM-DD) as text, independent of the server's time zone. */
function calendarDate(isoDate: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "short" }): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }).format(d);
}

const pct = (v: number | null) => (v === null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);

const HEAD = "px-2 py-2 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted";
const CELL = "px-2 py-2 align-top";

// ---------------------------------------------------------------- shared building blocks

function Panel({ id, title, description, action, icon: Icon, children, className }: { id: string; title: string; description?: string; action?: { href: string; label: string }; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 ${className ?? ""}`}>
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
        <CardContent className="min-w-0 flex-1 px-4 py-3">{children}</CardContent>
      </Card>
    </section>
  );
}

function SectionError() {
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-signal-redSoft px-3 py-2.5" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Unable to load this section.</p>
        <p className="text-xs text-ink-muted">Refresh to retry.</p>
      </div>
    </div>
  );
}

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

/** Renders a section's data, or its error state. */
function Load<T>({ section, children }: { section: Section<T>; children: (data: T) => ReactNode }) {
  return section.status === "error" ? <SectionError /> : <>{children(section.data)}</>;
}

function CellLink({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  return (
    <Link href={href} aria-label={label} className="inline-flex items-center justify-end gap-1 text-right text-xs sm:whitespace-nowrap font-medium text-signal-blue hover:underline">
      {children} <ArrowRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}

// ---------------------------------------------------------------- 1. KPI summary

function Kpis({ section }: { section: TrainerDashboardData["kpis"] }) {
  return (
    <section aria-labelledby="tdash-kpis">
      <h2 id="tdash-kpis" className="sr-only">
        Summary
      </h2>
      {section.status === "error" ? (
        <SectionError />
      ) : (
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              {
                key: "batches",
                label: "Active batches",
                value: String(section.data.currentBatches),
                note: `${section.data.ongoingBatches} ongoing · ${section.data.upcomingBatches} upcoming`,
                href: "/trainer/batches",
                icon: Layers,
                tile: "bg-primary-50 text-primary-600",
              },
              {
                key: "students",
                label: "Current students",
                value: String(section.data.activeStudents),
                note: "Enrolled in your current batches",
                href: "/trainer/students",
                icon: GraduationCap,
                tile: "bg-signal-blueSoft text-signal-blue",
              },
              {
                key: "today",
                label: "Classes today",
                value: String(section.data.classesToday),
                note: section.data.classesToday === 0 ? "None scheduled · India time" : `${section.data.classesTodayCompleted} completed · India time`,
                href: "/trainer/classes",
                icon: CalendarDays,
                tile: "bg-brand-goldSoft text-signal-amber",
              },
              {
                key: "performance",
                label: "Average student score",
                value: pct(section.data.averagePerformance),
                note:
                  section.data.releasedResults === 0
                    ? "No released test results yet"
                    : `${section.data.releasedResults} released test result${section.data.releasedResults === 1 ? "" : "s"}`,
                href: "/trainer/performance",
                icon: LineChart,
                tile: "bg-signal-tealSoft text-signal-teal",
              },
            ] as const
          ).map((k) => (
            <li key={k.key} className="min-w-0">
              <Link
                href={k.href}
                aria-label={`${k.label}: ${k.value}. ${k.note}.`}
                className="flex h-full flex-col rounded-md border border-surface-border bg-surface-raised p-3 shadow-panel transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
              >
                <span className="flex items-start gap-2">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${k.tile}`} aria-hidden="true">
                    <k.icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 pt-0.5 text-xs font-medium leading-tight text-ink-muted">{k.label}</span>
                </span>
                <span className="mt-2 block text-kpi text-ink">{k.value}</span>
                <span className="mt-1 block text-2xs text-ink-faint">{k.note}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 2. pending actions

const ACTION_ICON: Record<PendingActionKey, LucideIcon> = {
  attendance: ClipboardCheck,
  assignments: ClipboardList,
  tests: MonitorPlay,
  results: FileCheck2,
};

function PendingActions({ section }: { section: TrainerDashboardData["pending"] }) {
  return (
    <Panel id="tdash-pending" title="Pending actions" description="Work waiting on you, from your classes, submissions and tests." icon={ListChecks}>
      <Load section={section}>
        {(actions) =>
          actions.length === 0 ? (
            <Compact title="No pending actions" description="Attendance, submissions and tests are up to date." />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {actions.map((a) => {
                const Icon = ACTION_ICON[a.key];
                return (
                  <li key={a.key} className="flex min-w-0 flex-col rounded-md border border-surface-border bg-surface-raised px-3 py-2.5">
                    <div className="flex items-start gap-3">
                      <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-brand-goldSoft px-1.5 font-mono text-sm font-semibold text-ink">{a.count}</span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 [overflow-wrap:anywhere] text-sm font-semibold text-ink">
                          <Icon className="h-3.5 w-3.5 shrink-0 text-primary-600" aria-hidden />
                          {a.title}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted">{a.explanation}</p>
                      </div>
                    </div>
                    <Link href={a.href} className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-signal-blue hover:underline">
                      {a.linkLabel} <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Load>
    </Panel>
  );
}

// ---------------------------------------------------------------- 3. students needing attention

const PRIORITY: Record<AttentionPriority, { label: string; tone: "red" | "amber" | "blue" }> = {
  critical: { label: "Critical", tone: "red" },
  attention: { label: "Attention", tone: "amber" },
  monitor: { label: "Monitor", tone: "blue" },
};

function Figure({ value, low, marked }: { value: number | null; low: boolean; marked?: string }) {
  return (
    <span className={`font-mono text-xs ${low ? "font-semibold text-signal-red" : "text-ink"}`}>
      {pct(value)}
      {marked && <span className="block font-sans font-normal text-2xs text-ink-faint">{marked}</span>}
    </span>
  );
}

function AttentionRow({ s }: { s: AttentionStudent }) {
  const lowPerf = s.performance !== null && s.performance < PERFORMANCE_LOW_BELOW;
  const lowAtt = s.attendance !== null && s.attendance < ATTENDANCE_LOW_BELOW;
  const p = PRIORITY[s.priority];
  return (
    <tr className="border-b border-surface-border last:border-b-0">
      <td className={`${CELL} min-w-0`}>
        <p className="[overflow-wrap:anywhere] text-sm font-medium text-ink">{s.name}</p>
        {s.studentCode && <p className="font-mono text-2xs text-ink-faint">{s.studentCode}</p>}
        <p className="[overflow-wrap:anywhere] text-2xs text-ink-muted xl:hidden">{s.batchName}</p>
        <p className="mt-0.5 font-mono text-2xs text-ink-muted sm:hidden md:block lg:hidden">
          Perf {pct(s.performance)} · Att {pct(s.attendance)}
        </p>
        <p className="mt-0.5 [overflow-wrap:anywhere] text-2xs text-ink-muted">{s.reasons.join(" · ")}</p>
        {s.weakArea && (
          <p className="mt-0.5 [overflow-wrap:anywhere] text-2xs text-ink-muted xl:hidden">
            Weak area: {s.weakArea.title} ({pct(s.weakArea.percent)})
          </p>
        )}
      </td>
      <td className={`${CELL} hidden break-words text-xs text-ink-muted xl:table-cell`}>{s.batchName}</td>
      <td className={`${CELL} hidden sm:table-cell md:hidden lg:table-cell`}>
        <Figure value={s.performance} low={lowPerf} marked={s.releasedResults > 0 ? `${s.releasedResults} result${s.releasedResults === 1 ? "" : "s"}` : "No results"} />
      </td>
      <td className={`${CELL} hidden sm:table-cell md:hidden lg:table-cell`}>
        <Figure value={s.attendance} low={lowAtt} marked={s.attendanceMarked > 0 ? `${s.attendanceMarked} marked` : "Not marked"} />
      </td>
      <td className={`${CELL} hidden [overflow-wrap:anywhere] text-xs xl:table-cell`}>
        {s.weakArea ? (
          <span className="[overflow-wrap:anywhere] text-ink">
            {s.weakArea.title} <span className="font-mono text-ink-muted">({pct(s.weakArea.percent)})</span>
          </span>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
      <td className={CELL}>
        <Badge tone={p.tone}>{p.label}</Badge>
      </td>
      <td className={`${CELL} text-right`}>
        <CellLink href={s.href} label={`View performance of ${s.name}`}>
          View
        </CellLink>
      </td>
    </tr>
  );
}

function StudentsNeedingAttention({ section }: { section: TrainerDashboardData["attention"] }) {
  return (
    <Panel
      id="tdash-attention"
      title="Students needing attention"
      description={`Your current batches · test average below ${PERFORMANCE_LOW_BELOW}% or attendance below ${ATTENDANCE_LOW_BELOW}% (last ${ATTENDANCE_WINDOW_DAYS} days), or did not pass the latest test.`}
      action={{ href: "/trainer/performance", label: "Open performance" }}
      icon={Users}
    >
      <Load section={section}>
        {({ rows, total }) =>
          rows.length === 0 ? (
            <Compact title="No students need attention" description="No enrolled student is below the thresholds on released results or marked attendance." />
          ) : (
            <>
              <table className="w-full table-fixed border-collapse text-sm sm:table-auto">
                <caption className="sr-only">Students needing attention, most urgent first</caption>
                <thead>
                  <tr className="border-b border-surface-border">
                    <th scope="col" className={HEAD}>
                      Student
                    </th>
                    <th scope="col" className={`${HEAD} hidden xl:table-cell`}>
                      Batch
                    </th>
                    <th scope="col" className={`${HEAD} hidden sm:table-cell md:hidden lg:table-cell`}>
                      Performance
                    </th>
                    <th scope="col" className={`${HEAD} hidden sm:table-cell md:hidden lg:table-cell`}>
                      Attendance
                    </th>
                    <th scope="col" className={`${HEAD} hidden xl:table-cell`}>
                      Weak area
                    </th>
                    <th scope="col" className={`${HEAD} w-24 sm:w-auto`}>
                      Priority
                    </th>
                    <th scope="col" className={`${HEAD} w-16 text-right sm:w-auto`}>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <AttentionRow key={`${s.batchId}-${s.studentId}`} s={s} />
                  ))}
                </tbody>
              </table>
              {total > rows.length && (
                <p className="mt-2 text-2xs text-ink-faint">
                  Showing the {rows.length} most urgent of {total} students.{" "}
                  <Link href="/trainer/performance" className="font-medium text-signal-blue hover:underline">
                    See all in Performance
                  </Link>
                </p>
              )}
            </>
          )
        }
      </Load>
    </Panel>
  );
}

// ---------------------------------------------------------------- 4. classes

function TodayClasses({ section, today }: { section: TrainerDashboardData["todayClasses"]; today: string }) {
  return (
    <Panel
      id="tdash-today"
      title="Today's classes"
      description={`${calendarDate(today, { weekday: "long", day: "2-digit", month: "short" })} · India time`}
      action={{ href: "/trainer/classes", label: "All classes" }}
      icon={CalendarDays}
      className="xl:col-span-2"
    >
      <Load section={section}>
        {(rows) =>
          rows.length === 0 ? (
            <Compact title="No classes today" description="You have no classes scheduled for today." />
          ) : (
            <table className="w-full table-fixed border-collapse text-sm lg:table-auto">
              <caption className="sr-only">Your classes today</caption>
              <thead>
                <tr className="border-b border-surface-border">
                  <th scope="col" className={`${HEAD} w-16 sm:w-24`}>
                    Time
                  </th>
                  <th scope="col" className={HEAD}>
                    Class
                  </th>
                  <th scope="col" className={`${HEAD} hidden lg:table-cell`}>
                    Batch
                  </th>
                  <th scope="col" className={`${HEAD} hidden xl:table-cell`}>
                    Course
                  </th>
                  <th scope="col" className={`${HEAD} hidden sm:table-cell`}>
                    Status
                  </th>
                  <th scope="col" className={`${HEAD} w-20 text-right sm:w-28 lg:w-auto`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <ClassRow key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          )
        }
      </Load>
    </Panel>
  );
}

function ClassRow({ c }: { c: DashboardClassRow }) {
  return (
    <tr className="border-b border-surface-border last:border-b-0">
      <td className={`${CELL} font-mono text-xs text-ink-muted`}>
        {c.startTime}
        <span className="block whitespace-nowrap">–{c.endTime}</span>
      </td>
      <td className={CELL}>
        <p className="[overflow-wrap:anywhere] text-sm font-medium text-ink">{c.title}</p>
        <p className="[overflow-wrap:anywhere] text-2xs text-ink-muted lg:hidden">{c.batchName}</p>
        <p className="[overflow-wrap:anywhere] text-2xs text-ink-faint xl:hidden">{c.courseTitle}</p>
        <StatusBadge status={c.status} className="mt-1 sm:hidden" />
      </td>
      <td className={`${CELL} hidden break-words text-xs text-ink-muted lg:table-cell`}>{c.batchName}</td>
      <td className={`${CELL} hidden break-words text-xs text-ink-muted xl:table-cell`}>{c.courseTitle}</td>
      <td className={`${CELL} hidden sm:table-cell`}>
        <StatusBadge status={c.status} />
      </td>
      <td className={`${CELL} text-right`}>
        <CellLink href={`/trainer/classes/${encodeURIComponent(c.id)}`} label={c.needsAttendance ? `Mark attendance for ${c.title}` : `Open ${c.title}`}>
          {c.needsAttendance ? "Mark attendance" : "Open"}
        </CellLink>
      </td>
    </tr>
  );
}

function UpcomingClasses({ section }: { section: TrainerDashboardData["upcomingClasses"] }) {
  return (
    <Panel id="tdash-upcoming-classes" title="Upcoming classes" description={`Next ${UPCOMING_CLASS_DAYS} days`} icon={CalendarClock}>
      <Load section={section}>
        {(rows) =>
          rows.length === 0 ? (
            <Compact title="No upcoming classes" description={`Nothing scheduled in the next ${UPCOMING_CLASS_DAYS} days.`} />
          ) : (
            <ul className="divide-y divide-surface-border">
              {rows.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-ink-muted">
                      {calendarDate(c.date)} · {c.startTime}–{c.endTime}
                    </p>
                    <Link href={`/trainer/classes/${encodeURIComponent(c.id)}`} className="block [overflow-wrap:anywhere] text-sm font-medium text-ink hover:underline">
                      {c.title}
                    </Link>
                    <p className="[overflow-wrap:anywhere] text-2xs text-ink-muted">
                      {c.batchName}
                      {c.courseTitle ? ` · ${c.courseTitle}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={c.status} className="shrink-0" />
                </li>
              ))}
            </ul>
          )
        }
      </Load>
    </Panel>
  );
}

// ---------------------------------------------------------------- 5. tests

function testWhen(from: string | null, until: string | null, status: "scheduled" | "active"): string {
  if (status === "active") return until ? `Open until ${formatDateTime(until)}` : "Open now";
  return from ? formatDateTime(from) : "Start not set";
}

function UpcomingTests({ section }: { section: TrainerDashboardData["upcomingTests"] }) {
  return (
    <Panel id="tdash-tests" title="Upcoming & open tests" description="Open now and scheduled, in your current batches" action={{ href: "/trainer/tests", label: "All tests" }} icon={FileCheck2} className="xl:col-span-2">
      <Load section={section}>
        {(rows) =>
          rows.length === 0 ? (
            <Compact title="No upcoming tests" description="No test is open or scheduled in your current batches." />
          ) : (
            <table className="w-full table-fixed border-collapse text-sm lg:table-auto">
              <caption className="sr-only">Upcoming tests</caption>
              <thead>
                <tr className="border-b border-surface-border">
                  <th scope="col" className={HEAD}>
                    Test
                  </th>
                  <th scope="col" className={`${HEAD} hidden lg:table-cell`}>
                    Batch
                  </th>
                  <th scope="col" className={`${HEAD} hidden xl:table-cell`}>
                    Course
                  </th>
                  <th scope="col" className={`${HEAD} hidden sm:table-cell`}>
                    Date / time
                  </th>
                  <th scope="col" className={`${HEAD} hidden sm:table-cell`}>
                    Status
                  </th>
                  <th scope="col" className={`${HEAD} w-16 text-right lg:w-auto`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-surface-border last:border-b-0">
                    <td className={CELL}>
                      <p className="[overflow-wrap:anywhere] text-sm font-medium text-ink">{t.title}</p>
                      <p className="[overflow-wrap:anywhere] text-2xs text-ink-muted lg:hidden">{t.batchName}</p>
                      <p className="[overflow-wrap:anywhere] text-2xs text-ink-faint xl:hidden">{t.courseTitle}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-muted sm:hidden">{testWhen(t.availableFrom, t.availableUntil, t.effectiveStatus)}</p>
                      <StatusBadge status={t.effectiveStatus} className="mt-1 sm:hidden" />
                    </td>
                    <td className={`${CELL} hidden break-words text-xs text-ink-muted lg:table-cell`}>{t.batchName}</td>
                    <td className={`${CELL} hidden break-words text-xs text-ink-muted xl:table-cell`}>{t.courseTitle}</td>
                    <td className={`${CELL} hidden font-mono text-xs text-ink-muted sm:table-cell`}>{testWhen(t.availableFrom, t.availableUntil, t.effectiveStatus)}</td>
                    <td className={`${CELL} hidden sm:table-cell`}>
                      <StatusBadge status={t.effectiveStatus} />
                    </td>
                    <td className={`${CELL} text-right`}>
                      <CellLink href={`/trainer/tests/${encodeURIComponent(t.id)}`} label={`View ${t.title}`}>
                        View
                      </CellLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Load>
    </Panel>
  );
}

const MEDAL = ["bg-brand-goldSoft text-ink", "bg-surface-sunken text-ink", "bg-primary-50 text-primary-700"] as const;

function CurrentTestTop({ section }: { section: TrainerDashboardData["currentTest"] }) {
  return (
    <Panel id="tdash-top" title="Current Test Performance" description="Top students within one current or recent test of your batches" icon={Trophy}>
      <Load section={section}>
        {(t) =>
          t === null ? (
            <Compact title="No current test results" description="No open test, or test closed in the last 30 days, has finished attempts yet." />
          ) : (
            <div className="min-w-0">
              <Link href={`/trainer/tests/${encodeURIComponent(t.testId)}`} className="block [overflow-wrap:anywhere] text-sm font-semibold text-ink hover:underline">
                {t.title}
              </Link>
              <p className="[overflow-wrap:anywhere] text-2xs text-ink-muted">
                {t.batchName}
                {t.courseTitle ? ` · ${t.courseTitle}` : ""}
              </p>
              <p className="mt-0.5 text-2xs text-ink-faint">
                {t.effectiveStatus === "active"
                  ? `Open — best results so far (${t.resultCount} finished)`
                  : `Closed${t.availableUntil ? ` ${formatDateTime(t.availableUntil)}` : ""} · ${t.resultCount} finished`}
              </p>
              {t.top.length === 0 ? (
                <Compact title="No results to rank" description="Finished attempts belong to students no longer enrolled." />
              ) : (
                <ol className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label={`Top students in ${t.title}`}>
                  {t.top.map((s, i) => (
                    <li key={`${s.rank}-${s.name}`} className="flex min-w-0 items-center gap-2.5 rounded-md border border-surface-border px-2.5 py-2">
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold ${MEDAL[i] ?? MEDAL[1]}`} aria-label={`Rank ${s.rank}`}>
                        {s.rank}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="[overflow-wrap:anywhere] text-sm font-medium text-ink">{s.name}</p>
                        {s.studentCode && <p className="font-mono text-2xs text-ink-faint">{s.studentCode}</p>}
                      </div>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-sm font-semibold text-ink">{pct(s.percentage)}</span>
                        <span className={`block text-2xs ${s.passed ? "text-signal-green" : "text-signal-red"}`}>{s.passed ? "Passed" : "Not passed"}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )
        }
      </Load>
    </Panel>
  );
}

// ---------------------------------------------------------------- 6. attendance and performance

const ATT_PARTS = [
  { key: "present", label: "Present", bar: "bg-signal-green", text: "text-signal-green" },
  { key: "late", label: "Late", bar: "bg-signal-amber", text: "text-signal-amber" },
  { key: "absent", label: "Absent", bar: "bg-signal-red", text: "text-signal-red" },
  { key: "excused", label: "Excused", bar: "bg-signal-blue", text: "text-signal-blue" },
] as const;

function AttendanceOverviewPanel({ section }: { section: TrainerDashboardData["attendance"] }) {
  return (
    <Panel
      id="tdash-attendance"
      title="Attendance overview"
      description={`Last ${ATTENDANCE_WINDOW_DAYS} days · your current batches`}
      action={{ href: "/trainer/attendance", label: "Attendance" }}
      icon={UserCheck}
    >
      <Load section={section}>
        {(a) =>
          a.marked === 0 ? (
            <Compact title="No attendance recorded" description={`No attendance was marked in the last ${ATTENDANCE_WINDOW_DAYS} days.`} />
          ) : (
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-kpi text-ink">{pct(a.rate)}</span>
                <span className="text-xs text-ink-muted">
                  attended · {a.marked} marks over {a.classesHeld} class{a.classesHeld === 1 ? "" : "es"}
                </span>
              </p>
              <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                {ATT_PARTS.map((p) => (a[p.key] > 0 ? <span key={p.key} className={p.bar} style={{ width: `${(a[p.key] / a.marked) * 100}%` }} /> : null))}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ATT_PARTS.map((p) => (
                  <div key={p.key} className="rounded-md bg-surface-sunken px-2.5 py-2">
                    <dt className={`text-2xs font-semibold uppercase tracking-wide ${p.text}`}>{p.label}</dt>
                    <dd className="font-mono text-sm font-semibold text-ink">{a[p.key]}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-2xs text-ink-faint">Attended = present, late or excused, out of marked records. Unmarked classes are not counted as absent.</p>
            </div>
          )
        }
      </Load>
    </Panel>
  );
}

function PerformancePanel({ performance, topics }: { performance: TrainerDashboardData["performance"]; topics: TrainerDashboardData["weakTopics"] }) {
  return (
    <Panel id="tdash-performance" title="Performance & weak topics" description="Released test results · your current batches" action={{ href: "/trainer/performance", label: "Performance" }} icon={LineChart}>
      <Load section={performance}>
        {(p) =>
          p.releasedResults === 0 ? (
            <Compact title="No released results yet" description="Averages appear once a test in your batches has closed with finished attempts." />
          ) : (
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-surface-sunken px-2.5 py-2">
                <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Average</dt>
                <dd className="font-mono text-lg font-semibold text-ink">{pct(p.average)}</dd>
              </div>
              <div className="rounded-md bg-surface-sunken px-2.5 py-2">
                <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Pass rate</dt>
                <dd className="font-mono text-lg font-semibold text-ink">{pct(p.passRate)}</dd>
              </div>
              <p className="col-span-2 text-2xs text-ink-faint">
                {p.releasedResults} released result{p.releasedResults === 1 ? "" : "s"} (best attempt per student and test).
              </p>
            </dl>
          )
        }
      </Load>
      <h3 className="mt-3 text-xs font-semibold text-ink">Weak topics</h3>
      <div className="mt-1.5">
        <Load section={topics}>
          {(list) =>
            list.length === 0 ? (
              <Compact title="No weak topics" description={`No module is below ${MODULE_WEAK_BELOW}% on released results, or no module data yet.`} />
            ) : (
              <ul className="flex flex-col gap-2">
                {list.map((t) => (
                  <li key={t.title} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 [overflow-wrap:anywhere] text-ink">{t.title}</span>
                      <span className="shrink-0 font-mono text-ink-muted">{pct(t.percent)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                      <div className="h-full rounded-full bg-signal-red" style={{ width: `${Math.max(2, Math.min(100, t.percent))}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </Load>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationsSummary({ section }: { section: TrainerDashboardData["notifications"] }) {
  return (
    <Panel
      id="tdash-notifications"
      title="Notifications"
      description={section.status === "ok" ? `${section.data.unreadCount} unread` : "Your latest notifications"}
      action={{ href: "/trainer/notifications", label: "View all" }}
      icon={Bell}
    >
      <Load section={section}>
        {(n) =>
          n.latest.length === 0 ? (
            <Compact title="No notifications" description="New class, submission and test updates will appear here." />
          ) : (
            <ul className="divide-y divide-surface-border">
              {n.latest.map((item) => (
                <li key={item.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-brand-gold"}`}
                    aria-label={item.readAt ? undefined : "Unread"}
                    role={item.readAt ? undefined : "img"}
                  />
                  <div className="min-w-0">
                    {item.link ? (
                      <Link href={item.link} className="block [overflow-wrap:anywhere] text-sm font-medium text-ink hover:underline">
                        {item.title}
                      </Link>
                    ) : (
                      <p className="[overflow-wrap:anywhere] text-sm font-medium text-ink">{item.title}</p>
                    )}
                    <p className="line-clamp-2 [overflow-wrap:anywhere] text-2xs text-ink-muted">{item.body}</p>
                    <p className="font-mono text-2xs text-ink-faint">{formatDateTime(item.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Load>
    </Panel>
  );
}

function NoBatchesNotice() {
  return (
    <section aria-labelledby="tdash-no-batches" className="flex items-start gap-2.5 rounded-md border border-brand-gold/40 bg-brand-goldSoft/40 px-4 py-3">
      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" aria-hidden />
      <div className="min-w-0">
        <h2 id="tdash-no-batches" className="text-sm font-semibold text-ink">
          No active batches
        </h2>
        <p className="text-xs text-ink-muted">You aren&apos;t assigned to an upcoming or ongoing batch. Students, tests and results appear here once a batch is assigned to you.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- page

export function TrainerDashboard({ data }: { data: TrainerDashboardData }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title={TRAINER_DASHBOARD_TITLE}
        description={TRAINER_DASHBOARD_SUBTITLE}
        className="min-w-0 pb-0"
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface-raised px-2.5 py-1 text-xs text-ink-muted">
            <CalendarDays className="h-3.5 w-3.5 text-primary-600" aria-hidden />
            {calendarDate(data.today, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · India time
          </span>
        }
      />
      <Kpis section={data.kpis} />
      {data.noCurrentBatches && <NoBatchesNotice />}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
        <TodayClasses section={data.todayClasses} today={data.today} />
        <UpcomingClasses section={data.upcomingClasses} />
      </div>
      <PendingActions section={data.pending} />
      <CurrentTestTop section={data.currentTest} />
      <StudentsNeedingAttention section={data.attention} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <PerformancePanel performance={data.performance} topics={data.weakTopics} />
        <AttendanceOverviewPanel section={data.attendance} />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
        <UpcomingTests section={data.upcomingTests} />
        <NotificationsSummary section={data.notifications} />
      </div>
    </div>
  );
}

/** Loading placeholder with the dashboard's shape (the page's Suspense fallback). */
export function TrainerDashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the dashboard…</span>
      <div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-28" />
      <Skeleton className="h-56" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Skeleton className="h-48 xl:col-span-2" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}
