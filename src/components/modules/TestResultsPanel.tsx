"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, Info, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { finalizeOverdueAttemptsAction } from "@/services/results.actions";
import { formatDateTime } from "@/utils/format";
import type { AttemptFinalizeReason, AttemptStatus } from "@/types/student-test";
import type { StaffTestResultsState } from "@/types/test-result";

const STATUS_LABEL: Record<AttemptStatus, string> = {
  in_progress: "In progress",
  submitted: "Submitted",
  finalized: "Finalized",
};

const REASON_LABEL: Record<AttemptFinalizeReason, string> = {
  student_submit: "submitted by student",
  deadline: "time ran out",
  test_closed: "test closed",
  class_cancelled: "class cancelled",
  batch_cancelled: "batch cancelled",
  withdrawn: "student withdrawn",
  enrollment_ended: "enrolment ended",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  );
}

/**
 * Staff results for one test (Super Admin / the batch's current
 * trainer). Everything shown is read from the database as graded —
 * nothing is calculated from answers here. Activity indicators are
 * prompts for review, never a finding of misconduct.
 */
export function TestResultsPanel({ testId, state }: { testId: string; state: StaffTestResultsState }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function finalize() {
    startTransition(async () => {
      const result = await finalizeOverdueAttemptsAction(testId);
      setConfirming(false);
      if (!result.ok) {
        showToast({ variant: "error", title: "Couldn't finalize attempts", description: result.error });
        return;
      }
      showToast({
        variant: "success",
        title: result.finalized ? `${result.finalized} attempt${result.finalized === 1 ? "" : "s"} finalized.` : "No attempts were due.",
      });
      router.refresh();
    });
  }

  if (state.kind === "draft") return null;

  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <BarChart3 className="h-4 w-4 text-ink-muted" /> Results
          </h2>
          {state.kind === "ready" && state.results.canFinalize && state.results.totals.attemptsInProgress > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setConfirming(true)} disabled={isPending}>
              Finalize overdue attempts
            </Button>
          )}
        </div>

        {state.kind === "unavailable" ? (
          <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2.5 text-sm text-ink-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>Results are visible to Super Admins and the batch&rsquo;s current trainer while the batch is upcoming or ongoing.</span>
          </div>
        ) : state.kind === "error" ? (
          <p className="text-sm text-signal-red">{state.message}</p>
        ) : state.results.students.length === 0 ? (
          <EmptyState title="No attempts yet" description="Results will appear here once students start this test." />
        ) : (
          <ReadyResults state={state} />
        )}
      </CardContent>

      <Dialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={finalize}
        title="Finalize overdue attempts?"
        description="The database will submit and grade in-progress attempts that must stop now (time ran out, the test closed, or the class, batch or enrolment ended). Attempts still within their time are not affected."
        confirmLabel="Finalize"
        tone="primary"
        isLoading={isPending}
      />
    </Card>
  );
}

function ReadyResults({ state }: { state: Extract<StaffTestResultsState, { kind: "ready" }> }) {
  const { totals, students, questions, indicators } = state.results;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Students attempted" value={String(totals.studentsAttempted)} />
        <Stat label="With a result" value={String(totals.studentsWithResult)} />
        <Stat label="Pass rate" value={totals.passRate !== null ? `${totals.passRate}%` : "—"} />
        <Stat label="Average best score" value={totals.averageBestPercentage !== null ? `${totals.averageBestPercentage}%` : "—"} />
        <Stat
          label="In progress"
          value={`${totals.attemptsInProgress}${totals.attemptsOverdue > 0 ? ` (${totals.attemptsOverdue} overdue)` : ""}`}
        />
      </div>

      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Student</TableHeaderCell>
            <TableHeaderCell>Attempts</TableHeaderCell>
            <TableHeaderCell>Best score</TableHeaderCell>
            <TableHeaderCell>Best %</TableHeaderCell>
            <TableHeaderCell>Result</TableHeaderCell>
            <TableHeaderCell>Latest attempt</TableHeaderCell>
            <TableHeaderCell>Indicators</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {students.map((s) => (
            <TableRow key={s.studentId}>
              <TableCell className="font-medium text-ink">
                {s.studentName}
                {s.studentCode && <span className="block text-2xs font-normal text-ink-faint">{s.studentCode}</span>}
              </TableCell>
              <TableCell>
                {s.attemptsUsed}
                {s.finishedAttempts !== s.attemptsUsed && <span className="block text-2xs text-ink-faint">{s.finishedAttempts} finished</span>}
              </TableCell>
              <TableCell>{s.best ? `${s.best.score}/${s.best.maxScore}` : "—"}</TableCell>
              <TableCell>{s.best ? `${s.best.percentage}%` : "—"}</TableCell>
              <TableCell>
                {s.best ? (
                  <Badge tone={s.best.passed ? "green" : "red"}>{s.best.passed ? "Passed" : "Not passed"}</Badge>
                ) : (
                  <span className="text-xs text-ink-faint">No finished attempt</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {s.latest ? (
                  <>
                    #{s.latest.attemptNumber} · {STATUS_LABEL[s.latest.status] ?? s.latest.status}
                    {s.latest.finalizeReason && ` (${REASON_LABEL[s.latest.finalizeReason] ?? s.latest.finalizeReason})`}
                    <span className="block text-2xs text-ink-faint">
                      {s.latest.finalizedAt ? `Finished ${formatDateTime(s.latest.finalizedAt)}` : `Started ${formatDateTime(s.latest.startedAt)}`}
                    </span>
                  </>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>{s.indicatorCount > 0 ? <Badge tone="amber">{s.indicatorCount}</Badge> : <span className="text-xs text-ink-faint">0</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-2xs text-ink-faint">Times are India time. Best result = highest percentage across the student&rsquo;s finished attempts.</p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Question correctness</h3>
          <p className="mb-3 text-xs text-ink-muted">Share of finished attempts that answered each question correctly.</p>
          <div className="flex flex-col gap-3">
            {questions.map((q) => (
              <div key={q.testQuestionId}>
                {q.correctPercent === null ? (
                  <p className="text-xs text-ink-muted">
                    {q.position}. {q.questionText} <span className="text-ink-faint">— no finished attempts yet</span>
                  </p>
                ) : (
                  <ProgressBar
                    value={q.correctPercent}
                    label={`${q.position}. ${q.questionText} (${q.correct}/${q.graded})`}
                    tone={q.correctPercent >= 80 ? "teal" : q.correctPercent >= 65 ? "amber" : "red"}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <ShieldAlert className="h-4 w-4 text-ink-muted" /> Activity indicators
          </h3>
          <p className="mb-3 text-xs text-ink-muted">
            Recorded automatically by the test engine. They are prompts for review only and do not mean a student did anything wrong.
          </p>
          {indicators.length === 0 ? (
            <p className="text-xs text-ink-faint">No indicators recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {indicators.map((i) => (
                <li key={i.eventType} className="flex items-start justify-between gap-3 text-xs text-ink-muted">
                  <span>{i.label}</span>
                  <span className="font-mono text-ink">{i.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
