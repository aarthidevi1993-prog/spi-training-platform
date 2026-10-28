import { Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";

export interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = "Loading…", className }: LoadingStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-16 text-ink-muted", className)}>
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      <p className="text-sm">{label}</p>
    </div>
  );
}
