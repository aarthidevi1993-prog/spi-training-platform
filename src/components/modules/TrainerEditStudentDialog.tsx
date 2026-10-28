"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { trainerUpdateStudentAction } from "@/services/students.actions";
import { LIMITS } from "@/lib/user-management/lifecycle";
import { TRAINER_EDIT_MESSAGE } from "@/lib/students/trainer-edit";

/**
 * Trainer → "Edit student" (P3.10-B). The name is shown and editable;
 * phone, organization and designation are private (trainers cannot read
 * them), so their fields start empty: a typed value replaces the existing
 * one, an empty field keeps it. The save goes through
 * trainerUpdateStudentAction → trainer_update_student, which decides scope;
 * its answer is shown as a fixed sentence.
 */
export function TrainerEditStudentDialog({ student, onClose }: { student: { id: string; name: string } | null; onClose: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [designation, setDesignation] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();
  const submitting = useRef(false);

  useEffect(() => {
    setFullName(student?.name ?? "");
    setPhone("");
    setOrganization("");
    setDesignation("");
    setError(undefined);
  }, [student]);

  if (!student) return null;
  const target = student;

  function close() {
    if (!isPending) onClose();
  }

  function submit() {
    // Duplicate-submission guard: one save at a time.
    if (submitting.current || isPending) return;
    if (!fullName.trim()) {
      setError("The student's full name can't be empty.");
      return;
    }
    submitting.current = true;
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await trainerUpdateStudentAction(target.id, { fullName, phone, organization, designation }).catch(() => ({
          ok: false as const,
          error: TRAINER_EDIT_MESSAGE.generic,
        }));
        if (!result.ok) {
          setError(result.error);
          return;
        }
        showToast({ variant: "success", title: result.message, description: fullName.trim() });
        onClose();
        router.refresh();
      } finally {
        submitting.current = false;
      }
    });
  }

  return (
    <Modal
      isOpen
      onClose={close}
      title="Edit student"
      description={target.name}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={isPending} disabled={isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        aria-label="Edit student"
      >
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <Input name="fullName" label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={LIMITS.fullName} disabled={isPending} required />

        <p className="flex items-start gap-2 rounded border border-surface-border bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Contact details are private, so their current values aren&apos;t shown to trainers. Type a new value to replace one; leave a field empty to keep
            its current value unchanged.
          </span>
        </p>

        <Input
          name="phone"
          label="Phone (optional)"
          placeholder="Leave empty to keep the current value"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={LIMITS.phone}
          disabled={isPending}
        />
        <Input
          name="organization"
          label="Organization (optional)"
          placeholder="Leave empty to keep the current value"
          value={organization}
          onChange={(e) => setOrganization(e.target.value)}
          maxLength={LIMITS.organization}
          disabled={isPending}
        />
        <Input
          name="designation"
          label="Designation (optional)"
          placeholder="Leave empty to keep the current value"
          value={designation}
          onChange={(e) => setDesignation(e.target.value)}
          maxLength={LIMITS.designation}
          disabled={isPending}
        />
        {/* Enter submits through the same guarded path. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
