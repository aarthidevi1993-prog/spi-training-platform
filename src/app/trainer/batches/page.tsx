import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchesTable } from "@/components/modules/BatchesTable";
import { batchesService } from "@/services/batches.service";
import type { BatchSummary } from "@/types/batch";

export const dynamic = "force-dynamic";

export default async function TrainerBatchesPage() {
  let batches: BatchSummary[] = [];
  let loadError: string | null = null;

  try {
    // batchesService scopes this to the signed-in trainer's assigned batches, server-side.
    batches = await batchesService.listBatches();
  } catch (err) {
    console.error("[trainer/batches] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your batches. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Batches" description="Batches you're assigned to train." />
      {loadError ? (
        <ErrorState title="We couldn't load your batches" description={loadError} />
      ) : (
        <BatchesTable rows={batches} trainerDetail />
      )}
    </div>
  );
}
