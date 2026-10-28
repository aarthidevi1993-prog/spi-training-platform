import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { StudentCoursesGrid } from "@/components/modules/StudentCoursesGrid";
import { coursesService } from "@/services/courses.service";
import type { CourseSummary } from "@/types/course";

export const dynamic = "force-dynamic";

export default async function StudentCoursesPage() {
  let courses: CourseSummary[] = [];
  let loadError: string | null = null;

  try {
    // Scoped server-side to the student's enrolled batches' courses.
    courses = await coursesService.listCourses();
  } catch (err) {
    console.error("[student/courses] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your courses. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Courses" description="Courses you're currently enrolled in." />
      {loadError ? (
        <ErrorState title="We couldn't load your courses" description={loadError} />
      ) : (
        <StudentCoursesGrid courses={courses} basePath="/student/courses" />
      )}
    </div>
  );
}
