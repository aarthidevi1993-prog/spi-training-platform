import { Suspense } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { AdminDashboard, AdminDashboardSkeleton, DASHBOARD_TITLE } from "@/components/dashboard/AdminDashboard";
import { adminDashboardService } from "@/services/dashboard.service";

// Per-user data read from the session: never cached or shared between users.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

async function DashboardContent({ period }: { period: unknown }) {
  let load;
  let data;
  try {
    load = await adminDashboardService.load(period);
    data = await load.core;
  } catch (err) {
    console.error("[admin/dashboard] load failed:", err instanceof Error ? err.name : "unknown error");
    return (
      <div>
        <PageHeader title={DASHBOARD_TITLE} />
        <ErrorState title="We couldn't load the dashboard" description="Please try again." />
      </div>
    );
  }
  // The current-state sections render now; the period-based panels stream in with their own fallbacks.
  return <AdminDashboard data={data} analytics={load.analytics} />;
}

/**
 * Super Admin dashboard. Access: middleware + the admin layout's RoleGuard,
 * then the dashboard service (Super Admin only) and RLS on every read.
 * `?period=` selects the reporting period (validated in the service; default
 * this_month). The skeleton is this page's own Suspense fallback, so other
 * /admin pages keep their own loading states.
 */
export default function AdminDashboardPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<AdminDashboardSkeleton />}>
      <DashboardContent period={searchParams.period} />
    </Suspense>
  );
}
