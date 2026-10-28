import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/utils/cn";

export interface SummaryStatProps {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "green" | "gold" | "red" | "blue";
}

const toneClasses = {
  green: "bg-primary-50 text-primary-600",
  gold: "bg-brand-goldSoft text-brand-gold",
  red: "bg-signal-redSoft text-signal-red",
  blue: "bg-signal-blueSoft text-signal-blue",
} as const;

/** Compact labelled stat card — attendance present/absent/late, performance summary numbers, etc. */
export function SummaryStat({ label, value, icon: Icon, tone = "green" }: SummaryStatProps) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-lg", toneClasses[tone])}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-xs text-ink-muted">{label}</p>
        <p className="mt-0.5 text-xl font-semibold text-ink">{value}</p>
      </div>
    </Card>
  );
}
