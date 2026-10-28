import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { TestsGrid } from "@/components/modules/TestsGrid";
import { testsService } from "@/services/tests.service";
import type { TestManagementData } from "@/types/test";

export const dynamic = "force-dynamic";

export default async function TrainerTestsPage() {
  let data: TestManagementData | null = null;
  let loadError: string | null = null;

  try {
    // testsService scopes this server-side: tests of the trainer's batches
    // and classes (RLS), manageable only while they are the batch's
    // current trainer and the batch is upcoming or ongoing.
    data = await testsService.getManagementData();
  } catch (err) {
    console.error("[trainer/tests] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your tests. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Tests" description="Create and manage tests for the batches you currently teach." />
      {loadError || !data ? (
        <ErrorState title="We couldn't load your tests" description={loadError ?? "Please try again."} />
      ) : (
        <TestsGrid data={data} basePath="/trainer/tests" />
      )}
    </div>
  );
}
