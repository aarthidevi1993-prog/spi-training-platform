import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { AttendanceView } from "@/components/modules/AttendanceView";
import { attendanceService } from "@/services/attendance.service";
import type { AttendanceOverview } from "@/types/attendance";

export const dynamic = "force-dynamic";

export default async function StudentAttendancePage() {
  let overview: AttendanceOverview | null = null;

  try {
    // Scoped server-side (and by RLS) to the signed-in student's own records.
    overview = await attendanceService.getOverview();
  } catch (err) {
    console.error("[student/attendance] load failed:", err instanceof Error ? err.message : err);
  }

  return (
    <div>
      <PageHeader title="My Attendance" description="Your attendance record across all classes." />
      {overview ? (
        <AttendanceView overview={overview} />
      ) : (
        <ErrorState title="We couldn't load your attendance" description="We couldn't load your attendance. Please try again." />
      )}
    </div>
  );
}
