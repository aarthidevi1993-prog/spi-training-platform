import { PageHeader } from "@/components/layout/PageHeader";
import { QuestionImportView } from "@/components/modules/QuestionImportView";

export const dynamic = "force-dynamic";

export default function AdminQuestionImportPage() {
  return (
    <div>
      <PageHeader title="Import questions" description="Add or update Question Bank questions from an Excel, CSV, Word or PDF file. Imported questions are always drafts." />
      <QuestionImportView basePath="/admin/questions" />
    </div>
  );
}
