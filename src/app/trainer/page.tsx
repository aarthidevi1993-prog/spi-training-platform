import { Suspense } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  TrainerDashboard,
  TrainerDashboardSkeleton,
  TRAINER_DASHBOARD_SUBTITLE,
  TRAINER_DASHBOARD_TITLE,
} from "@/components/dashboard/TrainerDashboard";
import { trainerDashboardService } from "@/services/trainer-dashboard.service";
import type { TrainerDashboardData } from "@/lib/dashboard/trainer-dashboard";

// Per-user data read from the session: never cached or shared between users.
export const dynamic = "force-dynamic";

async function DashboardContent() {
  let data: TrainerDashboardData;
  try {
    data = await trainerDashboardService.load();
  } catch (err) {
    console.error("[trainer/dashboard] load failed:", err instanceof Error ? err.name : "unknown error");
    return (
      <div>
        <PageHeader title={TRAINER_DASHBOARD_TITLE} description={TRAINER_DASHBOARD_SUBTITLE} />
        <ErrorState title="We couldn't load your dashboard" description="Please refresh the page to try again." />
      </div>
    );
  }
  return <TrainerDashboard data={data} />;
}

/**
 * Trainer dashboard. Access: middleware + the trainer layout's RoleGuard,
 * then the trainer dashboard service (active trainers only) and RLS on
 * every read. The skeleton is this page's own Suspense fallback (not a
 * /trainer loading.tsx), so other /trainer pages keep their own loading
 * states.
 */
export default function TrainerDashboardPage() {
  return (
    <Suspense fallback={<TrainerDashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
