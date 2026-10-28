import type { HTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const toneClasses = {
  neutral: "bg-surface-sunken text-ink-muted",
  teal: "bg-signal-tealSoft text-signal-teal",
  blue: "bg-signal-blueSoft text-signal-blue",
  amber: "bg-signal-amberSoft text-signal-amber",
  red: "bg-signal-redSoft text-signal-red",
  green: "bg-signal-greenSoft text-signal-green",
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof toneClasses;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-mono text-2xs font-semibold",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
