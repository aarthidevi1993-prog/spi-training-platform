import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { TestsGrid } from "@/components/modules/TestsGrid";
import { testsService } from "@/services/tests.service";
import type { TestManagementData } from "@/types/test";

export const dynamic = "force-dynamic";

export default async function AdminTestsPage() {
  let data: TestManagementData | null = null;
  let loadError: string | null = null;

  try {
    // Super admin: every test and class (RLS enforces the same).
    data = await testsService.getManagementData();
  } catch (err) {
    console.error("[admin/tests] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load tests. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Tests" description="Create, publish and manage class tests across all batches." />
      {loadError || !data ? (
        <ErrorState title="We couldn't load tests" description={loadError ?? "Please try again."} />
      ) : (
        <TestsGrid data={data} basePath="/admin/tests" />
      )}
    </div>
  );
}
