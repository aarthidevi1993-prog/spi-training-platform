"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { createRefusalField, outcomeTone, resendGuidance, type OutcomeTone } from "@/lib/user-management/invitations";
import { inviteStudentAction, inviteSuperAdminAction, inviteTrainerAction, resendInvitationAction } from "@/services/invitations.actions";
import type { InvitationActionResult, InvitationSendOutcome } from "@/types/user-management";

export type InviteKind = "student" | "trainer" | "super_admin";

export interface InviteBatchOption {
  id: string;
  label: string;
}

const EMPTY = { email: "", fullName: "", phone: "", organization: "", designation: "", batchId: "", specializations: "" };
type Draft = typeof EMPTY;
type FieldErrors = { email?: string };

const TONE: Record<OutcomeTone, { icon: typeof Info; box: string }> = {
  success: { icon: CheckCircle2, box: "border-signal-green/30 bg-signal-greenSoft text-ink" },
  info: { icon: Info, box: "border-signal-blue/30 bg-signal-blueSoft text-ink" },
  warning: { icon: AlertTriangle, box: "border-signal-amber/30 bg-signal-amberSoft text-ink" },
  error: { icon: XCircle, box: "border-signal-red/30 bg-signal-redSoft text-ink" },
};

/** The code the database assigned to the invitation (0020), when the outcome carries one. */
function assignedCode(o: InvitationSendOutcome): string | null {
  return "code" in o && typeof o.code === "string" ? o.code : null;
}

/** Extra guidance under each result, beyond the outcome message itself. */
function resultHint(o: InvitationSendOutcome): string | null {
  if (o.kind === "sent_unrecorded") return "Do not resend now. The invitation is pending; check the person's account on the Users page shortly.";
  if (o.kind === "delivery_unknown") return "Wait at least a minute before resending, and only if the email doesn't arrive.";
  if (o.kind === "delivery_failed") return "The invitation was created and stays pending; no email was sent.";
  if (o.kind === "refused" && o.reason === "resend_limit") return "A new invitation for this address is possible once this one is revoked or has expired.";
  return null;
}

/**
 * Add Student / Add Trainer invitation dialog (Super Admin, P3.4). The
 * role is fixed by which action is called; the server and the database
 * decide everything else. Duplicate submissions are prevented by the
 * pending transition, a submitting ref (for a second Enter/click before
 * React re-renders), and by switching to the result view as soon as an
 * invitation exists — the same form is never submitted twice.
 *
 * P3.12 "super_admin": name and email only, a full-access warning, and an
 * explicit confirmation that must be ticked before anything is sent. The
 * Super Admin role is fixed by inviteSuperAdminAction on the server.
 */
