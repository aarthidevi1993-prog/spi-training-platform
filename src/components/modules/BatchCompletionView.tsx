"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Lock, Unlock, XCircle } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/utils/format";
import {
  approveCompletionAction,
  issueCertificateAction,
  recommendCompletionAction,
  rejectCompletionAction,
  revokeCertificateAction,
  withdrawRecommendationAction,
} from "@/services/certificates.actions";
import type {
  CompletionActionResult,
  StaffBatchCompletion,
  StaffCertificateSummary,
  StaffCompletionStudent,
} from "@/types/certificate";
import { CertificatesTable } from "./CertificatesTable";
import { CompletionDecisionDialog, type CompletionDecisionMode } from "./CompletionDecisionDialog";
import { CompletionRequirementsEditor } from "./CompletionRequirementsEditor";
import { RevokeCertificateDialog } from "./RevokeCertificateDialog";
import { COMPLETION_STATUS, LOCK_REASON, finalAssessmentLabel } from "./completionLabels";

export interface BatchCompletionViewProps {
  data: StaffBatchCompletion;
  certificates: StaffCertificateSummary[];
  /** e.g. "/admin/certificates" */
  basePath: string;
  /** Where a certificate document can be opened (admin only); null hides the link. */
  certificateViewBase: string | null;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="inline h-3.5 w-3.5 text-signal-green" aria-label="Met" />
  ) : (
    <XCircle className="inline h-3.5 w-3.5 text-signal-red" aria-label="Not met" />
  );
}

type Confirm = { kind: "withdraw" | "issue"; student: StaffCompletionStudent } | null;

/**
 * A batch's completion overview (staff_batch_completion). Every state
 * shown — eligibility, lock, completion status, certificates — comes
 * from the database; buttons only offer the next steps those states
 * allow, and every action goes through a server action that the
 * database re-checks. Trainers (canManage = false) see requirements
 * read-only and can only recommend or withdraw.
 */
