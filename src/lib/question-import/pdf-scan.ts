/**
 * Bulk import — PDF pre-scan (pure; browser and Node), run before the PDF
 * is handed to pdf.js. It is the "zip bomb" safeguard for PDF: every
 * Flate-compressed stream that text extraction may decode (content
 * streams, fonts, object streams — not images, which are never decoded
 * for text) is inflated here with the platform's DecompressionStream and
 * counted; a file that expands past the limit is refused before pdf.js
 * decodes anything.
 */

/** Largest total of decompressed (non-image) stream data accepted. */
export const PDF_INFLATE_TOTAL_MAX = 150 * 1024 * 1024;
/** Largest single decompressed stream accepted. */
export const PDF_INFLATE_STREAM_MAX = 60 * 1024 * 1024;
/** More streams than this is refused (no normal question paper comes close). */
export const PDF_STREAM_COUNT_MAX = 200_000;

export type PdfScanResult = { ok: true; streams: number; inflatedBytes: number } | { ok: false; reason: "not_pdf" | "too_large_inflated" | "too_many_streams" };

/** Input is fed in slices: deflate expands at most ~1,032×, so a slice can never hide more than ~17 MB of output. */
const FEED_SLICE = 16 * 1024;

/**
 * Inflate zlib data, counting bytes; stops at `limit`. Returns the byte
 * count, or -1 when over the limit. Damaged data counts what was read.
 * The data is fed slice by slice while the output is counted: a browser's
 * DecompressionStream discards the output of a chunk that ends in junk
 * (e.g. bytes after the compressed data), so feeding it all at once could
 * let such a stream pass uncounted.
 */
async function inflatedSize(data: Uint8Array, limit: number): Promise<number> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  (async () => {
    for (let i = 0; i < data.length; i += FEED_SLICE) await writer.write(data.subarray(i, i + FEED_SLICE) as BufferSource);
    await writer.close();
  })().catch(() => undefined);
  const reader = stream.readable.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return -1;
      }
    }
  } catch {
    // Damaged or not really Flate data: pdf.js decides what to do with it.
  }
  return total;
}

export async function scanPdf(bytes: Uint8Array): Promise<PdfScanResult> {
  const text = new TextDecoder("latin1").decode(bytes);
  const header = text.indexOf("%PDF-");
  if (header < 0 || header > 1024) return { ok: false, reason: "not_pdf" };

  let streams = 0;
  let total = 0;
  let at = 0;
  for (;;) {
    const keyword = text.indexOf("stream", at);
    if (keyword < 0) break;
    at = keyword + 6;
    // "stream" as a keyword: preceded by the dictionary's ">>" and followed by an end of line (not "endstream").
    if (text.startsWith("end", keyword - 3)) continue;
    const before = text.slice(Math.max(0, keyword - 4), keyword).trimEnd();
    if (!before.endsWith(">>")) continue;
    let start = keyword + 6;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    else if (text[start - 1] !== "\r") continue;
    streams++;
    if (streams > PDF_STREAM_COUNT_MAX) return { ok: false, reason: "too_many_streams" };

    const objStart = text.lastIndexOf(" obj", keyword);
    const dict = text.slice(objStart >= 0 && keyword - objStart < 65_536 ? objStart : Math.max(0, keyword - 4096), keyword);
    const end = text.indexOf("endstream", start);
    let dataEnd = end < 0 ? text.length : end;
    while (dataEnd > start && (text[dataEnd - 1] === "\n" || text[dataEnd - 1] === "\r")) dataEnd--; // the EOL before "endstream"
    at = Math.max(at, dataEnd);
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue;
    if (!/\/Filter\s*(?:\[\s*)?\/(?:FlateDecode|Fl)\b/.test(dict)) continue;

    const size = await inflatedSize(bytes.subarray(start, dataEnd), Math.min(PDF_INFLATE_STREAM_MAX, PDF_INFLATE_TOTAL_MAX - total));
    if (size < 0) return { ok: false, reason: "too_large_inflated" };
    total += size;
  }
  return { ok: true, streams, inflatedBytes: total };
}
