import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { ExamMonitoringView } from "@/components/modules/ExamMonitoringView";
import { examMonitoringService, ExamMonitoringAuthorizationError } from "@/services/exam-monitoring.service";
import type { ExamMonitoringData } from "@/types/exam-monitoring";

export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/exam-monitoring";

/**
 * Exam monitoring (admin). The layout's RoleGuard admits only this role;
 * examMonitoringService re-checks the signed-in user server-side and RLS
 * decides every row. Filters come from the URL and are validated there.
 */
export default async function AdminExamMonitoringPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  let data: ExamMonitoringData | null = null;
  let loadError: string | null = null;

  try {
    data = await examMonitoringService.getMonitoring(searchParams);
  } catch (err) {
    if (err instanceof ExamMonitoringAuthorizationError) {
      loadError = err.message;
    } else {
      console.error("[admin/exam-monitoring] load failed:", err instanceof Error ? err.message : err);
      loadError = "We couldn't load exam monitoring. Please try again.";
    }
  }

  return (
    <div>
      <Link href="/admin/tests" className="mb-1 flex items-center gap-1 text-xs text-ink-muted hover:text-ink">
        <ChevronLeft className="h-3.5 w-3.5" /> Tests
      </Link>
      <PageHeader title="Exam monitoring" description="Review exam activity across all batches: attempts in progress, server security events and browser activity signals." />
      {loadError || !data ? (
        <ErrorState title="We couldn't load exam monitoring" description={loadError ?? "Please try again."} />
      ) : (
        <ExamMonitoringView data={data} basePath={BASE_PATH} />
      )}
    </div>
  );
}
