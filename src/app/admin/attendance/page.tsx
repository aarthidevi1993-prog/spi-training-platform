import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { AttendanceView } from "@/components/modules/AttendanceView";
import { attendanceService } from "@/services/attendance.service";
import type { AttendanceOverview } from "@/types/attendance";

export const dynamic = "force-dynamic";

export default async function AdminAttendancePage() {
  let overview: AttendanceOverview | null = null;

  try {
    overview = await attendanceService.getOverview();
  } catch (err) {
    console.error("[admin/attendance] load failed:", err instanceof Error ? err.message : err);
  }

  return (
    <div>
      <PageHeader title="Attendance" description="Mark and review attendance for each class." />
      {overview ? (
        <AttendanceView overview={overview} />
      ) : (
        <ErrorState title="We couldn't load attendance" description="We couldn't load attendance. Please try again." />
      )}
    </div>
  );
}
