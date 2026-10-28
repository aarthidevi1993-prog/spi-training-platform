"use client";

import { useMemo, useState } from "react";
import { Search, UserCheck, UserX, Clock3, ClipboardCheck } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ChartContainer } from "@/components/ui/ChartContainer";
import { BarChart } from "@/components/ui/charts";
import { EmptyState } from "@/components/ui/EmptyState";
import { SummaryStat } from "@/components/dashboard/SummaryStat";
import { formatDate } from "@/utils/format";
import type { AttendanceOverview } from "@/types/attendance";

/**
 * Share of countable records, as a whole percentage — or "—" when
 * nothing has been marked yet (never a pretend 0% / 100%). Excused
 * records are outside the denominator.
 */
function share(count: number, countable: number): string {
  return countable > 0 ? `${Math.round((count / countable) * 100)}%` : "—";
}

export function AttendanceView({ overview }: { overview: AttendanceOverview }) {
  const { rows, summary, trend } = overview;
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState("all");

  const batchOptions = useMemo(
    () => [{ label: "All batches", value: "all" }, ...overview.batches.map((b) => ({ label: b, value: b }))],
    [overview.batches]
  );

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const matchesQuery = query.trim() === "" || r.student.toLowerCase().includes(query.toLowerCase());
      const matchesBatch = batch === "all" || r.batch === batch;
      return matchesQuery && matchesBatch;
    });
  }, [rows, query, batch]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryStat label="Present" value={share(summary.present, summary.countable)} icon={UserCheck} tone="green" />
        <SummaryStat label="Absent" value={share(summary.absent, summary.countable)} icon={UserX} tone="red" />
        <SummaryStat label="Late" value={share(summary.late, summary.countable)} icon={Clock3} tone="gold" />
      </div>

      <ChartContainer title="Attendance Trend" description="Present vs absent by class date">
        {trend.length > 0 ? (
          <>
            <BarChart data={trend} presentColor="#0E6B3E" absentColor="#F2B705" />
            <div className="mt-2 flex items-center gap-4 text-2xs text-ink-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-primary-500" /> Present
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-brand-gold" /> Absent
              </span>
            </div>
          </>
        ) : (
          <EmptyState
            icon={ClipboardCheck}
            title="Not yet marked"
            description="The trend will appear once attendance has been marked for a class."
          />
        )}
      </ChartContainer>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <Input placeholder="Search student…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
        <Select value={batch} onChange={(e) => setBatch(e.target.value)} className="sm:w-44" options={batchOptions} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No attendance marked yet"
          description="Attendance records will appear here once a trainer marks attendance for a class."
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="No attendance records match" description="Try a different student or batch filter." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Student</TableHeaderCell>
              <TableHeaderCell>Batch</TableHeaderCell>
              <TableHeaderCell>Class</TableHeaderCell>
              <TableHeaderCell>Date</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium text-ink">{r.student}</TableCell>
                <TableCell>{r.batch}</TableCell>
                <TableCell>{r.className}</TableCell>
                <TableCell>{r.date ? formatDate(r.date) : "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
