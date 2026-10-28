import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { CourseForm } from "@/components/modules/CourseForm";
import { coursesService } from "@/services/courses.service";
import { courseManagementService, CourseManagementUnavailableError } from "@/services/course-management.service";
import { COURSE_MIGRATION_MISSING_ERROR, COURSE_MIGRATION_MISSING_TITLE } from "@/lib/courses/course-management";
import type { CourseDetail, CourseUsage } from "@/types/course";

export const dynamic = "force-dynamic";

/** Edit Course (Super Admin — the admin portal guard, the service and the 0030 functions all enforce it). */
export default async function AdminEditCoursePage({ params }: { params: { courseId: string } }) {
  let course: CourseDetail | null;
  let usage: CourseUsage | null = null;
  try {
    course = await coursesService.getCourse(params.courseId);
    if (course) usage = (await courseManagementService.getManagement(course.id))?.usage ?? null;
  } catch (err) {
    console.error("[admin/courses/edit] load failed:", err instanceof Error ? err.message : err);
    if (err instanceof CourseManagementUnavailableError) {
      return <ErrorState title={COURSE_MIGRATION_MISSING_TITLE} description={COURSE_MIGRATION_MISSING_ERROR} />;
    }
    return <ErrorState title="We couldn't open the form" description="Please try again." />;
  }
  if (!course) notFound();
  if (!usage) {
    return <ErrorState title="Editing isn't available" description="Course management requires Supabase mode." />;
  }

  return (
    <div>
      <PageHeader title="Edit course" description={`${course.courseCode ?? ""} — ${course.title}`} />
      <CourseForm
        basePath="/admin/courses"
        locked={usage.hasHistory}
        initial={{
          id: course.id,
          courseCode: course.courseCode,
          title: course.title,
          description: course.description,
          level: course.level,
          durationHours: course.durationHours,
        }}
      />
    </div>
  );
}
