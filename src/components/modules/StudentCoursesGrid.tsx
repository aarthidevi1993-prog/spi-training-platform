"use client";

import { useMemo, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import type { CourseSummary } from "@/types/course";
import { StudentCourseCard } from "./StudentCourseCard";

/** Hours without a trailing ".0" (e.g. 40, 12.5). */
function formatHours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-3">
      <dt className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

/**
 * The student's enrolled courses: a compact summary (computed only
 * from the loaded list), a title-only search, and the course cards.
 * Receives the already-loaded, server-scoped courses; no data fetching
 * happens here. Students get no status filter — every course here is
 * one they are enrolled in.
 */
export function StudentCoursesGrid({ courses, basePath = "/student/courses" }: { courses: CourseSummary[]; basePath?: string }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? courses : courses.filter((c) => c.title.toLowerCase().includes(q));
  }, [courses, query]);

  const totals = useMemo(
    () => ({
      hours: courses.reduce((sum, c) => sum + (Number.isFinite(c.durationHours) ? c.durationHours : 0), 0),
      modules: courses.reduce((sum, c) => sum + (Number.isFinite(c.modules) ? c.modules : 0), 0),
    }),
    [courses]
  );

  if (courses.length === 0) {
    return <EmptyState icon={BookOpen} title="No courses yet" description="You are not currently enrolled in any courses." />;
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-3 divide-x divide-surface-border rounded-md border border-surface-border border-t-brand-gold bg-surface-raised shadow-panel sm:max-w-xl" style={{ borderTopWidth: 2 }}>
        <SummaryItem label="Enrolled courses" value={String(courses.length)} />
        <SummaryItem label="Total hours" value={formatHours(totals.hours)} />
        <SummaryItem label="Modules" value={String(totals.modules)} />
      </dl>

      <div className="relative w-full sm:max-w-sm">
        <label htmlFor="student-course-search" className="sr-only">
          Search your courses
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <Input
          id="student-course-search"
          type="search"
          placeholder="Search your courses…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
          autoComplete="off"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Search} title="No courses match your search" description="Try a different course name." />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((course) => (
            <StudentCourseCard key={course.id} course={course} basePath={basePath} />
          ))}
        </div>
      )}
    </div>
  );
}
