import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info, PlayCircle, Trophy } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/ErrorState";
import { formatDate, formatDateTime } from "@/utils/format";
import { studentTestsService } from "@/services/student-tests.service";
import { TEST_TYPE_LABEL } from "@/types/test";
import type { StudentTestSummary } from "@/types/student-test";
import { STUDENT_TEST_STATE } from "../StudentTestsView";
import { StartTestButton } from "../StartTestButton";

export const dynamic = "force-dynamic";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

const STATE_NOTE: Partial<Record<StudentTestSummary["state"], string>> = {
  scheduled: "This test isn't open yet. Come back when it opens.",
  closed: "This test has closed.",
  attempts_exhausted: "You've used all of your attempts. Your result will be shown here once the test closes.",
  submitted: "Your attempt has been submitted. Results are shown once the test closes.",
  not_available: "This test isn't available to you.",
};

export default async function StudentTestDetailPage({ params }: { params: { testId: string } }) {
  let test: StudentTestSummary | null = null;
  let loadError: string | null = null;

  try {
    test = await studentTestsService.getTest(params.testId);
  } catch (err) {
    console.error("[student/tests/detail] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this test. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this test" description={loadError} />;
  if (!test) notFound();

  const state = STUDENT_TEST_STATE[test.state];

  return (
    <div>
      <Link href="/student/tests" className="mb-3 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to tests
      </Link>

      <PageHeader
        title={test.title}
        description={`${TEST_TYPE_LABEL[test.testType] ?? test.testType} · ${test.courseCode ? `${test.courseCode} — ` : ""}${test.courseTitle}`}
        actions={<Badge tone={state.tone}>{state.label}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Fact label="Class" value={`${test.classTitle}${test.classDate ? ` · ${formatDate(test.classDate)}` : ""}`} />
                <Fact label="Batch" value={test.batchCode ? `${test.batchCode} — ${test.batchName}` : test.batchName} />
                <Fact label="Questions" value={String(test.questionCount)} />
                <Fact label="Duration" value={test.timeLimitMinutes !== null ? `${test.timeLimitMinutes} minutes` : "—"} />
                <Fact label="Attempts" value={`${test.attemptsUsed} of ${test.attemptLimit} used`} />
                <Fact
                  label="Available (India time)"
                  value={`${test.availableFrom ? formatDateTime(test.availableFrom) : "—"} → ${test.availableUntil ? formatDateTime(test.availableUntil) : "—"}`}
                />
              </dl>
            </CardContent>
          </Card>

          {test.instructions && (
            <Card>
              <CardContent>
                <h2 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Instructions</h2>
                <p className="whitespace-pre-line text-sm text-ink">{test.instructions}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <h2 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                <Info className="h-3.5 w-3.5" /> Before you start
              </h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
                <li>The timer runs on the server. Closing or refreshing the page does not pause it.</li>
                <li>Your answers are saved as you go. If you refresh, you&rsquo;ll continue where you left off.</li>
                <li>When the time runs out, your saved answers are submitted automatically.</li>
                <li>Your score, the correct answers and explanations are shown only after the test closes.</li>
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardContent className="flex flex-col gap-3">
            {test.state === "in_progress" && test.activeAttemptId ? (
              <>
                <p className="text-sm text-ink">You have an attempt in progress.</p>
                <Link href={`/student/tests/${test.testId}/attempt/${test.activeAttemptId}`}>
                  <Button className="w-full">
                    <PlayCircle className="h-4 w-4" /> Resume test
                  </Button>
                </Link>
              </>
            ) : test.canStart ? (
              <>
                <p className="text-sm text-ink-muted">
                  {test.attemptsUsed > 0
                    ? `You can try again (${test.attemptLimit - test.attemptsUsed} attempt${test.attemptLimit - test.attemptsUsed === 1 ? "" : "s"} left). Your best result counts.`
                    : "Ready when you are."}
                </p>
                <StartTestButton testId={test.testId} timeLimitMinutes={test.timeLimitMinutes} />
              </>
            ) : (
              <p className="text-sm text-ink-muted">{STATE_NOTE[test.state] ?? "This test isn't available right now."}</p>
            )}

            {test.bestResult && (
              <div className="rounded-md border border-surface-border bg-surface px-3 py-2.5">
                <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                  <Trophy className="h-3.5 w-3.5" /> Best result
                </p>
                <p className="mt-1 text-lg font-semibold text-ink">{test.bestResult.percentage}%</p>
                <p className="text-xs text-ink-muted">
                  {test.bestResult.score} / {test.bestResult.maxScore} marks · {test.bestResult.passed ? "Passed" : "Not passed"}
                </p>
                <Link
                  href={`/student/tests/${test.testId}/attempt/${test.bestResult.attemptId}`}
                  className="mt-2 inline-block text-xs font-medium text-signal-blue hover:underline"
                >
                  View review
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
