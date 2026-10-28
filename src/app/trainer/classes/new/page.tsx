import { PageHeader } from "@/components/layout/PageHeader";
import { ClassForm } from "@/components/modules/ClassForm";
import { getClassFilterOptions } from "@/lib/classes/filter-options";

export const dynamic = "force-dynamic";

export default async function TrainerNewClassPage() {
  const options = await getClassFilterOptions();

  return (
    <div>
      <PageHeader title="Schedule class" description="Schedule a new class for one of your batches." />
      {/* lockTrainer: the service also forces trainerId server-side. */}
      <ClassForm options={options} basePath="/trainer/classes" lockTrainer />
    </div>
  );
}
