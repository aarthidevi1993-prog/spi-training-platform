import { FileBarChart } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ReportsView } from "@/components/modules/ReportsView";
import { ReportsAuthorizationError, reportsService, type ReportResult } from "@/services/reports.service";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  let report: ReportResult | null = null;
  let loadError: { title: string; description: string } | null = null;

  try {
    // Scope comes from the signed-in user; URL filters are re-checked against it.
    report = await reportsService.getReport(searchParams);
  } catch (err) {
    if (err instanceof ReportsAuthorizationError) {
      loadError = { title: "You can't view reports", description: err.message };
    } else {
      console.error("[admin/reports] load failed:", err instanceof Error ? err.message : err);
      loadError = { title: "We couldn't load the report", description: "Please try again." };
    }
  }

  return (
    <div>
      <PageHeader title="Reports" description="Attendance, performance, test results and assignment completion — view and download." />
      {loadError ? (
        <ErrorState title={loadError.title} description={loadError.description} />
      ) : report === null ? (
        <EmptyState icon={FileBarChart} title="Reports require Supabase mode." description="Sign in with a Supabase account to see reports." />
      ) : (
        <ReportsView report={report} basePath="/admin/reports" />
      )}
    </div>
  );
}
