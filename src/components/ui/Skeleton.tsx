import { cn } from "@/utils/cn";

/** Loading placeholder block — compose several to build a skeleton for a card, row, or list. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-sunken", className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-md border border-surface-border bg-surface-raised p-4", className)}>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="mt-3 h-7 w-1/2" />
      <Skeleton className="mt-2 h-3 w-1/4" />
    </div>
  );
}
