import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { studentTestsService } from "@/services/student-tests.service";
import type { StudentAttemptView } from "@/types/student-test";
import { TestRunner } from "../../../TestRunner";
import { AttemptResultView } from "../../../AttemptResultView";

export const dynamic = "force-dynamic";

/**
 * One attempt of the signed-in student. In progress → the secure paper
 * (resumes after a refresh with saved answers and the original server
 * deadline). Finished → its state, and the result once released. The
 * database proves ownership; anything else is a 404.
 */
export default async function StudentAttemptPage({ params }: { params: { testId: string; attemptId: string } }) {
  let view: StudentAttemptView | null = null;
  let loadError: string | null = null;

  try {
    view = await studentTestsService.getAttemptView(params.testId, params.attemptId);
  } catch (err) {
    console.error("[student/tests/attempt] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this attempt. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this attempt" description={loadError} />;
  if (!view) notFound();

  return view.kind === "paper" ? <TestRunner key={view.paper.attemptId} paper={view.paper} /> : <AttemptResultView result={view.result} />;
}
