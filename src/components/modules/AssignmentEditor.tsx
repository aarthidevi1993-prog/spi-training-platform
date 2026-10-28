"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { createAssignmentAction, updateAssignmentAction } from "@/services/assignments.actions";
import { ASSIGNMENT_LIMITS, type AssignmentInput, type AssignmentView } from "@/types/assignment";

const TEXTAREA_CLASS =
  "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue";

export interface AssignmentEditorProps {
  /** Present for "create" (new draft in this class). */
  classId?: string;
  /** Present for "edit". */
  assignment?: AssignmentView;
  onDone: () => void;
}

/**
 * Create / edit an assignment's details (managers only). Status changes
 * are separate lifecycle actions. The due date is entered in India time.
 */
export function AssignmentEditor({ classId, assignment, onDone }: AssignmentEditorProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(assignment?.title ?? "");
  const [instructions, setInstructions] = useState(assignment?.instructions ?? "");
  const [resourceUrl, setResourceUrl] = useState(assignment?.resourceUrl ?? "");
  const [dueAtLocal, setDueAtLocal] = useState(assignment?.dueAtLocal ?? "");
  const [maxScore, setMaxScore] = useState(assignment?.maxScore !== null && assignment?.maxScore !== undefined ? String(assignment.maxScore) : "");

  function save() {
    setError(null);
    const input: AssignmentInput = {
      title,
      instructions: instructions || null,
      resourceUrl: resourceUrl || null,
      dueAtLocal: dueAtLocal || null,
      maxScore: maxScore.trim() === "" ? null : Number(maxScore),
    };

    startTransition(async () => {
      const result = assignment
        ? await updateAssignmentAction(assignment.id, input)
        : classId
          ? await createAssignmentAction(classId, input)
          : { ok: false, error: "Missing class." };

      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't save the assignment", description: result.error });
        return;
      }
      showToast({ variant: "success", title: assignment ? "Assignment updated." : "Draft assignment created." });
      onDone();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-signal-red">
            {error}
          </p>
        )}
        <Input
          label="Title"
          value={title}
          maxLength={ASSIGNMENT_LIMITS.titleMax}
          onChange={(e) => setTitle(e.target.value)}
          disabled={isPending}
          placeholder="e.g. Instrument index worksheet"
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`instructions-${assignment?.id ?? "new"}`} className="text-sm font-medium text-ink">
            Instructions (optional)
          </label>
          <textarea
            id={`instructions-${assignment?.id ?? "new"}`}
            rows={4}
            value={instructions}
            maxLength={ASSIGNMENT_LIMITS.instructionsMax}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={isPending}
            className={TEXTAREA_CLASS}
            placeholder="What students should do and submit…"
          />
        </div>
        <Input
          label="Brief / resource link (optional)"
          type="url"
          inputMode="url"
          value={resourceUrl}
          maxLength={ASSIGNMENT_LIMITS.urlMax}
          onChange={(e) => setResourceUrl(e.target.value)}
          disabled={isPending}
          placeholder="https://…sharepoint.com/…"
          hint="Link to the brief in SharePoint or OneDrive. Files are not uploaded here."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Due (India time, optional)"
            type="datetime-local"
            value={dueAtLocal}
            onChange={(e) => setDueAtLocal(e.target.value)}
            disabled={isPending}
          />
          <Input
            label="Maximum score (optional)"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={maxScore}
            onChange={(e) => setMaxScore(e.target.value)}
            disabled={isPending}
          />
        </div>
      </CardContent>
      <CardFooter>
        <Button type="button" variant="secondary" onClick={onDone} disabled={isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={save} isLoading={isPending}>
          {isPending ? "Saving…" : assignment ? "Save changes" : "Create draft"}
        </Button>
      </CardFooter>
    </Card>
  );
}
