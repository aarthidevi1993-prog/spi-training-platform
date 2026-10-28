import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchDetailView } from "@/components/modules/BatchDetailView";
import { enrollmentService } from "@/services/enrollment.service";
import { isUuid, type BatchEnrollmentDetail } from "@/lib/enrollments/enrollment";

export const dynamic = "force-dynamic";

/**
 * Batch detail (trainer — P3.10-A). The layout's RoleGuard admits only
 * trainers; enrollmentService re-checks the signed-in user, returns only
 * batches assigned to this trainer and RLS decides every row (roster
 * without withdrawn rows, history of batches they currently teach). An
 * invalid id, a missing batch or another trainer's batch all surface as a
 * 404. The only mutation is "Enrol student" in trainer mode, which goes
 * through trainerEnrolStudentAction → trainer_enroll_student().
 */
export default async function TrainerBatchDetailPage({ params }: { params: { batchId: string } }) {
  if (!isUuid(params.batchId)) notFound();

  let detail: BatchEnrollmentDetail | null = null;
  let loadFailed = false;
  try {
    detail = await enrollmentService.getBatchDetail(params.batchId);
  } catch (err) {
    console.error("[trainer/batches/detail] load failed:", err instanceof Error ? err.name : "unknown error");
    loadFailed = true;
  }

  if (loadFailed) {
    return (
      <div>
        <PageHeader title="Batch" description="Batches you're assigned to train." />
        <ErrorState title="We couldn't load this batch" description="Please try again." />
      </div>
    );
  }
  // A non-trainer view never renders here (the service only answers "trainer" for a trainer session).
  if (!detail || detail.mode !== "trainer") notFound();

  return <BatchDetailView detail={detail} backHref="/trainer/batches" />;
}
