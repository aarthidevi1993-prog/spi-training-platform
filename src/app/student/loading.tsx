import { LoadingState } from "@/components/ui/LoadingState";

/** Shown while a student page loads (the dashboard reads the student's metrics on the server). */
export default function StudentLoading() {
  return <LoadingState />;
}
