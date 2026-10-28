import Link from "next/link";
import { CalendarDays, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { CourseHistoryEntry, CourseUsage } from "@/types/course";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
};

/**
 * Super Admin course page, below the tabs: the batches that use this
 * catalogue course (each batch owns its dates, trainer, students and
 * records) and the course's audit history (course_events, newest first).
 */
export function CourseAdminSections({ usage, history }: { usage: CourseUsage; history: CourseHistoryEntry[] }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarDays className="h-4 w-4" /> Batches using this course ({usage.batchCount})
          </CardTitle>
        </CardHeader>
        {usage.batches.length === 0 ? (
          <CardContent>
            <p className="text-sm text-ink-muted">No batches yet. Create a batch from Batches and select this course once it is published.</p>
          </CardContent>
        ) : (
          <div className="divide-y divide-surface-border">
            {usage.batches.map((b) => (
              <Link key={b.id} href={`/admin/batches/${b.id}`} className="flex flex-col gap-1 px-5 py-3 hover:bg-surface-sunken sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words text-sm">
                  <span className="font-mono text-xs text-ink-muted">{b.batchCode}</span> <span className="font-medium text-ink">{b.name}</span>
                  <span className="block text-xs text-ink-muted">
                    {b.startDate} → {b.endDate} · {b.trainerName ?? "Trainer not assigned"}
                  </span>
                </span>
                <StatusBadge status={b.status} />
              </Link>
            ))}
            {usage.batches.length < usage.batchCount && (
              <p className="px-5 py-2.5 text-xs text-ink-muted">
                Showing the latest {usage.batches.length} of {usage.batchCount} batches. See Batches for the full list.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4" /> Course history
          </CardTitle>
        </CardHeader>
        {history.length === 0 ? (
          <CardContent>
            <p className="text-sm text-ink-muted">No recorded changes yet. Changes made through Course Management appear here.</p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-surface-border">
            {history.map((h) => (
              <li key={h.id} className="px-5 py-2.5 text-sm">
                <span className="break-words text-ink">{h.summary}</span>
                <span className="block text-xs text-ink-muted">
                  {when(h.occurredAt)} {h.actor === null ? "· system" : h.actor === "you" ? "· by you" : <>· by <span className="font-mono">{h.actor.slice(0, 8)}</span></>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
