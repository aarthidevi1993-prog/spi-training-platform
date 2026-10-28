import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { ClassForm } from "@/components/modules/ClassForm";
import { getClassFilterOptions } from "@/lib/classes/filter-options";
import { classesService } from "@/services/classes.service";

export const dynamic = "force-dynamic";

export default async function TrainerEditClassPage({ params }: { params: { classId: string } }) {
  // Scoped server-side: another trainer's class id yields null -> 404.
  const [trainingClass, options] = await Promise.all([
    classesService.getClass(params.classId),
    getClassFilterOptions(),
  ]);
  if (!trainingClass) notFound();

  return (
    <div>
      <PageHeader title="Edit class" description={trainingClass.title} />
      <ClassForm options={options} initial={trainingClass} basePath="/trainer/classes" lockTrainer />
    </div>
  );
}
