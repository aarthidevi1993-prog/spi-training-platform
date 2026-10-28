import { Gauge } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PerformanceView } from "@/components/modules/PerformanceView";
import { performanceService } from "@/services/performance.service";
import type { PerformanceData } from "@/types/performance";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export default async function AdminPerformancePage({ searchParams }: { searchParams: { batch?: string | string[]; student?: string | string[] } }) {
  let data: PerformanceData | null = null;
  let loadError: string | null = null;

  try {
    // Scope comes from the signed-in user; URL filters are re-checked against it.
    data = await performanceService.getPerformance({ batchId: first(searchParams.batch), studentId: first(searchParams.student) });
  } catch (err) {
    console.error("[admin/performance] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load performance data. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Performance" description="Track student performance across attendance and tests." />
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
