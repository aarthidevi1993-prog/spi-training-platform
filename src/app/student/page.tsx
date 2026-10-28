import { ClipboardCheck, FileCheck2, LineChart, BookOpen } from "lucide-react";
import { PortalDashboard } from "@/components/layout/PortalDashboard";
import { StudentDashboardSections } from "@/components/dashboard/StudentDashboardSections";
import { authService } from "@/services/auth.service";
import { performanceService } from "@/services/performance.service";
import { classesService } from "@/services/classes.service";
import { assignmentsService } from "@/services/assignments.service";
import {
  STUDENT_KPI_ERROR,
  STUDENT_KPI_UNAVAILABLE,
  loadStudentDashboardKpis,
  loadStudentDashboardList,
  pickUpcomingClasses,
  studentRecentResults,
} from "@/lib/dashboard/student-dashboard";

// Attendance, test average, tests passed, assignment average.
const kpiIcons = [ClipboardCheck, LineChart, FileCheck2, BookOpen];

/**
 * Student dashboard. Every read uses the signed-in student's own session through the
 * existing services (RLS limits each one to this student); nothing is taken from the URL.
 *   - KPI row: the student-scoped performance service (Phase 1).
 *   - Upcoming classes: classesService (the student's enrolled batches), "upcoming" filter.
 *   - Pending assignments: assignmentsService.listPendingForStudent.
 *   - Recent results: the same performance data as the KPI row (released results only) —
 *     one call, shared, so no extra query.
 * Each part fails on its own: an error shows a message, never zeros or an empty list.
 */
export default async function StudentDashboardPage() {
  const user = await authService.getCurrentUser();
  const log = (part: string) => (detail: string) => console.error(`[student/dashboard] ${part} failed:`, detail);
  const today = new Date().toISOString().slice(0, 10);

  // One performance read, shared by the KPI row and Recent results (each handles its failure).
  let performance: ReturnType<typeof performanceService.getPerformance> | undefined;
  const getPerformance = () => (performance ??= performanceService.getPerformance());

  const [kpiState, upcomingClasses, pendingAssignments, recentResults] = await Promise.all([
    loadStudentDashboardKpis(getPerformance, log("metrics")),
    loadStudentDashboardList(
      async () => pickUpcomingClasses(await classesService.listClasses({ dateRange: "upcoming" }), today),
      log("upcoming classes")
    ),
    loadStudentDashboardList(() => assignmentsService.listPendingForStudent(), log("pending assignments")),
    loadStudentDashboardList(async () => studentRecentResults(await getPerformance()), log("recent results")),
  ]);

  return (
    <PortalDashboard
      role="student"
      signedInAs={user?.fullName || undefined}
      kpis={kpiState.kind === "ready" ? kpiState.kpis : undefined}
      kpiIcons={kpiIcons}
      kpiNotice={
        kpiState.kind === "error"
          ? { tone: "error", text: STUDENT_KPI_ERROR }
          : kpiState.kind === "unavailable"
            ? { tone: "info", text: STUDENT_KPI_UNAVAILABLE }
            : undefined
      }
      sections={<StudentDashboardSections upcomingClasses={upcomingClasses} pendingAssignments={pendingAssignments} recentResults={recentResults} />}
    />
  );
}
