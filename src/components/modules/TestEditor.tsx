"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { createTestAction, updateTestAction } from "@/services/tests.actions";
import { formatDate } from "@/utils/format";
import {
  TEST_LIMITS,
  TEST_TYPE_LABEL,
  type TestClassOption,
  type TestInput,
  type TestSummary,
  type TestType,
} from "@/types/test";

const TEXTAREA_CLASS =
  "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue";

export interface TestEditorProps {
  /** Classes the caller may create tests for (create mode). */
  classes: TestClassOption[];
  /** Present for "edit"; omitted for "create" (new draft). */
  test?: TestSummary;
  onClose: () => void;
  /** Called with the test id after a successful save. */
  onSaved?: (testId: string) => void;
}

function numberOrNull(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/**
 * Create / edit a test's settings in a modal. Drafts: everything but the
 * class. Published tests: only title, instructions and extending the
 * closing time — the rest is shown locked (the database enforces it).
 * Opening/closing times are entered in India time.
 */
export function TestEditor({ classes, test, onClose, onSaved }: TestEditorProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formId = test?.id ?? "new";
  const published = Boolean(test && test.status !== "draft");

  const [classId, setClassId] = useState(test?.classId ?? (classes.length === 1 ? (classes[0]?.id ?? "") : ""));
  const [testType, setTestType] = useState<TestType>(test?.testType ?? "quiz");
  const [title, setTitle] = useState(test?.title ?? "");
  const [instructions, setInstructions] = useState(test?.instructions ?? "");
  const [passMark, setPassMark] = useState(test?.passMarkPercent !== null && test?.passMarkPercent !== undefined ? String(test.passMarkPercent) : "");
  const [timeLimit, setTimeLimit] = useState(test?.timeLimitMinutes ? String(test.timeLimitMinutes) : "");
  const [attemptLimit, setAttemptLimit] = useState(String(test?.attemptLimit ?? 1));
  const [availableFrom, setAvailableFrom] = useState(test?.availableFromLocal ?? "");
  const [availableUntil, setAvailableUntil] = useState(test?.availableUntilLocal ?? "");

  function close() {
    if (!isPending) onClose();
  }

  function save() {
    setError(null);
    if (!classId) {
      setError("Choose a class.");
      return;
    }
    const input: TestInput = {
      classId,
      testType,
      title,
      instructions: instructions.trim() ? instructions : null,
      passMarkPercent: numberOrNull(passMark),
      timeLimitMinutes: numberOrNull(timeLimit),
      attemptLimit: attemptLimit.trim() === "" ? Number.NaN : Number(attemptLimit),
      availableFromLocal: availableFrom || null,
      availableUntilLocal: availableUntil || null,
    };

    startTransition(async () => {
      const result = test ? await updateTestAction(test.id, input) : await createTestAction(input);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't save the test", description: result.error });
        return;
      }
      showToast({ variant: "success", title: test ? "Test updated." : "Draft test created." });
      onClose();
      if (result.id && onSaved) onSaved(result.id);
      else router.refresh();
    });
  }

  const lockedHint = published ? "Locked after publishing." : undefined;

  return (
    <Modal
      isOpen
      onClose={close}
      size="lg"
      title={test ? "Edit test settings" : "Create test"}
      description={
        test
          ? published
            ? "After publishing you can change the title and instructions, and extend the closing time."
            : undefined
          : "New tests start as drafts. Add questions, then publish when the test is ready."
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} isLoading={isPending}>
            {isPending ? "Saving…" : test ? "Save changes" : "Create draft"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2 text-sm text-signal-red">
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {test ? (
            <Input id={`test-class-${formId}`} label="Class" value={`${test.classTitle} (${test.batchCode || test.batchName})`} disabled hint="A test's class can't be changed." />
          ) : (
            <Select
              id={`test-class-${formId}`}
              label="Class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              disabled={isPending}
              placeholder="Choose a class"
              options={classes.map((c) => ({
                label: `${c.title} — ${c.batchCode} · ${c.courseCode} · ${formatDate(c.classDate)}`,
                value: c.id,
              }))}
            />
          )}
          <Select
            id={`test-type-${formId}`}
            label="Test type"
            value={testType}
            onChange={(e) => setTestType(e.target.value as TestType)}
            disabled={isPending || published}
            hint={lockedHint}
            options={(Object.keys(TEST_TYPE_LABEL) as TestType[]).map((t) => ({ label: TEST_TYPE_LABEL[t], value: t }))}
          />
        </div>

        <Input
          id={`test-title-${formId}`}
          label="Title"
          value={title}
          maxLength={TEST_LIMITS.titleMax}
          onChange={(e) => setTitle(e.target.value)}
          disabled={isPending}
          placeholder="e.g. Instrumentation basics — Quiz 1"
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`test-instructions-${formId}`} className="text-sm font-medium text-ink">
            Instructions (optional)
          </label>
          <textarea
            id={`test-instructions-${formId}`}
            rows={3}
            value={instructions}
            maxLength={TEST_LIMITS.instructionsMax}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={isPending}
            className={TEXTAREA_CLASS}
            placeholder="What students should know before they start…"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            id={`test-pass-${formId}`}
            label="Pass mark (%)"
            type="number"
            inputMode="decimal"
            min={TEST_LIMITS.passMarkMin}
            max={TEST_LIMITS.passMarkMax}
            step="0.01"
            value={passMark}
            onChange={(e) => setPassMark(e.target.value)}
            disabled={isPending || published}
            hint={lockedHint}
          />
          <Input
            id={`test-time-${formId}`}
            label="Time limit (minutes)"
            type="number"
            inputMode="numeric"
            min={TEST_LIMITS.timeLimitMin}
            max={TEST_LIMITS.timeLimitMax}
            step="1"
            value={timeLimit}
            onChange={(e) => setTimeLimit(e.target.value)}
            disabled={isPending || published}
            hint={lockedHint}
          />
          <Input
            id={`test-attempts-${formId}`}
            label="Attempt limit"
            type="number"
            inputMode="numeric"
            min={TEST_LIMITS.attemptLimitMin}
            max={TEST_LIMITS.attemptLimitMax}
            step="1"
            value={attemptLimit}
            onChange={(e) => setAttemptLimit(e.target.value)}
            disabled={isPending || published}
            hint={lockedHint}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id={`test-from-${formId}`}
            label="Opens (India time)"
            type="datetime-local"
            value={availableFrom}
            onChange={(e) => setAvailableFrom(e.target.value)}
            disabled={isPending || published}
            hint={lockedHint}
          />
          <Input
            id={`test-until-${formId}`}
            label="Closes (India time)"
            type="datetime-local"
            value={availableUntil}
            onChange={(e) => setAvailableUntil(e.target.value)}
            disabled={isPending}
            hint={published ? "Can only be extended after publishing." : undefined}
          />
        </div>

        {!published && (
          <p className="text-xs text-ink-muted">
            Settings can stay incomplete while the test is a draft. Publishing needs the pass mark, time limit, opening and
            closing times, and at least one question.
          </p>
        )}
      </div>
    </Modal>
  );
}
