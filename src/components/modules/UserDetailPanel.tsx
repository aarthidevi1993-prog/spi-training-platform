"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Ban, History, Mail, Pencil, RotateCcw, Send, ShieldAlert, UserCog, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { ACCOUNT_STATUS_LABEL } from "@/lib/user-management/users";
import { INVITATION_RESEND_LIMIT, LIMITS } from "@/lib/user-management/lifecycle";
import { outcomeTone } from "@/lib/user-management/invitations";
import { changeUserRoleAction, setAccountStatusAction, updateUserDetailsAction } from "@/services/users.actions";
import { recoverInvitationAction, resendInvitationAction, revokeInvitationAction } from "@/services/invitations.actions";
import { formatDate, formatDateTime } from "@/utils/format";
import type { UserRole } from "@/types/user";
import type { UserActionResult, UserDetail } from "@/types/user-management";

const textareaClass = "rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink focus:border-signal-blue";

function displayName(d: UserDetail): string {
  return d.user.name ?? "this account";
}

function roleText(role: UserRole | null): string {
  return role ? ROLE_LABEL[role] : "Unknown role";
}

/** Runs a server action, then shows the outcome and reloads the server data. */
function useLifecycleAction() {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  function run(action: () => Promise<UserActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        showToast({ variant: "success", title: result.message });
        onDone?.();
      } else {
        showToast({ variant: "error", title: "The change was not made", description: result.error });
      }
      router.refresh();
    });
  }
  return { isPending, run };
}

// -------------------------------------------------------------------
// Account status
// -------------------------------------------------------------------
function StatusDialog({ detail, target, onClose }: { detail: UserDetail; target: "active" | "suspended" | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { isPending, run } = useLifecycleAction();
  useEffect(() => setReason(""), [target]);
  if (!target) return null;
  const u = detail.user;
  const suspending = target === "suspended";
  const consequence = suspending
    ? `${displayName(detail)} loses access to every portal from their next request and cannot sign in until reactivated. Their role, records, enrolments and history are kept unchanged.`
    : `${displayName(detail)} can sign in again with their existing role (${roleText(u.role)}). Records, enrolments and history are unchanged.`;
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={suspending ? "Suspend this account?" : "Reactivate this account?"}
      description={consequence}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={suspending ? "danger" : "primary"}
            isLoading={isPending}
            onClick={() => run(() => setAccountStatusAction(u.id, target, reason.trim() || null), onClose)}
          >
            {suspending ? "Suspend account" : "Reactivate account"}
          </Button>
        </>
      }
    >
      <dl className="mb-4 grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-ink-muted">Account</dt>
        <dd className="text-ink">
          {displayName(detail)} <span className="font-mono text-2xs text-ink-faint">{u.id}</span>
        </dd>
        <dt className="text-ink-muted">Current status</dt>
        <dd>
          <StatusBadge status={u.accountStatus} />
        </dd>
        <dt className="text-ink-muted">New status</dt>
        <dd>
          <StatusBadge status={target} />
        </dd>
      </dl>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Reason (optional, kept in the audit history)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={LIMITS.reason} className={textareaClass} />
        <span className="text-xs text-ink-faint">
          {reason.trim().length}/{LIMITS.reason}
        </span>
      </label>
    </Modal>
  );
}

// -------------------------------------------------------------------
// Role
// -------------------------------------------------------------------
const ROLES: UserRole[] = ["admin", "trainer", "student"];

