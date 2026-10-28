import { test } from "node:test";
import assert from "node:assert/strict";
import { core, context, row, codes, Q_DRAFT } from "./helpers.mjs";

const { planChunks, runChunks, validateRow, IMPORT_CHUNK_MAX_BYTES } = core;
const rows = (n, start = 2) => Array.from({ length: n }, (_, i) => row(start + i));
const okOutcome = (chunk, runId = "run") => ({
  ok: true,
  data: {
    runId,
    rows: chunk.map((r) => ({ rowNumber: r.rowNumber, outcome: "created", questionId: `q${r.rowNumber}` })),
    created: chunk.length,
    updated: 0,
    run: { id: runId, createdCount: 0 },
  },
});
const noDelay = async () => {};

// ---- planChunks ----
test("planChunks: at most 100 rows per chunk, row order and numbers preserved", () => {
  const chunks = planChunks(rows(250).reverse());
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.deepEqual(chunks.flat().map((r) => r.rowNumber), Array.from({ length: 250 }, (_, i) => i + 2));
});
test("planChunks: a smaller maxRows is honoured; larger than 100 is capped", () => {
  assert.deepEqual(planChunks(rows(10), { maxRows: 4 }).map((c) => c.length), [4, 4, 2]);
  assert.deepEqual(planChunks(rows(150), { maxRows: 500 }).map((c) => c.length), [100, 50]);
});
test("planChunks: splits by request size (large rows) under the 1 MB server-action limit", () => {
  const big = Array.from({ length: 100 }, (_, i) => row(i + 2, { questionText: "x".repeat(5000), explanation: "e".repeat(5000), options: Array.from({ length: 10 }, (_, k) => `${"o".repeat(990)}${k}`) }));
  const chunks = planChunks(big);
  assert.ok(chunks.length > 1, "split by size");
  for (const c of chunks) assert.ok(new TextEncoder().encode(JSON.stringify(c)).length <= IMPORT_CHUNK_MAX_BYTES, "each chunk within the byte budget");
  assert.equal(chunks.flat().length, 100);
});
test("planChunks: empty input", () => {
  assert.deepEqual(planChunks([]), []);
});

// ---- runChunks ----
test("runChunks: sends every chunk in order and totals the outcomes", async () => {
  const sent = [];
  const progress = [];
  const result = await runChunks({
    chunks: planChunks(rows(250)),
    send: async (chunk) => { sent.push(chunk.map((r) => r.rowNumber)); return okOutcome(chunk); },
    onProgress: (p) => progress.push(p.chunkIndex),
    delay: noDelay,
  });
  assert.equal(result.created, 250);
  assert.equal(result.chunksSent, 3);
  assert.equal(result.stopped, null);
  assert.deepEqual(progress, [0, 1, 2]);
  assert.deepEqual(sent[0][0], 2);
  assert.equal(result.rows.length, 250);
});
test("runChunks: resume skips rows already done (and whole chunks when all done)", async () => {
  const sent = [];
  const result = await runChunks({
    chunks: planChunks(rows(250)),
    doneRowNumbers: Array.from({ length: 150 }, (_, i) => i + 2), // rows 2..151 done
    send: async (chunk) => { sent.push(chunk.map((r) => r.rowNumber)); return okOutcome(chunk); },
    delay: noDelay,
  });
  assert.equal(result.chunksSkipped, 1);
  assert.deepEqual(sent.map((s) => s.length), [50, 50]);
  assert.equal(sent[0][0], 152);
  assert.equal(result.created, 100);
});
test("runChunks: a retryable failure is retried, then succeeds", async () => {
  let calls = 0;
  const result = await runChunks({
    chunks: [rows(3)],
    send: async (chunk) => (++calls < 3 ? { ok: false, error: "The database is busy.", retryable: true } : okOutcome(chunk)),
    delay: noDelay,
  });
  assert.equal(calls, 3);
  assert.equal(result.stopped, null);
  assert.equal(result.created, 3);
});
test("runChunks: a thrown network error counts as retryable", async () => {
  let calls = 0;
  const result = await runChunks({
    chunks: [rows(2)],
    send: async (chunk) => { if (++calls === 1) throw new TypeError("fetch failed"); return okOutcome(chunk); },
    delay: noDelay,
  });
  assert.equal(calls, 2);
  assert.equal(result.created, 2);
});
test("runChunks: retries are bounded (maxAttempts), then it stops", async () => {
  let calls = 0;
  const result = await runChunks({ chunks: [rows(2), rows(2, 10)], send: async () => { calls++; return { ok: false, error: "timeout", retryable: true }; }, maxAttempts: 3, delay: noDelay });
  assert.equal(calls, 3);
  assert.deepEqual(result.stopped, { chunkIndex: 0, error: "timeout", retryable: true });
});
test("runChunks: a non-retryable error stops immediately (never retried)", async () => {
  let calls = 0;
  const result = await runChunks({
    chunks: [rows(2), rows(2, 10)],
    send: async () => { calls++; return { ok: false, error: "This import is no longer in progress.", retryable: false }; },
    delay: noDelay,
  });
  assert.equal(calls, 1);
  assert.equal(result.stopped.retryable, false);
  assert.equal(result.chunksSent, 0);
});
test("runChunks: rows skipped/rejected by the server are not treated as done", async () => {
  const result = await runChunks({
    chunks: [rows(2)],
    send: async (chunk) => ({
      ok: true,
      data: { runId: "r", created: 1, updated: 0, run: {}, rows: [{ rowNumber: chunk[0].rowNumber, outcome: "created", questionId: "q" }, { rowNumber: chunk[1].rowNumber, outcome: "rejected", reason: "duplicate", questionId: null }] },
    }),
    delay: noDelay,
  });
  assert.equal(result.created, 1);
  assert.deepEqual(result.rows.map((r) => r.outcome), ["created", "rejected"]);
});

// ---- expectedRevision (server re-validation input) ----
test("expectedRevision: equal to the current revision → UPDATE", () => {
  const r = validateRow(row(2, { questionId: Q_DRAFT, expectedRevision: 3 }), context());
  assert.equal(r.status, "UPDATE");
  assert.equal(r.expectedRevision, 3);
});
test("expectedRevision: different from the current revision → revision_conflict ERROR", () => {
  const r = validateRow(row(2, { questionId: Q_DRAFT, expectedRevision: 2 }), context());
  assert.equal(r.status, "ERROR");
  assert.deepEqual(codes(r), ["revision_conflict"]);
  assert.match(r.issues[0].message, /revision 2 → 3/);
});
