import { FileQuestion } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { studentTestsService } from "@/services/student-tests.service";
import type { StudentTestSummary } from "@/types/student-test";
import { StudentTestsView } from "./StudentTestsView";

export const dynamic = "force-dynamic";

export default async function StudentTestsPage() {
  let tests: StudentTestSummary[] | null = null;
  let loadError: string | null = null;

  try {
    // student_available_tests(): the database scopes this to the signed-in student.
    tests = await studentTestsService.listTests();
  } catch (err) {
    console.error("[student/tests] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your tests. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Tests" description="Take your class tests and see your results once each test closes." />
      {loadError ? (
        <ErrorState title="We couldn't load your tests" description={loadError} />
      ) : tests === null ? (
        <EmptyState icon={FileQuestion} title="Tests require Supabase mode." description="Sign in with a Supabase account to take tests." />
      ) : (
        <StudentTestsView tests={tests} />
      )}
    </div>
  );
}
