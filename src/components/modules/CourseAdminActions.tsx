"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Pencil, Send, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { deleteCourseAction, setCourseStatusAction } from "@/services/courses.actions";
import { archiveImpactLines, statusActionLabel, statusActionsFor, type ArchiveImpact } from "@/lib/courses/course-management";

type Target = "draft" | "published" | "archived";
type Confirm = { kind: "status"; status: Target } | { kind: "delete" };

const ICON = { published: Send, archived: Archive, draft: Undo2 } as const;

/**
 * Super Admin course header actions: Edit, the status changes the database
 * would accept (Publish / Archive / Move to draft) and — only when nothing
 * references the course — Delete. Archive and Delete are confirmed first.
 * Only the course id (and the target status) are sent; the 0030 functions
 * decide and audit.
 */
export function CourseAdminActions({
  courseId,
  status,
  batchCount,
  canDelete,
  archiveImpact,
}: {
  courseId: string;
  status: string;
  batchCount: number;
  canDelete: boolean;
  /** Archive confirmation specifics: affected upcoming / ongoing batches and pending invitations. */
  archiveImpact?: ArchiveImpact;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(action: Confirm) {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = action.kind === "delete" ? await deleteCourseAction(courseId) : await setCourseStatusAction(courseId, action.status);
      if (!result.ok) {
        if (confirm) setError(result.error);
        else showToast({ variant: "error", title: "Couldn't update the course", description: result.error });
        router.refresh();
        return;
      }
      showToast({ variant: "success", title: result.message });
      setConfirm(null);
      if (action.kind === "delete") router.push("/admin/courses");
      router.refresh();
    });
  }

  const statusActions = statusActionsFor(status, batchCount);
  const impactLines = archiveImpactLines(archiveImpact);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/admin/courses/${courseId}/edit`}>
        <Button size="sm" variant="secondary">
          <Pencil className="h-4 w-4" /> Edit
        </Button>
      </Link>
      {statusActions.map((target) => {
        const Icon = ICON[target];
        return (
          <Button
            key={target}
            size="sm"
            variant={target === "published" ? "primary" : "secondary"}
            disabled={isPending}
            onClick={() => (target === "published" ? run({ kind: "status", status: target }) : setConfirm({ kind: "status", status: target }))}
          >
            <Icon className="h-4 w-4" /> {statusActionLabel(status, target)}
          </Button>
        );
      })}
      {canDelete && (
        <Button size="sm" variant="danger" disabled={isPending} onClick={() => setConfirm({ kind: "delete" })}>
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      )}

      {confirm && (
        <Modal
          isOpen
          onClose={isPending ? () => undefined : () => (setConfirm(null), setError(null))}
          title={confirm.kind === "delete" ? "Delete this course?" : confirm.status === "archived" ? "Deactivate this course?" : "Move this course back to draft?"}
          description={
            confirm.kind === "delete"
              ? "This draft course has never been published and nothing uses it, so it and its modules are permanently removed. Its audit history is kept."
              : confirm.status === "archived"
                ? "Inactive courses can't be selected for new batches, and their upcoming batches take no new students. Existing batches continue normally — classes can still be scheduled, ongoing batches can still enrol students, and attendance, tests, assignments and completion are recorded as usual. Nothing is deleted. You can reactivate it later."
                : "A draft course can't be selected for new batches until it is published again."
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => (setConfirm(null), setError(null))} disabled={isPending}>
                Cancel
              </Button>
              <Button variant={confirm.kind === "delete" ? "danger" : "primary"} isLoading={isPending} disabled={isPending} onClick={() => run(confirm)}>
                {confirm.kind === "delete" ? "Delete course" : statusActionLabel(status, confirm.status)}
              </Button>
            </>
          }
        >
          {confirm.kind === "status" && confirm.status === "archived" && impactLines.length > 0 && (
            <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-ink">
              {impactLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-sm text-signal-red">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
