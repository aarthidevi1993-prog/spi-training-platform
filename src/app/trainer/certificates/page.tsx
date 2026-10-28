import { Award, Layers } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { CompletionBatchesTable } from "@/components/modules/CompletionBatchesTable";
import { certificatesService } from "@/services/certificates.service";
import type { CompletionBatchSummary } from "@/types/certificate";

export const dynamic = "force-dynamic";

/** Trainer: their assigned batches (any status) with completion progress. */
export default async function TrainerCertificatesPage() {
  let batches: CompletionBatchSummary[] | null = null;
  let loadError: string | null = null;

  try {
    batches = await certificatesService.listCompletionBatches();
  } catch (err) {
    console.error("[trainer/certificates] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your batches. Please try again.";
  }

  return (
    <div>
      <PageHeader
        title="Certificates"
        description="Review completion eligibility for your batches and recommend students. A Super Admin approves and issues certificates."
      />
      {loadError ? (
        <ErrorState title="We couldn't load your batches" description={loadError} />
      ) : batches === null ? (
        <EmptyState icon={Award} title="Certificates require Supabase mode." description="Sign in with a Supabase account to see completion." />
      ) : batches.length === 0 ? (
        <EmptyState icon={Layers} title="No batches assigned" description="Batches you are assigned to will appear here." />
      ) : (
        <CompletionBatchesTable rows={batches} basePath="/trainer/certificates" />
      )}
    </div>
  );
}
