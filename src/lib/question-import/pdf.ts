/**
 * Bulk import — PDF reader, in the browser (the file is never uploaded).
 * Text-based PDFs only; scanned (image-only) pages are not read — OCR is a
 * later phase.
 *
 * The PDF must use the question-block format of the Word template (Q1.,
 * Type:, Marks:, A) …, Answer:, Explanation:) — typically the Word
 * template filled in and saved as PDF. Text lines are rebuilt from the
 * positioned text on each page and read by the same block reader as Word
 * (docx.ts, source "pdf"), which hands rows to rowsFromSheet — so
 * validation, answers, fingerprints, duplicates, Question ID + Revision and
 * the draft-only rules are exactly those of Excel/CSV/Word. In a PDF a line
 * that continues the question, an option or the explanation is joined to
 * it (text wraps at the page edge).
 *
 * Safety: size limit before reading; a decompression pre-scan (pdf-scan.ts)
 * before pdf.js sees the file; pdf.js runs with fonts, XFA, scripting and
 * rendering off and only extracts text; page/text limits and a time limit;
 * encrypted PDFs (password or restrictions) are refused.
 */
import type { ParsedImportFile } from "@/types/question-import";
import { isQuestionBlockLine, rowsFromDocxBody, type DocxBody, type DocxParagraph } from "./docx";
import {
  OCR_MAX_PAGES,
  OCR_MAX_PDF_IMAGE_PIXELS,
  OCR_MAX_TOTAL_CHARS,
  OCR_MAX_CHARS_PER_PAGE,
  OCR_MAX_WORDS_PER_PAGE,
  OCR_PAGE_TIMEOUT_MS,
  OCR_TOTAL_TIMEOUT_MS,
  browserOcr,
  ocrOutputSize,
  pageTextFromOcr,
  type OcrEngine,
  type OcrImage,
  type PdfOcrOptions,
  type RenderablePage,
} from "./pdf-ocr";
import { scanPdf } from "./pdf-scan";
import { checkFileSize } from "./sheet";

export const PDF_MAX_PAGES = 1000;
export const PDF_MAX_TEXT_CHARS = 5_000_000;
export const PDF_TIMEOUT_MS = 120_000;

/** One positioned piece of text, as pdf.js reports it. */
export interface PdfTextItem {
  str: string;
  /** Left edge and baseline, in PDF points. */
  x: number;
  y: number;
  width: number;
  /** Font size (points). */
  size: number;
  /** Rotated or skewed text (e.g. a diagonal watermark). */
  rotated?: boolean;
  /** OCR word confidence (0–100). */
  confidence?: number;
}

export interface PdfPageText {
  width: number;
  items: PdfTextItem[];
  /** The page was read by OCR (Phase H). */
  ocr?: boolean;
  /** A scanned page OCR could not read; the reason is reported. */
  unreadable?: string;
}

interface PdfLine {
  text: string;
  /** A wide horizontal gap inside the line: columns or a table. */
  layout: boolean;
  /** OCR: the lowest word confidence on the line. */
  confidence?: number;
}

/** Rebuild a page's lines: items on the same baseline, left to right, lines top to bottom. */
export function pageLines(page: PdfPageText): { lines: PdfLine[]; rotatedSkipped: number } {
  let rotatedSkipped = 0;
  const items = page.items.filter((i) => {
    if (i.rotated) {
      if (i.str.trim()) rotatedSkipped++;
      return false;
    }
    return i.str.length > 0 && Number.isFinite(i.x) && Number.isFinite(i.y);
  });
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  const groups: PdfTextItem[][] = [];
  for (const item of items) {
    const line = groups[groups.length - 1];
    const tolerance = Math.max(2, 0.4 * Math.max(item.size, line?.[0]?.size ?? 0));
    if (line && Math.abs(line[0]!.y - item.y) <= tolerance) line.push(item);
    else groups.push([item]);
  }

  const wideGap = Math.max(60, 0.15 * (page.width || 595));
  const lines: PdfLine[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x - b.x);
    let text = "";
    let layout = false;
    let end = -Infinity;
    let confidence: number | undefined;
    for (const item of group) {
      if (typeof item.confidence === "number" && item.str.trim()) confidence = Math.min(confidence ?? 100, item.confidence);
      // pdf.js reports the space between two runs as a whitespace item spanning the gap:
      // it adds a space but does not move the end of the text, so wide gaps stay visible.
      if (!item.str.trim()) {
        if (text && !/\s$/.test(text)) text += " ";
        continue;
      }
      const gap = item.x - end;
      if (text) {
        if (gap > wideGap) layout = true;
        if (gap > 0.15 * (item.size || 10) && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
      }
      text += item.str;
      end = Math.max(end, item.x + Math.max(0, item.width));
    }
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) lines.push(confidence === undefined ? { text: clean, layout } : { text: clean, layout, confidence });
  }
  return { lines, rotatedSkipped };
}

