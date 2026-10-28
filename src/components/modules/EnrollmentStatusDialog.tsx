"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { setEnrollmentAction } from "@/services/enrollment.actions";
import { ENROLLMENT_GENERIC_ERROR, REASON_MAX_LENGTH, isUuid, type EnrollmentActions, type EnrollmentStatus } from "@/lib/enrollments/enrollment";

const textareaClass = "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink focus:border-signal-blue";

/** The only three changes offered, each with its fixed target status. */
const CHANGES = {
  withdraw: { status: "withdrawn", button: "Withdraw", title: "Withdraw this student?", confirm: "Withdraw student", variant: "danger" },
  complete: { status: "completed", button: "Mark completed", title: "Mark enrolment as completed?", confirm: "Mark completed", variant: "primary" },
  reEnrol: { status: "enrolled", button: "Re-enrol", title: "Re-enrol this student?", confirm: "Re-enrol student", variant: "primary" },
} as const;
type ChangeKey = keyof typeof CHANGES;
const ORDER: ChangeKey[] = ["withdraw", "complete", "reEnrol"];

export interface EnrollmentStatusStudent {
  studentId: string;
  name: string;
  code: string;
  status: EnrollmentStatus;
  actions: EnrollmentActions;
}

/**
 * Withdraw / Mark completed / Re-enrol for one roster row on the Super
 * Admin batch detail (P3.8 slice 3B). Which buttons appear comes from the
 * server-computed `actions`; every change needs a confirmation and goes
 * through setEnrollmentAction → admin_set_enrollment(), which decides
 * transitions, capacity, availability, batch state and authorization. Its
 * answer is shown as a fixed sentence; the dialog stays open on failure.
 */
export function EnrollmentStatusDialog({
  batchId,
  batchName,
  seatsUsed,
  maxSeats,
  student,
}: {
  batchId: string;
  batchName: string;
  seatsUsed: number;
  maxSeats: number;
  student: EnrollmentStatusStudent;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [target, setTarget] = useState<ChangeKey | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  const available = ORDER.filter((key) => student.actions[key]);
  if (available.length === 0) return <span className="text-ink-faint">—</span>;

  const label = `${student.name} (${student.code})`;
  const consequence: Record<ChangeKey, string> = {
    withdraw: `${student.name} leaves the active roster and frees a seat. Any test in progress is ended and graded now. They can't start tests or submit work in this batch. You can re-enrol them later while the batch is upcoming or ongoing (seats permitting). The change is kept in the enrolment history.`,
    complete:
      "Completion is final: it can't be withdrawn or undone. Any test in progress is ended and graded now. This doesn't issue a certificate; certificates follow the completion workflow. The change is kept in the enrolment history.",
    reEnrol: `${student.name} returns to the active roster and takes a seat (${seatsUsed}/${maxSeats} used). Seats, the student's availability and the batch status are checked again when you confirm. The earlier withdrawal stays in the history; the original enrolment date is kept.`,
  };

  function openDialog(key: ChangeKey) {
    setReason("");
    setError(undefined);
    setTarget(key);
  }

  function close() {
    if (!isPending) setTarget(null);
  }

  function submit() {
    if (isPending || !target || !isUuid(student.studentId)) return;
    if (reason.trim().length > REASON_MAX_LENGTH) {
      setError(`The reason can be at most ${REASON_MAX_LENGTH} characters.`);
      return;
    }
    setError(undefined);
    const change = CHANGES[target];
    startTransition(async () => {
      const result = await setEnrollmentAction(batchId, student.studentId, change.status, reason.trim() || null).catch(() => ({
        ok: false as const,
        error: ENROLLMENT_GENERIC_ERROR,
      }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      showToast({ variant: "success", title: result.message, description: `${label} · ${batchName}` });
      setTarget(null);
      router.refresh();
    });
  }

  const change = target ? CHANGES[target] : null;

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {available.map((key) => (
          <Button key={key} size="sm" variant={key === "withdraw" ? "secondary" : "ghost"} onClick={() => openDialog(key)} disabled={isPending}>
            {CHANGES[key].button}
          </Button>
        ))}
      </div>

      <Modal
        isOpen={change !== null}
        onClose={close}
        title={change?.title}
        description={`${label} · ${batchName}`}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            {change && (
              <Button variant={change.variant} onClick={submit} isLoading={isPending} disabled={isPending}>
                {change.confirm}
              </Button>
            )}
          </>
        }
      >
        {change && target && (
          <div className="flex flex-col gap-4">
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}

            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-ink-muted">Current status</dt>
              <dd>
                <StatusBadge status={student.status} />
              </dd>
              <dt className="text-ink-muted">New status</dt>
              <dd>
                <StatusBadge status={change.status} />
              </dd>
            </dl>

            <p className="text-sm text-ink-muted">{consequence[target]}</p>
            {target === "reEnrol" && seatsUsed >= maxSeats && (
              <p className="text-sm text-signal-amber">Batch appears full; the database will check.</p>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink">Reason (optional, kept in the enrolment history)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={REASON_MAX_LENGTH}
                disabled={isPending}
                className={textareaClass}
              />
              <span className="text-xs text-ink-faint">
                {reason.trim().length}/{REASON_MAX_LENGTH}
              </span>
            </label>
          </div>
        )}
      </Modal>
    </>
  );
}
