import type { LucideIcon } from "lucide-react";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/utils/cn";
import type { KpiDatum } from "@/lib/mock/dashboard.mock";

export interface KpiCardProps extends Omit<KpiDatum, "trend" | "trendLabel"> {
  icon: LucideIcon;
  tone?: "green" | "gold" | "blue" | "teal";
  /** Change vs a previous period. Omitted when there is no verified comparison. */
  trend?: number;
  trendLabel?: string;
  /** Plain context line shown instead of a trend (e.g. what the value is based on). */
  hint?: string;
}

const toneClasses = {
  green: "bg-primary-50 text-primary-600",
  gold: "bg-brand-goldSoft text-brand-gold",
  blue: "bg-signal-blueSoft text-signal-blue",
  teal: "bg-signal-tealSoft text-signal-teal",
} as const;

export function KpiCard({ label, value, trend, trendLabel, hint, icon: Icon, tone = "green" }: KpiCardProps) {
  const hasTrend = typeof trend === "number";
  const TrendIcon = !hasTrend ? Minus : trend > 0 ? ArrowUp : trend < 0 ? ArrowDown : Minus;
  const trendTone = !hasTrend ? "text-ink-faint" : trend > 0 ? "text-signal-green" : trend < 0 ? "text-signal-red" : "text-ink-faint";

  return (
    <Card className="p-4">
      {/* Phones: icon above the text, so labels have the card's full width; from sm: icon beside the text. */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-3">
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", toneClasses[tone])}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {/* Full labels wrap instead of being truncated ("TEST AVER…"). */}
          <p className="break-words text-2xs font-semibold uppercase leading-tight tracking-wide text-ink-muted">{label}</p>
          <p className="mt-0.5 text-2xl font-bold text-ink sm:text-kpi">{value}</p>
          {hasTrend ? (
            <p className={cn("mt-1 flex items-center gap-1 text-xs font-medium", trendTone)}>
              <TrendIcon className="h-3 w-3" />
              {trend > 0 ? "+" : ""}
              {trend}% <span className="font-normal text-ink-faint">{trendLabel}</span>
            </p>
          ) : hint ? (
            <p className="mt-1 text-xs text-ink-faint">{hint}</p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
