import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchesTable } from "@/components/modules/BatchesTable";
import { batchesService } from "@/services/batches.service";
import { batchTrainerService } from "@/services/batch-trainer.service";
import type { AvailableTrainerOption } from "@/lib/batches/assign-trainer";
import type { BatchSummary } from "@/types/batch";

export const dynamic = "force-dynamic";

export default async function AdminBatchesPage() {
  let batches: BatchSummary[] = [];
  let loadError: string | null = null;

  try {
    batches = await batchesService.listBatches();
  } catch (err) {
    console.error("[admin/batches] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the batches. Please try again.";
  }

  // Trainers that may be assigned (P3.6). If this fails, the dialog simply offers none.
  let trainers: AvailableTrainerOption[] = [];
  try {
    trainers = await batchTrainerService.listAvailableTrainers();
  } catch (err) {
    console.error("[admin/batches] trainer options failed:", err instanceof Error ? err.name : "unknown error");
  }

  return (
    <div>
      <PageHeader
        title="Batches"
        description="Schedule and manage training batches for each course."
        actions={
          <Link href="/admin/batches/new">
            <Button size="sm">
              <Plus className="h-4 w-4" /> Add Batch
            </Button>
          </Link>
        }
      />
      {loadError ? (
        <ErrorState title="We couldn't load the batches" description={loadError} />
      ) : (
        <BatchesTable rows={batches} assignment={{ trainers }} />
      )}
    </div>
  );
}
