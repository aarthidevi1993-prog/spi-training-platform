import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { CoursesGrid } from "@/components/modules/CoursesGrid";
import { coursesService } from "@/services/courses.service";
import type { CourseSummary } from "@/types/course";

export const dynamic = "force-dynamic";

export default async function TrainerCoursesPage() {
  let courses: CourseSummary[] = [];
  let loadError: string | null = null;

  try {
    // coursesService scopes this to the signed-in trainer's batches server-side.
    courses = await coursesService.listCourses();
  } catch (err) {
    console.error("[trainer/courses] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your courses. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Courses" description="Courses you're assigned to teach." />
      {loadError ? (
        <ErrorState title="We couldn't load your courses" description={loadError} />
      ) : (
        <CoursesGrid
          courses={courses}
          basePath="/trainer/courses"
          empty={{ title: "No courses assigned yet", description: "Courses appear here once you are assigned to a batch." }}
        />
      )}
    </div>
  );
}
