"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ExternalLink, Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { changeAssignmentStatusAction, deleteAssignmentAction } from "@/services/assignments.actions";
import { formatDateTime } from "@/utils/format";
import type { AssignmentStatus, AssignmentView, AssignmentViewer } from "@/types/assignment";
import { AssignmentEditor } from "./AssignmentEditor";
import { SubmissionsReview } from "./SubmissionsReview";
import { StudentSubmission } from "./StudentSubmission";

export interface AssignmentCardProps {
  assignment: AssignmentView;
  viewer: AssignmentViewer;
  classCancelled: boolean;
}

/**
 * One assignment: details for everyone; lifecycle actions (only the
 * valid ones for its status) and submission review for managers; the
 * student's own submission for students. Previous trainers (readers)
 * see details only.
 */
export function AssignmentCard({ assignment: a, viewer, classCancelled }: AssignmentCardProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isManager = viewer === "manager";

  function changeStatus(next: AssignmentStatus, label: string) {
    startTransition(async () => {
      const result = await changeAssignmentStatusAction(a.id, next);
      if (!result.ok) {
        showToast({ variant: "error", title: `Couldn't ${label.toLowerCase()} the assignment`, description: result.error });
        return;
      }
      showToast({ variant: "success", title: `Assignment ${next}.` });
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteAssignmentAction(a.id);
      setConfirmDelete(false);
      if (!result.ok) {
        showToast({ variant: "error", title: "Couldn't delete the assignment", description: result.error });
        return;
      }
      showToast({ variant: "success", title: "Draft assignment deleted." });
      router.refresh();
    });
  }

  if (editing && isManager) {
    return <AssignmentEditor assignment={a} onDone={() => setEditing(false)} />;
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">{a.title}</h3>
              <StatusBadge status={a.status} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
              <span className="flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5" />
                {a.dueAt ? `Due ${formatDateTime(a.dueAt)} (India time)` : "No due date"}
              </span>
              {a.maxScore !== null && (
                <span className="flex items-center gap-1">
                  <Target className="h-3.5 w-3.5" /> Max score {a.maxScore}
                </span>
              )}
              {a.resourceUrl && (
                <a
                  href={a.resourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-signal-blue hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open brief
                </a>
              )}
            </div>
          </div>

          {isManager && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={isPending}>
                Edit
              </Button>
              {a.status === "draft" && !classCancelled && (
                <Button size="sm" onClick={() => changeStatus("published", "Publish")} isLoading={isPending}>
                  Publish
                </Button>
              )}
              {a.status === "published" && (
                <Button size="sm" variant="secondary" onClick={() => changeStatus("closed", "Close")} isLoading={isPending}>
                  Close
                </Button>
              )}
              {a.status === "closed" && !classCancelled && (
                <Button size="sm" variant="secondary" onClick={() => changeStatus("published", "Reopen")} isLoading={isPending}>
                  Reopen
                </Button>
              )}
              {a.status === "draft" && (
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={isPending}>
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>

        {a.instructions && <p className="whitespace-pre-line text-sm text-ink-muted">{a.instructions}</p>}

        {isManager && a.status === "draft" && (
          <p className="text-xs text-ink-faint">Draft — students can&rsquo;t see this assignment until it&rsquo;s published.</p>
        )}
        {isManager && a.status !== "draft" && <SubmissionsReview assignment={a} />}
        {viewer === "student" && <StudentSubmission assignment={a} classCancelled={classCancelled} />}
      </CardContent>

      <Dialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete this draft assignment?"
        description={`"${a.title}" will be removed. Only drafts can be deleted.`}
        confirmLabel="Delete draft"
        tone="danger"
        isLoading={isPending}
      />
    </Card>
  );
}
