import { PageHeader } from "@/components/layout/PageHeader";
import { ClassesView } from "@/components/modules/ClassesView";
import { ClassSummaryCards } from "@/components/modules/ClassSummaryCards";
import { getClassFilterOptions } from "@/lib/classes/filter-options";
import { classesService } from "@/services/classes.service";
import type { ClassSummaryCounts, ClassWithRelations } from "@/types/class";

export const dynamic = "force-dynamic";

export default async function StudentClassesPage() {
  const options = await getClassFilterOptions();

  let classes: ClassWithRelations[] = [];
  let counts: ClassSummaryCounts = { today: 0, upcoming: 0, completed: 0, cancelled: 0 };
  let loadError: string | null = null;

  try {
    // Scoped server-side to the student's enrolled batch — a student
    // can never receive another batch's classes here.
    [classes, counts] = await Promise.all([classesService.listClasses(), classesService.getSummary()]);
  } catch (err) {
    console.error("[student/classes] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your classes. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Classes" description="Your upcoming and past classes." />
      {!loadError && <ClassSummaryCards counts={counts} />}
      {/* Read-only: no create/edit/cancel/delete for students. */}
      <ClassesView classes={classes} options={options} basePath="/student/classes" loadError={loadError} />
    </div>
  );
}
