import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { AttendanceView } from "@/components/modules/AttendanceView";
import { attendanceService } from "@/services/attendance.service";
import type { AttendanceOverview } from "@/types/attendance";

export const dynamic = "force-dynamic";

export default async function TrainerAttendancePage() {
  let overview: AttendanceOverview | null = null;

  try {
    // Scoped server-side to the batches the signed-in trainer runs.
    overview = await attendanceService.getOverview();
  } catch (err) {
    console.error("[trainer/attendance] load failed:", err instanceof Error ? err.message : err);
  }

  return (
    <div>
      <PageHeader
        title="Attendance"
        description="Mark and review attendance for your classes."
        actions={
          // Attendance is marked per class: My Classes → a class → Attendance tab.
          <Link href="/trainer/classes">
            <Button size="sm">
              <ClipboardCheck className="h-4 w-4" /> Mark Attendance
            </Button>
          </Link>
        }
      />
      {overview ? (
        <AttendanceView overview={overview} />
      ) : (
        <ErrorState title="We couldn't load attendance" description="We couldn't load your attendance records. Please try again." />
      )}
    </div>
  );
}
