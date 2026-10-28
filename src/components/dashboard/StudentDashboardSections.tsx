import Link from "next/link";
import { AlertCircle, Award, CalendarDays, ChevronRight, ClipboardList, Info } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatDate, formatDateTime } from "@/utils/format";
import type { PendingAssignmentItem, RecentResultItem, StudentDashboardList, UpcomingClassItem } from "@/lib/dashboard/student-dashboard";

export const UPCOMING_CLASSES_ERROR = "We couldn't load your upcoming classes. Please try again later.";
export const PENDING_ASSIGNMENTS_ERROR = "We couldn't load your assignments. Please try again later.";
export const PENDING_ASSIGNMENTS_UNAVAILABLE = "Your assignments appear here when you sign in with your training account.";
export const RECENT_RESULTS_ERROR = "We couldn't load your recent results. Please try again later.";
export const RECENT_RESULTS_UNAVAILABLE = "Your released results appear here when you sign in with your training account.";

function Notice({ tone, text }: { tone: "info" | "error"; text: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "m-4 flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red"
          : "m-4 flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted"
      }
    >
      {tone === "error" ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>{text}</span>
    </div>
  );
}

function Section<T>({
  title,
  icon: Icon,
  list,
  empty,
  error,
  unavailable,
  viewAll,
  renderItem,
}: {
  title: string;
  icon: typeof CalendarDays;
  list: StudentDashboardList<T>;
  empty: string;
  error: string;
  unavailable: string;
  viewAll: { href: string; label: string };
  renderItem: (item: T) => React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="items-center">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-ink-muted" aria-hidden /> {title}
        </CardTitle>
        {list.kind === "ready" && list.total > list.items.length && (
          <Link href={viewAll.href} className="shrink-0 text-xs font-medium text-primary-600 hover:underline">
            {viewAll.label} ({list.total})
          </Link>
        )}
      </CardHeader>
      {list.kind === "error" ? (
        <Notice tone="error" text={error} />
      ) : list.kind === "unavailable" ? (
        <Notice tone="info" text={unavailable} />
      ) : list.items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-surface-border">{list.items.map(renderItem)}</ul>
      )}
    </Card>
  );
}

/**
 * Student dashboard (Phase 2): the next classes and the assignments still to submit.
 * Read-only lists; each item opens the existing class page (where assignments are submitted).
 */
export function StudentDashboardSections({
  upcomingClasses,
  pendingAssignments,
  recentResults,
}: {
  upcomingClasses: StudentDashboardList<UpcomingClassItem>;
  pendingAssignments: StudentDashboardList<PendingAssignmentItem>;
  /** Phase 3: released results only (optional so the sections can render without it). */
  recentResults?: StudentDashboardList<RecentResultItem>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <Section
        title="Upcoming classes"
        icon={CalendarDays}
        list={upcomingClasses}
        empty="No upcoming classes scheduled."
        error={UPCOMING_CLASSES_ERROR}
        unavailable={UPCOMING_CLASSES_ERROR}
        viewAll={{ href: "/student/classes", label: "View all" }}
        renderItem={(c) => (
          <li key={c.id}>
            <Link href={c.href} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-sunken">
              <span className="min-w-0 break-words">
                <span className="block text-sm font-medium text-ink">{c.title}</span>
                <span className="block text-xs text-ink-muted">
                  {c.courseTitle ? `${c.courseTitle} · ` : ""}
                  {formatDate(c.classDate)} · {c.startTime}
                  {c.status === "live" ? " · Live now" : ""}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            </Link>
          </li>
        )}
      />
      <Section
        title="Pending assignments"
        icon={ClipboardList}
        list={pendingAssignments}
        empty="No assignments waiting for you to submit."
        error={PENDING_ASSIGNMENTS_ERROR}
        unavailable={PENDING_ASSIGNMENTS_UNAVAILABLE}
        viewAll={{ href: "/student/classes", label: "View classes" }}
        renderItem={(a) => (
          <li key={a.id}>
            <Link href={a.href} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-sunken">
              <span className="min-w-0 break-words">
                <span className="block text-sm font-medium text-ink">{a.title}</span>
                <span className="block text-xs text-ink-muted">
                  {a.classTitle ? `${a.classTitle} · ` : ""}
                  {a.dueAt ? <>Due {formatDateTime(a.dueAt)}</> : "No due date"}
                  {a.pastDue && <span className="font-medium text-signal-red"> · Due date passed</span>}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            </Link>
          </li>
        )}
      />
      {recentResults && (
        <Section
          title="Recent results"
          icon={Award}
          list={recentResults}
          empty="No released results yet. Results appear once a test closes."
          error={RECENT_RESULTS_ERROR}
          unavailable={RECENT_RESULTS_UNAVAILABLE}
          viewAll={{ href: "/student/results", label: "View all" }}
          renderItem={(r) => (
            <li key={r.testId}>
              <Link href={r.href} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-sunken">
                <span className="min-w-0 break-words">
                  <span className="block text-sm font-medium text-ink">{r.title}</span>
                  <span className="block text-xs text-ink-muted">
                    {r.percentage}% ·{" "}
                    <span className={r.passed ? "font-medium text-signal-green" : "font-medium text-signal-red"}>{r.passed ? "Passed" : "Not passed"}</span>
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
              </Link>
            </li>
          )}
        />
      )}
    </div>
  );
}
