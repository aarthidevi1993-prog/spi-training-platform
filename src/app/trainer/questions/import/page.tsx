import { PageHeader } from "@/components/layout/PageHeader";
import { QuestionImportView } from "@/components/modules/QuestionImportView";

export const dynamic = "force-dynamic";

export default function TrainerQuestionImportPage() {
  return (
    <div>
      <PageHeader
        title="Import questions"
        description="Add or update questions for the courses you currently teach from an Excel, CSV, Word or PDF file. Imported questions are always drafts."
      />
      <QuestionImportView basePath="/trainer/questions" />
    </div>
  );
}
