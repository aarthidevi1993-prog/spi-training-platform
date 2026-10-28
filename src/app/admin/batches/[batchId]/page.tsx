import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { BatchDetailView } from "@/components/modules/BatchDetailView";
import { enrollmentService } from "@/services/enrollment.service";
import { isUuid, type BatchEnrollmentDetail } from "@/lib/enrollments/enrollment";

export const dynamic = "force-dynamic";

/**
 * Batch detail (Super Admin, read-only — P3.8 slice 2). The layout's
 * RoleGuard admits only Super Admins; enrollmentService re-checks the
 * signed-in user and RLS decides every row. An invalid id, a missing
 * batch or one outside the caller's scope all surface as a 404; a load
 * failure shows a generic message (details are logged by name only).
 */
export default async function AdminBatchDetailPage({ params }: { params: { batchId: string } }) {
  if (!isUuid(params.batchId)) notFound();

  let detail: BatchEnrollmentDetail | null = null;
  let loadFailed = false;
  try {
    detail = await enrollmentService.getBatchDetail(params.batchId);
  } catch (err) {
    console.error("[admin/batches/detail] load failed:", err instanceof Error ? err.name : "unknown error");
    loadFailed = true;
  }

  if (loadFailed) {
    return (
      <div>
        <PageHeader title="Batch" description="Schedule and manage training batches for each course." />
        <ErrorState title="We couldn't load this batch" description="Please try again." />
      </div>
    );
  }
  if (!detail) notFound();

  return <BatchDetailView detail={detail} backHref="/admin/batches" />;
}
