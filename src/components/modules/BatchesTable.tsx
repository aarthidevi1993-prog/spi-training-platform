"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, MoreHorizontal, Eye, Users, UserCog } from "lucide-react";
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
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { AssignTrainerDialog, type AssignTrainerTarget } from "@/components/modules/AssignTrainerDialog";
import { isAssignableBatchStatus, type AvailableTrainerOption } from "@/lib/batches/assign-trainer";
import { formatDate } from "@/utils/format";
import type { BatchSummary } from "@/types/batch";

const PAGE_SIZE = 5;

/**
 * `assignment` is passed by the Super Admin page only (P3.6): it adds
 * "Assign trainer" / "Change trainer" for upcoming/ongoing batches and
 * flags assigned trainers who are no longer available. The trainer
 * portal renders the table without it. The database decides every
 * assignment regardless of what the browser shows.
 *
 * `trainerDetail` (P3.10-A) is passed by the trainer page only: "View
 * batch" opens /trainer/batches/[batchId], whose service shows only the
 * trainer's own batches (anything else is a 404).
 */
export function BatchesTable({
  rows,
  assignment,
  trainerDetail = false,
}: {
  rows: BatchSummary[];
  assignment?: { trainers: AvailableTrainerOption[] };
  trainerDetail?: boolean;
}) {
  const router = useRouter();
  // P3.8: the Super Admin view (the only one passed `assignment`) opens the admin batch detail;
  // P3.10-A: the trainer view opens the trainer batch detail.
  const detailBasePath = assignment ? "/admin/batches" : trainerDetail ? "/trainer/batches" : null;
  const [assignTarget, setAssignTarget] = useState<AssignTrainerTarget | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const matchesQuery = query.trim() === "" || r.name.toLowerCase().includes(query.toLowerCase()) || r.course.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = status === "all" || r.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [rows, query, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <Input
            placeholder="Search batches…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="sm:w-44"
          options={[
            { label: "All statuses", value: "all" },
            { label: "Upcoming", value: "upcoming" },
            { label: "Ongoing", value: "ongoing" },
            { label: "Completed", value: "completed" },
            { label: "Cancelled", value: "cancelled" },
          ]}
        />
      </div>

      {paged.length === 0 ? (
        <EmptyState title="No batches match your search" description="Try a different name, course, or status filter." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Batch</TableHeaderCell>
              <TableHeaderCell>Course</TableHeaderCell>
              <TableHeaderCell>Trainer</TableHeaderCell>
              <TableHeaderCell>Students</TableHeaderCell>
              <TableHeaderCell>Start Date</TableHeaderCell>
              <TableHeaderCell>End Date</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium text-ink">{b.name}</TableCell>
                <TableCell>{b.course}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {b.trainer}
                    {assignment && b.trainerUnavailable && (
                      <Badge tone="amber" title="This trainer's account is not active (invited, suspended or inactive). Change the trainer.">
                        Unavailable
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 text-ink-faint" />
                    {b.students}/{b.maxSeats}
                  </span>
                </TableCell>
                <TableCell>{formatDate(b.startDate)}</TableCell>
                <TableCell>{formatDate(b.endDate)}</TableCell>
                <TableCell>
                  <StatusBadge status={b.status} />
                </TableCell>
                <TableCell className="text-right">
                  {detailBasePath && (
                    <Dropdown
                      align="right"
                      trigger={
                        <button
                          aria-label={`Actions for ${b.name}`}
                          className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      }
                    >
                      {/* P5.0: no "Edit" — batch editing isn't built, so it isn't offered (trainers have no batch write rights). */}
                      <DropdownItem onClick={() => router.push(`${detailBasePath}/${encodeURIComponent(b.id)}`)}>
                        <Eye className="h-3.5 w-3.5" /> View
                      </DropdownItem>
                      {assignment && (
                        <DropdownItem
                          disabled={!isAssignableBatchStatus(b.status)}
                          title={isAssignableBatchStatus(b.status) ? undefined : "Only upcoming or ongoing batches can have their trainer changed."}
                          onClick={() =>
                            setAssignTarget({
                              id: b.id,
                              name: b.name,
                              trainerId: b.trainerId ?? null,
                              trainerName: b.trainerId ? b.trainer : null,
                              trainerUnavailable: b.trainerUnavailable === true,
                            })
                          }
                        >
                          <UserCog className="h-3.5 w-3.5" /> {b.trainerId ? "Change trainer" : "Assign trainer"}
                        </DropdownItem>
                      )}
                    </Dropdown>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {assignment && <AssignTrainerDialog batch={assignTarget} trainers={assignment.trainers} onClose={() => setAssignTarget(null)} />}
    </div>
  );
}
