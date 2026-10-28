"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Info } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { saveClassAttendanceAction } from "@/services/attendance.actions";
import { formatDate } from "@/utils/format";
import {
  ATTENDANCE_REMARKS_MAX_LENGTH,
  type AttendanceMarkInput,
  type AttendanceStatus,
  type ClassAttendanceRoster,
} from "@/types/attendance";

const STATUS_OPTIONS: { label: string; value: AttendanceStatus }[] = [
  { label: "Present", value: "present" },
  { label: "Absent", value: "absent" },
  { label: "Late", value: "late" },
  { label: "Excused", value: "excused" },
];

type Draft = { status: AttendanceStatus | ""; remarks: string };

/**
 * Class detail → Attendance tab. Trainers (for batches they run) and
 * admins mark each student Present / Absent / Late / Excused with an
 * optional remark; everyone else sees a read-only list (a student only
 * ever receives their own line). Unmarked students stay unmarked — they
 * are never saved as absent.
 */
export function AttendanceRoster({ roster }: { roster: ClassAttendanceRoster }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();

  const initial = useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const e of roster.entries) map[e.studentId] = { status: e.status ?? "", remarks: e.remarks ?? "" };
    return map;
  }, [roster.entries]);

  const [drafts, setDrafts] = useState<Record<string, Draft>>(initial);
  const [error, setError] = useState<string | null>(null);

  // Only rows that changed and have a status are sent.
  const changes: AttendanceMarkInput[] = roster.entries
    .filter((e) => e.editable)
    .flatMap((e) => {
      const d = drafts[e.studentId];
      const before = initial[e.studentId];
      if (!d || !before || d.status === "") return [];
      if (d.status === before.status && d.remarks.trim() === before.remarks.trim()) return [];
      return [{ studentId: e.studentId, status: d.status, remarks: d.remarks.trim() || null }];
    });

  function update(studentId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [studentId]: { ...(prev[studentId] ?? { status: "", remarks: "" }), ...patch } }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveClassAttendanceAction(roster.classId, changes);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't save attendance", description: result.error });
        return;
      }
      showToast({ variant: "success", title: "Attendance saved." });
      router.refresh();
    });
  }

  if (roster.entries.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No students on this class's roster"
        description="Students enrolled in the class's batch will appear here."
      />
    );
  }

  const editing = roster.canMark;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {roster.readOnlyReason && (
          <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2.5 text-sm text-ink-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{roster.readOnlyReason}</span>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-signal-red">
            {error}
          </p>
        )}

        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Student</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Remarks</TableHeaderCell>
              <TableHeaderCell>Last marked</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {roster.entries.map((e) => {
              const d = drafts[e.studentId] ?? { status: "", remarks: "" };
              const canEditRow = editing && e.editable;
              return (
                <TableRow key={e.studentId}>
                  <TableCell>
                    <p className="text-sm font-medium text-ink">{e.name}</p>
                    <p className="text-xs text-ink-muted">
                      {e.studentCode}
                      {!e.editable && " · no longer enrolled"}
                    </p>
                  </TableCell>
                  <TableCell className="w-44">
                    {canEditRow ? (
                      <Select
                        aria-label={`Attendance for ${e.name}`}
                        value={d.status}
                        onChange={(ev) => update(e.studentId, { status: ev.target.value as AttendanceStatus | "" })}
                        disabled={isPending}
                        placeholder="Not marked"
                        options={STATUS_OPTIONS}
                      />
                    ) : e.status ? (
                      <StatusBadge status={e.status} />
                    ) : (
                      <span className="text-xs text-ink-faint">Not yet marked</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canEditRow ? (
                      <Input
                        aria-label={`Remarks for ${e.name}`}
                        value={d.remarks}
                        maxLength={ATTENDANCE_REMARKS_MAX_LENGTH}
                        onChange={(ev) => update(e.studentId, { remarks: ev.target.value })}
                        disabled={isPending}
                        placeholder="Optional"
                      />
                    ) : (
                      <span className="text-sm text-ink-muted">{e.remarks ?? "—"}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-ink-muted">{e.markedAt ? formatDate(e.markedAt) : "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

      {editing && (
        <CardFooter>
          <p className="mr-auto text-xs text-ink-muted">
            {changes.length === 0 ? "No unsaved changes." : `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}.`}
          </p>
          <Button type="button" onClick={save} isLoading={isPending} disabled={changes.length === 0}>
            {isPending ? "Saving…" : "Save attendance"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
