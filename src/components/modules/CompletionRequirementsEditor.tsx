"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/utils/format";
import {
  addRequiredAssignmentAction,
  clearFinalAssessmentAction,
  removeRequiredAssignmentAction,
  setFinalAssessmentAction,
} from "@/services/certificates.actions";
import type { CompletionActionResult, CompletionRequirements, RequirementOption } from "@/types/certificate";

function optionLabel(o: RequirementOption): string {
  return `${o.title} — ${o.classTitle}${o.classDate ? ` (${formatDate(o.classDate)})` : ""}`;
}

export interface CompletionRequirementsEditorProps {
  batchId: string;
  requirements: CompletionRequirements;
  finalAssessmentOptions: RequirementOption[];
  assignmentOptions: RequirementOption[];
}

/**
 * Super Admin editor for a batch's completion requirements. Rendered
 * only while the database reports the requirements as unlocked; every
 * change goes through the 0011 functions, which re-check the lock and
 * validate the chosen test/assignment.
 */
export function CompletionRequirementsEditor({ batchId, requirements, finalAssessmentOptions, assignmentOptions }: CompletionRequirementsEditorProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [testId, setTestId] = useState(requirements.finalAssessment?.testId ?? "");
  const [assignmentId, setAssignmentId] = useState("");

  const required = new Set(requirements.requiredAssignments.map((a) => a.assignmentId));
  const addable = assignmentOptions.filter((a) => !required.has(a.id));

  function run(action: () => Promise<CompletionActionResult>, success: string, failure: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        showToast({ variant: "error", title: failure, description: result.error });
        return;
      }
      showToast({ variant: "success", title: success });
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Required final assessment</h3>
        <p className="mt-0.5 text-xs text-ink-muted">Exactly one published final exam of this batch. Students must pass it.</p>
        {finalAssessmentOptions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No published final exams in this batch yet.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-96">
              <Select
                aria-label="Final assessment"
                value={testId}
                onChange={(e) => setTestId(e.target.value)}
                placeholder="Choose a final exam"
                options={finalAssessmentOptions.map((o) => ({ value: o.id, label: optionLabel(o) }))}
              />
            </div>
            <Button
              size="sm"
              onClick={() => run(() => setFinalAssessmentAction(batchId, testId), "Final assessment saved.", "Couldn't save the final assessment")}
              disabled={isPending || !testId || testId === requirements.finalAssessment?.testId}
            >
              Save
            </Button>
            {requirements.finalAssessment && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  run(() => clearFinalAssessmentAction(batchId), "Final assessment cleared.", "Couldn't clear the final assessment", () => setTestId(""))
                }
                disabled={isPending}
              >
                Clear
              </Button>
            )}
          </div>
        )}
        {!requirements.finalAssessment && (
          <p className="mt-2 text-xs font-medium text-signal-amber">No final assessment is designated — no student can be eligible until one is set.</p>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-ink">Required assignments</h3>
        <p className="mt-0.5 text-xs text-ink-muted">Each must be returned with a score. None required is allowed.</p>
        {requirements.requiredAssignments.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No assignments are required.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-surface-border rounded-md border border-surface-border">
            {requirements.requiredAssignments.map((a) => (
              <li key={a.assignmentId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-ink">{a.title}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${a.title}`}
                  disabled={isPending}
                  onClick={() =>
                    run(() => removeRequiredAssignmentAction(batchId, a.assignmentId), "Assignment removed.", "Couldn't remove the assignment")
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {addable.length > 0 && (
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-96">
              <Select
                aria-label="Add required assignment"
                value={assignmentId}
                onChange={(e) => setAssignmentId(e.target.value)}
                placeholder="Choose an assignment"
                options={addable.map((o) => ({ value: o.id, label: optionLabel(o) }))}
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending || !assignmentId}
              onClick={() =>
                run(() => addRequiredAssignmentAction(batchId, assignmentId), "Assignment added.", "Couldn't add the assignment", () => setAssignmentId(""))
              }
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
