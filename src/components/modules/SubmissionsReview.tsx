"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
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
import { reopenSubmissionAction, returnSubmissionAction } from "@/services/assignments.actions";
import { formatDateTime } from "@/utils/format";
import { ASSIGNMENT_LIMITS, type AssignmentRosterEntry, type AssignmentView } from "@/types/assignment";

type Draft = { score: string; feedback: string };

/**
 * Manager review table: the batch roster with each student's
 * submission. Managers can Return (optional score + feedback) or Reopen
 * a returned submission. A student's submitted link and note are shown
 * read-only — there are deliberately no controls to edit them.
 */
export function SubmissionsReview({ assignment }: { assignment: AssignmentView }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [busyStudent, setBusyStudent] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const roster: AssignmentRosterEntry[] = assignment.roster ?? [];
  const submittedCount = roster.filter((r) => r.submission).length;

  function draftFor(studentId: string): Draft {
    return drafts[studentId] ?? { score: "", feedback: "" };
  }

  function update(studentId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [studentId]: { ...draftFor(studentId), ...patch } }));
  }

  function act(studentId: string, kind: "return" | "reopen") {
    const d = draftFor(studentId);
    setBusyStudent(studentId);
    startTransition(async () => {
      const result =
        kind === "return"
          ? await returnSubmissionAction(assignment.id, studentId, {
              score: d.score.trim() === "" ? null : Number(d.score),
              feedback: d.feedback || null,
            })
          : await reopenSubmissionAction(assignment.id, studentId);
      setBusyStudent(null);

      if (!result.ok) {
        showToast({ variant: "error", title: "Couldn't update the submission", description: result.error });
        return;
      }
      showToast({ variant: "success", title: kind === "return" ? "Submission returned." : "Submission reopened." });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[studentId];
        return next;
      });
      router.refresh();
    });
  }

  if (roster.length === 0) {
    return <EmptyState title="No students in this batch" description="Enrolled students will appear here." />;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">
        {submittedCount} of {roster.filter((r) => r.current).length} current students submitted.
      </p>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Student</TableHeaderCell>
            <TableHeaderCell>Submission</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Review</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {roster.map((r) => {
            const s = r.submission;
            const d = draftFor(r.studentId);
            const busy = isPending && busyStudent === r.studentId;
            return (
              <TableRow key={r.studentId}>
                <TableCell>
                  <p className="text-sm font-medium text-ink">{r.name}</p>
                  <p className="text-xs text-ink-muted">
                    {r.studentCode}
                    {!r.current && " · no longer enrolled"}
                  </p>
                </TableCell>
                <TableCell>
                  {s ? (
                    <div className="flex flex-col gap-1">
                      <a
                        href={s.submissionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-signal-blue hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open work
                      </a>
                      <span className="text-xs text-ink-muted">
                        {formatDateTime(s.submittedAt)} {s.isLate && <Badge tone="amber">Late</Badge>}
                      </span>
                      {s.note && <span className="text-xs text-ink-muted">“{s.note}”</span>}
                    </div>
                  ) : (
                    <span className="text-xs text-ink-faint">Not submitted</span>
                  )}
                </TableCell>
                <TableCell>{s ? <StatusBadge status={s.status} /> : <span className="text-xs text-ink-faint">—</span>}</TableCell>
                <TableCell className="min-w-[220px]">
                  {!s ? (
                    <span className="text-xs text-ink-faint">—</span>
                  ) : s.status === "returned" ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm text-ink">
                        {s.score !== null
                          ? `Score ${s.score}${assignment.maxScore !== null ? ` / ${assignment.maxScore}` : ""}`
                          : "No score"}
                      </span>
                      {s.feedback && <span className="text-xs text-ink-muted">{s.feedback}</span>}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => act(r.studentId, "reopen")}
                        isLoading={busy}
                        disabled={isPending}
                      >
                        Reopen
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Input
                        aria-label={`Score for ${r.name}`}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        max={assignment.maxScore ?? undefined}
                        value={d.score}
                        onChange={(e) => update(r.studentId, { score: e.target.value })}
                        disabled={isPending}
                        placeholder={assignment.maxScore !== null ? `Score (max ${assignment.maxScore})` : "Score (optional)"}
                      />
                      <Input
                        aria-label={`Feedback for ${r.name}`}
                        value={d.feedback}
                        maxLength={ASSIGNMENT_LIMITS.feedbackMax}
                        onChange={(e) => update(r.studentId, { feedback: e.target.value })}
                        disabled={isPending}
                        placeholder="Feedback (optional)"
                      />
                      <Button size="sm" onClick={() => act(r.studentId, "return")} isLoading={busy} disabled={isPending}>
                        Return
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
