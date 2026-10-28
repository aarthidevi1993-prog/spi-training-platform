import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchCompletionView } from "@/components/modules/BatchCompletionView";
import { certificatesService } from "@/services/certificates.service";
import type { StaffBatchCompletion, StaffCertificateSummary } from "@/types/certificate";

export const dynamic = "force-dynamic";

/** Super Admin: requirements, eligibility, approval, issue and revocation for one batch. */
export default async function AdminBatchCompletionPage({ params }: { params: { batchId: string } }) {
  let data: StaffBatchCompletion | null = null;
  let certificates: StaffCertificateSummary[] = [];
  let loadError: string | null = null;

  try {
    data = await certificatesService.getBatchCompletion(params.batchId);
    if (data) certificates = (await certificatesService.listCertificates(data.batch.id)) ?? [];
  } catch (err) {
    console.error("[admin/certificates/batch] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this batch. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this batch" description={loadError} />;
  if (!data) notFound();

  return (
    <BatchCompletionView
      data={data}
      certificates={certificates}
      basePath="/admin/certificates"
      certificateViewBase="/admin/certificates/view"
    />
  );
}
