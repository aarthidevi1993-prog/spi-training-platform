import { Gauge } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PerformanceView } from "@/components/modules/PerformanceView";
import { performanceService } from "@/services/performance.service";
import type { PerformanceData } from "@/types/performance";

export const dynamic = "force-dynamic";

export default async function StudentPerformancePage() {
  let data: PerformanceData | null = null;
  let loadError: string | null = null;

  try {
    // Own data only: released results (student_available_tests), own attendance and assignments.
    data = await performanceService.getPerformance();
  } catch (err) {
    console.error("[student/performance] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load performance data. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Performance" description="Track your attendance, test scores and course progress." />
      {loadError ? (
        <ErrorState title="We couldn't load performance data" description={loadError} />
      ) : data === null ? (
        <EmptyState icon={Gauge} title="Performance requires Supabase mode." description="Sign in with a Supabase account to see performance data." />
      ) : (
        <PerformanceView data={data} />
      )}
    </div>
  );
}
