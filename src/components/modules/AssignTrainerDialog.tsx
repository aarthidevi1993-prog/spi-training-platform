"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { assignBatchTrainerAction } from "@/services/batches.actions";
import { ASSIGN_GENERIC_ERROR, isUuid, type AvailableTrainerOption } from "@/lib/batches/assign-trainer";

export interface AssignTrainerTarget {
  id: string;
  name: string;
  trainerId: string | null;
  trainerName: string | null;
  trainerUnavailable: boolean;
}

/**
 * Assign or change a batch's trainer (Super Admin; P3.6). Only available
 * trainers are offered; the database function decides (current batch,
 * available trainer, row lock, audit) and its answer is shown as a fixed
 * sentence. Removing the trainer is not offered.
 */
export function AssignTrainerDialog({
  batch,
  trainers,
  onClose,
}: {
  batch: AssignTrainerTarget | null;
  trainers: AvailableTrainerOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [trainerId, setTrainerId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setTrainerId("");
    setError(undefined);
  }, [batch?.id]);

  if (!batch) return null;
  const choices = trainers.filter((t) => t.id !== batch.trainerId);
  const changing = batch.trainerId !== null;

  function close() {
    if (!isPending) onClose();
  }

  function submit() {
    if (!batch || isPending) return;
    if (!isUuid(trainerId)) {
      setError("Choose a trainer.");
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const result = await assignBatchTrainerAction(batch.id, trainerId).catch(() => ({ ok: false as const, error: ASSIGN_GENERIC_ERROR }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      showToast({ variant: "success", title: result.message, description: batch.name });
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      isOpen
      onClose={close}
      title={changing ? "Change trainer" : "Assign trainer"}
      description={batch.name}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={isPending} disabled={isPending || choices.length === 0}>
            {changing ? "Change trainer" : "Assign trainer"}
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
        {changing && (
          <p className="text-sm text-ink-muted">
            Current trainer: <span className="font-medium text-ink">{batch.trainerName}</span>
            {batch.trainerUnavailable && <span className="text-signal-amber"> (no longer available)</span>}
          </p>
        )}
        {choices.length === 0 ? (
          <p className="text-sm text-ink-muted">No other trainer is available. Only active trainers with an active account can be assigned.</p>
        ) : (
          <Select
            name="trainerId"
            label="Trainer"
            value={trainerId}
            onChange={(e) => setTrainerId(e.target.value)}
            disabled={isPending}
            placeholder="Choose a trainer"
            options={choices.map((t) => ({ label: t.name, value: t.id }))}
          />
        )}
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
          <li>Scheduled and live classes of this batch move to the new trainer; completed classes keep the trainer who taught them.</li>
          {changing && <li>The current trainer loses access to this batch&apos;s current work.</li>}
          <li>Student enrolments are not affected.</li>
        </ul>
      </div>
    </Modal>
  );
}