function RoleDialog({ detail, open, onClose }: { detail: UserDetail; open: boolean; onClose: () => void }) {
  const u = detail.user;
  const missingOwnRecord = u.recordState === "missing";
  const initial = missingOwnRecord && u.role ? u.role : (ROLES.find((r) => r !== u.role) ?? "student");
  const [role, setRole] = useState<UserRole>(initial);
  const [fullName, setFullName] = useState(u.name ?? "");
  const { isPending, run } = useLifecycleAction();
  useEffect(() => {
    setRole(initial);
    setFullName(u.name ?? "");
  }, [open, initial, u.name]);
  if (!open) return null;

  const sameRole = role === u.role;
  const needsRecord = role === "student" ? !detail.hasStudentRecord : role === "trainer" ? !detail.hasTrainerRecord : false;
  const existingTarget = role === "student" && detail.hasStudentRecord ? "student" : role === "trainer" && detail.hasTrainerRecord ? "trainer" : null;
  const options = ROLES.filter((r) => r !== u.role || missingOwnRecord).map((r) => ({
    value: r,
    label: r === u.role ? `${ROLE_LABEL[r]} — create the missing record` : ROLE_LABEL[r],
  }));

  const consequences: string[] = [];
  if (!sameRole) {
    consequences.push(`Access moves from the ${roleText(u.role)} portal to the ${ROLE_LABEL[role]} portal on the next request.`);
    if (u.record) consequences.push(`The current ${u.record.kind} record (${u.record.code}) is kept and marked inactive; its history stays.`);
    if (role === "admin") consequences.push("Super Admins can see and manage every account and all training data.");
  }
  if (existingTarget) consequences.push(`The existing ${existingTarget} record is reactivated (nothing new is created).`);
  if (needsRecord) consequences.push(`A new ${role} record is created with the name below and an automatically assigned ${role} code; the email comes from the account.`);
  consequences.push("The database refuses the change if it would leave no active Super Admin, or while the old role still has current batches, enrolments or a test in progress.");

  const submit = () =>
    run(() => changeUserRoleAction(u.id, role, needsRecord ? { fullName: fullName.trim() } : null), onClose);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={sameRole ? "Create the missing record?" : "Change this account's role?"}
      description={`${displayName(detail)} · currently ${roleText(u.role)} · ${ACCOUNT_STATUS_LABEL[u.accountStatus]}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" isLoading={isPending} onClick={submit} disabled={needsRecord && !fullName.trim()}>
            {sameRole ? "Create record" : `Change role to ${ROLE_LABEL[role]}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select name="role" label="New role" value={role} onChange={(e) => setRole(e.target.value as UserRole)} options={options} />
        {needsRecord && (
          <Input
            name="fullName"
            label="Full name"
            hint={`The ${role} code is assigned automatically.`}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={LIMITS.fullName}
          />
        )}
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
          {consequences.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------
// Details
// -------------------------------------------------------------------
function DetailsForm({ detail, onCancel }: { detail: UserDetail; onCancel: () => void }) {
  const contact = detail.contact!;
  const [fullName, setFullName] = useState(contact.fields.fullName);
  const [phone, setPhone] = useState(contact.fields.phone ?? "");
  const [organization, setOrganization] = useState(contact.fields.organization ?? "");
  const [designation, setDesignation] = useState(contact.fields.designation ?? "");
  const [specializations, setSpecializations] = useState(contact.kind === "trainer" ? contact.fields.specializations.join(", ") : "");
  const [bio, setBio] = useState(contact.kind === "trainer" ? (contact.fields.bio ?? "") : "");
  const { isPending, run } = useLifecycleAction();

  const save = () => {
    const details: Record<string, unknown> =
      contact.kind === "student"
        ? { fullName, phone, organization, designation }
        : { fullName, phone, organization, designation, bio, specializations: specializations.split(",").map((s) => s.trim()).filter(Boolean) };
    run(() => updateUserDetailsAction(detail.user.id, details), onCancel);
  };

  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      aria-label="Edit details"
    >
      <Input name="fullName" label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={LIMITS.fullName} required />
      <Input name="phone" label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={LIMITS.phone} />
      <Input name="organization" label="Organization" value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={LIMITS.organization} />
      <Input name="designation" label="Designation" value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={LIMITS.designation} />
      {contact.kind === "trainer" && (
        <>
          <Input name="specializations" label="Specializations" hint="Comma-separated (max 20)" value={specializations} onChange={(e) => setSpecializations(e.target.value)} />
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium text-ink">Bio</span>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={LIMITS.bio} className={textareaClass} />
          </label>
        </>
      )}
      <p className="text-xs text-ink-muted sm:col-span-2">Email comes from the account and isn&apos;t edited here. Only changed fields are saved and recorded in the history.</p>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" isLoading={isPending}>
          Save details
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DetailsView({ detail }: { detail: UserDetail }) {
  const c = detail.contact!;
  const rows: [string, string][] =
    c.kind === "student"
      ? [
          ["Phone", c.fields.phone ?? "—"],
          ["Organization", c.fields.organization ?? "—"],
          ["Designation", c.fields.designation ?? "—"],
        ]
      : [
          ["Phone", c.fields.phone ?? "—"],
          ["Organization", c.fields.organization ?? "—"],
          ["Designation", c.fields.designation ?? "—"],
          ["Specializations", c.fields.specializations.length ? c.fields.specializations.join(", ") : "—"],
          ["Bio", c.fields.bio ?? "—"],
        ];
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="whitespace-pre-line text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// -------------------------------------------------------------------
// Invitation of an invited account (P3.9)
// -------------------------------------------------------------------
function RevokeInvitationDialog({ detail, open, onClose }: { detail: UserDetail; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { isPending, run } = useLifecycleAction();
  useEffect(() => setReason(""), [open]);
  const inv = detail.invitation;
  if (!open || !inv) return null;
  return (
    <Modal
      isOpen
      onClose={() => {
        if (!isPending) onClose();
      }}
      title="Revoke this invitation?"
      description={`${displayName(detail)} will no longer be able to accept it. Only the invitation changes: the account stays Invited, nothing is deleted, and the address can be invited again later.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" isLoading={isPending} onClick={() => run(() => revokeInvitationAction(inv.id, reason.trim() || null), onClose)}>
            Revoke invitation
          </Button>
        </>
      }
    >
      <dl className="mb-4 grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-ink-muted">Account</dt>
        <dd className="text-ink">{detail.user.email ?? displayName(detail)}</dd>
        <dt className="text-ink-muted">Invitation</dt>
        <dd>
          <StatusBadge status={inv.status} />
        </dd>
        <dt className="text-ink-muted">Expires</dt>
        <dd className="text-ink">{formatDateTime(inv.expiresAt)}</dd>
      </dl>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">Reason (optional, kept with the invitation)</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={LIMITS.reason} className={textareaClass} disabled={isPending} />
        <span className="text-xs text-ink-faint">
          {reason.trim().length}/{LIMITS.reason}
        </span>
      </label>
    </Modal>
  );
}

/**
 * The invited account's latest invitation: status, when it was sent, and — while it is pending —
 * Resend (the existing delivery path; the database enforces cooldown, cap and expiry) and Revoke
 * (after a confirmation). The buttons are hints only; the server and the database decide.
 */
function InvitationSection({ detail }: { detail: UserDetail }) {
  const inv = detail.invitation!;
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const sending = useRef(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  function resend() {
    // Duplicate-submission guard: one resend request at a time.
    if (sending.current || isPending) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const result = await resendInvitationAction(inv.id);
        if (result.status === "outcome") showToast({ variant: outcomeTone(result.outcome), title: result.message });
        else showToast({ variant: "error", title: "The invitation was not resent", description: result.error });
      } finally {
        sending.current = false;
        router.refresh();
      }
    });
  }

  const pending = inv.status === "pending";
  return (
    <section aria-labelledby="ud-invitation" className="flex flex-col gap-2 border-t border-surface-border pt-4">
      <h3 id="ud-invitation" className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
        <Mail className="h-3.5 w-3.5" aria-hidden /> Invitation
      </h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge status={inv.status} />
        <span className="text-xs text-ink-muted">
          {inv.lastSentAt ? `Last sent ${formatDateTime(inv.lastSentAt)}` : "Not sent yet"}
          {pending ? ` · expires ${formatDateTime(inv.expiresAt)}` : inv.status === "expired" ? ` · expired ${formatDateTime(inv.expiresAt)}` : ""}
          {inv.resendCount > 0 ? ` · resent ${inv.resendCount} of ${INVITATION_RESEND_LIMIT} times` : ""}
        </span>
      </div>
      {!pending && (
        <p className="text-xs text-ink-muted">This invitation can no longer be accepted. To give this person access, invite the address again from Students or Trainers.</p>
      )}
      {pending && !inv.canResend && (
        <p className="text-xs text-ink-muted">This invitation has been resent the maximum number of times. Revoke it, then invite the address again if needed.</p>
      )}
      {(inv.canResend || inv.canRevoke) && (
        <div className="flex flex-wrap gap-2">
          {inv.canResend && (
            <Button size="sm" variant="secondary" isLoading={isPending} onClick={resend}>
              <Send className="h-3.5 w-3.5" /> Resend invitation
            </Button>
          )}
          {inv.canRevoke && (
            <Button size="sm" variant="danger" disabled={isPending} onClick={() => setRevokeOpen(true)}>
              <Ban className="h-3.5 w-3.5" /> Revoke invitation
            </Button>
          )}
        </div>
      )}
      <RevokeInvitationDialog detail={detail} open={revokeOpen} onClose={() => setRevokeOpen(false)} />
    </section>
  );
}

/**
 * P5.2: an invited account that never finished setting up, whose pending invitation could not be re-sent because
 * the address is already registered. "Send sign-in link" asks the server to e-mail a one-time sign-in link to the
 * account's own address (the database checks eligibility, cooldown and cap and records the request). Nothing is
 * linked until the person opens the link and continues; no account is deleted or changed here.
 */
function RecoverySection({ detail }: { detail: UserDetail }) {
  const rec = detail.recovery!;
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const sending = useRef(false);

  function send() {
    // Duplicate-submission guard: one request at a time.
    if (sending.current || isPending) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const result = await recoverInvitationAction(rec.invitationId);
        if (result.ok) showToast({ variant: "success", title: result.message });
        // Not "no link was sent": when the result is uncertain a link may have gone out — the description says which.
        else showToast({ variant: "error", title: "Sign-in link not confirmed as sent", description: result.error });
      } finally {
        sending.current = false;
        router.refresh();
      }
    });
  }

  return (
    <section aria-labelledby="ud-recovery" className="flex flex-col gap-2 border-t border-surface-border pt-4">
      <h3 id="ud-recovery" className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
        <Mail className="h-3.5 w-3.5" aria-hidden /> Invitation not linked
      </h3>
      <p className="text-xs text-ink-muted">
        This person has a pending invitation (expires {formatDateTime(rec.expiresAt)}), but it can&apos;t be resent because their address is
        already registered.{" "}
        {rec.available
          ? "Send them a sign-in link: after they open it and continue, they can finish setting up their account."
          : "A sign-in link will be the way to let them finish setting up their account once sign-in links are turned on."}
      </p>
      <p className="text-xs text-ink-muted">
        {/* recovery_requested_at is recorded before the e-mail is attempted: it is a request time, not a delivery time. */}
        {rec.recoveryRequestedAt ? `Last sign-in link requested ${formatDateTime(rec.recoveryRequestedAt)}` : "No sign-in link requested yet"}
        {rec.resendCount > 0 ? ` · emails resent ${rec.resendCount} of ${INVITATION_RESEND_LIMIT} times` : ""}
      </p>
      {/* The server-side switch (default off) decides whether the action is offered; the server refuses either way. */}
      {rec.available ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isLoading={isPending} disabled={rec.resendCount >= INVITATION_RESEND_LIMIT} onClick={send}>
            <Send className="h-3.5 w-3.5" /> Send sign-in link
          </Button>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">
          Sign-in links are turned off on this server until their email setup has been confirmed, so this can&apos;t be sent yet.
        </p>
      )}
    </section>
  );
}

// -------------------------------------------------------------------
// Panel
// -------------------------------------------------------------------
/**
 * Lifecycle controls for one account (Super Admin). Every button calls a
 * server action; the server re-checks the caller and the 0017 database
 * function decides — these controls are only shown when that function
 * could accept them, never as the authorization.
 */
/**
 * `initialEdit` (P3.11-C, from `?edit=details`): open the details form at once — only when the panel itself
 * offers editing (a present record for the account's current role). Saving goes through the same server action;
 * editing never changes the account's status or role.
 */
export function UserDetailPanel({ detail, closeHref, initialEdit = false }: { detail: UserDetail; closeHref: string; initialEdit?: boolean }) {
  const [statusTarget, setStatusTarget] = useState<"active" | "suspended" | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const u = detail.user;
  const a = detail.actions;
  const canStartEditing = initialEdit && a.editDetails && detail.contact !== null;
  const [editing, setEditing] = useState(canStartEditing);
  useEffect(() => setEditing(canStartEditing), [u.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reset per account only

  return (
    <Card aria-label={`Account ${u.name ?? u.id}`}>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={u.name ?? "?"} tone={u.name ? "blue" : "neutral"} />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-ink">{u.name ?? "Name not recorded"}</p>
              <p className="truncate text-sm text-ink-muted">{u.email ?? "—"}</p>
              <p className="truncate font-mono text-2xs text-ink-faint">{u.id}</p>
            </div>
          </div>
          <Link href={closeHref} className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken" aria-label="Close account details">
            <X className="h-4 w-4" />
          </Link>
        </div>

        {a.note && (
          <p className="flex items-start gap-2 rounded border border-surface-border bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {a.note}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <section aria-labelledby="ud-account" className="flex flex-col gap-2">
            <h3 id="ud-account" className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Account status
            </h3>
            <div className="flex items-center gap-2">
              <StatusBadge status={u.accountStatus} />
              <span className="text-xs text-ink-faint">since {formatDate(u.accountStatusChangedAt)}</span>
            </div>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-ink-faint">Account created</dt>
              <dd className="text-ink-muted">{formatDate(u.createdAt)}</dd>
              {detail.invitationAcceptedAt && (
                <>
                  <dt className="text-ink-faint">Invitation accepted</dt>
                  <dd className="text-ink-muted">{formatDate(detail.invitationAcceptedAt)}</dd>
                </>
              )}
            </dl>
            <div className="flex flex-wrap gap-2">
              {a.suspend && (
                <Button size="sm" variant="danger" onClick={() => setStatusTarget("suspended")}>
                  Suspend
                </Button>
              )}
              {a.reactivate && (
                <Button size="sm" onClick={() => setStatusTarget("active")}>
                  <RotateCcw className="h-3.5 w-3.5" /> Reactivate
                </Button>
              )}
            </div>
          </section>

          <section aria-labelledby="ud-role" className="flex flex-col gap-2">
            <h3 id="ud-role" className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Role
            </h3>
            <p className="text-sm text-ink">{roleText(u.role)}</p>
            {a.changeRole && (
              <div>
                <Button size="sm" variant="secondary" onClick={() => setRoleOpen(true)}>
                  <UserCog className="h-3.5 w-3.5" /> {u.recordState === "missing" ? "Change role / create record" : "Change role"}
                </Button>
              </div>
            )}
          </section>

          <section aria-labelledby="ud-record" className="flex flex-col gap-2">
            <h3 id="ud-record" className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              Domain record
            </h3>
            {u.recordState === "not_applicable" ? (
              <p className="text-sm text-ink-faint">Not applicable</p>
            ) : u.record ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-ink">{u.record.code}</span>
                <StatusBadge status={u.record.status} />
              </div>
            ) : (
              <Badge tone="amber">Missing</Badge>
            )}
            {u.otherRecord && (
              <p className="text-xs text-ink-muted">
                Earlier {u.otherRecord.kind} record {u.otherRecord.code} ({u.otherRecord.status})
              </p>
            )}
          </section>
        </div>

        {detail.invitation && <InvitationSection key={detail.invitation.id} detail={detail} />}

        {detail.recovery && <RecoverySection key={detail.recovery.invitationId} detail={detail} />}

        {detail.contact && (
          <section aria-labelledby="ud-details" className="flex flex-col gap-3 border-t border-surface-border pt-4">
            <div className="flex items-center justify-between">
              <h3 id="ud-details" className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                {detail.contact.kind === "student" ? "Student details" : "Trainer details"}
              </h3>
              {a.editDetails && !editing && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
              )}
            </div>
            {editing ? <DetailsForm detail={detail} onCancel={() => setEditing(false)} /> : <DetailsView detail={detail} />}
          </section>
        )}

        <section aria-labelledby="ud-history" className="flex flex-col gap-2 border-t border-surface-border pt-4">
          <h3 id="ud-history" className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
            <History className="h-3.5 w-3.5" aria-hidden /> Account history
          </h3>
          {detail.history.length === 0 ? (
            <p className="text-sm text-ink-faint">No user-management changes recorded for this account yet.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {detail.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="whitespace-nowrap text-xs text-ink-faint">{formatDateTime(h.occurredAt)}</span>
                  <span className="text-ink">{h.summary}</span>
                  <span className="text-xs text-ink-muted">
                    {h.actor === null ? (
                      "· system"
                    ) : h.actor === "you" ? (
                      "· by you"
                    ) : h.actorName ? (
                      <>· by {h.actorName}</>
                    ) : (
                      <>
                        · by <span className="font-mono">{h.actor.slice(0, 8)}</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </CardContent>

      <StatusDialog detail={detail} target={statusTarget} onClose={() => setStatusTarget(null)} />
      <RoleDialog detail={detail} open={roleOpen} onClose={() => setRoleOpen(false)} />
    </Card>
  );
}
