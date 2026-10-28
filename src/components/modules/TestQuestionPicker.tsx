"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { addTestQuestionsAction } from "@/services/tests.actions";
import { TEST_LIMITS, type TestCandidateQuestion } from "@/types/test";
import { QUESTION_TYPE_LABEL } from "./QuestionEditor";

export interface TestQuestionPickerProps {
  testId: string;
  /** Active bank questions of the class's course not already in the test (no answer keys). */
  candidates: TestCandidateQuestion[];
  onClose: () => void;
}

/**
 * Choose active Question Bank questions to copy into a draft test. The
 * server copies the question content and answer key (add_test_questions);
 * nothing but question ids is sent from here.
 */
export function TestQuestionPicker({ testId, candidates, onClose }: TestQuestionPickerProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? candidates : candidates.filter((c) => c.text.toLowerCase().includes(q) || (c.moduleTitle ?? "").toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  function close() {
    if (!isPending) onClose();
  }

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await addTestQuestionsAction(testId, selected);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't add the questions", description: result.error });
        return;
      }
      showToast({ variant: "success", title: selected.length === 1 ? "Question added." : `${selected.length} questions added.` });
      onClose();
      router.refresh();
    });
  }

  const overLimit = selected.length > TEST_LIMITS.questionsPerAdd;

  return (
    <Modal
      isOpen
      onClose={close}
      size="lg"
      title="Add questions from the Question Bank"
      description="Only active questions from this class's course are listed. Their content is copied into the test."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={add} isLoading={isPending} disabled={selected.length === 0 || overLimit}>
            {isPending ? "Adding…" : `Add selected (${selected.length})`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2 text-sm text-signal-red">
            {error}
          </p>
        )}
        {overLimit && (
          <p role="alert" className="text-sm text-signal-red">
            Add at most {TEST_LIMITS.questionsPerAdd} questions at a time.
          </p>
        )}

        {candidates.length === 0 ? (
          <EmptyState
            title="No questions available"
            description="There are no active Question Bank questions for this course that aren't already in the test."
          />
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <Input aria-label="Search questions" placeholder="Search questions…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>
            <ul className="flex flex-col divide-y divide-surface-border rounded-md border border-surface-border">
              {filtered.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-surface-sunken">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                      disabled={isPending}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink">{c.text}</span>
                      <span className="block text-xs text-ink-muted">
                        {QUESTION_TYPE_LABEL[c.questionType]} · {c.marks} {c.marks === 1 ? "mark" : "marks"}
                        {c.moduleTitle ? ` · ${c.moduleTitle}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              {filtered.length === 0 && <li className="px-3 py-4 text-sm text-ink-muted">No questions match your search.</li>}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