const ENGINE_NOT_STARTED = "the OCR engine could not be started";

const PAGE_NUMBER = /^(?:page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
const headerKey = (text: string) => text.replace(/\d+/g, "#").toLowerCase();

/**
 * Pages → document body (pure). Page numbers and running headers/footers
 * (the same first or last line on most pages) are dropped — never a line
 * of the question format. A page without text becomes a marker that makes
 * the question around it NEEDS REVIEW.
 */
export function bodyFromPdfPages(pages: PdfPageText[]): { body: DocxBody; warnings: string[]; emptyPages: number[] } {
  const perPage = pages.map((p) => pageLines(p));
  const warnings: string[] = [];

  // Running headers/footers: identical (digits aside) first/last lines on at least 3 pages, or on every page of a 2-page file.
  const repeated = new Set<string>();
  const texted = perPage.filter((p) => p.lines.length > 0);
  if (texted.length >= 2) {
    const counts = new Map<string, number>();
    for (const p of texted) {
      const edges = new Set([p.lines[0]!.text, p.lines[p.lines.length - 1]!.text].map(headerKey));
      for (const k of edges) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const needed = texted.length === 2 ? 2 : Math.max(3, Math.ceil(texted.length / 2));
    for (const [k, n] of counts) if (n >= needed) repeated.add(k);
  }

  const blocks: DocxParagraph[] = [];
  const emptyPages: number[] = [];
  const ocrPages: number[] = [];
  const unreadable = new Map<string, number[]>();
  let dropped = 0;
  let rotated = 0;
  perPage.forEach((p, i) => {
    const pageNo = i + 1;
    const page = pages[i]!;
    rotated += p.rotatedSkipped;
    if (p.lines.length === 0) {
      // No text: a scanned page OCR did not read (or could not). The question around it needs review.
      if (page.unreadable) unreadable.set(page.unreadable, [...(unreadable.get(page.unreadable) ?? []), pageNo]);
      else emptyPages.push(pageNo);
      blocks.push({ kind: "p", index: blocks.length + 1, page: pageNo, text: "", numbered: false, flags: { scanned: true } });
      return;
    }
    if (page.ocr) ocrPages.push(pageNo);
    p.lines.forEach((line, j) => {
      const edge = j === 0 || j === p.lines.length - 1;
      if (edge && !isQuestionBlockLine(line.text) && (PAGE_NUMBER.test(line.text) || repeated.has(headerKey(line.text)))) {
        dropped++;
        return;
      }
      blocks.push({
        kind: "p",
        index: blocks.length + 1,
        page: pageNo,
        text: line.text,
        numbered: false,
        flags: line.layout ? { layout: true } : {},
        ...(page.ocr ? { ocr: true, confidence: line.confidence } : {}),
      });
    });
  });
  const list = (n: number[]) => (n.length > 10 ? `${n.slice(0, 10).join(", ")} and ${n.length - 10} more` : n.join(", "));
  const pagesWord = (n: number[]) => `Page${n.length === 1 ? "" : "s"} ${list(n)}`;
  if (dropped > 0) warnings.push("Page numbers and repeated page headers/footers were ignored.");
  if (rotated > 0) warnings.push("Rotated text (such as a watermark) was ignored.");
  if (ocrPages.length > 0) {
    warnings.push(`${pagesWord(ocrPages)} ${ocrPages.length === 1 ? "was" : "were"} scanned and read with OCR. Check every OCR question against its page before importing.`);
  }
  for (const [reason, n] of unreadable) {
    warnings.push(`${pagesWord(n)} could not be read by OCR (${reason}). Questions on ${n.length === 1 ? "it" : "them"} are missing or incomplete.`);
  }
  if (emptyPages.length > 0) {
    warnings.push(`${pagesWord(emptyPages)} ${emptyPages.length === 1 ? "has" : "have"} no selectable text (probably scanned) and ${emptyPages.length === 1 ? "was" : "were"} not read. OCR is not supported yet.`);
  }
  return { body: { blocks, trackedChanges: false }, warnings, emptyPages };
}

/**
 * Pages → import rows (pure). A file whose pages were all scanned is an
 * OCR import (source "pdf_ocr": every row needs review); in a mixed file
 * only the rows read by OCR do.
 */
export function rowsFromPdfPages(pages: PdfPageText[]): ParsedImportFile {
  const scannedOnly = pages.length > 0 && pages.every((p) => p.ocr || p.unreadable);
  const source = scannedOnly ? "pdf_ocr" : "pdf";
  const fail = (error: string): ParsedImportFile => ({ source, rows: [], fileErrors: [error], warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });
  const { body, warnings, emptyPages } = bodyFromPdfPages(pages);
  if (pages.length > 0 && emptyPages.length === pages.length) {
    return fail("This PDF has no selectable text — it looks like a scanned document or images only. Scanned PDFs are not supported yet (OCR is planned). Use a text PDF, for example the Word template saved as PDF.");
  }
  if (scannedOnly && pages.every((p) => p.unreadable === ENGINE_NOT_STARTED)) {
    return fail("OCR could not be started in this browser, so this scanned PDF was not read. Reload the page and try again, or use a text PDF (for example, the Word template saved as PDF).");
  }
  if (scannedOnly && pages.every((p) => p.unreadable)) {
    const reasons = Array.from(new Set(pages.map((p) => p.unreadable)));
    return fail(`OCR could not read this scanned PDF (${reasons.join("; ")}). Use a clearer scan (at least 300 dpi, straight, dark text), or a text PDF.`);
  }
  const parsed = rowsFromDocxBody(body, source);
  return { ...parsed, warnings: [...warnings, ...parsed.warnings] };
}

// ---------------------------------------------------------------------------
// File → rows (pdf.js)
// ---------------------------------------------------------------------------

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js, with its worker code run in this thread ("fake worker") — no worker file to host. Loaded only when a PDF is chosen. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs"); // sets globalThis.pdfjsWorker
    return (await import("pdfjs-dist/legacy/build/pdf.min.mjs")) as unknown as PdfJs;
  })();
  return pdfjsPromise;
}

