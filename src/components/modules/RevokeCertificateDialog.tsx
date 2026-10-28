"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { COMPLETION_LIMITS } from "@/types/certificate";

export interface RevokeCertificateDialogProps {
  /** Certificate being revoked; null = closed. */
  certificate: { certificateNumber: string; studentName: string } | null;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

/** Super Admin revocation with a mandatory reason (10–1000 characters). */
export function RevokeCertificateDialog({ certificate, isLoading, onClose, onConfirm }: RevokeCertificateDialogProps) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [certificate]);

  if (!certificate) return null;
  const trimmed = reason.trim();
  const valid = trimmed.length >= COMPLETION_LIMITS.revocationReasonMin && trimmed.length <= COMPLETION_LIMITS.revocationReasonMax;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Revoke ${certificate.certificateNumber}?`}
      description={`${certificate.studentName}'s certificate will stop being valid immediately. It stays in the records and verifies as revoked. The student's completion is not removed, and a new certificate can be issued later.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onConfirm(trimmed)} isLoading={isLoading} disabled={!valid}>
            Revoke certificate
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Reason (required, kept in the audit record)</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          maxLength={COMPLETION_LIMITS.revocationReasonMax + 50}
          className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink focus:border-signal-blue"
        />
        <span className={trimmed.length > 0 && !valid ? "text-xs text-signal-red" : "text-xs text-ink-faint"}>
          {trimmed.length}/{COMPLETION_LIMITS.revocationReasonMax} · at least {COMPLETION_LIMITS.revocationReasonMin} characters
        </span>
      </label>
    </Modal>
  );
}
