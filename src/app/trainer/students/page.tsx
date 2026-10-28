import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { StudentsTable } from "@/components/modules/StudentsTable";
import { studentsService } from "@/services/students.service";
import type { StudentSummary } from "@/types/student";

export const dynamic = "force-dynamic";

export default async function TrainerStudentsPage() {
  let students: StudentSummary[] = [];
  let loadError: string | null = null;

  try {
    // studentsService scopes this to students currently enrolled in the
    // signed-in trainer's batches, server-side.
    students = await studentsService.listStudents();
  } catch (err) {
    console.error("[trainer/students] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your students. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Students" description="Students enrolled in your assigned batches." />
      {loadError ? (
        <ErrorState title="We couldn't load your students" description={loadError} />
      ) : (
        <StudentsTable rows={students} trainerEdit />
      )}
    </div>
  );
}
