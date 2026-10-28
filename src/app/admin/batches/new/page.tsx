import { PageHeader } from "@/components/layout/PageHeader";
import { BatchForm } from "@/components/modules/BatchForm";
import { ErrorState } from "@/components/ui/ErrorState";
import { batchesService } from "@/services/batches.service";
import type { BatchFormOptions } from "@/types/batch";

export const dynamic = "force-dynamic";

export default async function AdminNewBatchPage() {
  let options: BatchFormOptions | null = null;
  try {
    options = await batchesService.getCreateBatchOptions();
  } catch (err) {
    console.error("[admin/batches/new] options failed:", err instanceof Error ? err.message : err);
  }

  return (
    <div>
      <PageHeader title="Add batch" description="Create a new training batch for a course." />
      {options ? (
        <BatchForm options={options} basePath="/admin/batches" />
      ) : (
        <ErrorState title="We couldn't open the form" description="Please try again." />
      )}
    </div>
  );
}
