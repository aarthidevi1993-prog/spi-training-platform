import { LoadingState } from "@/components/ui/LoadingState";

/** Shown while the trainer's course pages load (read on the server, scoped to their batches). */
export default function TrainerCoursesLoading() {
  return <LoadingState label="Loading courses…" />;
}
