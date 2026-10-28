import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Clock3, XCircle } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/utils/format";
import type { AttemptFinalizeReason, StudentAttemptResult } from "@/types/student-test";

const REASON_LABEL: Record<AttemptFinalizeReason, string> = {
  student_submit: "Submitted by you",
  deadline: "Submitted automatically when time ran out",
  test_closed: "Closed when the test was closed",
  class_cancelled: "Closed because the class was cancelled",
  batch_cancelled: "Closed because the batch was cancelled",
  withdrawn: "Closed because you were withdrawn from the batch",
  enrollment_ended: "Closed because your enrolment ended",
};

/**
 * A finished attempt. Before the test closes: state only (no score,
 * pass/fail, correct answers or explanations — the database doesn't
 * release them). After it closes: exactly what get_attempt_result()
 * returns — nothing is calculated here.
 */
export function AttemptResultView({ result: r }: { result: StudentAttemptResult }) {
  return (
    <div>
      <Link href={`/student/tests/${r.testId}`} className="mb-3 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to test
      </Link>

      <PageHeader
        title={r.testTitle}
        description={`Attempt ${r.attemptNumber}${r.finalizeReason ? ` · ${REASON_LABEL[r.finalizeReason] ?? r.finalizeReason}` : ""}`}
        actions={
          r.released ? (
            <Badge tone={r.released.passed ? "green" : "red"}>{r.released.passed ? "Passed" : "Not passed"}</Badge>
          ) : (
            <Badge tone="blue">{r.status === "in_progress" ? "In progress" : "Submitted"}</Badge>
          )
        }
      />

      {!r.released ? (
        <Card className="mx-auto max-w-lg">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Clock3 className="h-7 w-7 text-signal-blue" />
            <h2 className="text-lg font-semibold text-ink">Your attempt has been recorded</h2>
            <p className="text-sm text-ink-muted">
              You answered {r.answeredCount} of {r.questionCount} questions
              {r.finalizedAt ? ` · finished ${formatDateTime(r.finalizedAt)} (India time)` : ""}.
            </p>
            <p className="text-sm text-ink-muted">
              Your score, the correct answers and explanations will be available here after the test closes.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Score</p>
                <p className="mt-1 text-lg font-semibold text-ink">
                  {r.released.score} / {r.released.maxScore}
                </p>
              </div>
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Percentage</p>
                <p className="mt-1 text-lg font-semibold text-ink">{r.released.percentage}%</p>
              </div>
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Pass mark</p>
                <p className="mt-1 text-lg font-semibold text-ink">
                  {r.released.passMarkPercent !== null ? `${r.released.passMarkPercent}%` : "—"}
                </p>
              </div>
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Attempt</p>
                <p className="mt-1 text-sm text-ink">
                  {r.attemptNumber}
                  {r.released.isBestAttempt && <span className="ml-2 text-xs font-medium text-signal-green">Best result</span>}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-ink">Review</h2>
              <ol className="flex flex-col gap-3">
                {r.released.review.map((q, index) => (
                  <li key={index} className="rounded-md border border-surface-border px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium text-ink">
                        {index + 1}. {q.questionText}
                      </p>
                      <span className={q.isCorrect ? "text-signal-green" : "text-signal-red"}>
                        {q.isCorrect ? (
                          <CheckCircle2 className="h-4 w-4" aria-label="Correct" />
                        ) : (
                          <XCircle className="h-4 w-4" aria-label="Incorrect" />
                        )}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {q.marksAwarded ?? 0} / {q.marks} {q.marks === 1 ? "mark" : "marks"}
                    </p>
                    <ul className="mt-2 flex flex-col gap-1">
                      {q.options.map((o) => (
                        <li key={o.id} className="flex items-center gap-2 text-sm">
                          {o.isCorrect ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-signal-green" aria-label="Correct answer" />
                          ) : o.selected ? (
                            <XCircle className="h-4 w-4 shrink-0 text-signal-red" aria-label="Your incorrect choice" />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                          )}
                          <span className={o.isCorrect ? "font-medium text-ink" : "text-ink-muted"}>{o.text}</span>
                          {o.selected && <span className="text-2xs text-ink-faint">(your answer)</span>}
                        </li>
                      ))}
                    </ul>
                    {q.explanation && (
                      <p className="mt-2 rounded bg-surface-sunken px-3 py-2 text-xs text-ink-muted">{q.explanation}</p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
