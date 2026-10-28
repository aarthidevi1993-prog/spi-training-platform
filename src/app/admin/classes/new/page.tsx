import { PageHeader } from "@/components/layout/PageHeader";
import { ClassForm } from "@/components/modules/ClassForm";
import { getClassFilterOptions } from "@/lib/classes/filter-options";

export const dynamic = "force-dynamic";

export default async function AdminNewClassPage() {
  const options = await getClassFilterOptions();

  return (
    <div>
      <PageHeader title="Create class" description="Schedule a new class for a batch." />
      <ClassForm options={options} basePath="/admin/classes" />
    </div>
  );
}