export function InviteUserDialog({
  kind,
  open,
  onClose,
  batches = [],
}: {
  kind: InviteKind;
  open: boolean;
  onClose: () => void;
  batches?: InviteBatchOption[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const submitting = useRef(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: InvitationSendOutcome; message: string } | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmed, setConfirmed] = useState(false);

  // Fresh dialog every time it opens.
  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY);
    setFieldErrors({});
    setFormError(null);
    setResult(null);
    setResendAt(null);
    setConfirmed(false);
  }, [open]);

  // Countdown for an allowed resend.
  useEffect(() => {
    if (resendAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAt]);

  const isStudent = kind === "student";
  const isSuperAdmin = kind === "super_admin";
  const noun = isStudent ? "student" : isSuperAdmin ? "Super Admin" : "trainer";
  const busy = isPending || submitting.current;

  function close() {
    if (busy) return; // never while a request is in flight
    onClose();
  }

  function finish(res: InvitationActionResult) {
    if (res.status === "error") {
      setFormError(res.error);
      return;
    }
    const o = res.outcome;
    if (o.kind === "sent") {
      const code = assignedCode(o);
      showToast({
        variant: "success",
        title: res.message,
        description: isSuperAdmin
          ? "The new Super Admin gets full administrative access after accepting the invitation; until then the account is listed under Users as invited."
          : `${code ? `${isStudent ? "Student" : "Trainer"} Code: ${code}. ` : ""}The ${noun} will appear in ${isStudent ? "Students" : "Trainers"} after accepting the invitation; until then the account is listed under Users as invited.`,
      });
      router.refresh();
      onClose();
      return;
    }
    if (o.kind === "refused" && o.stage === "create") {
      const field = createRefusalField(o.reason);
      if (field) setFieldErrors({ [field]: res.message });
      else setFormError(res.message);
      return;
    }
    if (o.kind === "unavailable" || (o.kind === "refused" && o.invitationId === null)) {
      setFormError(res.message);
      return;
    }
    // An invitation exists from here on: show the result, never the form again.
    const g = resendGuidance(o);
    setResult({ outcome: o, message: res.message });
    setResendAt(g.allowed ? Date.now() + g.afterSeconds * 1000 : null);
    setNow(Date.now());
    router.refresh();
  }

  function guarded(task: () => Promise<InvitationActionResult>) {
    if (submitting.current || isPending) return;
    submitting.current = true;
    setFieldErrors({});
    setFormError(null);
    startTransition(async () => {
      try {
        finish(await task());
      } catch {
        setFormError("Something went wrong. Please try again.");
      } finally {
        submitting.current = false;
      }
    });
  }

  function submit() {
    if (result) return; // the same form is never sent twice
    if (isSuperAdmin && !confirmed) {
      setFormError("Confirm that this person should have full administrative access before sending the invitation.");
      return;
    }
    const d = draft;
    guarded(() =>
      isSuperAdmin
        ? inviteSuperAdminAction({ email: d.email, fullName: d.fullName })
        : isStudent
        ? inviteStudentAction({
            email: d.email,
            fullName: d.fullName,
            phone: d.phone,
            organization: d.organization,
            designation: d.designation,
            batchId: d.batchId || undefined,
          })
        : inviteTrainerAction({
            email: d.email,
            fullName: d.fullName,
            phone: d.phone,
            organization: d.organization,
            designation: d.designation,
            specializations: d.specializations.split(",").map((s) => s.trim()).filter(Boolean),
          })
    );
  }

  function resend() {
    if (!result?.outcome.invitationId) return;
    const id = result.outcome.invitationId;
    guarded(() => resendInvitationAction(id));
  }

  if (!open) return null;
  const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));
  const waitSeconds = resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000));
  const guidance = result ? resendGuidance(result.outcome) : null;

  // ---------------------------------------------------------------- result view
  if (result) {
    const tone = TONE[outcomeTone(result.outcome)];
    const Icon = tone.icon;
    const hint = resultHint(result.outcome);
    const code = assignedCode(result.outcome);
    return (
      <Modal
        isOpen
        onClose={close}
        title={`Invitation for a new ${noun}`}
        footer={
          <>
            {guidance?.allowed && (
              <Button variant="secondary" onClick={resend} isLoading={isPending} disabled={busy || waitSeconds > 0}>
                {waitSeconds > 0 ? `Resend in ${waitSeconds} s` : "Resend invitation"}
              </Button>
            )}
            <Button onClick={close} disabled={busy}>
              Close
            </Button>
          </>
        }
      >
        <div className={`flex items-start gap-3 rounded border px-3 py-3 text-sm ${tone.box}`} role="status" aria-live="polite">
          <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="flex flex-col gap-1">
            <p>{result.message}</p>
            {code && !isSuperAdmin && (
              <p>
                {isStudent ? "Student" : "Trainer"} Code: <span className="font-mono font-semibold">{code}</span>
              </p>
            )}
            {hint && <p className="text-ink-muted">{hint}</p>}
            {guidance?.allowed && guidance.warning && <p className="text-ink-muted">{guidance.warning}</p>}
          </div>
        </div>
        {formError && <p className="mt-3 text-sm text-signal-red">{formError}</p>}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- form view
  return (
    <Modal
      isOpen
      onClose={close}
      size="lg"
      title={isStudent ? "Invite a student" : isSuperAdmin ? "Invite a Super Admin" : "Invite a trainer"}
      description={
        isSuperAdmin
          ? "An invitation email is sent to this address. The new Super Admin sets a password when accepting it; until then the account is listed under Users as invited."
          : `An invitation email is sent to this address and a ${noun} code is assigned automatically. The ${noun} sets a password when accepting it; until then the account is listed under Users as invited.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="invite-user-form"
            variant={isSuperAdmin ? "danger" : "primary"}
            isLoading={isPending}
            disabled={busy || (isSuperAdmin && !confirmed)}
          >
            {isSuperAdmin ? "Send Super Admin invitation" : "Send invitation"}
          </Button>
        </>
      }
    >
      <form
        id="invite-user-form"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        aria-label={isStudent ? "Invite a student" : isSuperAdmin ? "Invite a Super Admin" : "Invite a trainer"}
        aria-busy={busy}
      >
        {formError && (
          <p className="rounded border border-signal-red/30 bg-signal-redSoft px-3 py-2 text-sm text-ink sm:col-span-2" role="alert">
            {formError}
          </p>
        )}
        {isSuperAdmin && (
          <div className="flex items-start gap-3 rounded border border-signal-red/30 bg-signal-redSoft px-3 py-3 text-sm text-ink sm:col-span-2" role="note">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="font-semibold">Super Admins have full administrative access.</p>
              <p className="text-ink-muted">
                After accepting, this person can manage every user (invite, suspend, change roles), every batch, class, test and
                certificate, and all training records. Invite only someone who must administer the whole platform.
              </p>
            </div>
          </div>
        )}
        <Input name="email" type="email" label="Email" value={draft.email} onChange={set("email")} error={fieldErrors.email} maxLength={254} required disabled={busy} autoComplete="off" />
        <Input name="fullName" label="Full name" value={draft.fullName} onChange={set("fullName")} maxLength={200} required disabled={busy} />
        {isSuperAdmin ? (
          <label className="flex items-start gap-2 text-sm text-ink sm:col-span-2">
            <input
              type="checkbox"
              name="confirmFullAccess"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={busy}
              className="mt-0.5 h-4 w-4 rounded border-surface-border"
            />
            <span>I confirm that {draft.fullName.trim() || "this person"} should become a Super Admin with full administrative access.</span>
          </label>
        ) : (
          <>
            <Input name="phone" label="Phone (optional)" value={draft.phone} onChange={set("phone")} maxLength={40} disabled={busy} />
            <Input name="organization" label="Organization (optional)" value={draft.organization} onChange={set("organization")} maxLength={200} disabled={busy} />
            <Input name="designation" label="Designation (optional)" value={draft.designation} onChange={set("designation")} maxLength={200} disabled={busy} />
          </>
        )}
        {isSuperAdmin ? null : isStudent ? (
          <>
            <div className="sm:col-span-2">
              <Select
                name="batchId"
                label="Batch (optional)"
                value={draft.batchId}
                onChange={set("batchId")}
                disabled={busy}
                options={[{ value: "", label: "No batch — enrol later" }, ...batches.map((b) => ({ value: b.id, label: b.label }))]}
              />
            </div>
          </>
        ) : (
          <div className="sm:col-span-2">
            <Input
              name="specializations"
              label="Specializations (optional)"
              hint="Comma-separated, up to 20"
              value={draft.specializations}
              onChange={set("specializations")}
              disabled={busy}
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
