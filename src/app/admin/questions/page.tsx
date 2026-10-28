import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { QuestionsView } from "@/components/modules/QuestionsView";
import { questionsService } from "@/services/questions.service";
import type { QuestionBankData } from "@/types/question";

export const dynamic = "force-dynamic";

export default async function AdminQuestionsPage() {
  let data: QuestionBankData | null = null;
  let loadError: string | null = null;

  try {
    // Super admin: every course and question (RLS enforces the same).
    data = await questionsService.getBankData();
  } catch (err) {
    console.error("[admin/questions] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the Question Bank. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Question Bank" description="Build and organize the shared question bank." />
      {loadError || !data ? (
        <ErrorState title="We couldn't load the Question Bank" description={loadError ?? "Please try again."} />
      ) : (
        <QuestionsView data={data} />
      )}
    </div>
  );
}
