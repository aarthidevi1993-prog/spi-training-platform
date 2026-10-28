"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Circle, Info, PencilLine, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import {
  closeTestAction,
  deleteDraftTestAction,
  publishTestAction,
  removeTestQuestionAction,
  reopenTestAction,
  type TestActionResult,
} from "@/services/tests.actions";
import { formatDate, formatDateTime } from "@/utils/format";
import { TEST_TYPE_LABEL, type TestDetail } from "@/types/test";
import type { StaffTestResultsState } from "@/types/test-result";
import { TestEditor } from "./TestEditor";
import { TestQuestionPicker } from "./TestQuestionPicker";
import { QUESTION_TYPE_LABEL } from "./QuestionEditor";
import { TestResultsPanel } from "./TestResultsPanel";

export interface TestDetailViewProps {
  test: TestDetail;
  /** Route prefix, e.g. "/admin/tests". */
  basePath: string;
  /** Staff results for this test (loaded server-side under RLS). */
  results: StaffTestResultsState;
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

/**
 * Staff test page: settings, lifecycle actions (only the ones valid for
 * the stored status), the frozen question set with its answer key, and
 * the results of the test's attempts.
 * Admin/Trainer only — the lifecycle itself is enforced by the database.
 */
export function TestDetailView({ test: t, basePath, results }: TestDetailViewProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<"publish" | "close" | "delete" | null>(null);

  const isDraft = t.status === "draft";
  const isPublishedOpen = t.status === "scheduled" || t.status === "active";
  const isClosed = t.status === "closed";

  function runAction(action: () => Promise<TestActionResult>, success: string, failure: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      setConfirm(null);
      if (!result.ok) {
        showToast({ variant: "error", title: failure, description: result.error });
        return;
      }
      showToast({ variant: "success", title: success });
      if (after) after();
      else router.refresh();
    });
  }

  const confirmConfig = {
    publish: {
      title: "Publish this test?",
      description:
        "The question set, marks, test type, pass mark, time limit, attempt limit and opening time will be locked. You can still edit the title and instructions, extend the closing time, and close or reopen the test.",
      confirmLabel: "Publish",
      tone: "primary" as const,
      onConfirm: () => runAction(() => publishTestAction(t.id), "Test published.", "Couldn't publish the test"),
    },
    close: {
      title: "Close this test?",
      description: "Students won't be able to start new attempts. You can reopen it later while the closing time is in the future.",
      confirmLabel: "Close test",
      tone: "primary" as const,
      onConfirm: () => runAction(() => closeTestAction(t.id), "Test closed.", "Couldn't close the test"),
    },
    delete: {
      title: "Delete this draft test?",
      description: `"${t.title}" and its question set will be removed. Only drafts can be deleted.`,
      confirmLabel: "Delete draft",
      tone: "danger" as const,
      onConfirm: () =>
        runAction(() => deleteDraftTestAction(t.id), "Draft test deleted.", "Couldn't delete the test", () => router.push(basePath)),
    },
  };
  const dialog = confirm ? confirmConfig[confirm] : null;

  return (
    <div>
      <Link href={basePath} className="mb-3 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to tests
      </Link>

      <PageHeader
        title={t.title}
        description={`${t.classTitle} · ${t.batchCode || t.batchName}${t.courseCode ? ` · ${t.courseCode}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.effectiveStatus} />
            {t.canManage && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={isPending}>
                  <PencilLine className="h-4 w-4" /> Edit settings
                </Button>
                {isDraft && (
                  <Button size="sm" onClick={() => setConfirm("publish")} isLoading={isPending && confirm === "publish"}>
                    Publish
                  </Button>
                )}
                {isPublishedOpen && (
                  <Button size="sm" variant="secondary" onClick={() => setConfirm("close")} disabled={isPending}>
                    Close
                  </Button>
                )}
                {isClosed && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => runAction(() => reopenTestAction(t.id), "Test reopened.", "Couldn't reopen the test")}
                    isLoading={isPending}
                  >
                    Reopen
                  </Button>
                )}
                {isDraft && (
                  <Button size="sm" variant="danger" onClick={() => setConfirm("delete")} disabled={isPending}>
                    Delete
                  </Button>
                )}
              </>
            )}
          </div>
        }
      />

      {!t.canManage && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2.5 text-sm text-ink-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Read only. Tests can be managed by a Super Admin or the batch&rsquo;s current trainer while the batch is upcoming or ongoing.</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">
                Questions
                {t.questions && (
                  <span className="ml-2 font-normal text-ink-muted">
                    {t.questions.length} · {t.totalMarks ?? 0} marks
                  </span>
                )}
              </h2>
              {t.canManage && isDraft && (
                <Button size="sm" onClick={() => setPicking(true)} disabled={isPending}>
                  <Plus className="h-4 w-4" /> Add questions
                </Button>
              )}
            </div>

            {t.questions === null ? (
              <p className="text-sm text-ink-muted">The question set is visible to the batch&rsquo;s assigned trainer and Super Admins.</p>
            ) : t.questions.length === 0 ? (
              <EmptyState
                title="No questions yet"
                description={t.canManage && isDraft ? "Add active questions from the Question Bank for this course." : "This test has no questions."}
              />
            ) : (
              <ol className="flex flex-col gap-3">
                {t.questions.map((q, index) => (
                  <li key={q.id} className="rounded-md border border-surface-border px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">
                          {index + 1}. {q.questionText}
                        </p>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {QUESTION_TYPE_LABEL[q.questionType]} · {q.marks} {q.marks === 1 ? "mark" : "marks"}
                        </p>
                      </div>
                      {t.canManage && isDraft && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove question ${index + 1}`}
                          disabled={isPending}
                          onClick={() =>
                            runAction(() => removeTestQuestionAction(t.id, q.id), "Question removed.", "Couldn't remove the question")
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    <ul className="mt-2 flex flex-col gap-1">
                      {q.options.map((o, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm">
                          {o.isCorrect ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-signal-green" aria-label="Correct answer" />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                          )}
                          <span className={o.isCorrect ? "font-medium text-ink" : "text-ink-muted"}>{o.text}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardContent>
            <dl className="flex flex-col gap-3">
              <Setting label="Type" value={TEST_TYPE_LABEL[t.testType]} />
              <Setting label="Class" value={`${t.classTitle}${t.classDate ? ` · ${formatDate(t.classDate)}` : ""}`} />
              <Setting label="Batch" value={t.batchCode ? `${t.batchCode} — ${t.batchName}` : t.batchName} />
              <Setting label="Pass mark" value={t.passMarkPercent !== null ? `${t.passMarkPercent}%` : "Not set"} />
              <Setting label="Time limit" value={t.timeLimitMinutes !== null ? `${t.timeLimitMinutes} minutes` : "Not set"} />
              <Setting label="Attempt limit" value={String(t.attemptLimit)} />
              <Setting label="Opens (India time)" value={t.availableFrom ? formatDateTime(t.availableFrom) : "Not set"} />
              <Setting label="Closes (India time)" value={t.availableUntil ? formatDateTime(t.availableUntil) : "Not set"} />
              {t.status !== t.effectiveStatus && (
                <div>
                  <Badge tone="neutral">Stored status: {t.status}</Badge>
                </div>
              )}
            </dl>
            {t.instructions && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Instructions</p>
                <p className="mt-1 whitespace-pre-line text-sm text-ink">{t.instructions}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <TestResultsPanel testId={t.id} state={results} />

      {editing && <TestEditor classes={[]} test={t} onClose={() => setEditing(false)} />}
      {picking && <TestQuestionPicker testId={t.id} candidates={t.candidates} onClose={() => setPicking(false)} />}

      <Dialog
        isOpen={dialog !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => dialog?.onConfirm()}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmLabel={dialog?.confirmLabel}
        tone={dialog?.tone}
        isLoading={isPending}
      />
    </div>
  );
}
