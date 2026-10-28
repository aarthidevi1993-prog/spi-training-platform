import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { TestDetailView } from "@/components/modules/TestDetailView";
import { testsService } from "@/services/tests.service";
import { resultsService } from "@/services/results.service";
import type { TestDetail } from "@/types/test";
import type { StaffTestResultsState } from "@/types/test-result";

export const dynamic = "force-dynamic";

export default async function TrainerTestDetailPage({ params }: { params: { testId: string } }) {
  let test: TestDetail | null = null;
  let loadError: string | null = null;

  try {
    // RLS limits this to tests of the trainer's batches/classes; the
    // service decides whether they may manage it (current trainer only).
    test = await testsService.getTestDetail(params.testId);
  } catch (err) {
    console.error("[trainer/tests/detail] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this test. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this test" description={loadError} />;
  if (!test) notFound();

  // Results: Super Admin / the batch's current trainer only (RLS on every 0009 table).
  let results: StaffTestResultsState;
  try {
    results = await resultsService.getStaffTestResults(test.id);
  } catch (err) {
    console.error("[trainer/tests/detail] results load failed:", err instanceof Error ? err.message : err);
    results = { kind: "error", message: "We couldn't load the results. Please try again." };
  }

  return <TestDetailView test={test} basePath="/trainer/tests" results={results} />;
}
