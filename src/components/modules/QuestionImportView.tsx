"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, FileSpreadsheet, FileText, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/hooks/useToast";
import { planChunks, runChunks } from "@/lib/question-import/engine";
import { checkFileSize } from "@/lib/question-import/sheet";
import { validateImport } from "@/lib/question-import/validate";
import {
  discardQuestionImportAction,
  finishQuestionImportAction,
  getActiveQuestionImportAction,
  getQuestionImportContextAction,
  getQuestionImportResumeStateAction,
  importQuestionChunkAction,
  startQuestionImportAction,
} from "@/services/question-import.actions";
import type {
  ImportContext,
  ImportPreviewSummary,
  ImportRowOutcome,
  ImportRowResult,
  ImportRunProgress,
  ImportSource,
  ParsedImportFile,
  RawImportRow,
} from "@/types/question-import";
import { CSV_MIME, DOCX_MIME, XLSX_MIME, downloadFile } from "@/utils/download";
import { formatDateTime } from "@/utils/format";
import { ImportSummaryTiles, QuestionImportPreview } from "./QuestionImportPreview";

type Stage = "choose" | "reading" | "preview" | "importing" | "done";

interface SelectedFile {
  name: string;
  size: number;
  sha256: string;
  source: ImportSource;
}

interface RunOutcome {
  run: ImportRunProgress | null;
  outcomes: ImportRowOutcome[];
  stopped: { error: string; retryable: boolean } | null;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sourceOf(fileName: string): ImportSource | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

type OcrProgress = { done: number; total: number; page: number };

async function parseFile(source: ImportSource, buffer: ArrayBuffer, onOcrProgress: (p: OcrProgress) => void): Promise<ParsedImportFile> {
  if (source === "xlsx") return (await import("@/lib/question-import/xlsx")).parseXlsx(buffer);
  if (source === "docx") return (await import("@/lib/question-import/docx")).parseDocx(buffer);
  // Scanned pages are read with OCR in this browser (the result's source is then "pdf_ocr").
  if (source === "pdf") return (await import("@/lib/question-import/pdf")).parsePdf(buffer, { onProgress: onOcrProgress });
  return (await import("@/lib/question-import/csv")).parseCsv(buffer);
}

/**
 * Bulk import from Excel, CSV, Word (.docx) or PDF. The file is read, validated and previewed in
 * the browser — it is never uploaded. Confirmed rows are sent in chunks of
 * at most 100 to the server, which re-validates every row; 0013 writes
 * them (always as drafts). The preview is advisory only.
 */
export function QuestionImportView({ basePath }: { basePath: string }) {
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [parsed, setParsed] = useState<ParsedImportFile | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [context, setContext] = useState<ImportContext | null>(null);
  const [courseId, setCourseId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [validation, setValidation] = useState<{ results: ImportRowResult[]; summary: ImportPreviewSummary } | null>(null);
  const [validating, setValidating] = useState(false);
  const [activeRun, setActiveRun] = useState<ImportRunProgress | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<RunOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getActiveQuestionImportAction().then((r) => {
      if (r.ok) setActiveRun(r.data);
    });
  }, []);

  const rows: RawImportRow[] = useMemo(
    () => (parsed ? parsed.rows.map((r) => ({ ...r, includeAnyway: include.has(r.rowNumber), reviewConfirmed: confirmed.has(r.rowNumber) })) : []),
    [parsed, include, confirmed]
  );
  const ocrRows = useMemo(() => (parsed ? parsed.rows.filter((r) => r.source?.uncertain).length : 0), [parsed]);
  const rawByRow = useMemo(() => new Map(rows.map((r) => [r.rowNumber, r])), [rows]);
  const courseCodeById = useMemo(() => new Map((context?.courses ?? []).map((c) => [c.id.toLowerCase(), c.code])), [context]);
  const needsCourse = parsed ? !parsed.everyRowHasCourse : false;
  const selectedCourse = context?.courses.find((c) => c.id === courseId);

