"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { removeStudentAccountAction, removeTrainerAccountAction } from "@/services/users.actions";
import type { RemovableRole } from "@/lib/user-management/lifecycle";

/**
 * P3.11-B — confirm "Remove" on the Super Admin Students / Trainers lists. Remove DEACTIVATES the account
 * (suspended: no sign-in, no data access); nothing is deleted. The server re-checks Super Admin, the target's
 * role, self / last-Super-Admin protection and — for trainers — current batches and classes; a refusal is
 * shown here so the explanation can be read. Only the account id is sent.
 */
const COPY: Record<RemovableRole, { title: string; consequence: string; keeps: string; confirm: string }> = {
  student: {
    title: "Remove this student?",
    consequence: "The student's account is deactivated: they can no longer sign in or see any training data.",
    keeps: "Nothing is deleted. Their enrolments, attendance, assignments, tests, results, certificates and audit history are kept. A Super Admin can reactivate the account from its account panel on the Users page.",
    confirm: "Remove student",
  },
  trainer: {
    title: "Remove this trainer?",
    consequence: "The trainer's account is deactivated: they can no longer sign in or manage any training data.",
    keeps: "Nothing is deleted. Their authored content, past classes, batches and audit history are kept. A trainer who still has current batches or scheduled classes can't be removed until those are reassigned. A Super Admin can reactivate the account from its account panel on the Users page.",
    confirm: "Remove trainer",
  },
};

export function RemoveAccountDialog({
  kind,
  target,
  onClose,
}: {
  kind: RemovableRole;
  target: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [target]);
  if (!target) return null;
  const copy = COPY[kind];

  function confirm() {
    if (!target || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = kind === "student" ? await removeStudentAccountAction(target.id) : await removeTrainerAccountAction(target.id);
      if (result.ok) {
        showToast({ variant: "success", title: result.message });
        onClose();
      } else {
        setError(result.error);
      }
      router.refresh();
    });
  }

  return (
    <Modal
      isOpen
      onClose={isPending ? () => undefined : onClose}
      title={copy.title}
      description={copy.consequence}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" isLoading={isPending} disabled={isPending} onClick={confirm}>
            {copy.confirm}
          </Button>
        </>
      }
    >
      <dl className="mb-3 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-ink-muted">{kind === "student" ? "Student" : "Trainer"}</dt>
        <dd className="text-ink">
          {target.name} <span className="font-mono text-2xs text-ink-faint">{target.id}</span>
        </dd>
      </dl>
      <p className="text-sm text-ink-muted">{copy.keeps}</p>
      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-md bg-signal-redSoft px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" aria-hidden />
          <p className="text-sm text-ink">{error}</p>
        </div>
      )}
    </Modal>
  );
}