class PdfReadError extends Error {}

const withTimeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new PdfReadError("This PDF took too long to read. It may be damaged or unusually complex."));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

const UNREADABLE = "This file could not be read as a PDF. It may be damaged or not a PDF — open it and save/export it as PDF again.";

class OcrTimeout extends Error {}

/** Resolve within `ms`, or reject with OcrTimeout (the step itself cannot be cancelled). */
const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OcrTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

export interface ParsePdfOptions {
  timeoutMs?: number;
  /** OCR for scanned pages. Default: the browser's (tesseract.js); none outside a browser. null: no OCR (Phase G behaviour). */
  ocr?: PdfOcrOptions | null;
  /** OCR progress: page `done` of `total` scanned pages. */
  onProgress?: (progress: { done: number; total: number; page: number }) => void;
  /** OCR time limits (default OCR_PAGE_TIMEOUT_MS / OCR_TOTAL_TIMEOUT_MS). */
  ocrPageTimeoutMs?: number;
  ocrTotalTimeoutMs?: number;
}

type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

/**
 * OCR the given pages (sequentially — one engine, bounded memory). Pages
 * that cannot be read get a reason; the file continues without them.
 */
async function ocrPages(doc: PdfDocument, pageNumbers: number[], ocr: PdfOcrOptions, options: ParsePdfOptions): Promise<Map<number, PdfPageText>> {
  const { onProgress } = options;
  const pageMs = options.ocrPageTimeoutMs ?? OCR_PAGE_TIMEOUT_MS;
  const totalMs = options.ocrTotalTimeoutMs ?? OCR_TOTAL_TIMEOUT_MS;
  const out = new Map<number, PdfPageText>();
  const unreadable = (n: number, reason: string) => out.set(n, { width: 0, items: [], unreadable: reason });
  let engine: OcrEngine;
  try {
    engine = await within(ocr.engine(), pageMs);
  } catch {
    for (const n of pageNumbers) unreadable(n, ENGINE_NOT_STARTED);
    return out;
  }
  const started = Date.now();
  let totalChars = 0;
  try {
    for (let i = 0; i < pageNumbers.length; i++) {
      const n = pageNumbers[i]!;
      onProgress?.({ done: i, total: pageNumbers.length, page: n });
      if (Date.now() - started > totalMs) {
        for (const rest of pageNumbers.slice(i)) unreadable(rest, "the OCR time limit for one file was reached");
        break;
      }
      let image: OcrImage | null = null;
      try {
        const page = await doc.getPage(n);
        image = await within(ocr.render(page as unknown as RenderablePage), pageMs);
        const result = await within(engine.recognize(image), pageMs);
        page.cleanup();
        const size = ocrOutputSize(result);
        if (size.words > OCR_MAX_WORDS_PER_PAGE || size.chars > OCR_MAX_CHARS_PER_PAGE) {
          unreadable(n, "far more text than a question page");
          continue;
        }
        totalChars += size.chars;
        if (totalChars > OCR_MAX_TOTAL_CHARS) throw new PdfReadError("OCR produced too much text for one import. Split the scanned PDF into smaller files.");
        const text = pageTextFromOcr(result);
        if (text.items.length === 0) unreadable(n, "no text was recognised");
        else out.set(n, text);
      } catch (err) {
        if (err instanceof PdfReadError) throw err;
        if (err instanceof OcrTimeout) {
          // A stuck step cannot be interrupted: stop OCR for this file.
          for (const rest of pageNumbers.slice(i)) unreadable(rest, rest === n ? "it took too long" : "OCR stopped after a page took too long");
          break;
        }
        unreadable(n, "the page image could not be read");
      } finally {
        image?.release?.();
      }
    }
    onProgress?.({ done: pageNumbers.length, total: pageNumbers.length, page: pageNumbers[pageNumbers.length - 1] ?? 0 });
  } finally {
    await engine.terminate().catch(() => undefined);
  }
  return out;
}

