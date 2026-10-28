import { cn } from "@/utils/cn";

export interface ProgressBarProps {
  value: number;
  max?: number;
  tone?: "teal" | "amber" | "red" | "blue";
  label?: string;
  className?: string;
}

const toneClasses = {
  teal: "bg-signal-teal",
  amber: "bg-signal-amber",
  red: "bg-signal-red",
  blue: "bg-signal-blue",
} as const;

export function ProgressBar({ value, max = 100, tone = "blue", label, className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>{label}</span>
          <span className="font-mono">{Math.round(pct)}%</span>
        </div>
      )}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className={cn("h-full rounded-full transition-all", toneClasses[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
