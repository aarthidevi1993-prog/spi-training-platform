"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, MoreHorizontal, Eye, Pencil, Trash2 } from "lucide-react";
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
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Badge } from "@/components/ui/Badge";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { RemoveAccountDialog } from "@/components/modules/RemoveAccountDialog";
import { DEFAULT_USER_FILTERS, userDetailHref, userEditDetailsHref } from "@/lib/user-management/users";
import type { TrainerSummary } from "@/types/trainer";

const PAGE_SIZE = 5;
/** The Super Admin Users page; `?user=<id>` opens the account panel (trainers.id is the account id). */
const ADMIN_USERS_PATH = "/admin/users";

/** A removed (deactivated) account shows as Suspended, whatever its record status (P3.11-B). */
function displayStatus(t: TrainerSummary): string {
  return t.accountStatus === "suspended" ? "suspended" : t.status;
}

/**
 * "Edit trainer" only for an account whose current role is trainer (P3.11-C): a stale trainer record (role since
 * changed) would open the account's OTHER record in the panel, so it gets View profile only.
 */
function canEditAsTrainer(t: TrainerSummary): boolean {
  return t.accountRole === "trainer";
}

/** Remove is offered only where it can succeed: an active account (invited/suspended are refused). */
function canRemove(t: TrainerSummary): boolean {
  return t.accountStatus !== "suspended" && t.accountStatus !== "invited";
}

export function TrainersTable({ rows }: { rows: TrainerSummary[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const router = useRouter();

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const matchesQuery =
        query.trim() === "" ||
        r.name.toLowerCase().includes(query.toLowerCase()) ||
        r.email.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = status === "all" || displayStatus(r) === status;
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
            placeholder="Search trainers…"
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
            { label: "Active", value: "active" },
            { label: "Invited", value: "invited" },
            { label: "Inactive", value: "inactive" },
            { label: "Suspended (removed)", value: "suspended" },
          ]}
        />
      </div>

      {paged.length === 0 ? (
        <EmptyState title="No trainers match your search" description="Try a different name, email, or status filter." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Trainer</TableHeaderCell>
              <TableHeaderCell>Assigned Courses</TableHeaderCell>
              <TableHeaderCell>Assigned Batches</TableHeaderCell>
              <TableHeaderCell>Students</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar name={t.name} size="sm" tone="blue" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{t.name}</p>
                      <p className="truncate text-xs text-ink-muted">{t.email}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {t.courses.length > 0 ? (
                      t.courses.map((c) => (
                        <Badge key={c} tone="neutral">
                          {c}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{t.batches.length > 0 ? t.batches.join(", ") : <span className="text-xs text-ink-faint">—</span>}</TableCell>
                <TableCell>{t.students}</TableCell>
                <TableCell>
                  <StatusBadge status={displayStatus(t)} />
                </TableCell>
                <TableCell className="text-right">
                  <Dropdown
                    align="right"
                    trigger={
                      <button
                        aria-label={`Actions for ${t.name}`}
                        className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    }
                  >
                    {/* P3.11-C: the trainer's existing account panel on the Users page (the server re-checks Super Admin). */}
                    <DropdownItem onClick={() => router.push(userDetailHref(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, t.id))}>
                      <Eye className="h-3.5 w-3.5" /> View profile
                    </DropdownItem>
                    {canEditAsTrainer(t) && (
                      <DropdownItem onClick={() => router.push(userEditDetailsHref(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, t.id))}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </DropdownItem>
                    )}
                    {/* P3.11-B: Remove deactivates the account after confirmation (nothing is deleted); the server refuses
                        while the trainer still has current batches or scheduled/live classes. */}
                    {canRemove(t) && (
                      <DropdownItem onClick={() => setRemoveTarget({ id: t.id, name: t.name })} className="text-signal-red">
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </DropdownItem>
                    )}
                  </Dropdown>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <RemoveAccountDialog kind="trainer" target={removeTarget} onClose={() => setRemoveTarget(null)} />
    </div>
  );
}