export async function parsePdf(data: ArrayBuffer, options: ParsePdfOptions = {}): Promise<ParsedImportFile> {
  const empty = (error: string): ParsedImportFile => ({ source: "pdf", rows: [], fileErrors: [error], warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });
  const tooBig = checkFileSize("pdf", data.byteLength);
  if (tooBig) return empty(tooBig);

  // A copy: pdf.js takes ownership of (detaches) the buffer it is given.
  const bytes = new Uint8Array(data.slice(0));
  const scan = await scanPdf(bytes);
  if (!scan.ok) {
    if (scan.reason === "not_pdf") return empty(UNREADABLE);
    return empty("This PDF expands to far more data than a question paper needs, so it was not read (a safety limit). Save it again as a normal PDF and try again.");
  }

  const ocr = options.ocr === undefined ? browserOcr() : options.ocr;
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    verbosity: 0,
    // Only used when scanned pages are drawn for OCR: bounded image decoding, self-hosted decoders.
    ...(ocr ? { maxImageSize: OCR_MAX_PDF_IMAGE_PIXELS, ...(ocr.pdfjsWasmUrl ? { wasmUrl: ocr.pdfjsWasmUrl } : {}) } : {}),
  });
  const destroy = () => {
    task.destroy().catch(() => undefined);
  };

  try {
    const { doc, pages } = await withTimeout(
      (async () => {
        const doc = await task.promise;
        const { info } = (await doc.getMetadata()) as { info: { EncryptFilterName?: string | null } };
        if (info?.EncryptFilterName) {
          throw new PdfReadError("This PDF is encrypted (it has a password or restrictions on copying/printing). Save an unprotected copy — for example, remove the security in your PDF tool or export it again from Word — and try again.");
        }
        if (doc.numPages > PDF_MAX_PAGES) throw new PdfReadError(`This PDF has ${doc.numPages} pages; the limit is ${PDF_MAX_PAGES}. Split it into smaller files.`);
        const out: PdfPageText[] = [];
        let chars = 0;
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          const items: PdfTextItem[] = [];
          for (const raw of content.items) {
            if (!("str" in raw)) continue;
            const [a, b, c, d, e, f] = raw.transform as number[];
            chars += raw.str.length;
            items.push({
              str: raw.str,
              x: e!,
              y: f!,
              width: raw.width,
              size: Math.hypot(c!, d!) || raw.height || 10,
              rotated: Math.abs(b!) > 1e-3 * Math.abs(a!) || Math.abs(c!) > 1e-3 * Math.abs(d!),
            });
          }
          if (chars > PDF_MAX_TEXT_CHARS) throw new PdfReadError("This PDF contains too much text to import at once. Split it into smaller files.");
          const [x1 = 0, , x2 = 595] = page.view;
          out.push({ width: Math.abs(x2 - x1), items });
          page.cleanup();
        }
        return { doc, pages: out };
      })(),
      options.timeoutMs ?? PDF_TIMEOUT_MS,
      destroy
    );

    // Scanned pages (no selectable text): OCR them when available (Phase H); otherwise Phase G behaviour.
    const scanned = pages.map((p, i) => (p.items.some((it) => it.str.trim() && !it.rotated) ? 0 : i + 1)).filter((n) => n > 0);
    if (ocr && scanned.length > 0) {
      if (scanned.length > OCR_MAX_PAGES) {
        return empty(`This PDF has ${scanned.length} scanned pages; OCR can read at most ${OCR_MAX_PAGES} scanned pages per file. Split it into smaller files.`);
      }
      const read = await ocrPages(doc, scanned, ocr, options);
      for (const [n, page] of read) pages[n - 1] = page;
    }
    return rowsFromPdfPages(pages);
  } catch (err) {
    if (err instanceof PdfReadError) return empty(err.message);
    const name = err && typeof err === "object" && "name" in err ? String((err as { name?: unknown }).name) : "";
    if (name === "PasswordException") {
      return empty("This PDF is password-protected. Remove the password (save an unprotected copy) and try again.");
    }
    return empty(UNREADABLE);
  } finally {
    destroy();
  }
}
