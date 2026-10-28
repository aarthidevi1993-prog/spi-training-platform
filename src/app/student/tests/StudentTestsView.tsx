import Link from "next/link";
import { FileQuestion, Clock, CalendarClock, RotateCcw, PlayCircle, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateTime } from "@/utils/format";
import { TEST_TYPE_LABEL } from "@/types/test";
import type { StudentTestState, StudentTestSummary } from "@/types/student-test";

export const STUDENT_TEST_STATE: Record<StudentTestState, { label: string; tone: BadgeProps["tone"] }> = {
  scheduled: { label: "Scheduled", tone: "blue" },
  available: { label: "Available", tone: "green" },
  in_progress: { label: "In progress", tone: "amber" },
  submitted: { label: "Submitted", tone: "blue" },
  closed: { label: "Closed", tone: "neutral" },
  attempts_exhausted: { label: "Attempts used", tone: "neutral" },
  not_available: { label: "Not available", tone: "red" },
};

/**
 * The signed-in student's tests (from student_available_tests). Only
 * what the database returns for this student is shown — never an
 * answer key. Scores appear only once a test has closed.
 */
export function StudentTestsView({ tests }: { tests: StudentTestSummary[] }) {
  if (tests.length === 0) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="No tests yet"
        description="Tests for your classes will appear here once your trainer publishes them."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tests.map((t) => {
        const state = STUDENT_TEST_STATE[t.state];
        const href = `/student/tests/${t.testId}`;
        return (
          <Card key={t.testId}>
            <CardContent className="flex h-full flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
                <Badge tone={state.tone}>{state.label}</Badge>
              </div>
              <p className="text-xs text-ink-muted">
                {TEST_TYPE_LABEL[t.testType] ?? t.testType} · {t.courseCode ? `${t.courseCode} — ` : ""}
                {t.courseTitle}
              </p>
              <p className="text-xs text-ink-muted">
                {t.classTitle} · {t.batchCode || t.batchName}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
                <span className="flex items-center gap-1">
                  <FileQuestion className="h-3.5 w-3.5" /> {t.questionCount} questions
                </span>
                {t.timeLimitMinutes !== null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {t.timeLimitMinutes} min
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <RotateCcw className="h-3.5 w-3.5" /> {t.attemptsUsed}/{t.attemptLimit} attempts
                </span>
              </div>
              {(t.availableFrom || t.availableUntil) && (
                <p className="flex items-start gap-1 text-xs text-ink-muted">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t.availableFrom ? formatDateTime(t.availableFrom) : "—"} → {t.availableUntil ? formatDateTime(t.availableUntil) : "—"}
                    <span className="block text-ink-faint">India time</span>
                  </span>
                </p>
              )}
              {t.bestResult && (
                <p className="text-xs font-medium text-ink">
                  Best result: {t.bestResult.percentage}% ({t.bestResult.score}/{t.bestResult.maxScore}) —{" "}
                  {t.bestResult.passed ? "Passed" : "Not passed"}
                </p>
              )}
              <div className="mt-auto pt-1">
                <Link href={href}>
                  <Button size="sm" className="w-full" variant={t.state === "available" || t.state === "in_progress" ? "primary" : "secondary"}>
                    {t.state === "in_progress" ? (
                      <>
                        <PlayCircle className="h-4 w-4" /> Resume test
                      </>
                    ) : t.state === "available" ? (
                      <>
                        <PlayCircle className="h-4 w-4" /> View &amp; start
                      </>
                    ) : (
                      <>
                        <Eye className="h-4 w-4" /> View details
                      </>
                    )}
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
