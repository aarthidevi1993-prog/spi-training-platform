"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, FileQuestion, Plus } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateTime } from "@/utils/format";
import { TEST_TYPE_LABEL, type TestManagementData, type TestType } from "@/types/test";
import { TestEditor } from "./TestEditor";

export interface TestsGridProps {
  data: TestManagementData;
  /** Route prefix for test detail links, e.g. "/admin/tests". */
  basePath: string;
}

/**
 * Admin/Trainer test list (real data). Search + status/type/batch
 * filters, and a "Create test" modal limited to the classes the server
 * says the caller may manage. Status shown is the effective status
 * (scheduled → active → closed moves with time).
 */
export function TestsGrid({ data, basePath }: TestsGridProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [batch, setBatch] = useState("all");
  const [creating, setCreating] = useState(false);

  const batches = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of data.tests) seen.set(t.batchId, t.batchCode || t.batchName);
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data.tests]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.tests.filter(
      (t) =>
        (q === "" ||
          t.title.toLowerCase().includes(q) ||
          t.classTitle.toLowerCase().includes(q) ||
          t.batchName.toLowerCase().includes(q) ||
          t.batchCode.toLowerCase().includes(q) ||
          t.courseCode.toLowerCase().includes(q)) &&
        (status === "all" || t.effectiveStatus === status) &&
        (type === "all" || t.testType === type) &&
        (batch === "all" || t.batchId === batch)
    );
  }, [data.tests, query, status, type, batch]);

  if (!data.enabled) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Test management requires Supabase mode."
        description="Sign in with a Supabase account to create and manage tests."
      />
    );
  }

  const canCreate = data.classes.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input aria-label="Search tests" placeholder="Search tests, classes, batches…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
          </div>
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="sm:w-40"
            options={[
              { label: "All statuses", value: "all" },
              { label: "Draft", value: "draft" },
              { label: "Scheduled", value: "scheduled" },
              { label: "Active", value: "active" },
              { label: "Closed", value: "closed" },
            ]}
          />
          <Select
            aria-label="Filter by type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="sm:w-40"
            options={[
              { label: "All types", value: "all" },
              ...(Object.keys(TEST_TYPE_LABEL) as TestType[]).map((t) => ({ label: TEST_TYPE_LABEL[t], value: t })),
            ]}
          />
          <Select
            aria-label="Filter by batch"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            className="sm:w-44"
            options={[{ label: "All batches", value: "all" }, ...batches]}
          />
        </div>
        <div>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!canCreate}>
            <Plus className="h-4 w-4" /> Create test
          </Button>
        </div>
      </div>

      {data.tests.length === 0 ? (
        <EmptyState
          icon={FileQuestion}
          title={canCreate ? "No tests yet" : "No classes to create tests for"}
          description={
            canCreate
              ? "Create a draft test for a class, add questions from the Question Bank, then publish it."
              : "You can create tests once you're the current trainer of an upcoming or ongoing batch."
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileQuestion} title="No tests match your filters" description="Try a different search, status, type or batch." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Test</TableHeaderCell>
              <TableHeaderCell>Class / Batch</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Pass mark</TableHeaderCell>
              <TableHeaderCell>Time limit</TableHeaderCell>
              <TableHeaderCell>Attempts</TableHeaderCell>
              <TableHeaderCell>Opens (India time)</TableHeaderCell>
              <TableHeaderCell>Closes (India time)</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="max-w-xs">
                  <Link href={`${basePath}/${t.id}`} className="block truncate font-medium text-signal-blue hover:underline">
                    {t.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                    <Badge tone="neutral">{TEST_TYPE_LABEL[t.testType]}</Badge>
                    {t.questionCount !== null && <span>{t.questionCount} questions</span>}
                    {!t.canManage && <Badge tone="neutral">Read only</Badge>}
                  </div>
                </TableCell>
                <TableCell>
                  <p className="text-ink">{t.classTitle}</p>
                  <p className="text-xs text-ink-muted">
                    {t.batchCode || t.batchName}
                    {t.courseCode ? ` · ${t.courseCode}` : ""}
                  </p>
                </TableCell>
                <TableCell>
                  <StatusBadge status={t.effectiveStatus} />
                </TableCell>
                <TableCell>{t.passMarkPercent !== null ? `${t.passMarkPercent}%` : "—"}</TableCell>
                <TableCell>{t.timeLimitMinutes !== null ? `${t.timeLimitMinutes} min` : "—"}</TableCell>
                <TableCell>{t.attemptLimit}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">{t.availableFrom ? formatDateTime(t.availableFrom) : "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">{t.availableUntil ? formatDateTime(t.availableUntil) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {creating && (
        <TestEditor
          classes={data.classes}
          onClose={() => setCreating(false)}
          onSaved={(id) => router.push(`${basePath}/${id}`)}
        />
      )}
    </div>
  );
}
