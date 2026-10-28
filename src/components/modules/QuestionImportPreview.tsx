"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, CircleAlert, Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/utils/cn";
import type { ImportPreviewSummary, ImportRowResult, ImportRowStatus, RawImportRow } from "@/types/question-import";

export const PREVIEW_PAGE_SIZE = 50;

const STATUS_BADGE: Record<ImportRowStatus, { label: string; tone: "green" | "blue" | "amber" | "red" }> = {
  CREATE: { label: "New", tone: "green" },
  UPDATE: { label: "Update", tone: "blue" },
  DUPLICATE: { label: "Duplicate", tone: "amber" },
  NEEDS_REVIEW: { label: "Needs review", tone: "amber" },
  ERROR: { label: "Error", tone: "red" },
};

type Filter = "all" | ImportRowStatus | "warnings";

const TYPE_LABEL: Record<string, string> = { single_choice: "Single choice", multiple_choice: "Multiple choice", true_false: "True/false" };

export function ImportSummaryTiles({ summary }: { summary: ImportPreviewSummary }) {
  const tiles: { label: string; value: number; tone?: string }[] = [
    { label: "Total rows", value: summary.total },
    { label: "New", value: summary.create, tone: "text-signal-green" },
    { label: "Updates", value: summary.update, tone: "text-signal-blue" },
    { label: "Duplicates", value: summary.duplicate, tone: "text-signal-amber" },
    { label: "Needs review", value: summary.needsReview, tone: "text-signal-amber" },
    { label: "Errors", value: summary.error, tone: "text-signal-red" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <Card key={t.label} className="px-4 py-3">
          <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{t.label}</dt>
          <dd className={cn("mt-1 text-xl font-semibold tabular-nums text-ink", t.value > 0 && t.tone)}>{t.value.toLocaleString("en-IN")}</dd>
        </Card>
      ))}
    </dl>
  );
}

export interface QuestionImportPreviewProps {
  results: ImportRowResult[];
  rawByRow: Map<number, RawImportRow>;
  courseCodeById: Map<string, string>;
  onToggleInclude: (rowNumber: number, include: boolean) => void;
  disabled?: boolean;
  /** How an item is labelled: "Row" (spreadsheet row) or "Question" (Word: the document's Q number). */
  itemLabel?: string;
  /** OCR rows: the reviewer confirmed the row against its scanned page. */
  onToggleConfirm?: (rowNumber: number, confirmed: boolean) => void;
}

/** The validated rows, 50 at a time, filterable by status. Advisory only — the server re-checks every row. */
export function QuestionImportPreview({ results, rawByRow, courseCodeById, onToggleInclude, disabled, itemLabel = "Row", onToggleConfirm }: QuestionImportPreviewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: results.length, CREATE: 0, UPDATE: 0, DUPLICATE: 0, NEEDS_REVIEW: 0, ERROR: 0, warnings: 0 };
    for (const r of results) {
      c[r.status] += 1;
      if (r.issues.some((i) => i.severity === "warning")) c.warnings += 1;
    }
    return c;
  }, [results]);

  const filtered = useMemo(
    () => (filter === "all" ? results : filter === "warnings" ? results.filter((r) => r.issues.some((i) => i.severity === "warning")) : results.filter((r) => r.status === filter)),
    [results, filter]
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PREVIEW_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PREVIEW_PAGE_SIZE, (current + 1) * PREVIEW_PAGE_SIZE);

  const tabs: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "CREATE", label: "New" },
    { value: "UPDATE", label: "Updates" },
    { value: "DUPLICATE", label: "Duplicates" },
    { value: "NEEDS_REVIEW", label: "Needs review" },
    { value: "ERROR", label: "Errors" },
    { value: "warnings", label: "Warnings" },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap gap-1 border-b border-surface-border px-4 py-2" role="tablist" aria-label="Filter rows">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={filter === t.value}
            onClick={() => {
              setFilter(t.value);
              setPage(0);
            }}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              filter === t.value ? "bg-primary-50 text-primary-700" : "text-ink-muted hover:bg-surface-sunken"
            )}
          >
            {t.label} <span className="tabular-nums text-ink-faint">({counts[t.value].toLocaleString("en-IN")})</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-muted">No rows in this view.</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {visible.map((r) => {
            const raw = rawByRow.get(r.rowNumber);
            const badge = STATUS_BADGE[r.status];
            const text = r.question?.text ?? (raw?.questionText || "(no question text)");
            const courseCode = r.question ? courseCodeById.get(r.question.courseId) : raw?.courseCode;
            const isDuplicate = r.status === "DUPLICATE" || r.includeAnyway;
            // Read by OCR: the reviewer confirms it against the scanned page (clears only the OCR check).
            const isOcr = !!raw?.source?.uncertain || typeof raw?.source?.ocrConfidence === "number";
            return (
              <li key={r.rowNumber} className="flex gap-4 px-5 py-3">
                <div className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-ink-faint">
                  {itemLabel} {r.rowNumber}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                    {r.includeAnyway && <Badge tone="amber">Included anyway</Badge>}
                    <span className="text-xs text-ink-muted">
                      {[
                        courseCode,
                        r.question ? TYPE_LABEL[r.question.type] : raw?.questionType ? TYPE_LABEL[String(raw.questionType).trim().toLowerCase()] ?? raw.questionType : null,
                        r.question ? `${r.question.marks} mark${r.question.marks === 1 ? "" : "s"}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-ink">{text}</p>
                  {r.issues.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {r.issues.map((i, k) => (
                        <li key={k} className={cn("flex items-start gap-1.5 text-xs", i.severity === "error" ? "text-signal-red" : i.severity === "needs_review" ? "text-signal-amber" : "text-ink-muted")}>
                          {i.severity === "error" ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : i.severity === "needs_review" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                          <span>{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {(isDuplicate || (isOcr && onToggleConfirm)) && (
                  <div className="flex shrink-0 flex-col gap-1.5 pt-0.5">
                    {isOcr && onToggleConfirm && (
                      <label className="flex cursor-pointer items-start gap-2 text-xs text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-primary-500"
                          checked={!!raw?.reviewConfirmed}
                          disabled={disabled}
                          onChange={(e) => onToggleConfirm(r.rowNumber, e.target.checked)}
                        />
                        Checked against {raw?.source?.page ? `page ${raw.source.page}` : "the page"}
                      </label>
                    )}
                    {isDuplicate && (
                      <label className="flex cursor-pointer items-start gap-2 text-xs text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-primary-500"
                          checked={r.includeAnyway}
                          disabled={disabled}
                          onChange={(e) => onToggleInclude(r.rowNumber, e.target.checked)}
                        />
                        Include anyway
                      </label>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {filtered.length > PREVIEW_PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-surface-border px-4 py-2 text-xs text-ink-muted">
          <span>
            Rows {(current * PREVIEW_PAGE_SIZE + 1).toLocaleString("en-IN")}–{Math.min((current + 1) * PREVIEW_PAGE_SIZE, filtered.length).toLocaleString("en-IN")} of {filtered.length.toLocaleString("en-IN")}
          </span>
          <div className="flex gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