export function BatchCompletionView({ data, certificates, basePath, certificateViewBase }: BatchCompletionViewProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [decision, setDecision] = useState<{ mode: CompletionDecisionMode; student: StaffCompletionStudent } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [revoke, setRevoke] = useState<StaffCompletionStudent | null>(null);

  const { batch, canManage } = data;

  function run(action: () => Promise<CompletionActionResult>, success: (r: CompletionActionResult) => string, failure: string) {
    startTransition(async () => {
      const result = await action();
      setDecision(null);
      setConfirm(null);
      setRevoke(null);
      if (!result.ok) {
        showToast({ variant: "error", title: failure, description: result.error });
      } else {
        showToast({ variant: "success", title: success(result) });
      }
      // Always reload the authoritative state from the database.
      router.refresh();
    });
  }

  function onDecision(note: string) {
    if (!decision) return;
    const { mode, student } = decision;
    if (mode === "recommend") {
      run(() => recommendCompletionAction(batch.id, student.studentId, note || null), () => "Completion recommended.", "Couldn't recommend completion");
    } else if (mode === "approve" && student.completion) {
      const id = student.completion.id;
      run(() => approveCompletionAction(id, note || null), () => "Completion approved.", "Couldn't approve completion");
    } else if (mode === "reject" && student.completion) {
      const id = student.completion.id;
      run(() => rejectCompletionAction(id, note), () => "Completion rejected.", "Couldn't reject completion");
    }
  }

  function onConfirm() {
    if (!confirm?.student.completion) return;
    const id = confirm.student.completion.id;
    if (confirm.kind === "withdraw") {
      run(() => withdrawRecommendationAction(id), () => "Recommendation withdrawn.", "Couldn't withdraw the recommendation");
    } else {
      run(
        () => issueCertificateAction(id),
        (r) => (r.certificateNumber ? `Certificate ${r.certificateNumber} issued.` : "Certificate issued."),
        "Couldn't issue the certificate"
      );
    }
  }

  function actionsFor(s: StaffCompletionStudent) {
    const status = s.completion?.status ?? null;
    const buttons: JSX.Element[] = [];
    const canRecommend = s.eligibility.eligible && (status === null || status === "rejected" || status === "withdrawn");
    if (canRecommend) {
      buttons.push(
        <Button key="rec" size="sm" variant="secondary" disabled={isPending} onClick={() => setDecision({ mode: "recommend", student: s })}>
          Recommend
        </Button>
      );
    }
    if (status === "recommended") {
      if (canManage) {
        buttons.push(
          <Button key="app" size="sm" disabled={isPending} onClick={() => setDecision({ mode: "approve", student: s })}>
            Approve
          </Button>,
          <Button key="rej" size="sm" variant="secondary" disabled={isPending} onClick={() => setDecision({ mode: "reject", student: s })}>
            Reject
          </Button>
        );
      }
      buttons.push(
        <Button key="wd" size="sm" variant="ghost" disabled={isPending} onClick={() => setConfirm({ kind: "withdraw", student: s })}>
          Withdraw
        </Button>
      );
    }
    if (canManage && status === "approved") {
      if (s.activeCertificate) {
        buttons.push(
          <Button key="rev" size="sm" variant="ghost" className="text-signal-red" disabled={isPending} onClick={() => setRevoke(s)}>
            Revoke
          </Button>
        );
      } else {
        buttons.push(
          <Button key="iss" size="sm" disabled={isPending} onClick={() => setConfirm({ kind: "issue", student: s })}>
            {s.revokedCertificates > 0 ? "Reissue" : "Issue certificate"}
          </Button>
        );
      }
    }
    return buttons.length > 0 ? <div className="flex flex-wrap justify-end gap-1.5">{buttons}</div> : <span className="text-xs text-ink-faint">—</span>;
  }

  return (
    <div>
      <Link href={basePath} className="mb-3 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to certificates
      </Link>

      <PageHeader
        title={`${batch.name} (${batch.batchCode})`}
        description={batch.courseTitle ? `${batch.courseCode ? `${batch.courseCode} — ` : ""}${batch.courseTitle}` : "Completion and certificates"}
        actions={<StatusBadge status={batch.status} />}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Info label="Trainer" value={batch.trainerName ?? "Not assigned"} />
              <Info label="Batch status" value={batch.status.charAt(0).toUpperCase() + batch.status.slice(1)} />
              <Info label="Start date" value={batch.startDate ? formatDate(batch.startDate) : "—"} />
              <Info label="End date (completion date)" value={batch.endDate ? formatDate(batch.endDate) : "—"} />
            </dl>
            <div className="mt-4 flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2.5 text-sm">
              {data.requirementsLocked ? (
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" aria-hidden />
              ) : (
                <Unlock className="mt-0.5 h-4 w-4 shrink-0 text-signal-green" aria-hidden />
              )}
              <span className="text-ink-muted">
                {data.requirementsLocked
                  ? `Requirements are locked. ${data.lockReason ? LOCK_REASON[data.lockReason] ?? "" : ""}`
                  : "Requirements can still be changed. They lock when the batch is completed or cancelled, or once a completion is approved."}
              </span>
            </div>
            {batch.status !== "completed" && (
              <p className="mt-3 text-xs text-ink-muted">
                Students become eligible only after the batch is marked completed.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {canManage && !data.requirementsLocked ? (
              <CompletionRequirementsEditor
                batchId={batch.id}
                requirements={data.requirements}
                finalAssessmentOptions={data.finalAssessmentOptions}
                assignmentOptions={data.assignmentOptions}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Required final assessment</h3>
                  <p className="mt-1 text-sm text-ink">
                    {data.requirements.finalAssessment?.title ?? <span className="text-ink-muted">Not designated — no student can be eligible.</span>}
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-ink">Required assignments</h3>
                  {data.requirements.requiredAssignments.length === 0 ? (
                    <p className="mt-1 text-sm text-ink-muted">None required.</p>
                  ) : (
                    <ul className="mt-1 list-inside list-disc text-sm text-ink">
                      {data.requirements.requiredAssignments.map((a) => (
                        <li key={a.assignmentId}>{a.title}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {!canManage && <p className="text-xs text-ink-faint">Requirements are set by a Super Admin.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-3 mt-6 text-sm font-semibold text-ink">Students</h2>
      {data.students.length === 0 ? (
        <EmptyState title="No students" description="No students are enrolled in this batch." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Student</TableHeaderCell>
              <TableHeaderCell>Attendance</TableHeaderCell>
              <TableHeaderCell>Final assessment</TableHeaderCell>
              <TableHeaderCell>Assignments</TableHeaderCell>
              <TableHeaderCell>Eligibility</TableHeaderCell>
              <TableHeaderCell>Completion</TableHeaderCell>
              <TableHeaderCell>Certificate</TableHeaderCell>
              <TableHeaderCell className="text-right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.students.map((s) => {
              const e = s.eligibility;
              const status = s.completion ? COMPLETION_STATUS[s.completion.status] : null;
              return (
                <TableRow key={s.studentId}>
                  <TableCell className="font-medium text-ink">
                    {s.fullName}
                    <span className="block text-2xs font-normal text-ink-faint">
                      {s.studentCode}
                      {s.enrollmentStatus && s.enrollmentStatus !== "enrolled" ? ` · ${s.enrollmentStatus}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <Mark ok={e.attendance.ok} /> {e.attendance.percent !== null ? `${e.attendance.percent}%` : "—"}
                    <span className="block text-2xs text-ink-faint">
                      {e.attendance.attended}/{e.attendance.eligibleClasses} · min {e.attendance.minimumPercent}%
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <Mark ok={e.finalAssessment.ok} /> {finalAssessmentLabel(e.finalAssessment.state)}
                    {e.finalAssessment.bestPercentage !== null && (
                      <span className="block text-2xs text-ink-faint">Best {e.finalAssessment.bestPercentage}%</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    <Mark ok={e.assignments.ok} /> {e.assignments.satisfied}/{e.assignments.required}
                    {e.assignments.state === "requirement_invalid" && (
                      <span className="block text-2xs text-signal-red">Requirement invalid</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {e.eligible ? <Badge tone="teal">Eligible</Badge> : <Badge tone="neutral">Not eligible</Badge>}
                    {!e.batchCompleted && <span className="block text-2xs text-ink-faint">Batch not completed</span>}
                  </TableCell>
                  <TableCell>
                    {status ? <Badge tone={status.tone}>{status.label}</Badge> : <span className="text-xs text-ink-faint">—</span>}
                    {s.completion?.status === "rejected" && s.completion.decisionNote && (
                      <span className="mt-1 block max-w-[14rem] text-2xs text-ink-muted" title={s.completion.decisionNote}>
                        {s.completion.decisionNote}
                      </span>
                    )}
                    {s.completion?.completionDate && (
                      <span className="block text-2xs text-ink-faint">Completed {formatDate(s.completion.completionDate)}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {s.activeCertificate ? (
                      certificateViewBase ? (
                        <Link
                          href={`${certificateViewBase}/${encodeURIComponent(s.activeCertificate.certificateNumber)}`}
                          className="font-mono text-xs text-primary-600 hover:underline"
                        >
                          {s.activeCertificate.certificateNumber}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-ink">{s.activeCertificate.certificateNumber}</span>
                      )
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                    {s.revokedCertificates > 0 && (
                      <span className="block text-2xs text-ink-faint">{s.revokedCertificates} revoked</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{actionsFor(s)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {certificates.length > 0 && (
        <>
          <h2 className="mb-3 mt-6 text-sm font-semibold text-ink">Certificates of this batch</h2>
          <CertificatesTable
            showStudent
            rows={certificates.map((c) => ({
              certificateNumber: c.certificateNumber,
              studentName: c.studentName,
              courseCode: c.courseCode,
              courseTitle: c.courseTitle,
              batchCode: c.batchCode,
              batchName: c.batchName,
              completionDate: c.completionDate,
              issuedAt: c.issuedAt,
              status: c.status,
              href: certificateViewBase ? `${certificateViewBase}/${encodeURIComponent(c.certificateNumber)}` : undefined,
            }))}
          />
        </>
      )}

      <CompletionDecisionDialog
        mode={decision?.mode ?? null}
        studentName={decision?.student.fullName ?? ""}
        isLoading={isPending}
        onClose={() => setDecision(null)}
        onConfirm={onDecision}
      />

      <RevokeCertificateDialog
        certificate={
          revoke?.activeCertificate ? { certificateNumber: revoke.activeCertificate.certificateNumber, studentName: revoke.fullName } : null
        }
        isLoading={isPending}
        onClose={() => setRevoke(null)}
        onConfirm={(reason) => {
          const id = revoke?.activeCertificate?.id;
          if (id) run(() => revokeCertificateAction(id, reason), () => "Certificate revoked.", "Couldn't revoke the certificate");
        }}
      />

      <Dialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={onConfirm}
        title={
          confirm?.kind === "issue"
            ? `${confirm.student.revokedCertificates > 0 ? "Reissue" : "Issue"} certificate for ${confirm.student.fullName}?`
            : `Withdraw the recommendation for ${confirm?.student.fullName ?? ""}?`
        }
        description={
          confirm?.kind === "issue"
            ? "The database re-checks eligibility, then generates the certificate number, verification code and a permanent snapshot of the details."
            : "The student can be recommended again later."
        }
        confirmLabel={confirm?.kind === "issue" ? "Issue certificate" : "Withdraw"}
        isLoading={isPending}
      />
    </div>
  );
}
