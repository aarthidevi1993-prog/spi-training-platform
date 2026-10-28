import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { QuestionsView } from "@/components/modules/QuestionsView";
import { questionsService } from "@/services/questions.service";
import type { QuestionBankData } from "@/types/question";

export const dynamic = "force-dynamic";

export default async function TrainerQuestionsPage() {
  let data: QuestionBankData | null = null;
  let loadError: string | null = null;

  try {
    // questionsService scopes this server-side to courses the signed-in
    // trainer currently teaches (upcoming/ongoing batches); RLS enforces the same.
    data = await questionsService.getBankData();
  } catch (err) {
    console.error("[trainer/questions] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the Question Bank. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Question Bank" description="Manage questions for the courses you currently teach." />
      {loadError || !data ? (
        <ErrorState title="We couldn't load the Question Bank" description={loadError ?? "Please try again."} />
      ) : (
        <QuestionsView data={data} />
      )}
    </div>
  );
}
