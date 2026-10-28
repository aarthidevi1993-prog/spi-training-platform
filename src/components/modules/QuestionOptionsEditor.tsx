"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { QUESTION_LIMITS, type QuestionOption, type QuestionType } from "@/types/question";

export interface QuestionOptionsEditorProps {
  /** Unique per editor instance (radio group name / ids). */
  name: string;
  type: QuestionType;
  options: QuestionOption[];
  onChange: (options: QuestionOption[]) => void;
  disabled?: boolean;
}

const HINT: Record<QuestionType, string> = {
  single_choice: "Select the one correct answer.",
  multiple_choice: "Select every correct answer (at least one).",
  true_false: "Select whether the statement is true or false.",
};

/**
 * Answer options for one question. Single choice / true-false use radio
 * buttons (exactly one correct); multiple choice uses checkboxes (at
 * least one). True/false options are fixed: they can't be renamed,
 * added or removed.
 */
export function QuestionOptionsEditor({ name, type, options, onChange, disabled = false }: QuestionOptionsEditorProps) {
  const isFixed = type === "true_false";
  const isMulti = type === "multiple_choice";

  function setCorrect(index: number, checked: boolean) {
    onChange(
      options.map((o, i) =>
        isMulti ? (i === index ? { ...o, isCorrect: checked } : o) : { ...o, isCorrect: i === index }
      )
    );
  }

  function setText(index: number, text: string) {
    onChange(options.map((o, i) => (i === index ? { ...o, text } : o)));
  }

  function remove(index: number) {
    onChange(options.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...options, { text: "", isCorrect: false }]);
  }

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="text-sm font-medium text-ink">Options</legend>
      <p className="text-xs text-ink-muted">{HINT[type]}</p>

      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type={isMulti ? "checkbox" : "radio"}
            name={`${name}-correct`}
            checked={option.isCorrect}
            onChange={(e) => setCorrect(index, e.target.checked)}
            aria-label={`Mark option ${index + 1} as correct`}
            className="h-4 w-4 shrink-0 accent-primary-500"
          />
          {isFixed ? (
            <span className="flex h-9 flex-1 items-center rounded border border-surface-border bg-surface-sunken px-3 text-sm text-ink">
              {option.text}
            </span>
          ) : (
            <div className="flex-1">
              <Input
                id={`${name}-option-${index}`}
                aria-label={`Option ${index + 1}`}
                value={option.text}
                maxLength={QUESTION_LIMITS.optionTextMax}
                onChange={(e) => setText(index, e.target.value)}
                placeholder={`Option ${index + 1}`}
              />
            </div>
          )}
          {!isFixed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => remove(index)}
              disabled={options.length <= QUESTION_LIMITS.optionsMin}
              aria-label={`Remove option ${index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}

      {!isFixed && (
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={add} disabled={options.length >= QUESTION_LIMITS.optionsMax}>
            <Plus className="h-4 w-4" /> Add option
          </Button>
        </div>
      )}
    </fieldset>
  );
}
