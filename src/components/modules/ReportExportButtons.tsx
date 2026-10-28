"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/hooks/useToast";
import { CSV_MIME, XLSX_MIME, downloadFile } from "@/utils/download";
import { reportFileName, toExportTable, type ReportTable, type ReportType } from "@/lib/reports/reports";

/**
 * CSV / Excel download of the report on screen. The file is built in the browser from exactly the table the
 * server returned for the caller's own scope (the same rows the page shows) — nothing is uploaded, nothing is
 * recomputed. Text cells are escaped against spreadsheet formula injection (toExportTable).
 */
export function ReportExportButtons({ type, table }: { type: ReportType; table: ReportTable }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const empty = table.rows.length === 0;

  async function exportAs(format: "csv" | "xlsx") {
    if (busy || empty) return;
    setBusy(true);
    try {
      const { toCsvText, toXlsxBytes } = await import("@/lib/question-import/export");
      const sheet = toExportTable(table);
      const name = reportFileName(type, format);
      if (format === "xlsx") downloadFile(await toXlsxBytes(sheet, "Report"), name, XLSX_MIME);
      else downloadFile(toCsvText(sheet), name, CSV_MIME);
      showToast({ variant: "success", title: `Exported ${sheet.rows.length} row${sheet.rows.length === 1 ? "" : "s"}` });
    } catch (err) {
      console.error("[report-export]", err instanceof Error ? err.message : err);
      showToast({ variant: "error", title: "Export failed", description: "The file could not be created. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy || empty} onClick={() => exportAs("csv")}>
        <Download className="h-3.5 w-3.5" aria-hidden /> CSV
      </Button>
      <Button size="sm" variant="secondary" disabled={busy || empty} onClick={() => exportAs("xlsx")}>
        <Download className="h-3.5 w-3.5" aria-hidden /> Excel
      </Button>
    </div>
  );
}
