import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchCompletionView } from "@/components/modules/BatchCompletionView";
import { certificatesService } from "@/services/certificates.service";
import type { StaffBatchCompletion, StaffCertificateSummary } from "@/types/certificate";

export const dynamic = "force-dynamic";

/**
 * Trainer: completion for one of their assigned batches. Requirements
 * are read-only and only recommend/withdraw are offered (canManage is
 * false); the database refuses anything else. A batch the trainer
 * isn't assigned to is a 404.
 */
export default async function TrainerBatchCompletionPage({ params }: { params: { batchId: string } }) {
  let data: StaffBatchCompletion | null = null;
  let certificates: StaffCertificateSummary[] = [];
  let loadError: string | null = null;

  try {
    data = await certificatesService.getBatchCompletion(params.batchId);
    if (data) certificates = (await certificatesService.listCertificates(data.batch.id)) ?? [];
  } catch (err) {
    console.error("[trainer/certificates/batch] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this batch. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this batch" description={loadError} />;
  if (!data) notFound();

  return <BatchCompletionView data={data} certificates={certificates} basePath="/trainer/certificates" certificateViewBase={null} />;
}
