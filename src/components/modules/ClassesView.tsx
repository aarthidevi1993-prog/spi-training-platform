"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, CalendarDays, Clock, UserRound, Video, MoreHorizontal, Eye, Pencil, Ban, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Card, CardContent } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/utils/format";
import { cn } from "@/utils/cn";
import { cancelClassAction, deleteClassAction } from "@/services/classes.actions";
import type { ClassWithRelations, ClassDateRange } from "@/types/class";
import type { ClassFilterOptions } from "@/types/class";

const typeDot: Record<ClassWithRelations["classType"], string> = {
  offline: "bg-primary-500",
  hybrid: "bg-brand-gold",
  online: "bg-signal-blue",
};

const DATE_RANGE_OPTIONS: { label: string; value: ClassDateRange }[] = [
  { label: "All dates", value: "all" },
  { label: "Today", value: "today" },
  { label: "Upcoming", value: "upcoming" },
  { label: "This week", value: "this_week" },
  { label: "Completed", value: "completed" },
];

export interface ClassesViewProps {
  classes: ClassWithRelations[];
  options: ClassFilterOptions;
  /** Route prefix for detail links, e.g. "/admin/classes". */
  basePath: string;
  /** Admin/trainer get row actions; students get a read-only list. */
  canManage?: boolean;
  /** Only admins may hard-delete. */
  canDelete?: boolean;
  /** Hide redundant columns in the trainer's own view. */
  showTrainer?: boolean;
  /** Set when the server failed to load the list. */
  loadError?: string | null;
}

export function ClassesView({
  classes,
  options,
  basePath,
  canManage = false,
  canDelete = false,
  showTrainer = true,
  loadError = null,
}: ClassesViewProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [classType, setClassType] = useState("all");
  const [courseId, setCourseId] = useState("all");
  const [batchId, setBatchId] = useState("all");
  const [trainerId, setTrainerId] = useState("all");
  const [dateRange, setDateRange] = useState<ClassDateRange>("all");
  const [pendingCancel, setPendingCancel] = useState<ClassWithRelations | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClassWithRelations | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { showToast } = useToast();

  // Client-side narrowing of the already role-scoped server result —
  // a responsiveness convenience, never a security boundary.
  const filtered = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    return classes.filter((c) => {
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const haystack = `${c.title} ${c.courseTitle} ${c.batchName} ${c.trainerName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (status !== "all" && c.status !== status) return false;
      if (classType !== "all" && c.classType !== classType) return false;
      if (courseId !== "all" && c.courseId !== courseId) return false;
      if (batchId !== "all" && c.batchId !== batchId) return false;
      if (trainerId !== "all" && c.trainerId !== trainerId) return false;

      if (dateRange === "today" && c.classDate !== today) return false;
      if (dateRange === "upcoming" && !(c.classDate >= today && c.status !== "cancelled")) return false;
      if (dateRange === "this_week" && !(c.classDate >= today && c.classDate <= weekEndStr)) return false;
      if (dateRange === "completed" && c.status !== "completed") return false;

      return true;
    });
  }, [classes, query, status, classType, courseId, batchId, trainerId, dateRange]);

  async function runCancel() {
    if (!pendingCancel) return;
    setIsSubmitting(true);
    const result = await cancelClassAction(pendingCancel.id);
    setIsSubmitting(false);
    setPendingCancel(null);
    showToast(
      result.ok
        ? { variant: "success", title: "Class cancelled." }
        : { variant: "error", title: "Couldn't cancel the class", description: result.errors?.form }
    );
  }

  async function runDelete() {
    if (!pendingDelete) return;
    setIsSubmitting(true);
    const result = await deleteClassAction(pendingDelete.id);
    setIsSubmitting(false);
    setPendingDelete(null);
    showToast(
      result.ok
        ? { variant: "success", title: "Class deleted." }
        : { variant: "error", title: "Couldn't delete the class", description: result.errors?.form }
    );
  }

  if (loadError) {
    return <ErrorState title="We couldn't load the classes" description={loadError} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-col gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <Input
            placeholder="Search classes…"
            aria-label="Search classes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Select
            aria-label="Filter by date"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as ClassDateRange)}
            options={DATE_RANGE_OPTIONS}
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { label: "All statuses", value: "all" },
              { label: "Scheduled", value: "scheduled" },
              { label: "Live", value: "live" },
              { label: "Completed", value: "completed" },
              { label: "Cancelled", value: "cancelled" },
            ]}
          />
          <Select
            aria-label="Filter by type"
            value={classType}
            onChange={(e) => setClassType(e.target.value)}
            options={[
              { label: "All types", value: "all" },
              { label: "Online", value: "online" },
              { label: "Offline", value: "offline" },
              { label: "Hybrid", value: "hybrid" },
            ]}
          />
          <Select
            aria-label="Filter by course"
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            options={[{ label: "All courses", value: "all" }, ...options.courses.map((c) => ({ label: c.title, value: c.id }))]}
          />
          <Select
            aria-label="Filter by batch"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            options={[{ label: "All batches", value: "all" }, ...options.batches.map((b) => ({ label: b.name, value: b.id }))]}
          />
          {showTrainer && (
            <Select
              aria-label="Filter by trainer"
              value={trainerId}
              onChange={(e) => setTrainerId(e.target.value)}
              options={[{ label: "All trainers", value: "all" }, ...options.trainers.map((t) => ({ label: t.name, value: t.id }))]}
            />
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={classes.length === 0 ? "No classes scheduled yet." : "No classes match your filters"}
          description={
            classes.length === 0
              ? "Once classes are scheduled they'll appear here."
              : "Try a different search term, date range, or filter."
          }
        />
      ) : (
        <>
          {/* Desktop: table. Hidden on small screens in favour of the cards below. */}
          <div className="hidden overflow-x-auto rounded-md border border-surface-border bg-surface-raised lg:block">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Class</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Course / Module</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Batch</th>
                  {showTrainer && (
                    <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Trainer</th>
                  )}
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Date &amp; time</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Type</th>
                  <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">Status</th>
                  <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wide text-ink-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-sunken/60">
                    <td className="px-4 py-3">
                      <Link href={`${basePath}/${c.id}`} className="font-medium text-ink hover:underline">
                        {c.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {c.courseTitle}
                      {c.moduleTitle && <span className="block text-xs text-ink-muted">{c.moduleTitle}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink">{c.batchName}</td>
                    {showTrainer && <td className="px-4 py-3 text-ink">{c.trainerName}</td>}
                    <td className="px-4 py-3 text-ink">
                      {formatDate(c.classDate)}
                      <span className="block text-xs text-ink-muted">
                        {c.startTime}–{c.endTime}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 capitalize text-ink">
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", typeDot[c.classType])} />
                        {c.classType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowActions
                        item={c}
                        basePath={basePath}
                        canManage={canManage}
                        canDelete={canDelete}
                        onCancel={setPendingCancel}
                        onDelete={setPendingDelete}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / tablet: stacked cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:hidden">
            {filtered.map((c) => (
              <Card key={c.id}>
                <CardContent className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`${basePath}/${c.id}`} className="text-sm font-semibold text-ink hover:underline">
                      {c.title}
                    </Link>
                    <StatusBadge status={c.status} />
                  </div>
                  <p className="text-xs text-ink-muted">
                    {c.courseTitle}
                    {c.moduleTitle ? ` · ${c.moduleTitle}` : ""}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                    <span className="flex items-center gap-1">
                      <CalendarDays className="h-3.5 w-3.5" /> {formatDate(c.classDate)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" /> {c.startTime}–{c.endTime}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-xs text-ink-muted">
                      <Badge tone="neutral">{c.batchName}</Badge>
                      {showTrainer && (
                        <span className="flex items-center gap-1">
                          <UserRound className="h-3.5 w-3.5" /> {c.trainerName}
                        </span>
                      )}
                    </span>
                    <RowActions
                      item={c}
                      basePath={basePath}
                      canManage={canManage}
                      canDelete={canDelete}
                      onCancel={setPendingCancel}
                      onDelete={setPendingDelete}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <Dialog
        isOpen={pendingCancel !== null}
        onClose={() => setPendingCancel(null)}
        onConfirm={runCancel}
        title="Cancel this class?"
        description={
          pendingCancel
            ? `"${pendingCancel.title}" will be marked as cancelled. Its history is kept and it can be rescheduled later.`
            : undefined
        }
        confirmLabel="Cancel class"
        cancelLabel="Keep class"
        tone="danger"
        isLoading={isSubmitting}
      />

      <Dialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={runDelete}
        title="Delete this class permanently?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" will be removed for good. This can't be undone — cancel it instead if you may need the record.`
            : undefined
        }
        confirmLabel="Delete permanently"
        tone="danger"
        isLoading={isSubmitting}
      />
    </div>
  );
}

