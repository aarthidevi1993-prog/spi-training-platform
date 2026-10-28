"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/utils/cn";
import { saveTestAnswerAction, submitTestAttemptAction } from "@/services/student-tests.actions";
import type { StudentAttemptPaper, StudentPaperQuestion } from "@/types/student-test";
import { useExamIntegrity } from "./useExamIntegrity";

type SaveState = "saving" | "saved" | "error";

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const TYPE_HINT: Record<StudentPaperQuestion["questionType"], string> = {
  single_choice: "Choose one answer.",
  multiple_choice: "Choose every correct answer.",
  true_false: "Choose True or False.",
};

/**
 * Secure exam screen. Questions/options arrive in the attempt's stored
 * (server-randomised) order with no answer key. Every change is saved
 * through the server; the countdown is display-only and synchronised to
 * the server clock — the database enforces the real deadline (+5 s
 * grace), grading and results. Nothing here decides correctness.
 * Browser activity (tab switches, offline, copy/paste, print, a second
 * tab) is noted for review through useExamIntegrity — best effort, never
 * a penalty, and independent of saving and submitting.
 */
export function TestRunner({ paper }: { paper: StudentAttemptPaper }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isSubmitting, startSubmit] = useTransition();

  const questions = paper.questions;
  const total = questions.length;
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.testQuestionId, q.selected]))
  );
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [overMessage, setOverMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The attempt is over on this page (submitted or stopped by the server): stop activity reporting.
  const [finished, setFinished] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);

  // Server clock sync: offset = server time − local time; deadline from the server.
  const offsetRef = useRef(new Date(paper.serverNow).getTime() - Date.now());
  const [deadlineMs, setDeadlineMs] = useState(() => new Date(paper.effectiveDeadline).getTime());
  const remainingOf = useCallback(
    () => Math.max(0, Math.floor((deadlineMs - (Date.now() + offsetRef.current)) / 1000)),
    [deadlineMs]
  );
  const [secondsLeft, setSecondsLeft] = useState(remainingOf);

  // Ordering for saves (never trusted for security): strictly increasing,
  // and above anything saved before a refresh.
  const seqRef = useRef(0);
  const nextSeq = () => {
    seqRef.current = Math.max(seqRef.current + 1, Date.now());
    return seqRef.current;
  };
  const inFlight = useRef(new Set<Promise<unknown>>());
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latestSelection = useRef<Record<string, string[]>>(answers);
  const autoSubmitted = useRef(false);
  const stopped = useRef(false);

  const attemptOver = useCallback(
    (message: string) => {
      if (stopped.current) return;
      stopped.current = true;
      setFinished(true);
      setOverMessage(message);
      router.refresh();
    },
    [router]
  );

  const saveNow = useCallback(
    (questionId: string) => {
      if (stopped.current) return;
      const optionIds = latestSelection.current[questionId] ?? [];
      setSaveState((s) => ({ ...s, [questionId]: "saving" }));
      const promise = saveTestAnswerAction(paper.attemptId, questionId, optionIds, nextSeq())
        .then((result) => {
          if (result.serverNow) offsetRef.current = new Date(result.serverNow).getTime() - Date.now();
          if (result.effectiveDeadline) setDeadlineMs(new Date(result.effectiveDeadline).getTime());
          if (result.ok) {
            setSaveState((s) => ({ ...s, [questionId]: "saved" }));
            return;
          }
          setSaveState((s) => ({ ...s, [questionId]: "error" }));
          if (result.attemptOver) {
            attemptOver(result.error ?? "This attempt has finished.");
          } else {
            showToast({ variant: "error", title: "Answer not saved", description: result.error });
          }
        })
        .catch(() => {
          setSaveState((s) => ({ ...s, [questionId]: "error" }));
          showToast({ variant: "error", title: "Answer not saved", description: "Check your connection — we'll keep your choice; select it again to retry." });
        })
        .finally(() => {
          inFlight.current.delete(promise);
        });
      inFlight.current.add(promise);
    },
    [paper.attemptId, attemptOver, showToast]
  );

  /** Save now, or shortly for multiple choice (several clicks → one save). */
  function scheduleSave(question: StudentPaperQuestion) {
    const id = question.testQuestionId;
    const existing = pendingTimers.current.get(id);
    if (existing) clearTimeout(existing);
    if (question.questionType === "multiple_choice") {
      pendingTimers.current.set(
        id,
        setTimeout(() => {
          pendingTimers.current.delete(id);
          saveNow(id);
        }, 400)
      );
    } else {
      pendingTimers.current.delete(id);
      saveNow(id);
    }
  }

  async function flushSaves() {
    for (const [id, timer] of Array.from(pendingTimers.current.entries())) {
      clearTimeout(timer);
      pendingTimers.current.delete(id);
      saveNow(id);
    }
    await Promise.allSettled(Array.from(inFlight.current));
  }

  function choose(question: StudentPaperQuestion, optionId: string) {
    if (stopped.current || isSubmitting) return;
    const id = question.testQuestionId;
    const prev = answers[id] ?? [];
    const next =
      question.questionType === "multiple_choice"
        ? prev.includes(optionId)
          ? prev.filter((x) => x !== optionId)
          : [...prev, optionId]
        : prev.length === 1 && prev[0] === optionId
          ? prev
          : [optionId];
    if (next === prev) return;
    latestSelection.current = { ...latestSelection.current, [id]: next };
    setAnswers((a) => ({ ...a, [id]: next }));
    scheduleSave(question);
  }

  const submit = useCallback(
    (automatic: boolean) => {
      setSubmitError(null);
      startSubmit(async () => {
        await flushSaves();
        const result = await submitTestAttemptAction(paper.attemptId).catch(() => null);
        setConfirming(false);
        if (!result || !result.ok) {
          const message = result?.error ?? "We couldn't reach the server. Check your connection and try again.";
          setSubmitError(message);
          showToast({ variant: "error", title: automatic ? "Automatic submission failed" : "Couldn't submit", description: message });
          return;
        }
        stopped.current = true;
        setFinished(true);
        showToast({
          variant: "success",
          title: result.alreadyFinished ? "This attempt had already finished." : automatic ? "Time is up — your answers were submitted." : "Test submitted.",
        });
        router.refresh();
      });
    },
    // flushSaves reads refs only; saveNow is stable per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paper.attemptId, router, showToast]
  );

  // Countdown (display only). At zero: save what's pending, then submit once.
  useEffect(() => {
    const tick = () => {
      const left = remainingOf();
      setSecondsLeft(left);
      if (left === 0 && !autoSubmitted.current && !stopped.current) {
        autoSubmitted.current = true;
        submit(true);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [remainingOf, submit]);

  useEffect(() => {
    const timers = pendingTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const answeredCount = useMemo(
    () => questions.filter((q) => (answers[q.testQuestionId] ?? []).length > 0).length,
    [answers, questions]
  );
  const unanswered = total - answeredCount;
  const { otherTabs } = useExamIntegrity(paper.attemptId, !finished, areaRef);
  const question = questions[current];
  const savingAny = Object.values(saveState).some((s) => s === "saving");

  if (overMessage) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <AlertTriangle className="h-7 w-7 text-signal-amber" />
          <h2 className="text-lg font-semibold text-ink">This attempt has finished</h2>
          <p className="text-sm text-ink-muted">{overMessage}</p>
          <Loader2 className="h-4 w-4 animate-spin text-ink-faint" aria-label="Loading the result" />
        </CardContent>
      </Card>
    );
  }

  if (!question) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="py-10 text-center text-sm text-ink-muted">This attempt has no questions.</CardContent>
      </Card>
    );
  }

  const selected = answers[question.testQuestionId] ?? [];
  const qState = saveState[question.testQuestionId];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/student/tests/${paper.testId}`} className="mb-1 flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
            <ChevronLeft className="h-3.5 w-3.5" /> Test details
          </Link>
          <h1 className="text-sm font-semibold text-ink">
            {paper.testTitle} <span className="font-normal text-ink-muted">· Attempt {paper.attemptNumber}</span>
          </h1>
        </div>
        <span
          role="timer"
          aria-live="off"
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-sm font-medium",
            secondsLeft < 60 ? "border-signal-red/30 bg-signal-redSoft text-signal-red" : "border-surface-border bg-surface-raised text-ink"
          )}
        >
          <Clock className="h-4 w-4" /> {formatTime(secondsLeft)}
        </span>
      </div>

      {submitError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2 text-sm text-signal-red">
          <span>{submitError}</span>
          <Button size="sm" variant="secondary" onClick={() => submit(secondsLeft === 0)} isLoading={isSubmitting}>
            Retry submission
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-xs text-ink-muted print:hidden">
        <p className="mb-1.5 flex items-center gap-1.5 font-semibold text-ink">
          <Info className="h-3.5 w-3.5" /> About this test
        </p>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>The official timer is kept by the server; the countdown here follows it.</li>
          <li>Your answers are saved automatically. Please finish by selecting Submit test.</li>
          <li>
            To support fair assessment, some browser activity is noted — for example switching tabs or windows, going offline, copying or
            pasting, printing, or opening this test in another tab.
          </li>
          <li>These notes are for your trainer to review. They don&apos;t change your answers or your score, and switching briefly to a class call is fine.</li>
        </ul>
      </div>

      {otherTabs > 0 && (
        <div role="status" className="rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-xs text-ink-muted print:hidden">
          This test is also open in another tab. Please continue in one tab — both tabs save to the same attempt.
        </div>
      )}

      <p className="hidden text-sm text-ink-muted print:block">Test questions are not included when this page is printed.</p>

      <div className="grid grid-cols-1 gap-4 print:hidden lg:grid-cols-[1fr_240px]">
        <div ref={areaRef} className="min-w-0">
          <Card>
            <CardContent className="flex flex-col gap-5">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-ink-muted">
                  <span>
                    Question {current + 1} of {total} · {question.marks} {question.marks === 1 ? "mark" : "marks"}
                  </span>
                  <span>
                    {answeredCount} answered
                    {qState === "saving" && " · Saving…"}
                    {qState === "saved" && " · Saved"}
                    {qState === "error" && " · Not saved"}
                  </span>
                </div>
                <ProgressBar value={answeredCount} max={total} tone="teal" />
              </div>

              <div>
                <p className="text-sm font-medium text-ink">{question.questionText}</p>
                <p className="mt-1 text-xs text-ink-muted">{TYPE_HINT[question.questionType]}</p>
              </div>

              <div role={question.questionType === "multiple_choice" ? "group" : "radiogroup"} className="flex flex-col gap-2">
                {question.options.map((option) => {
                  const isSelected = selected.includes(option.id);
                  const multi = question.questionType === "multiple_choice";
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role={multi ? "checkbox" : "radio"}
                      aria-checked={isSelected}
                      disabled={isSubmitting}
                      onClick={() => choose(question, option.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors",
                        isSelected
                          ? "border-primary-500 bg-primary-50 text-primary-700"
                          : "border-surface-border bg-surface-raised text-ink hover:border-primary-300"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center border-2",
                          multi ? "rounded" : "rounded-full",
                          isSelected ? "border-primary-500" : "border-surface-border"
                        )}
                      >
                        {isSelected && <span className={cn("h-2 w-2 bg-primary-500", multi ? "rounded-sm" : "rounded-full")} />}
                      </span>
                      {option.text}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-t border-surface-border pt-4">
                <Button variant="secondary" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0}>
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                {current === total - 1 ? (
                  <Button onClick={() => setConfirming(true)} isLoading={isSubmitting}>
                    Submit test
                  </Button>
                ) : (
                  <Button onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}>
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardContent>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">Questions</h3>
            <div className="grid grid-cols-5 gap-2 lg:grid-cols-4">
              {questions.map((q, i) => {
                const isAnswered = (answers[q.testQuestionId] ?? []).length > 0;
                const isCurrent = i === current;
                const failed = saveState[q.testQuestionId] === "error";
                return (
                  <button
                    key={q.testQuestionId}
                    type="button"
                    onClick={() => setCurrent(i)}
                    aria-label={`Question ${i + 1}${isAnswered ? ", answered" : ", not answered"}`}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-medium",
                      isCurrent
                        ? "border-primary-500 bg-primary-500 text-white"
                        : failed
                          ? "border-signal-red/40 bg-signal-redSoft text-signal-red"
                          : isAnswered
                            ? "border-primary-200 bg-primary-50 text-primary-700"
                            : "border-surface-border text-ink-muted hover:border-primary-300"
                    )}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex flex-col gap-1.5 text-xs text-ink-muted">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-primary-500" /> Current
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-primary-50 ring-1 ring-primary-200" /> Answered
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full border border-surface-border" /> Not answered
              </span>
            </div>
            <div className="mt-4 border-t border-surface-border pt-4">
              <Button className="w-full" onClick={() => setConfirming(true)} isLoading={isSubmitting}>
                <CheckCircle2 className="h-4 w-4" /> Submit test
              </Button>
              <p className="mt-2 text-2xs text-ink-faint">
                {savingAny ? "Saving your answers…" : "Answers are saved automatically."} The timer is kept by the server.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => submit(false)}
        title="Are you sure you want to submit this test?"
        description={
          unanswered > 0
            ? `You have ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}. Unanswered questions are marked incorrect. You can't change your answers after submitting.`
            : "All questions are answered. You can't change your answers after submitting."
        }
        confirmLabel="Submit test"
        isLoading={isSubmitting}
      />
    </div>
  );
}
