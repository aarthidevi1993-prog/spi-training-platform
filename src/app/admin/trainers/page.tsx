import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { InviteUserButton } from "@/components/modules/InviteUserButton";
import { trainersService } from "@/services/trainers.service";
import type { TrainerSummary } from "@/types/trainer";
import { TrainersTable } from "./TrainersTable";

export const dynamic = "force-dynamic";

export default async function AdminTrainersPage() {
  let trainers: TrainerSummary[] = [];
  let loadError: string | null = null;

  try {
    trainers = await trainersService.listTrainers();
  } catch (err) {
    console.error("[admin/trainers] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load the trainers. Please try again.";
  }

  return (
    <div>
      <PageHeader
        title="Trainers"
        description="Manage trainer profiles, specializations and assignments."
        actions={<InviteUserButton kind="trainer" />}
      />
      {loadError ? (
        <ErrorState title="We couldn't load the trainers" description={loadError} />
      ) : (
        <TrainersTable rows={trainers} />
      )}
    </div>
  );
}
