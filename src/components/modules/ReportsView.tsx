import Link from "next/link";
import { AlertTriangle, FileBarChart } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { cn } from "@/utils/cn";
import { formatDateTime } from "@/utils/format";
import { REPORT_TYPES, reportsHref, type ReportCell } from "@/lib/reports/reports";
import type { ReportResult } from "@/services/reports.service.core";
import { ReportExportButtons } from "./ReportExportButtons";

/** Rows shown on the page; the download always contains every row. */
export const REPORT_PREVIEW_ROWS = 200;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

function display(cell: ReportCell): string {
  if (cell === null) return "—";
  if (typeof cell === "number") return String(cell);
  return TIMESTAMP.test(cell) ? formatDateTime(cell) : cell;
}

/**
 * Reports dashboard for /admin/reports and /trainer/reports. Server-rendered from reportsService (scope from
 * the session). Filters are a plain GET form: the server re-validates every value against the caller's scope.
 */
export function ReportsView({ report, basePath }: { report: ReportResult; basePath: string }) {
  const f = report.filters;
  const shown = report.table.rows.slice(0, REPORT_PREVIEW_ROWS);
  const description = REPORT_TYPES.find((t) => t.value === report.type)?.description;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Report type" className="flex flex-wrap gap-2">
        {REPORT_TYPES.map((t) => (
          <Link
            key={t.value}
            href={reportsHref(basePath, { ...f, type: t.value })}
            aria-current={t.value === report.type ? "page" : undefined}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm font-medium",
              t.value === report.type ? "border-primary-500 bg-primary-50 text-primary-700" : "border-surface-border bg-white text-ink hover:bg-surface-sunken"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <Card>
        <CardContent>
          <form method="get" action={basePath} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
            <input type="hidden" name="type" value={report.type} />
            <Select name="course" label="Course" defaultValue={f.courseId ?? ""} options={[{ value: "", label: "All courses" }, ...report.options.courses]} className="lg:col-span-1" />
            <Select name="batch" label="Batch" defaultValue={f.batchId ?? ""} options={[{ value: "", label: "All batches" }, ...report.options.batches]} />
            {f.batchId ? (
              <Select name="student" label="Student" defaultValue={f.studentId ?? ""} options={[{ value: "", label: "All students" }, ...report.options.students]} />
            ) : (
              <p className="self-end pb-2 text-xs text-ink-faint">Choose a batch to filter by student.</p>
            )}
            <Input type="date" name="from" label="From" defaultValue={f.from ?? ""} />
            <Input type="date" name="to" label="To" defaultValue={f.to ?? ""} />
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                Apply
              </Button>
              <Link href={reportsHref(basePath, { type: report.type })} className="inline-flex h-8 items-center rounded-md px-3 text-sm text-ink-muted hover:bg-surface-sunken">
                Reset
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {report.ignored.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-signal-amber bg-signal-amberSoft px-3 py-2 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-amber" aria-hidden />
          <ul className="flex flex-col gap-0.5">
            {report.ignored.map((i, n) => (
              <li key={`${i.param}-${n}`}>{i.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink">{report.typeLabel}</h2>
              <p className="text-sm text-ink-muted">{report.scopeLabel}</p>
              {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
              <p className="mt-1 text-xs text-ink-faint">Generated {formatDateTime(report.generatedAt)}</p>
            </div>
            <ReportExportButtons type={report.type} table={report.table} />
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {report.summary.map((s) => (
              <div key={s.label} className="rounded-md border border-surface-border bg-surface-sunken px-3 py-2">
                <dt className="text-2xs uppercase tracking-wide text-ink-muted">{s.label}</dt>
                <dd className="text-lg font-semibold text-ink">{s.value}</dd>
              </div>
            ))}
          </dl>

          {report.table.rows.length === 0 ? (
            <EmptyState icon={FileBarChart} title="No records for these filters" description="Nothing matches the chosen course, batch, student and dates in your reporting scope. Nothing to download." />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHead>
                    <TableRow>
                      {report.table.headers.map((h) => (
                        <TableHeaderCell key={h} className="whitespace-nowrap">
                          {h}
                        </TableHeaderCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {shown.map((row, r) => (
                      <TableRow key={r}>
                        {row.map((cell, c) => (
                          <TableCell key={c} className={cn("whitespace-nowrap", typeof cell === "number" && "text-right tabular-nums")}>
                            {display(cell)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {report.table.rows.length > shown.length && (
                <p className="text-xs text-ink-muted">
                  Showing the first {shown.length} of {report.table.rows.length} rows. The download contains all {report.table.rows.length} rows.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
