"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <nav className={cn("flex items-center justify-between gap-2", className)} aria-label="Pagination">
      <button
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1}
        className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken disabled:opacity-40"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Prev
      </button>

      <div className="flex items-center gap-1">
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            aria-current={p === page ? "page" : undefined}
            className={cn(
              "h-8 w-8 rounded-lg text-sm font-medium transition-colors",
              p === page ? "bg-primary-500 text-white" : "text-ink-muted hover:bg-surface-sunken"
            )}
          >
            {p}
          </button>
        ))}
      </div>

      <button
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
        className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken disabled:opacity-40"
      >
        Next <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}
