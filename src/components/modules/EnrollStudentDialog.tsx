"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Search, UserPlus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { setEnrollmentAction, trainerEnrolStudentAction } from "@/services/enrollment.actions";
import { ENROLLMENT_GENERIC_ERROR, REASON_MAX_LENGTH, isUuid, type EnrollmentCandidate } from "@/lib/enrollments/enrollment";

const textareaClass = "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink focus:border-signal-blue";

/**
 * "+ Enrol student" on the batch detail. Offers the server-built
 * candidates by name and code only; one student per enrolment. The
 * database decides availability, capacity, duplicates, batch state and
 * authorization; its answer is shown as a fixed sentence. Re-enrolment,
 * withdrawal and completion are never offered here.
 *
 *   mode "admin"   (P3.8 slice 3A) — Super Admin: any available student
 *                  not yet in the batch; optional reason;
 *                  setEnrollmentAction → admin_set_enrollment().
 *   mode "trainer" (P3.10-A) — the trainer's own current students (the
 *                  service's candidates); no reason (the function takes
 *                  none); trainerEnrolStudentAction → trainer_enroll_student().
 */
export function EnrollStudentDialog({
  batchId,
  batchName,
  candidates,
  seatsUsed,
  maxSeats,
  mode = "admin",
}: {
  batchId: string;
  batchName: string;
  candidates: EnrollmentCandidate[];
  seatsUsed: number;
  maxSeats: number;
  mode?: "admin" | "trainer";
}) {
  const trainer = mode === "trainer";
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();
  const full = seatsUsed >= maxSeats;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  }, [candidates, query]);
  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  function openDialog() {
    setQuery("");
    setSelectedId(null);
    setReason("");
    setError(undefined);
    setOpen(true);
  }

  function close() {
    if (!isPending) setOpen(false);
  }

  function submit() {
    if (isPending || !selected || !isUuid(selected.id)) return;
    if (reason.trim().length > REASON_MAX_LENGTH) {
      setError(`The reason can be at most ${REASON_MAX_LENGTH} characters.`);
      return;
    }
    setError(undefined);
    const student = selected;
    startTransition(async () => {
      const failed = () => ({ ok: false as const, error: ENROLLMENT_GENERIC_ERROR });
      const result = trainer
        ? await trainerEnrolStudentAction(batchId, student.id).catch(failed)
        : await setEnrollmentAction(batchId, student.id, "enrolled", reason.trim() || null).catch(failed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      showToast({ variant: "success", title: result.message, description: `${student.name} (${student.code}) · ${batchName}` });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" onClick={openDialog} disabled={full} title={full ? "This batch has no free seats." : undefined}>
        <UserPlus className="h-4 w-4" aria-hidden /> {full ? "Batch full" : "Enrol student"}
      </Button>

      <Modal
        isOpen={open}
        onClose={close}
        title="Enrol student"
        description={batchName}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={submit} isLoading={isPending} disabled={isPending || !selected}>
              Enrol student
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {candidates.length === 0 ? (
            <EmptyState
              title="No students available"
              description={
                trainer
                  ? "Only active students already enrolled in another batch you currently teach can be added here. New students join through an invitation."
                  : "No active students are available to enrol (students already in this batch are not listed)."
              }
            />
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
                <Input
                  placeholder="Search by name or student code"
                  aria-label="Search by name or student code"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={isPending}
                  className="pl-9"
                  autoFocus
                />
              </div>

              {matches.length === 0 ? (
                <EmptyState title="No matching students" description="Try a different name or student code." />
              ) : (
                <ul role="radiogroup" aria-label="Students" className="max-h-64 divide-y divide-surface-border overflow-y-auto rounded border border-surface-border">
                  {matches.map((c) => {
                    const checked = c.id === selectedId;
                    return (
                      <li key={c.id}>
                        <label
                          className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${checked ? "bg-signal-blueSoft" : "hover:bg-surface-sunken"}`}
                        >
                          <input
                            type="radio"
                            name="enrol-student"
                            value={c.id}
                            checked={checked}
                            onChange={() => setSelectedId(c.id)}
                            disabled={isPending}
                            className="h-4 w-4 accent-signal-blue"
                          />
                          <span className="flex-1 text-ink">{c.name}</span>
                          <span className="font-mono text-xs text-ink-muted">{c.code}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!trainer && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-ink">Reason (optional, kept in the enrolment history)</span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={REASON_MAX_LENGTH}
                    disabled={isPending}
                    className={textareaClass}
                  />
                </label>
              )}

              <p className="text-xs text-ink-muted">
                {seatsUsed} of {maxSeats} seats used. The enrolment is checked again when you submit (availability, seats and batch status).
              </p>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
