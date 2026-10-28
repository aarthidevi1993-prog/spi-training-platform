"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { COMPLETION_LIMITS } from "@/types/certificate";

export type CompletionDecisionMode = "recommend" | "approve" | "reject";

const COPY: Record<CompletionDecisionMode, { title: string; description: string; confirm: string; noteLabel: string; required: boolean }> = {
  recommend: {
    title: "Recommend completion",
    description: "The database re-checks the student's eligibility. A Super Admin then approves or rejects the recommendation.",
    confirm: "Recommend",
    noteLabel: "Note (optional)",
    required: false,
  },
  approve: {
    title: "Approve completion",
    description: "Eligibility is re-checked before approval. The completion date is the batch end date. A certificate can then be issued.",
    confirm: "Approve",
    noteLabel: "Note (optional)",
    required: false,
  },
  reject: {
    title: "Reject completion",
    description: "The student will see this note. They can be recommended again later.",
    confirm: "Reject",
    noteLabel: "Reason shown to the student (required)",
    required: true,
  },
};

export interface CompletionDecisionDialogProps {
  mode: CompletionDecisionMode | null;
  studentName: string;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}

/** Recommend / approve / reject with a note. Validation here is only for the form; the database decides. */
export function CompletionDecisionDialog({ mode, studentName, isLoading, onClose, onConfirm }: CompletionDecisionDialogProps) {
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [mode]);

  if (!mode) return null;
  const copy = COPY[mode];
  const trimmed = note.trim();
  const tooLong = trimmed.length > COMPLETION_LIMITS.noteMax;
  const missing = copy.required && trimmed.length === 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${copy.title} — ${studentName}`}
      description={copy.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant={mode === "reject" ? "danger" : "primary"}
            onClick={() => onConfirm(trimmed)}
            isLoading={isLoading}
            disabled={tooLong || missing}
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">{copy.noteLabel}</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={COMPLETION_LIMITS.noteMax + 50}
          className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink focus:border-signal-blue"
        />
        <span className={tooLong ? "text-xs text-signal-red" : "text-xs text-ink-faint"}>
          {trimmed.length}/{COMPLETION_LIMITS.noteMax}
        </span>
      </label>
    </Modal>
  );
}
