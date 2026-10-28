import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { CourseDetailView } from "@/components/modules/CourseDetailView";
import { CourseClassesList } from "@/components/modules/CourseClassesList";
import { coursesService } from "@/services/courses.service";
import type { CourseDetail } from "@/types/course";

export const dynamic = "force-dynamic";

export default async function StudentCourseDetailPage({ params }: { params: { courseId: string } }) {
  let course: CourseDetail | null;

  try {
    // Null when the course doesn't exist, the id is invalid, *or* it is
    // outside this user's scope — all surface as the same 404.
    course = await coursesService.getCourse(params.courseId);
  } catch (err) {
    console.error("[student/courses/detail] load failed:", err instanceof Error ? err.message : err);
    return <ErrorState title="We couldn't load this course" description="Please try again." />;
  }

  if (!course) notFound();

  // This course's classes the student may see (same scope as the Classes pages); null = couldn't be read.
  const classes = await coursesService.listCourseClasses(course.id);

  return (
    <CourseDetailView
      course={course}
      backHref="/student/courses"
      classesPanel={<CourseClassesList classes={classes} basePath="/student/classes" />}
    />
  );
}
