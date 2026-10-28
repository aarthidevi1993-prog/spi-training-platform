import { Award, CheckCircle2, Layers, ShieldX, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SummaryStat } from "@/components/dashboard/SummaryStat";
import { CertificatesTable } from "@/components/modules/CertificatesTable";
import { CompletionBatchesTable } from "@/components/modules/CompletionBatchesTable";
import { certificatesService } from "@/services/certificates.service";
import type { CompletionBatchSummary, StaffCertificateSummary } from "@/types/certificate";

export const dynamic = "force-dynamic";

/** Super Admin: batches with completion/certificate counts, and recent certificates. */
export default async function AdminCertificatesPage() {
  let batches: CompletionBatchSummary[] | null = null;
  let certificates: StaffCertificateSummary[] | null = null;
  let loadError: string | null = null;

  try {
    [batches, certificates] = await Promise.all([certificatesService.listCompletionBatches(), certificatesService.listCertificates()]);
  } catch (err) {
    console.error("[admin/certificates] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load completion and certificate data. Please try again.";
  }

  const totals = (batches ?? []).reduce(
    (t, b) => ({
      recommended: t.recommended + b.counts.recommended,
      approved: t.approved + b.counts.approved,
      issued: t.issued + b.counts.issued,
      revoked: t.revoked + b.counts.revoked,
    }),
    { recommended: 0, approved: 0, issued: 0, revoked: 0 }
  );

  return (
    <div>
      <PageHeader title="Certificates" description="Completion requirements, approvals and certificates for every batch." />
      {loadError ? (
        <ErrorState title="We couldn't load certificates" description={loadError} />
      ) : batches === null || certificates === null ? (
        <EmptyState icon={Award} title="Certificates require Supabase mode." description="Sign in with a Supabase account to manage certificates." />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat label="Batches" value={String(batches.length)} icon={Layers} tone="blue" />
            <SummaryStat label="Awaiting approval" value={String(totals.recommended)} icon={UserCheck} tone="gold" />
            <SummaryStat label="Certificates issued" value={String(totals.issued)} icon={CheckCircle2} tone="green" />
            <SummaryStat label="Revoked" value={String(totals.revoked)} icon={ShieldX} tone="red" />
          </div>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Batches</h2>
            {batches.length === 0 ? (
              <EmptyState icon={Layers} title="No batches" description="Batches will appear here once they are created." />
            ) : (
              <CompletionBatchesTable rows={batches} basePath="/admin/certificates" />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Recent certificates</h2>
            {certificates.length === 0 ? (
              <EmptyState icon={Award} title="No certificates yet" description="Issued certificates will appear here." />
            ) : (
              <CertificatesTable
                showStudent
                rows={certificates.slice(0, 25).map((c) => ({
                  certificateNumber: c.certificateNumber,
                  studentName: c.studentName,
                  courseCode: c.courseCode,
                  courseTitle: c.courseTitle,
                  batchCode: c.batchCode,
                  batchName: c.batchName,
                  completionDate: c.completionDate,
                  issuedAt: c.issuedAt,
                  status: c.status,
                  href: `/admin/certificates/view/${encodeURIComponent(c.certificateNumber)}`,
                }))}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
