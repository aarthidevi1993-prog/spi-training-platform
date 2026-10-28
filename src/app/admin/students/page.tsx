import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { InviteUserButton } from "@/components/modules/InviteUserButton";
import type { InviteBatchOption } from "@/components/modules/InviteUserDialog";
import { StudentsTable } from "@/components/modules/StudentsTable";
import { batchesService } from "@/services/batches.service";
import { isEnrolmentClosedForCourse } from "@/lib/enrollments/enrollment";
import { studentsService } from "@/services/students.service";
import type { StudentSummary } from "@/types/student";

export const dynamic = "force-dynamic";

export default async function AdminStudentsPage() {
  let students: StudentSummary[] = [];
  let loadError: string | null = null;

  try {
    students = await studentsService.listStudents();
  } catch (err) {
    console.error("[admin/students] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the students. Please try again.";
  }

  // Optional batch for a student invitation: the Super Admin's batches that can still take
  // enrolments — not an upcoming batch of an archived course (0030). The database re-checks
  // the batch when the invitation is created.
  let inviteBatches: InviteBatchOption[] = [];
  try {
    inviteBatches = (await batchesService.listBatches())
      .filter((b) => (b.status === "upcoming" || b.status === "ongoing") && !isEnrolmentClosedForCourse(b.status, b.courseStatus))
      .map((b) => ({ id: b.id, label: `${b.name} · ${b.course} (${b.status})` }));
  } catch (err) {
    console.error("[admin/students] batch options failed:", err instanceof Error ? err.message : err);
  }

  return (
    <div>
      <PageHeader
        title="Students"
        description="Manage and monitor all SPI trainees."
        actions={<InviteUserButton kind="student" batches={inviteBatches} />}
      />
      {loadError ? (
        <ErrorState title="We couldn't load the students" description={loadError} />
      ) : (
        <StudentsTable rows={students} />
      )}
    </div>
  );
}
