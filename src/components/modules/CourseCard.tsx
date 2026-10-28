import Link from "next/link";
import { Layers, ListChecks, Clock, UserRound } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { courseStatusLabel } from "@/lib/courses/course-management";
import type { CourseSummary } from "@/types/course";

export function CourseCard({ course, basePath = "/admin/courses" }: { course: CourseSummary; basePath?: string }) {
  // Progress has no data source in Supabase mode yet (undefined → hidden).
  const progress = course.progress ?? 0;

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="bg-drafting relative flex h-28 items-center justify-center bg-panel">
        <Layers className="h-8 w-8 text-brand-gold" aria-hidden />
        <StatusBadge status={course.status} label={courseStatusLabel(course.status)} className="absolute right-3 top-3" />
      </div>

      {/* min-w-0 + break-words: long unbroken titles, codes, URLs or trainer lists wrap instead of being clipped by overflow-hidden. */}
      <CardContent className="flex min-w-0 flex-1 flex-col gap-3 break-words">
        <div>
          {course.courseCode && <p className="mb-0.5 font-mono text-2xs text-ink-faint">{course.courseCode}</p>}
          <h3 className="text-sm font-semibold text-ink">{course.title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{course.description}</p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <span className="flex items-center gap-1">
            <Layers className="h-3.5 w-3.5" /> {course.modules} Modules
          </span>
          {course.topics !== undefined && (
            <span className="flex items-center gap-1">
              <ListChecks className="h-3.5 w-3.5" /> {course.topics} Topics
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {course.durationHours} Hours
          </span>
        </div>

        <span className="flex items-start gap-1.5 text-xs text-ink-muted">
          <UserRound className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="min-w-0">{course.trainer}</span>
        </span>

        {progress > 0 && <ProgressBar value={progress} tone="teal" label="Progress" />}
      </CardContent>

      <CardFooter>
        <Link href={`${basePath}/${course.id}`} className="w-full">
          <Button variant={progress > 0 ? "primary" : "secondary"} size="sm" className="w-full">
            {progress > 0 ? "Continue" : "View"}
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
}
