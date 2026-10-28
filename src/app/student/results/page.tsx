import { Award } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ResultsTable } from "@/components/modules/ResultsTable";
import { resultsService } from "@/services/results.service";
import type { StudentResultRow } from "@/types/test-result";

export const dynamic = "force-dynamic";

export default async function StudentResultsPage() {
  let rows: StudentResultRow[] | null = null;
  let loadError: string | null = null;

  try {
    // student_available_tests(): scoped to the signed-in student; scores only once released.
    rows = await resultsService.listStudentResults();
  } catch (err) {
    console.error("[student/results] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your results. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Results" description="Review your test results, scores and pass/fail status." />
      {loadError ? (
        <ErrorState title="We couldn't load your results" description={loadError} />
      ) : rows === null ? (
        <EmptyState icon={Award} title="Results require Supabase mode." description="Sign in with a Supabase account to see your results." />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Award}
          title="No results yet"
          description="Your tests will appear here once your trainer publishes them. Scores are shown after each test closes."
        />
      ) : (
        <ResultsTable rows={rows} />
      )}
    </div>
  );
}
