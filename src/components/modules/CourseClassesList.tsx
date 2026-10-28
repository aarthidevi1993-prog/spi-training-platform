import Link from "next/link";
import { CalendarDays, Clock } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate } from "@/utils/format";
import type { ClassWithRelations } from "@/types/class";

export const COURSE_CLASSES_EMPTY_TITLE = "No scheduled classes yet";
export const COURSE_CLASSES_EMPTY_DESCRIPTION = "Classes for this course will appear here once a batch is scheduled.";
export const COURSE_CLASSES_ERROR = "We couldn't load this course's classes. The rest of the course is shown; please try again later.";

/**
 * The Classes tab of a course: the classes of this course the viewer may see (already scoped by
 * classesService — all for a Super Admin, their own for a trainer, their batches' for a student),
 * newest first, each with the module it covers. `classes` null = the read failed (the course page
 * itself still loads).
 */
export function CourseClassesList({ classes, basePath }: { classes: ClassWithRelations[] | null; basePath: string }) {
  if (classes === null) {
    return (
      <p role="alert" className="rounded-md border border-signal-red/30 bg-signal-redSoft px-4 py-3 text-sm text-signal-red">
        {COURSE_CLASSES_ERROR}
      </p>
    );
  }
  if (classes.length === 0) {
    return <EmptyState icon={CalendarDays} title={COURSE_CLASSES_EMPTY_TITLE} description={COURSE_CLASSES_EMPTY_DESCRIPTION} />;
  }
  return (
    <Card>
      <ul className="divide-y divide-surface-border">
        {classes.map((c) => (
          <li key={c.id} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <Link href={`${basePath}/${encodeURIComponent(c.id)}`} className="block [overflow-wrap:anywhere] text-sm font-medium text-ink hover:underline">
                {c.title}
              </Link>
              <p className="text-xs text-ink-muted">
                {c.moduleTitle ?? "No specific module"} · {c.batchName}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden /> {formatDate(c.classDate)}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" aria-hidden /> {c.startTime}–{c.endTime}
              </span>
              <StatusBadge status={c.status} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
