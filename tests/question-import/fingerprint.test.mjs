import { test } from "node:test";
import assert from "node:assert/strict";
import { core, VECTORS, C1, C2 } from "./helpers.mjs";

const { questionFingerprint, textFingerprint, sha256Hex, questionFingerprintInput } = core;

test("sha256Hex: standard test vector", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("fingerprint: every PostgreSQL vector matches public.question_import_fingerprint (0013)", async () => {
  for (const v of VECTORS) {
    assert.equal(await questionFingerprint(v.courseId, v.type, v.text, v.options), v.expected.fingerprint, v.name);
  }
});

test("text fingerprint: every PostgreSQL vector matches public.question_import_text_fingerprint (0013)", async () => {
  for (const v of VECTORS) {
    assert.equal(await textFingerprint(v.courseId, v.text), v.expected.textFingerprint, v.name);
  }
});

test("fingerprint input: documented layout (course ␞ type ␞ text ␞ sorted options joined by ␟)", () => {
  assert.equal(
    questionFingerprintInput("AAAAAAAA-0000-4000-8000-000000000000", "single_choice", " Hello  World ", ["b", "A"]),
    "aaaaaaaa-0000-4000-8000-000000000000\u001esingle_choice\u001ehello world\u001ea\u001fb"
  );
});

test("fingerprint ignores option order, case and spacing", async () => {
  const a = await questionFingerprint(C1, "single_choice", "What is FT?", ["Flow transmitter", "Flow switch"]);
  const b = await questionFingerprint(C1, "single_choice", "  what IS  ft? ", ["FLOW SWITCH", "flow   transmitter"]);
  assert.equal(a, b);
});

test("fingerprint does not include the correct answer or marks (only content)", async () => {
  // The function has no answer/marks inputs at all: same text+options => same fingerprint.
  assert.equal(questionFingerprint.length, 4);
});

test("fingerprint differs by course, type and options", async () => {
  const base = await questionFingerprint(C1, "single_choice", "Q", ["A", "B"]);
  assert.notEqual(base, await questionFingerprint(C2, "single_choice", "Q", ["A", "B"]));
  assert.notEqual(base, await questionFingerprint(C1, "multiple_choice", "Q", ["A", "B"]));
  assert.notEqual(base, await questionFingerprint(C1, "single_choice", "Q", ["A", "C"]));
  assert.notEqual(base, await questionFingerprint(C1, "single_choice", "Q", ["A", "B", "C"]));
});

test("course id case does not matter (uuid text is lowercase in PostgreSQL)", async () => {
  assert.equal(await questionFingerprint(C1.toUpperCase(), "true_false", "Q", ["True", "False"]), await questionFingerprint(C1, "true_false", "Q", ["True", "False"]));
});

test("text fingerprint ignores options and type", async () => {
  assert.equal(await textFingerprint(C1, "What is FT?"), await textFingerprint(C1, " what is  FT? "));
  assert.notEqual(await textFingerprint(C1, "What is FT?"), await textFingerprint(C2, "What is FT?"));
});

test("fingerprints are 64 lowercase hex characters", async () => {
  assert.match(await questionFingerprint(C1, "single_choice", "x", ["a", "b"]), /^[0-9a-f]{64}$/);
  assert.match(await textFingerprint(C1, "x"), /^[0-9a-f]{64}$/);
});
