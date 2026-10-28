import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { CoursesGrid } from "@/components/modules/CoursesGrid";
import { coursesService } from "@/services/courses.service";
import type { CourseSummary } from "@/types/course";

export const dynamic = "force-dynamic";

export default async function AdminCoursesPage() {
  let courses: CourseSummary[] = [];
  let loadError: string | null = null;

  try {
    courses = await coursesService.listCourses();
  } catch (err) {
    console.error("[admin/courses] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the courses. Please try again.";
  }

  return (
    <div>
      <PageHeader
        title="Courses"
        description="Manage the SPI course catalog: modules, levels and durations."
        actions={
          <Link href="/admin/courses/new">
            <Button size="sm">
              <Plus className="h-4 w-4" /> Add Course
            </Button>
          </Link>
        }
      />
      {loadError ? (
        <ErrorState title="We couldn't load the courses" description={loadError} />
      ) : (
        <CoursesGrid courses={courses} />
      )}
    </div>
  );
}
