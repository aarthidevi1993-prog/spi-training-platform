"use client";

import { useMemo, useState } from "react";
import { BookOpen, Search } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import type { CourseSummary } from "@/types/course";
import { CourseCard } from "@/components/modules/CourseCard";

/** Shown when the caller has no courses at all (as opposed to no courses matching the search / filter). */
export interface CoursesEmptyText {
  title: string;
  description: string;
}

const ADMIN_EMPTY: CoursesEmptyText = {
  title: "No courses yet",
  description: "Add the first course to start the SPI catalog.",
};

export function CoursesGrid({
  courses,
  basePath = "/admin/courses",
  empty = ADMIN_EMPTY,
}: {
  courses: CourseSummary[];
  basePath?: string;
  empty?: CoursesEmptyText;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const filtered = useMemo(() => {
    return courses.filter((c) => {
      const q = query.trim().toLowerCase();
      const matchesQuery = q === "" || c.title.toLowerCase().includes(q) || (c.courseCode ?? "").toLowerCase().includes(q);
      const matchesStatus = status === "all" || c.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [courses, query, status]);

  if (courses.length === 0) {
    return <EmptyState icon={BookOpen} title={empty.title} description={empty.description} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <Input placeholder="Search courses…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="sm:w-44"
          options={[
            { label: "All statuses", value: "all" },
            { label: "Active", value: "published" },
            { label: "Draft", value: "draft" },
            { label: "Inactive", value: "archived" },
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No courses match your search" description="Try a different title or status filter." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((course) => (
            <CourseCard key={course.id} course={course} basePath={basePath} />
          ))}
        </div>
      )}
    </div>
  );
}
