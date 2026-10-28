"use client";

import { usePathname, useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import type { PerformanceFilters as Filters } from "@/types/performance";

/**
 * Batch / student filters for the staff Performance page. They only
 * change the URL; the server re-checks every value against the
 * caller's scope (values outside it are ignored).
 */
export function PerformanceFilters({ filters }: { filters: Filters }) {
  const router = useRouter();
  const pathname = usePathname();

  function go(batchId: string, studentId: string) {
    const params = new URLSearchParams();
    if (batchId) params.set("batch", batchId);
    if (batchId && studentId) params.set("student", studentId);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Select
        aria-label="Filter by batch"
        value={filters.batchId ?? ""}
        onChange={(e) => go(e.target.value, "")}
        className="sm:w-56"
        options={[{ value: "", label: "All batches" }, ...filters.batches]}
      />
      {filters.batchId && (
        <Select
          aria-label="Filter by student"
          value={filters.studentId ?? ""}
          onChange={(e) => go(filters.batchId ?? "", e.target.value)}
          className="sm:w-56"
          options={[{ value: "", label: "All students" }, ...filters.students]}
        />
      )}
    </div>
  );
}
