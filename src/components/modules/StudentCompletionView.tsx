import { CheckCircle2, Circle, Info, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/utils/format";
import type { StudentCompletionItem } from "@/types/certificate";
import { COMPLETION_STATUS, finalAssessmentLabel } from "./completionLabels";

function Check({ ok, pending, label, detail }: { ok: boolean; pending?: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-signal-green" aria-label="Met" />
      ) : pending ? (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-label="Not yet" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red" aria-label="Not met" />
      )}
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-muted">{detail}</p>
      </div>
    </li>
  );
}

/**
 * The student's own completion status per batch, exactly as
 * student_completion_status() returns it. Nothing is calculated here.
 */
export function StudentCompletionView({ items }: { items: StudentCompletionItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {items.map((item) => {
        const e = item.eligibility;
        const c = item.completion;
        const status = c ? COMPLETION_STATUS[c.status] : null;
        return (
          <Card key={item.batchCode}>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">{item.courseTitle}</h3>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {item.courseCode ? `${item.courseCode} · ` : ""}
                    {item.batchName} ({item.batchCode})
                    {item.batchEndDate ? ` · ends ${formatDate(item.batchEndDate)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {status ? (
                    <Badge tone={status.tone}>{status.label}</Badge>
                  ) : e.eligible ? (
                    <Badge tone="teal">Eligible</Badge>
                  ) : (
                    <Badge tone="neutral">In progress</Badge>
                  )}
                </div>
              </div>

              <ul className="flex flex-col gap-3">
                <Check
                  ok={e.batchCompleted}
                  pending={!e.batchCompleted}
                  label="Batch completed"
                  detail={e.batchCompleted ? "The batch has finished." : `The batch is currently ${item.batchStatus}.`}
                />
                <Check
                  ok={e.attendance.ok}
                  label={`Attendance at least ${e.attendance.minimumPercent}%`}
                  detail={
                    e.attendance.eligibleClasses > 0
                      ? `${e.attendance.percent ?? 0}% — attended ${e.attendance.attended} of ${e.attendance.eligibleClasses} classes (present, late or excused).`
                      : "No classes counted yet."
                  }
                />
                <Check
                  ok={e.finalAssessment.ok}
                  pending={e.finalAssessment.state === "pending" || e.finalAssessment.state === "not_designated"}
                  label={item.requirements.finalAssessment ? `Final assessment: ${item.requirements.finalAssessment}` : "Final assessment"}
                  detail={finalAssessmentLabel(e.finalAssessment.state)}
                />
                <Check
                  ok={e.assignments.ok}
                  label="Required assignments returned and scored"
                  detail={
                    e.assignments.required === 0
                      ? "No assignments are required for this batch."
                      : `${e.assignments.satisfied} of ${e.assignments.required} complete${
                          item.requirements.requiredAssignments.length > 0 ? ` — ${item.requirements.requiredAssignments.join(", ")}` : ""
                        }.`
                  }
                />
              </ul>

              {c?.status === "approved" && (
                <p className="rounded-md border border-primary-100 bg-primary-50 px-3 py-2 text-sm text-primary-700">
                  Completion approved{c.completionDate ? ` — completion date ${formatDate(c.completionDate)}` : ""}.
                </p>
              )}
              {c?.status === "recommended" && (
                <p className="rounded-md border border-signal-blue/20 bg-signal-blueSoft px-3 py-2 text-sm text-signal-blue">
                  You have been recommended for completion. A Super Admin will review it.
                </p>
              )}
              {c?.status === "rejected" && (
                <div className="rounded-md border border-signal-red/25 bg-signal-redSoft px-3 py-2.5 text-sm">
                  <p className="font-medium text-signal-red">Completion was not approved</p>
                  {c.rejectionNote && <p className="mt-1 whitespace-pre-line text-ink">{c.rejectionNote}</p>}
                  {c.mayBecomeEligible && (
                    <p className="mt-1.5 text-xs text-ink-muted">
                      Your eligibility can be reassessed once the requirements are met; your trainer can then recommend you again.
                    </p>
                  )}
                </div>
              )}
              {!c && e.eligible && (
                <p className="flex items-start gap-2 text-xs text-ink-muted">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  You meet the requirements. Your trainer or a Super Admin will recommend your completion.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
