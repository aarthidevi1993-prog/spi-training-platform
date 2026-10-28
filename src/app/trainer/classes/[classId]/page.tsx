import { notFound } from "next/navigation";
import { ClassDetailView } from "@/components/modules/ClassDetailView";
import { classesService } from "@/services/classes.service";
import { attendanceService } from "@/services/attendance.service";
import type { ClassAttendanceRoster } from "@/types/attendance";
import { assignmentsService } from "@/services/assignments.service";
import type { ClassAssignmentsPanelData } from "@/types/assignment";

export const dynamic = "force-dynamic";

export default async function TrainerClassDetailPage({ params }: { params: { classId: string } }) {
  // Scoped to the signed-in trainer server-side — another trainer's
  // class id yields null, then a 404.
  const trainingClass = await classesService.getClass(params.classId);
  if (!trainingClass) notFound();

  // Attendance tab: a load failure only affects the tab, never the page.
  let attendance: ClassAttendanceRoster | null = null;
  let attendanceError: string | null = null;
  try {
    attendance = await attendanceService.getClassRoster(trainingClass);
  } catch (err) {
    console.error("[trainer/classes/detail] attendance load failed:", err instanceof Error ? err.message : err);
    attendanceError = "Please try again.";
  }

  // Assignment tab: same isolation — a failure only affects the tab.
  let assignments: ClassAssignmentsPanelData | null = null;
  let assignmentsError: string | null = null;
  try {
    assignments = await assignmentsService.getClassPanel(trainingClass);
  } catch (err) {
    console.error("[trainer/classes/detail] assignments load failed:", err instanceof Error ? err.message : err);
    assignmentsError = "Please try again.";
  }

  return (
    <ClassDetailView
      trainingClass={trainingClass}
      basePath="/trainer/classes"
      canManage
      attendance={attendance}
      attendanceError={attendanceError}
      assignments={assignments}
      assignmentsError={assignmentsError}
    />
  );
}