function RowActions({
  item,
  basePath,
  canManage,
  canDelete,
  onCancel,
  onDelete,
}: {
  item: ClassWithRelations;
  basePath: string;
  canManage: boolean;
  canDelete: boolean;
  onCancel: (c: ClassWithRelations) => void;
  onDelete: (c: ClassWithRelations) => void;
}) {
  const canJoin = item.teamsMeetingUrl && item.status !== "cancelled" && item.status !== "completed";

  if (!canManage) {
    return (
      <div className="flex items-center justify-end gap-2">
        {canJoin && (
          <a
            href={item.teamsMeetingUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-sunken"
          >
            <Video className="h-3.5 w-3.5" /> Join
          </a>
        )}
        <Link
          href={`${basePath}/${item.id}`}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-signal-blue hover:underline"
        >
          View
        </Link>
      </div>
    );
  }

  return (
    <Dropdown
      align="right"
      trigger={
        <button aria-label={`Actions for ${item.title}`} className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      }
    >
      <DropdownItem onClick={() => window.location.assign(`${basePath}/${item.id}`)}>
        <Eye className="h-3.5 w-3.5" /> View details
      </DropdownItem>
      <DropdownItem onClick={() => window.location.assign(`${basePath}/${item.id}/edit`)}>
        <Pencil className="h-3.5 w-3.5" /> Edit
      </DropdownItem>
      {item.status !== "cancelled" && (
        <DropdownItem onClick={() => onCancel(item)} className="text-signal-amber">
          <Ban className="h-3.5 w-3.5" /> Cancel class
        </DropdownItem>
      )}
      {canDelete && item.status !== "completed" && (
        <DropdownItem onClick={() => onDelete(item)} className="text-signal-red">
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </DropdownItem>
      )}
    </Dropdown>
  );
}
