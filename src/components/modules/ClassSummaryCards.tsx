import { CalendarClock, CalendarDays, CheckCircle2, Ban } from "lucide-react";
import { SummaryStat } from "@/components/dashboard/SummaryStat";
import type { ClassSummaryCounts } from "@/types/class";

/** Today / Upcoming / Completed / Cancelled counts, scoped to the caller's role by classesService. */
export function ClassSummaryCards({ counts }: { counts: ClassSummaryCounts }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <SummaryStat label="Today's Classes" value={String(counts.today)} icon={CalendarClock} tone="green" />
      <SummaryStat label="Upcoming" value={String(counts.upcoming)} icon={CalendarDays} tone="blue" />
      <SummaryStat label="Completed" value={String(counts.completed)} icon={CheckCircle2} tone="gold" />
      <SummaryStat label="Cancelled" value={String(counts.cancelled)} icon={Ban} tone="red" />
    </div>
  );
}
