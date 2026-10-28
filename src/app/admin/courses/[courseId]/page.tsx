import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { ErrorState } from "@/components/ui/ErrorState";
import { CourseDetailView } from "@/components/modules/CourseDetailView";
import { CourseAdminActions } from "@/components/modules/CourseAdminActions";
import { CourseModulesManager } from "@/components/modules/CourseModulesManager";
import { CourseAdminSections } from "@/components/modules/CourseAdminSections";
import { CourseClassesList } from "@/components/modules/CourseClassesList";
import { coursesService } from "@/services/courses.service";
import { courseManagementService, CourseManagementUnavailableError } from "@/services/course-management.service";
import { COURSE_MIGRATION_MISSING_ERROR, COURSE_MIGRATION_MISSING_TITLE } from "@/lib/courses/course-management";
import type { CourseDetail, CourseHistoryEntry, CourseUsage } from "@/types/course";

export const dynamic = "force-dynamic";

export default async function AdminCourseDetailPage({ params }: { params: { courseId: string } }) {
  let course: CourseDetail | null;
  let management: { usage: CourseUsage; history: CourseHistoryEntry[] } | null = null;
  let managementMissing = false;

  try {
    // Null when the course doesn't exist, the id is invalid, *or* it is
    // outside this user's scope — all surface as the same 404.
    course = await coursesService.getCourse(params.courseId);
    // Course Management state (Super Admin only; null in demo mode).
    if (course) {
      try {
        management = await courseManagementService.getManagement(course.id);
      } catch (err) {
        // Without the Course Management database update (migration 0030) the course is still shown,
        // read-only, exactly as before that update; any other failure is reported below.
        if (!(err instanceof CourseManagementUnavailableError)) throw err;
        managementMissing = true;
        console.error("[admin/courses/detail] course management unavailable (migration 0030 not applied); showing read-only view");
      }
    }
  } catch (err) {
    console.error("[admin/courses/detail] load failed:", err instanceof Error ? err.message : err);
    return <ErrorState title="We couldn't load this course" description="Please try again." />;
  }

  if (!course) notFound();

  // Every class of this course (Super Admin scope), with the module each covers; null = couldn't be read.
  const classesPanel = <CourseClassesList classes={await coursesService.listCourseClasses(course.id)} basePath="/admin/classes" />;

  if (!management) {
    // Demo mode, or Course Management not yet set up in the database: read-only course view. Without 0030 the
    // Super Admin is told why the management controls are missing (instead of the controls silently vanishing).
    if (managementMissing) {
      return (
        <CourseDetailView
          course={course}
          backHref="/admin/courses"
          classesPanel={classesPanel}
          actions={
            <div role="note" title={COURSE_MIGRATION_MISSING_ERROR} className="flex max-w-xs items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-ink">{COURSE_MIGRATION_MISSING_TITLE}.</span> Read-only until it is applied.
              </span>
            </div>
          }
        />
      );
    }
    return <CourseDetailView course={course} backHref="/admin/courses" classesPanel={classesPanel} />;
  }

  return (
    <CourseDetailView
      course={course}
      backHref="/admin/courses"
      classesPanel={classesPanel}
      actions={
        <CourseAdminActions
          courseId={course.id}
          status={course.status ?? "draft"}
          batchCount={management.usage.batchCount}
          canDelete={management.usage.canDelete}
          archiveImpact={{
            upcoming: management.usage.upcomingBatchCount,
            ongoing: management.usage.ongoingBatchCount,
            pendingInvitations: management.usage.pendingUpcomingInvitationCount,
          }}
        />
      }
      modulesPanel={<CourseModulesManager courseId={course.id} modules={course.modules} locked={management.usage.hasHistory} />}
      footer={<CourseAdminSections usage={management.usage} history={management.history} />}
    />
  );
}
