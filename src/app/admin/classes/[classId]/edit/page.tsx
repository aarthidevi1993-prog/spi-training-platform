import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { ClassForm } from "@/components/modules/ClassForm";
import { getClassFilterOptions } from "@/lib/classes/filter-options";
import { classesService } from "@/services/classes.service";

export const dynamic = "force-dynamic";

export default async function AdminEditClassPage({ params }: { params: { classId: string } }) {
  const [trainingClass, options] = await Promise.all([
    classesService.getClass(params.classId),
    getClassFilterOptions(),
  ]);
  if (!trainingClass) notFound();

  return (
    <div>
      <PageHeader title="Edit class" description={trainingClass.title} />
      <ClassForm options={options} initial={trainingClass} basePath="/admin/classes" />
    </div>
  );
}