  // Re-validate whenever the rows, the scope/bank context or the choices change.
  useEffect(() => {
    if (!parsed || !context) return;
    let cancelled = false;
    setValidating(true);
    validateImport(rows, { ...context, defaultCourseId: courseId || null, defaultModuleId: moduleId || null }).then((v) => {
      if (!cancelled) {
        setValidation(v);
        setValidating(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rows, context, courseId, moduleId, parsed]);

  async function loadContext(p: ParsedImportFile, chosenCourse: string): Promise<boolean> {
    const courseCodes = Array.from(new Set(p.rows.map((r) => (r.courseCode ?? "").trim()).filter(Boolean)));
    const questionIds = Array.from(new Set(p.rows.map((r) => (r.questionId ?? "").trim()).filter(Boolean)));
    const res = await getQuestionImportContextAction({ source: p.source, courseCodes, questionIds, defaultCourseId: chosenCourse || null });
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    setContext(res.data);
    return true;
  }

  function reset() {
    setStage("choose");
    setFile(null);
    setParsed(null);
    setFileErrors([]);
    setContext(null);
    setCourseId("");
    setModuleId("");
    setInclude(new Set());
    setConfirmed(new Set());
    setOcrProgress(null);
    setValidation(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFileChosen(f: File | undefined) {
    if (!f) return;
    reset();
    const source = sourceOf(f.name);
    if (!source) {
      setFileErrors([
        f.name.toLowerCase().endsWith(".doc")
          ? "Older Word .doc files can't be read. Open the file in Word and save it as .docx (Word Document)."
          : "Choose an Excel workbook (.xlsx), a CSV file (.csv), a Word document (.docx) or a PDF (.pdf). Older .xls/.doc files must be saved as .xlsx/.docx first.",
      ]);
      return;
    }
    const tooBig = checkFileSize(source, f.size);
    if (tooBig) {
      setFileErrors([tooBig]);
      return;
    }
    setStage("reading");
    try {
      const buffer = await f.arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      const p = await parseFile(source, buffer, setOcrProgress);
      setOcrProgress(null);
      if (p.fileErrors.length > 0) {
        setFileErrors(p.fileErrors);
        setStage("choose");
        return;
      }
      if (p.rows.length === 0) {
        setFileErrors(["The file has no questions below the header row."]);
        setStage("choose");
        return;
      }
      // The parsed source: a scanned PDF read by OCR is imported as "pdf_ocr".
      setFile({ name: f.name, size: f.size, sha256, source: p.source });
      setParsed(p);
      if (await loadContext(p, "")) setStage("preview");
      else setStage("choose");
    } catch (err) {
      console.error("[question-import] read failed:", err instanceof Error ? err.message : err);
      setFileErrors(["The file could not be read. Check that it is a valid .xlsx, .csv, .docx or .pdf file."]);
      setStage("choose");
    }
  }

  async function onCourseChange(id: string) {
    setCourseId(id);
    setModuleId("");
    if (parsed) await loadContext(parsed, id);
  }

  async function downloadTemplate(format: "xlsx" | "csv" | "docx") {
    if (format === "docx") {
      const w = await import("@/lib/question-import/docx-template");
      downloadFile(w.templateDocxBytes(), w.DOCX_TEMPLATE_FILE_NAME, DOCX_MIME);
      return;
    }
    const t = await import("@/lib/question-import/export");
    if (format === "xlsx") downloadFile(await t.templateXlsxBytes(), t.exportFileName("template", "xlsx"), XLSX_MIME);
    else downloadFile(t.templateCsvText(), t.exportFileName("template", "csv"), CSV_MIME);
  }

  async function discardActive() {
    if (!activeRun) return;
    setBusy(true);
    const res = await discardQuestionImportAction(activeRun.id);
    setBusy(false);
    if (!res.ok) {
      showToast({ variant: "error", title: "Couldn't discard the import", description: res.error });
      return;
    }
    setActiveRun(null);
    showToast({ variant: "success", title: "Unfinished import discarded", description: `${res.data.deleted} unchanged draft${res.data.deleted === 1 ? "" : "s"} removed; updates are kept.` });
  }

  async function runImport() {
    if (!file || !validation) return;
    setConfirmOpen(false);
    setError(null);
    const importable = new Set(validation.results.filter((r) => r.status === "CREATE" || r.status === "UPDATE").map((r) => r.rowNumber));
    const toSend = rows.filter((r) => importable.has(r.rowNumber));
    if (toSend.length === 0) return;
    setStage("importing");

    let runId: string;
    let done: number[] = [];
    if (activeRun && activeRun.status === "in_progress" && activeRun.fileSha256 === file.sha256 && activeRun.source === file.source) {
      runId = activeRun.id; // same file: resume
      const state = await getQuestionImportResumeStateAction(runId);
      if (!state.ok) {
        setError(state.error);
        setStage("preview");
        return;
      }
      done = state.data.doneRowNumbers;
    } else {
      const started = await startQuestionImportAction({
        source: file.source,
        fileName: file.name,
        fileSha256: file.sha256,
        plannedCreates: validation.summary.create,
        plannedUpdates: validation.summary.update,
        plannedExcluded: validation.summary.total - validation.summary.create - validation.summary.update,
      });
      if (!started.ok) {
        setError(started.error);
        setStage("preview");
        return;
      }
      runId = started.data.id;
      setActiveRun(started.data);
    }

    const doneSet = new Set(done);
    setProgress({ done: toSend.filter((r) => doneSet.has(r.rowNumber)).length, total: toSend.length });
    const outcome = await runChunks({
      chunks: planChunks(toSend),
      doneRowNumbers: done,
      send: (chunk) => importQuestionChunkAction(runId, { source: file.source, defaultCourseId: courseId || null, defaultModuleId: moduleId || null, rows: chunk }),
      onProgress: ({ outcome: o }) => setProgress((p) => ({ ...p, done: Math.min(p.total, p.done + o.rows.length) })),
    });
    if (outcome.stopped) {
      setResult({ run: outcome.lastRun, outcomes: outcome.rows, stopped: { error: outcome.stopped.error, retryable: outcome.stopped.retryable } });
      setStage("done");
      return;
    }
    const finished = await finishQuestionImportAction(runId);
    setActiveRun(null);
    setResult({ run: finished.ok ? finished.data : outcome.lastRun, outcomes: outcome.rows, stopped: null });
    setStage("done");
  }

  const importableCount = validation ? validation.summary.create + validation.summary.update : 0;
  const courseMissing = needsCourse && !courseId;
  // Word and PDF files are documents: items are questions (Q1, Q2, …), and one course applies to the document.
  const isWord = file?.source === "docx" || file?.source === "pdf" || file?.source === "pdf_ocr";
  const itemLabel = isWord ? "Question" : "Row";

  return (
    <div className="flex flex-col gap-5">
      <Link href={basePath} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary-600 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Question Bank
      </Link>

      {activeRun && stage !== "importing" && stage !== "done" && (
        <Card className="flex flex-col gap-3 border-signal-amber/40 bg-signal-amberSoft/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-ink">
            <p className="font-semibold">You have an unfinished import: {activeRun.fileName}</p>
            <p className="text-ink-muted">
              Started {formatDateTime(activeRun.createdAt)} · {activeRun.createdCount} created, {activeRun.updatedCount} updated so far. Choose the same file again to resume it, or discard it.
            </p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={discardActive} isLoading={busy}>
            Discard unfinished import
          </Button>
        </Card>
      )}

      {(stage === "choose" || stage === "reading") && (
        <Card className="px-6 py-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-base font-semibold text-ink">Choose an Excel, CSV, Word or PDF file</h2>
              <p className="mt-1 text-sm text-ink-muted">
                The file is read in your browser and is never uploaded. You will see a preview before anything is saved. New questions are always created as <strong>drafts</strong>; only draft questions can be updated.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5 text-xs text-ink-faint">
                <li>Excel (.xlsx): up to 5,000 questions, 10 MB</li>
                <li>CSV (.csv, UTF-8): up to 10,000 questions, 10 MB</li>
                <li>Word (.docx): up to 1,000 questions, 15 MB — single choice, multiple choice and true/false, typed as in the Word template</li>
                <li>PDF (.pdf): up to 1,000 questions, 25 MB — in the Word template&apos;s format (fill in the Word template and save it as PDF). Password-protected PDFs are not supported.</li>
                <li>Scanned PDF: up to 100 scanned pages, read with OCR in your browser. Every OCR question must be checked against its page before it can be imported.</li>
              </ul>
            </div>
            <div className="flex shrink-0 flex-col gap-2 text-sm">
              <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">Official template</span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => downloadTemplate("xlsx")}>
                  <FileSpreadsheet className="h-4 w-4" aria-hidden /> Template (.xlsx)
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => downloadTemplate("csv")}>
                  <FileSpreadsheet className="h-4 w-4" aria-hidden /> Template (.csv)
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => downloadTemplate("docx")}>
                  <FileText className="h-4 w-4" aria-hidden /> Template (.docx)
                </Button>
              </div>
            </div>
          </div>
          <label className="mt-5 flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-surface-border bg-surface px-6 py-10 text-center hover:border-primary-300">
            {stage === "reading" ? <Loader2 className="h-6 w-6 animate-spin text-primary-500" aria-hidden /> : <Upload className="h-6 w-6 text-primary-500" aria-hidden />}
            <span className="text-sm font-medium text-ink">
              {stage !== "reading"
                ? "Choose a file (.xlsx, .csv, .docx or .pdf)"
                : ocrProgress
                  ? `Scanned PDF: reading page ${Math.min(ocrProgress.done + 1, ocrProgress.total)} of ${ocrProgress.total} with OCR…`
                  : "Reading the file…"}
            </span>
            {stage === "reading" && ocrProgress && (
              <span className="text-xs text-ink-muted">OCR runs in your browser and can take a while for many pages. Keep this page open.</span>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv,.docx,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
              className="sr-only"
              disabled={stage === "reading"}
              onChange={(e) => onFileChosen(e.target.files?.[0])}
            />
          </label>
          {error && fileErrors.length === 0 && (
            <p role="alert" className="mt-4 rounded-sm border border-signal-red/30 bg-signal-redSoft px-4 py-3 text-sm text-signal-red">
              {error}
            </p>
          )}
          {fileErrors.length > 0 && (
            <div role="alert" className="mt-4 rounded-sm border border-signal-red/30 bg-signal-redSoft px-4 py-3 text-sm text-signal-red">
              <p className="font-semibold">This file can&apos;t be imported</p>
              <ul className="mt-1 list-disc pl-5">
                {fileErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {stage === "preview" && parsed && file && (
        <>
          <Card className="flex flex-col gap-4 px-5 py-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">{file.name}</p>
                <p className="text-xs text-ink-muted">
                  {(file.size / 1024).toFixed(0)} KB{parsed.sheetName ? ` · sheet "${parsed.sheetName}"` : ""} · {parsed.rows.length.toLocaleString("en-IN")}{" "}
                  {isWord ? `question${parsed.rows.length === 1 ? "" : "s"} found` : "question rows"}
                  {parsed.warnings.length > 0 ? ` · ${parsed.warnings.join(" ")}` : ""}
                </p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={reset}>
                Choose another file
              </Button>
            </div>
            {needsCourse && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={isWord ? "Course for this document" : "Course for rows without a Course Code"}
                  value={courseId}
                  onChange={(e) => onCourseChange(e.target.value)}
                  options={[{ label: "Choose a course…", value: "" }, ...(context?.courses ?? []).map((c) => ({ label: c.title ? `${c.code} — ${c.title}` : c.code, value: c.id }))]}
                />
                <Select
                  label={isWord ? "Module (optional) for questions without a Module Code" : "Module (optional) for rows without a Module Code"}
                  value={moduleId}
                  onChange={(e) => setModuleId(e.target.value)}
                  disabled={!selectedCourse}
                  options={[{ label: "No module", value: "" }, ...(selectedCourse?.modules ?? []).map((m) => ({ label: m.title ? `${m.code} — ${m.title}` : m.code, value: m.id }))]}
                />
              </div>
            )}
            {courseMissing && (
              <p className="text-xs text-signal-amber">
                {isWord
                  ? "Some questions have no Course Code. Choose the document's course above — it is never guessed. Questions that name a different course are refused."
                  : "Some rows have no Course Code. Choose their course above — it is never guessed."}
              </p>
            )}
            {ocrRows > 0 && (
              <p role="status" className="rounded-sm border border-signal-amber/40 bg-signal-amberSoft/40 px-3 py-2 text-xs text-ink">
                <strong>OCR was used</strong> for scanned pages: {ocrRows.toLocaleString("en-IN")} question{ocrRows === 1 ? " was" : "s were"} read from page images. OCR can misread text, so each one needs review: compare it with its page and tick
                “Checked against page …”. Questions where OCR was unsure of the answer, marks, options or codes stay in review — correct the file or add them in the Question Bank.
              </p>
            )}
            {context && context.courses.length === 0 && <p className="text-sm text-signal-red">You don&apos;t have any courses to import into. Trainers can import only into courses of their upcoming or ongoing batches.</p>}
          </Card>

          {validation ? <ImportSummaryTiles summary={validation.summary} /> : null}
          {validating && (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking rows…
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-sm border border-signal-red/30 bg-signal-redSoft px-4 py-2 text-sm text-signal-red">
              {error}
            </p>
          )}
          {validation && (
            <QuestionImportPreview
              results={validation.results}
              rawByRow={rawByRow}
              courseCodeById={courseCodeById}
              disabled={validating}
              itemLabel={itemLabel}
              onToggleConfirm={
                ocrRows > 0
                  ? (rowNumber, on) =>
                      setConfirmed((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(rowNumber);
                        else next.delete(rowNumber);
                        return next;
                      })
                  : undefined
              }
              onToggleInclude={(rowNumber, on) =>
                setInclude((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(rowNumber);
                  else next.delete(rowNumber);
                  return next;
                })
              }
            />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <p className="text-xs text-ink-muted sm:mr-auto">The preview is a guide. The server checks every row again when you import; only new and updated rows are sent.</p>
            <Button type="button" onClick={() => setConfirmOpen(true)} disabled={validating || !validation || importableCount === 0}>
              Import {importableCount.toLocaleString("en-IN")} question{importableCount === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      )}

      {stage === "importing" && (
        <Card className="px-6 py-8">
          <p className="text-sm font-semibold text-ink">Importing…</p>
          <p className="mt-1 text-xs text-ink-muted">Keep this page open. If it is interrupted, choose the same file again to resume — rows already saved are never saved twice.</p>
          <div className="mt-4">
            <ProgressBar value={progress.total ? (progress.done / progress.total) * 100 : 0} tone="teal" label={`${progress.done.toLocaleString("en-IN")} of ${progress.total.toLocaleString("en-IN")} rows`} />
          </div>
        </Card>
      )}

      {stage === "done" && result && <ImportResult result={result} validation={validation} basePath={basePath} itemLabel={itemLabel} onRetry={runImport} onAnother={reset} />}

      <Dialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={runImport}
        title="Import these questions?"
        description={
          validation
            ? `${validation.summary.create.toLocaleString("en-IN")} new question${validation.summary.create === 1 ? "" : "s"} will be created as drafts and ${validation.summary.update.toLocaleString("en-IN")} draft question${validation.summary.update === 1 ? "" : "s"} will be updated. ${(validation.summary.total - importableCount).toLocaleString("en-IN")} row${validation.summary.total - importableCount === 1 ? "" : "s"} (duplicates, errors, needs review) will not be imported. Nothing is activated.`
            : ""
        }
        confirmLabel="Import"
      />
    </div>
  );
}

function ImportResult({
  result,
  validation,
  basePath,
  itemLabel,
  onRetry,
  onAnother,
}: {
  result: RunOutcome;
  validation: { results: ImportRowResult[]; summary: ImportPreviewSummary } | null;
  basePath: string;
  itemLabel: string;
  onRetry: () => void;
  onAnother: () => void;
}) {
  const [page, setPage] = useState(0);
  const counts = useMemo(() => {
    const sent = new Set(result.outcomes.map((o) => o.rowNumber));
    const c = { created: 0, updated: 0, unchanged: 0, alreadyDone: 0, skipped: 0, duplicates: 0, rejected: 0 };
    for (const o of result.outcomes) {
      if (o.outcome === "created") c.created++;
      else if (o.outcome === "updated") c.updated++;
      else if (o.outcome === "unchanged") c.unchanged++;
      else if (o.outcome === "already_done") c.alreadyDone++;
      else if (o.outcome === "skipped") o.status === "DUPLICATE" ? c.duplicates++ : c.skipped++;
      else if (o.outcome === "rejected") o.reason === "duplicate" ? c.duplicates++ : c.rejected++;
    }
    for (const r of validation?.results ?? []) {
      if (sent.has(r.rowNumber) || r.status === "CREATE" || r.status === "UPDATE") continue;
      if (r.status === "DUPLICATE") c.duplicates++;
      else c.skipped++;
    }
    return c;
  }, [result, validation]);
  const problems = result.outcomes.filter((o) => o.outcome === "skipped" || o.outcome === "rejected");
  const pageRows = problems.slice(page * 50, page * 50 + 50);

  const tiles = [
    { label: "Created", value: counts.created },
    { label: "Updated", value: counts.updated + counts.unchanged },
    { label: "Skipped", value: counts.skipped },
    { label: "Duplicates", value: counts.duplicates },
    { label: "Rejected", value: counts.rejected },
    { label: "Already done", value: counts.alreadyDone },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2 px-6 py-5">
        {result.stopped ? (
          <>
            <p className="text-base font-semibold text-signal-red">The import stopped before it finished</p>
            <p className="text-sm text-ink-muted">{result.stopped.error} Rows imported so far are saved{result.stopped.retryable ? "; you can resume now." : "."}</p>
          </>
        ) : (
          <p className="flex items-center gap-2 text-base font-semibold text-ink">
            <CheckCircle2 className="h-5 w-5 text-signal-green" aria-hidden /> Import finished
          </p>
        )}
        <p className="text-sm text-ink-muted">New questions are drafts. Review and activate them in the Question Bank.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href={basePath} className="inline-flex h-9 items-center rounded bg-primary-500 px-4 text-sm font-medium text-white hover:bg-primary-600">
            Open Question Bank
          </Link>
          {result.stopped && (
            <Button type="button" variant="secondary" onClick={onRetry}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Resume import
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onAnother}>
            Import another file
          </Button>
        </div>
      </Card>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.label} className="px-4 py-3">
            <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{t.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value.toLocaleString("en-IN")}</dd>
          </Card>
        ))}
      </dl>
      {problems.length > 0 && (
        <Card className="overflow-hidden">
          <p className="border-b border-surface-border px-5 py-3 text-sm font-semibold text-ink">Rows the server did not import ({problems.length.toLocaleString("en-IN")})</p>
          <ul className="divide-y divide-surface-border">
            {pageRows.map((o) => (
              <li key={o.rowNumber} className="flex gap-4 px-5 py-2.5 text-sm">
                <span className="w-16 shrink-0 text-xs tabular-nums text-ink-faint">
                  {itemLabel} {o.rowNumber}
                </span>
                <span className="text-ink-muted">{o.message ?? o.issues?.map((i) => i.message).join(" ") ?? (o.status === "DUPLICATE" ? "Duplicate." : "Not imported.")}</span>
              </li>
            ))}
          </ul>
          {problems.length > 50 && (
            <div className="flex justify-end gap-1 border-t border-surface-border px-4 py-2">
              <Button type="button" size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={(page + 1) * 50 >= problems.length} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
