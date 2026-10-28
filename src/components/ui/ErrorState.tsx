import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export interface ErrorStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "The data couldn't be loaded. Try again, or contact support if the problem continues.",
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft py-16 text-center",
        className
      )}
    >
      <AlertTriangle className="h-8 w-8 text-signal-red" aria-hidden />
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-sm text-ink-muted">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
