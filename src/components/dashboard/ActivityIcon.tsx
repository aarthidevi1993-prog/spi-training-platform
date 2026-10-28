import { UserPlus, FileCheck2, ClipboardCheck, Award } from "lucide-react";
import type { ActivityType } from "@/lib/mock/dashboard.mock";
import { cn } from "@/utils/cn";

const config: Record<ActivityType, { icon: typeof UserPlus; classes: string }> = {
  enrollment: { icon: UserPlus, classes: "bg-signal-blueSoft text-signal-blue" },
  test: { icon: FileCheck2, classes: "bg-primary-50 text-primary-600" },
  attendance: { icon: ClipboardCheck, classes: "bg-brand-goldSoft text-brand-gold" },
  certificate: { icon: Award, classes: "bg-signal-tealSoft text-signal-teal" },
};

export function ActivityIcon({ type }: { type: ActivityType }) {
  const { icon: Icon, classes } = config[type];
  return (
    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", classes)}>
      <Icon className="h-4 w-4" />
    </span>
  );
}
