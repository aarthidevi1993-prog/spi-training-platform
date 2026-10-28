/**
 * Bulk import — chunk planning and the sequential, resumable chunk runner.
 * Pure: the caller supplies `send` (the import-chunk server action). The
 * database (0013) owns each chunk's transaction; this only decides what
 * to send, in which order, and when a failure may be retried.
 */
import { IMPORT_CHUNK_SIZE, type ImportActionResult, type ImportChunkOutcome, type ImportRowOutcome, type RawImportRow } from "@/types/question-import";

/** Stay well below Next.js's 1 MB server-action request limit. */
export const IMPORT_CHUNK_MAX_BYTES = 700_000;

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Split rows (in row-number order) into chunks of at most `maxRows` rows
 * and about `maxBytes` of JSON. Row numbers are preserved.
 */
export function planChunks(rows: RawImportRow[], options: { maxRows?: number; maxBytes?: number } = {}): RawImportRow[][] {
  const maxRows = Math.min(options.maxRows ?? IMPORT_CHUNK_SIZE, IMPORT_CHUNK_SIZE);
  const maxBytes = options.maxBytes ?? IMPORT_CHUNK_MAX_BYTES;
  const chunks: RawImportRow[][] = [];
  let current: RawImportRow[] = [];
  let size = 2;
  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    const rowSize = byteLength(row) + 1;
    if (current.length > 0 && (current.length >= maxRows || size + rowSize > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(row);
    size += rowSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface RunChunksResult {
  /** Every row outcome reported so far, in row order. */
  rows: ImportRowOutcome[];
  created: number;
  updated: number;
  chunksSent: number;
  chunksSkipped: number;
  /** Set when the run stopped early (a non-retryable error, or retries exhausted). */
  stopped: { chunkIndex: number; error: string; retryable: boolean } | null;
  lastRun: ImportChunkOutcome["run"] | null;
}

export interface RunChunksOptions {
  chunks: RawImportRow[][];
  send: (rows: RawImportRow[]) => Promise<ImportActionResult<ImportChunkOutcome>>;
  /** Rows already written in this run (from the resume state): never re-sent. */
  doneRowNumbers?: Iterable<number>;
  /** Attempts per chunk for retryable failures only (default 3). */
  maxAttempts?: number;
  /** Wait before retry n (default: 500 ms × n). */
  delay?: (attempt: number) => Promise<void>;
  onProgress?: (progress: { chunkIndex: number; chunks: number; outcome: ImportChunkOutcome }) => void;
}

const defaultDelay = (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt));

/**
 * Send chunks one at a time, in order. A retryable failure (network,
 * timeout, busy database) is retried up to `maxAttempts`; a
 * non-retryable one (validation, permission, run no longer in progress)
 * stops immediately — nothing is retried indefinitely. Rows already done
 * are skipped, so running again after an interruption resumes safely
 * (the database also reports such rows as already_done).
 */
export async function runChunks(options: RunChunksOptions): Promise<RunChunksResult> {
  const done = new Set(options.doneRowNumbers ?? []);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delay = options.delay ?? defaultDelay;
  const result: RunChunksResult = { rows: [], created: 0, updated: 0, chunksSent: 0, chunksSkipped: 0, stopped: null, lastRun: null };

  for (let index = 0; index < options.chunks.length; index++) {
    const rows = (options.chunks[index] ?? []).filter((r) => !done.has(r.rowNumber));
    if (rows.length === 0) {
      result.chunksSkipped += 1;
      continue;
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: ImportActionResult<ImportChunkOutcome>;
      try {
        response = await options.send(rows);
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : "The request failed.", retryable: true };
      }
      if (response.ok) {
        const outcome = response.data;
        result.chunksSent += 1;
        result.rows.push(...outcome.rows);
        result.created += outcome.created;
        result.updated += outcome.updated;
        result.lastRun = outcome.run;
        for (const r of outcome.rows) if (r.outcome !== "skipped" && r.outcome !== "rejected") done.add(r.rowNumber);
        options.onProgress?.({ chunkIndex: index, chunks: options.chunks.length, outcome });
        break;
      }
      if (!response.retryable || attempt >= maxAttempts) {
        result.stopped = { chunkIndex: index, error: response.error, retryable: response.retryable };
        result.rows.sort((a, b) => a.rowNumber - b.rowNumber);
        return result;
      }
      await delay(attempt);
    }
  }
  result.rows.sort((a, b) => a.rowNumber - b.rowNumber);
  return result;
}
