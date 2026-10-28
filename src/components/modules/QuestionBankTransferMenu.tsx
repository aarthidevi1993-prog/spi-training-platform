"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { useToast } from "@/hooks/useToast";
import { exportQuestionBankAction } from "@/services/question-import.actions";
import { CSV_MIME, XLSX_MIME, downloadFile } from "@/utils/download";
import type { ExportMode } from "@/types/question-import";

/**
 * Question Bank header actions: Import questions (Excel/CSV/Word) and Export
 * (the caller's own scope, built in the browser). Staff-only pages.
 */
export function QuestionBankTransferMenu() {
  const pathname = usePathname();
  const basePath = pathname.replace(/\/+$/, "");
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function runExport(mode: ExportMode, format: "xlsx" | "csv") {
    setBusy(true);
    try {
      const result = await exportQuestionBankAction(mode);
      if (!result.ok) {
        showToast({ variant: "error", title: "Export failed", description: result.error });
        return;
      }
      const { buildExportTable, exportFileName, toCsvText, toXlsxBytes } = await import("@/lib/question-import/export");
      const table = buildExportTable(result.data.questions, mode);
      if (table.rows.length === 0) {
        showToast({ variant: "info", title: mode === "update" ? "No draft questions to export" : "No questions to export" });
        return;
      }
      const name = exportFileName(mode, format);
      if (format === "xlsx") downloadFile(await toXlsxBytes(table), name, XLSX_MIME);
      else downloadFile(toCsvText(table), name, CSV_MIME);
      showToast({ variant: "success", title: `Exported ${table.rows.length} question${table.rows.length === 1 ? "" : "s"}` });
    } catch (err) {
      console.error("[question-export]", err instanceof Error ? err.message : err);
      showToast({ variant: "error", title: "Export failed", description: "The file could not be created. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Dropdown
        align="right"
        className="min-w-[17rem]"
        trigger={
          <Button type="button" size="sm" variant="secondary" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            Export <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        }
      >
        <p className="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">Question Bank</p>
        <DropdownItem onClick={() => runExport("bank", "xlsx")} disabled={busy}>Export all questions (.xlsx)</DropdownItem>
        <DropdownItem onClick={() => runExport("bank", "csv")} disabled={busy}>Export all questions (.csv)</DropdownItem>
        <div className="my-1 border-t border-surface-border" />
        <p className="px-3 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">For bulk update</p>
        <DropdownItem onClick={() => runExport("update", "xlsx")} disabled={busy}>Export draft questions for update (.xlsx)</DropdownItem>
        <DropdownItem onClick={() => runExport("update", "csv")} disabled={busy}>Export draft questions for update (.csv)</DropdownItem>
      </Dropdown>
      <Link
        href={`${basePath}/import`}
        className="inline-flex h-8 items-center gap-1.5 rounded border border-surface-border bg-white px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-sunken"
      >
        <Upload className="h-4 w-4" aria-hidden /> Import questions
      </Link>
    </div>
  );
}
