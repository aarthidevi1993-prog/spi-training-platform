import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ClassesView } from "@/components/modules/ClassesView";
import { ClassSummaryCards } from "@/components/modules/ClassSummaryCards";
import { getClassFilterOptions } from "@/lib/classes/filter-options";
import { classesService } from "@/services/classes.service";
import type { ClassSummaryCounts, ClassWithRelations } from "@/types/class";

export const dynamic = "force-dynamic";

export default async function AdminClassesPage() {
  const options = await getClassFilterOptions();

  let classes: ClassWithRelations[] = [];
  let counts: ClassSummaryCounts = { today: 0, upcoming: 0, completed: 0, cancelled: 0 };
  let loadError: string | null = null;

  try {
    [classes, counts] = await Promise.all([classesService.listClasses(), classesService.getSummary()]);
  } catch (err) {
    console.error("[admin/classes] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the classes. Please try again.";
  }

  return (
    <div>
      <PageHeader
        title="Classes"
        description="Plan, schedule and track every class across all courses and batches."
        actions={
          <Link href="/admin/classes/new">
            <Button size="sm">
              <Plus className="h-4 w-4" /> Create Class
            </Button>
          </Link>
        }
      />
      {!loadError && <ClassSummaryCards counts={counts} />}
      <ClassesView
        classes={classes}
        options={options}
        basePath="/admin/classes"
        canManage
        canDelete
        loadError={loadError}
      />
    </div>
  );
}
