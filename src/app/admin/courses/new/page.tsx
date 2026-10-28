import { PageHeader } from "@/components/layout/PageHeader";
import { CourseForm } from "@/components/modules/CourseForm";

export const dynamic = "force-dynamic";

/** Add Course (Super Admin — the admin portal guard, the service and RLS all enforce it). */
export default function AdminNewCoursePage() {
  return (
    <div>
      <PageHeader title="Add course" description="Create a new course in the SPI catalog." />
      <CourseForm basePath="/admin/courses" />
    </div>
  );
}
