import Link from "next/link";
import { ArrowRight, Clock, Layers, UserRound } from "lucide-react";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { CourseSummary } from "@/types/course";

function plural(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * A course in the student's "My Courses" catalogue. Presentational
 * only — it shows exactly the CourseSummary it is given (title,
 * description, module count, hours, trainer). Progress is shown only
 * when the data actually provides it (demo mode); it is never derived.
 */
export function StudentCourseCard({ course, basePath = "/student/courses" }: { course: CourseSummary; basePath?: string }) {
  const progress = course.progress ?? 0;
  const description = course.description?.trim();

  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-md border border-surface-border bg-surface-raised shadow-panel transition-colors hover:border-primary-300">
      {/* Narrow forest-green accent */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary-500" />

      <div className="flex flex-1 flex-col px-6 pb-5 pt-5">
        <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-[#8A6D12]">Course</p>
        <h3 className="mt-1.5 line-clamp-2 text-lg font-semibold leading-snug text-ink">{course.title}</h3>
        <span aria-hidden className="mt-3 block h-px w-10 bg-brand-gold" />
        {description && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-ink-muted">{description}</p>}
      </div>

      <dl className="mx-6 flex flex-col gap-2.5 border-t border-surface-border py-4 text-sm text-ink">
        <div className="flex items-center gap-2.5">
          <Layers aria-hidden className="h-4 w-4 shrink-0 text-primary-500" />
          <dt className="sr-only">Modules</dt>
          <dd>{plural(course.modules, "Module", "Modules")}</dd>
        </div>
        <div className="flex items-center gap-2.5">
          <Clock aria-hidden className="h-4 w-4 shrink-0 text-primary-500" />
          <dt className="sr-only">Duration</dt>
          <dd>{plural(course.durationHours, "Hour", "Hours")}</dd>
        </div>
        <div className="flex items-center gap-2.5">
          <UserRound aria-hidden className="h-4 w-4 shrink-0 text-primary-500" />
          <dt className="sr-only">Trainer</dt>
          <dd className="truncate" title={course.trainer}>
            {course.trainer}
          </dd>
        </div>
      </dl>

      {progress > 0 && (
        <div className="mx-6 border-t border-surface-border py-4">
          <ProgressBar value={progress} tone="teal" label="Progress" />
        </div>
      )}

      <div className="flex justify-end border-t border-surface-border bg-surface/60 px-6 py-3">
        <Link
          href={`${basePath}/${course.id}`}
          aria-label={`View course: ${course.title}`}
          className="inline-flex items-center gap-1.5 rounded-sm bg-primary-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          View course <ArrowRight aria-hidden className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}
