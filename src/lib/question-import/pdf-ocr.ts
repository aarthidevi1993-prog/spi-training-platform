/**
 * Bulk import — OCR for scanned PDF pages (Phase H), in the browser.
 *
 * A page with no selectable text is drawn to a canvas with pdf.js and read
 * with Tesseract (tesseract.js, WebAssembly). Everything runs locally: the
 * engine, its worker and the English language data are served by this app
 * from /ocr/ (scripts/copy-ocr-assets.mjs) — never from a CDN or a cloud
 * OCR service — and the page images exist only in memory.
 *
 * OCR words become the same positioned text items as a text PDF, so line
 * rebuilding, the question-block reader and validation are shared with
 * Phase G. OCR text is never corrected: every OCR question is NEEDS REVIEW
 * until the reviewer confirms it against its page, and low-confidence key
 * lines (answer, marks, options, codes) stay NEEDS REVIEW regardless.
 */
import type { PdfPageText, PdfTextItem } from "./pdf";

/** Scanned pages OCR reads per file. */
export const OCR_MAX_PAGES = 100;
/** Rendering resolution for OCR, capped by OCR_MAX_PIXELS. */
export const OCR_DPI = 300;
/** Largest page image (pixels) — about A4 at 350 dpi; bounds memory per page. */
export const OCR_MAX_PIXELS = 12_000_000;
/** Largest image inside a PDF page that pdf.js will decode while rendering (pixels). */
export const OCR_MAX_PDF_IMAGE_PIXELS = 100_000_000;
/** Time limits: per step (render or recognise one page) and for all OCR in a file. */
export const OCR_PAGE_TIMEOUT_MS = 90_000;
export const OCR_TOTAL_TIMEOUT_MS = 20 * 60_000;
/** Output limits (a page of questions has a few hundred words). */
export const OCR_MAX_WORDS_PER_PAGE = 10_000;
export const OCR_MAX_CHARS_PER_PAGE = 60_000;
export const OCR_MAX_TOTAL_CHARS = 2_000_000;

/** One recognised word; box in image pixels (y grows downwards); confidence 0–100. */
export interface OcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  /** Baseline height in image pixels (y grows downwards), when the engine reports one. */
  baseline?: number;
  words: OcrWord[];
}

export interface OcrPageResult {
  width: number;
  height: number;
  lines: OcrLine[];
}

/** A rendered page. `release` frees its memory once it has been read. */
export interface OcrImage {
  width: number;
  height: number;
  image: unknown;
  release?: () => void;
}

export interface OcrEngine {
  recognize(image: OcrImage): Promise<OcrPageResult>;
  terminate(): Promise<void>;
}

/** The part of a pdf.js page the renderer uses. */
export interface RenderablePage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: Record<string, unknown>): { promise: Promise<unknown> };
}

export interface PdfOcrOptions {
  /** Starts the OCR engine (only when a PDF has scanned pages). */
  engine: () => Promise<OcrEngine>;
  /** Draws a page as an image for the engine. */
  render: (page: RenderablePage) => Promise<OcrImage>;
  /** Where pdf.js finds its image decoders (JPEG 2000, JBIG2) for scanned pages. */
  pdfjsWasmUrl?: string;
}

/** OCR output → positioned text items (pure). Words on one engine line share its baseline. */
export function pageTextFromOcr(result: OcrPageResult): PdfPageText {
  const items: PdfTextItem[] = [];
  for (const line of result.lines) {
    const words = line.words.filter((w) => w.text.trim() && Number.isFinite(w.x0) && Number.isFinite(w.y1));
    if (words.length === 0) continue;
    const baseline = typeof line.baseline === "number" && Number.isFinite(line.baseline) ? line.baseline : Math.max(...words.map((w) => w.y1));
    const size = Math.max(1, ...words.map((w) => w.y1 - w.y0));
    for (const w of words) {
      items.push({
        str: w.text,
        x: w.x0,
        y: result.height - baseline,
        width: Math.max(0, w.x1 - w.x0),
        size,
        confidence: Math.max(0, Math.min(100, w.confidence)),
      });
    }
  }
  return { width: result.width, items, ocr: true };
}

export function ocrOutputSize(result: OcrPageResult): { words: number; chars: number } {
  let words = 0;
  let chars = 0;
  for (const line of result.lines) {
    words += line.words.length;
    for (const w of line.words) chars += w.text.length;
  }
  return { words, chars };
}

/** The shape of tesseract.js's `blocks` output that is used here. */
interface TesseractBlocks {
  blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ baseline?: { y0: number; y1: number }; words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }> }> | null;
}

/** tesseract.js result → OcrPageResult (pure). */
export function fromTesseract(data: TesseractBlocks, width: number, height: number): OcrPageResult {
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          baseline: line.baseline ? Math.max(line.baseline.y0, line.baseline.y1) : undefined,
          words: (line.words ?? []).map((w) => ({ text: w.text, confidence: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })),
        });
      }
    }
  }
  return { width, height, lines };
}

// ---------------------------------------------------------------------------
// Browser engine (tesseract.js) and renderer (canvas)
// ---------------------------------------------------------------------------

/** OCR in this browser, or null where there is no DOM (e.g. Node). */
export function browserOcr(): PdfOcrOptions | null {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof Worker === "undefined" || typeof WebAssembly === "undefined") return null;
  const abs = (path: string) => new URL(path, window.location.origin).href;
  return {
    pdfjsWasmUrl: abs("/ocr/pdfjs/"),
    async engine() {
      // tesseract.js never settles createWorker() when its language data fails to load, so check
      // the self-hosted files first and fail fast with a clear reason (never falls back to a CDN).
      for (const file of ["/ocr/worker.min.js", "/ocr/lang/eng.traineddata.gz"]) {
        const res = await fetch(abs(file), { method: "HEAD", cache: "no-store" }).catch(() => null);
        if (!res?.ok) throw new Error(`OCR file unavailable: ${file}`);
      }
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: abs("/ocr/worker.min.js"),
        corePath: abs("/ocr/core/"),
        langPath: abs("/ocr/lang"),
        gzip: true,
        cacheMethod: "none",
        workerBlobURL: false,
        logger: () => undefined,
        errorHandler: () => undefined,
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: String(OCR_DPI) });
      return {
        async recognize(img) {
          const { data } = await worker.recognize(img.image as HTMLCanvasElement, {}, { blocks: true, text: false });
          return fromTesseract(data as unknown as TesseractBlocks, img.width, img.height);
        },
        async terminate() {
          await worker.terminate();
        },
      };
    },
    async render(page) {
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(OCR_DPI / 72, Math.sqrt(OCR_MAX_PIXELS / Math.max(1, base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no canvas");
      await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
      return {
        width: canvas.width,
        height: canvas.height,
        image: canvas,
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}
