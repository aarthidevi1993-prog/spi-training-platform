"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { createQuestion, updateQuestion } from "@/services/questions.actions";
import {
  QUESTION_LIMITS,
  TRUE_FALSE_OPTION_TEXTS,
  type QuestionCourseOption,
  type QuestionDetail,
  type QuestionInput,
  type QuestionOption,
  type QuestionType,
} from "@/types/question";
import { QuestionOptionsEditor } from "./QuestionOptionsEditor";

const TEXTAREA_CLASS =
  "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue";

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  single_choice: "Single choice",
  multiple_choice: "Multiple choice",
  true_false: "True / False",
};

function blankOptions(count: number): QuestionOption[] {
  return Array.from({ length: count }, () => ({ text: "", isCorrect: false }));
}

function trueFalseOptions(): QuestionOption[] {
  return TRUE_FALSE_OPTION_TEXTS.map((text) => ({ text, isCorrect: false }));
}

export interface QuestionEditorProps {
  courses: QuestionCourseOption[];
  /** Present for "edit"; omitted for "create" (new draft). */
  question?: QuestionDetail;
  onClose: () => void;
}

/**
 * Create / edit a bank question in a modal (super admin or the course's
 * current trainer). Status changes are separate lifecycle actions. The
 * server re-validates everything and the database has the final say.
 */
export function QuestionEditor({ courses, question, onClose }: QuestionEditorProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formId = question?.id ?? "new";

  const [courseId, setCourseId] = useState(question?.courseId ?? (courses.length === 1 ? (courses[0]?.id ?? "") : ""));
  const [moduleId, setModuleId] = useState(question?.moduleId ?? "");
  const [type, setType] = useState<QuestionType>(question?.type ?? "single_choice");
  const [text, setText] = useState(question?.text ?? "");
  const [marks, setMarks] = useState(question ? String(question.marks) : "1");
  const [explanation, setExplanation] = useState(question?.explanation ?? "");
  const [options, setOptions] = useState<QuestionOption[]>(question?.options ?? blankOptions(4));

  const course = courses.find((c) => c.id === courseId);

  function changeCourse(next: string) {
    setCourseId(next);
    setModuleId(""); // modules belong to a course
  }

  function changeType(next: QuestionType) {
    if (next === type) return;
    if (next === "true_false") {
      setOptions(trueFalseOptions());
    } else if (type === "true_false") {
      setOptions(blankOptions(4));
    } else if (next === "single_choice" && options.filter((o) => o.isCorrect).length > 1) {
      // Single choice allows one correct answer: make the author choose again.
      setOptions(options.map((o) => ({ ...o, isCorrect: false })));
    }
    setType(next);
  }

  function close() {
    if (!isPending) onClose();
  }

  function save() {
    setError(null);
    if (!courseId) {
      setError("Choose a course.");
      return;
    }
    const input: QuestionInput = {
      courseId,
      moduleId: moduleId || null,
      type,
      text,
      marks: marks.trim() === "" ? Number.NaN : Number(marks),
      explanation: explanation.trim() ? explanation : null,
      options,
    };

    startTransition(async () => {
      const result = question ? await updateQuestion(question.id, input) : await createQuestion(input);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't save the question", description: result.error });
        return;
      }
      showToast({ variant: "success", title: question ? "Question updated." : "Draft question created." });
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      isOpen
      onClose={close}
      size="lg"
      title={question ? "Edit question" : "Add question"}
      description={question ? undefined : "New questions start as drafts. Activate them when they're ready for tests."}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} isLoading={isPending}>
            {isPending ? "Saving…" : question ? "Save changes" : "Create draft"}
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
          <Select
            id={`question-course-${formId}`}
            label="Course"
            value={courseId}
            onChange={(e) => changeCourse(e.target.value)}
            disabled={isPending || Boolean(question)}
            placeholder="Choose a course"
            options={courses.map((c) => ({ label: `${c.code} — ${c.title}`, value: c.id }))}
            hint={question ? "A question's course can't be changed." : undefined}
          />
          <Select
            id={`question-module-${formId}`}
            label="Module (optional)"
            value={moduleId}
            onChange={(e) => setModuleId(e.target.value)}
            disabled={isPending || !course}
            options={[
              { label: "No module (course-level)", value: "" },
              ...(course?.modules ?? []).map((m) => ({ label: `${m.code} — ${m.title}`, value: m.id })),
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id={`question-type-${formId}`}
            label="Question type"
            value={type}
            onChange={(e) => changeType(e.target.value as QuestionType)}
            disabled={isPending}
            options={(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((t) => ({ label: QUESTION_TYPE_LABEL[t], value: t }))}
          />
          <Input
            id={`question-marks-${formId}`}
            label="Marks"
            type="number"
            inputMode="decimal"
            min="0.01"
            max={QUESTION_LIMITS.marksMax}
            step="0.01"
            value={marks}
            onChange={(e) => setMarks(e.target.value)}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`question-text-${formId}`} className="text-sm font-medium text-ink">
            Question text
          </label>
          <textarea
            id={`question-text-${formId}`}
            rows={3}
            value={text}
            maxLength={QUESTION_LIMITS.textMax}
            onChange={(e) => setText(e.target.value)}
            disabled={isPending}
            className={TEXTAREA_CLASS}
            placeholder={type === "true_false" ? "Write a statement that is either true or false…" : "Write the question…"}
          />
        </div>

        <QuestionOptionsEditor name={`question-${formId}`} type={type} options={options} onChange={setOptions} disabled={isPending} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`question-explanation-${formId}`} className="text-sm font-medium text-ink">
            Explanation (optional)
          </label>
          <textarea
            id={`question-explanation-${formId}`}
            rows={2}
            value={explanation}
            maxLength={QUESTION_LIMITS.explanationMax}
            onChange={(e) => setExplanation(e.target.value)}
            disabled={isPending}
            className={TEXTAREA_CLASS}
            placeholder="Why the correct answer is correct (shown only if a test releases correct answers)."
          />
        </div>
      </div>
    </Modal>
  );
}
