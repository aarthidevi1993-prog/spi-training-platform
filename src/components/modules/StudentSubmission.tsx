"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { submitAssignmentAction } from "@/services/assignments.actions";
import { formatDateTime } from "@/utils/format";
import { ASSIGNMENT_LIMITS, type AssignmentView } from "@/types/assignment";

/**
 * The student's own submission for one assignment: status, late flag,
 * score and feedback once returned, and a link + note form while the
 * assignment is published and the submission hasn't been returned.
 */
export function StudentSubmission({ assignment, classCancelled }: { assignment: AssignmentView; classCancelled: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const own = assignment.ownSubmission;

  const [url, setUrl] = useState(own?.submissionUrl ?? "");
  const [note, setNote] = useState(own?.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const returned = own?.status === "returned";
  const canSubmit = assignment.status === "published" && !classCancelled && !returned;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await submitAssignmentAction(assignment.id, { submissionUrl: url, note: note || null });
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't submit", description: result.error });
        return;
      }
      showToast({ variant: "success", title: own ? "Resubmitted." : "Submitted." });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Your submission</p>
        {own ? <StatusBadge status={own.status} /> : <span className="text-xs text-ink-faint">Not submitted yet</span>}
        {own?.isLate && <Badge tone="amber">Late</Badge>}
      </div>

      {own && (
        <div className="flex flex-col gap-1 text-sm">
          <a
            href={own.submissionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-signal-blue hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open your work
          </a>
          <span className="text-xs text-ink-muted">Submitted {formatDateTime(own.submittedAt)}</span>
          {own.note && <span className="text-xs text-ink-muted">“{own.note}”</span>}
        </div>
      )}

      {returned && own && (
        <div className="flex flex-col gap-1 rounded-md bg-signal-greenSoft px-3 py-2 text-sm">
          <span className="font-medium text-ink">
            {own.score !== null
              ? `Score ${own.score}${assignment.maxScore !== null ? ` / ${assignment.maxScore}` : ""}`
              : "Reviewed"}
          </span>
          {own.feedback && <span className="text-ink-muted">{own.feedback}</span>}
          <span className="text-xs text-ink-muted">
            Returned by your trainer. Ask them to reopen it if you need to resubmit.
          </span>
        </div>
      )}

      {canSubmit ? (
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-sm text-signal-red">
              {error}
            </p>
          )}
          <Input
            label="Link to your work"
            type="url"
            inputMode="url"
            value={url}
            maxLength={ASSIGNMENT_LIMITS.urlMax}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isPending}
            placeholder="https://…sharepoint.com/… or OneDrive link"
            hint="Share your file from SharePoint/OneDrive and paste the link here."
          />
          <Input
            label="Note (optional)"
            value={note}
            maxLength={ASSIGNMENT_LIMITS.noteMax}
            onChange={(e) => setNote(e.target.value)}
            disabled={isPending}
          />
          <div>
            <Button size="sm" onClick={submit} isLoading={isPending} disabled={!url.trim()}>
              {isPending ? "Saving…" : own ? "Resubmit" : "Submit"}
            </Button>
          </div>
        </div>
      ) : (
        !returned && (
          <p className="text-xs text-ink-muted">
            {classCancelled
              ? "This class was cancelled, so submissions aren't accepted."
              : "This assignment is closed and no longer accepts submissions."}
          </p>
        )
      )}
    </div>
  );
}
