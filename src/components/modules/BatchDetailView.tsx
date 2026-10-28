import Link from "next/link";
import { ArrowLeft, History, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { formatDate, formatDateTime } from "@/utils/format";
import { EnrollStudentDialog } from "@/components/modules/EnrollStudentDialog";
import { EnrollmentStatusDialog } from "@/components/modules/EnrollmentStatusDialog";
import type { BatchEnrollmentDetail, EnrollmentStatus } from "@/lib/enrollments/enrollment";

/**
 * Batch detail (P3.8). Server-rendered from the enrolment service's read
 * model: the batch header, the roster with each enrolment status, and the
 * enrolment history. This view itself never changes anything; the only
 * mutations are the client EnrollStudentDialog (slice 3A: Super Admin, new
 * enrolment, current batches only; P3.10-A: the same dialog in trainer mode
 * for the trainer's own batch) and, per roster row, the client
 * EnrollmentStatusDialog (slice 3B: Super Admin only — withdraw / complete /
 * re-enrol, as allowed by the row's server-computed actions). Students are
 * shown by name and code only (no contact data).
 */

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

const STATUS_LABEL: Record<EnrollmentStatus, string> = { enrolled: "Enrolled", withdrawn: "Withdrawn", completed: "Completed" };

export function BatchDetailView({ detail, backHref }: { detail: BatchEnrollmentDetail; backHref: string }) {
  const { batch, roster, history, seatsUsed } = detail;
  const isAdmin = detail.mode === "admin";
  const studentLabel = new Map(roster.map((r) => [r.studentId, r.studentName ? `${r.studentName}${r.studentCode ? ` (${r.studentCode})` : ""}` : (r.studentCode ?? "Student")]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={backHref} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to batches
        </Link>
        <PageHeader title={batch.name} description={`${batch.code} · ${batch.course}`} />
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Info label="Course">{batch.course || "—"}</Info>
            <Info label="Trainer">{batch.trainerName ?? "Trainer not assigned"}</Info>
            <Info label="Status">
              <StatusBadge status={batch.status} />
            </Info>
            <Info label="Start date">{formatDate(batch.startDate)}</Info>
            <Info label="End date">{formatDate(batch.endDate)}</Info>
            <Info label="Seats">
              {seatsUsed} / {batch.maxSeats} used
            </Info>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="items-center">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-ink-muted" aria-hidden /> Students
          </CardTitle>
          {/* P3.10-A: the trainer view gets the same dialog in trainer mode (new enrolments only). */}
          {detail.canEnrol && (
            <EnrollStudentDialog
              batchId={batch.id}
              batchName={batch.name}
              candidates={detail.candidates.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
              seatsUsed={seatsUsed}
              maxSeats={batch.maxSeats}
              mode={detail.mode}
            />
          )}
        </CardHeader>
        <CardContent>
          {detail.enrolmentNote && (
            <p role="note" className="mb-3 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
              {detail.enrolmentNote}
            </p>
          )}
          {roster.length === 0 ? (
            <EmptyState title="No students yet" description="Nobody has been enrolled in this batch." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Student</TableHeaderCell>
                  <TableHeaderCell>Code</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Enrolled</TableHeaderCell>
                  <TableHeaderCell>Completed</TableHeaderCell>
                  {isAdmin && <TableHeaderCell className="text-right">Actions</TableHeaderCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {roster.map((r) => (
                  <TableRow key={r.studentId}>
                    <TableCell className="font-medium text-ink">{r.studentName ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.studentCode ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.enrollmentStatus} />
                    </TableCell>
                    <TableCell>{formatDate(r.enrolledAt)}</TableCell>
                    <TableCell>{r.completedAt ? formatDate(r.completedAt) : "—"}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <EnrollmentStatusDialog
                          batchId={batch.id}
                          batchName={batch.name}
                          seatsUsed={seatsUsed}
                          maxSeats={batch.maxSeats}
                          student={{
                            studentId: r.studentId,
                            name: r.studentName ?? "Student",
                            code: r.studentCode ?? "—",
                            status: r.enrollmentStatus,
                            actions: r.actions,
                          }}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-ink-muted" aria-hidden /> Enrolment history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <EmptyState title="No history yet" description="Enrolment changes for this batch will appear here." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Student</TableHeaderCell>
                  <TableHeaderCell>Change</TableHeaderCell>
                  <TableHeaderCell>By</TableHeaderCell>
                  <TableHeaderCell>Reason</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(h.occurredAt)}</TableCell>
                    <TableCell>{studentLabel.get(h.studentId) ?? "Student"}</TableCell>
                    <TableCell>
                      {h.previousStatus ? `${STATUS_LABEL[h.previousStatus]} → ` : ""}
                      {STATUS_LABEL[h.newStatus]}
                    </TableCell>
                    <TableCell>{h.sourceLabel}</TableCell>
                    <TableCell className="text-ink-muted">{h.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
