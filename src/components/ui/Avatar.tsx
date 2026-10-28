import { cn } from "@/utils/cn";
import { initials } from "@/utils/format";

export interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  tone?: "gold" | "blue" | "neutral";
  className?: string;
}

const sizeClasses = {
  sm: "h-7 w-7 text-2xs",
  md: "h-9 w-9 text-xs",
  lg: "h-12 w-12 text-sm",
} as const;

const toneClasses = {
  gold: "bg-brand-gold text-panel",
  blue: "bg-signal-blueSoft text-signal-blue",
  neutral: "bg-surface-sunken text-ink-muted",
} as const;

/** Initials avatar used across Sidebar, Topbar, and any people-tables (students/trainers). */
export function Avatar({ name, size = "md", tone = "gold", className }: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold",
        sizeClasses[size],
        toneClasses[tone],
        className
      )}
    >
      {initials(name)}
    </span>
  );
}
