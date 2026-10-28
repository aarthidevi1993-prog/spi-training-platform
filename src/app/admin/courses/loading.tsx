import { LoadingState } from "@/components/ui/LoadingState";

/** Shown while a Course Management page loads (list, detail, add and edit read the course on the server). */
export default function AdminCoursesLoading() {
  return <LoadingState label="Loading courses…" />;
}
