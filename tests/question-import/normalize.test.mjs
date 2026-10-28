import { test } from "node:test";
import assert from "node:assert/strict";
import { core, VECTORS } from "./helpers.mjs";

const { cleanText, fingerprintNormalize, compareCodePoints, parseUuid, normalizeCode, parseQuestionType, parseMarks, parseStatus } = core;

// ---- fingerprintNormalize: must equal public.question_import_normalize (0013) ----
test("normalize: every PostgreSQL vector (text) matches 0013 exactly", () => {
  for (const v of VECTORS) assert.equal(fingerprintNormalize(v.text), v.expected.normalizedText, v.name);
});
test("normalize: every PostgreSQL vector (options) matches 0013 exactly", () => {
  for (const v of VECTORS) assert.deepEqual(v.options.map(fingerprintNormalize), v.expected.normalizedOptions, v.name);
});
test("normalize: NFKC folds compatibility characters", () => {
  assert.equal(fingerprintNormalize("ＦＬＯＷ ﬁeld m² Ⅻ"), "flow field m2 xii");
});
test("normalize: combining accent equals precomposed", () => {
  assert.equal(fingerprintNormalize("Café"), fingerprintNormalize("Café"));
});
test("normalize: only ASCII A–Z is lower-cased (collation-independent)", () => {
  assert.equal(fingerprintNormalize("ÄRGER ÉTÉ ΣIGMA"), "Ärger ÉtÉ Σigma");
});
test("normalize: whitespace and control runs collapse to one space, ends trimmed", () => {
  assert.equal(fingerprintNormalize("  a\t\t b\r\n\nc\u0007\u007Fd  "), "a b c d");
  assert.equal(fingerprintNormalize("a  b"), "a b", "NBSP / em space become spaces through NFKC");
});
test("normalize: zero-width space is NOT whitespace (same as 0013)", () => {
  assert.equal(fingerprintNormalize("a​b"), "a​b");
});
test("normalize: empty and null", () => {
  assert.equal(fingerprintNormalize(""), "");
  assert.equal(fingerprintNormalize(null), "");
  assert.equal(fingerprintNormalize("   \t "), "");
});

// ---- compareCodePoints (= COLLATE "C" / UTF-8 byte order) ----
test("code point order differs from UTF-16 order for astral characters", () => {
  const values = ["😀", "", "zeta", "Ω"];
  assert.deepEqual([...values].sort(compareCodePoints), ["zeta", "Ω", "", "😀"]);
  assert.deepEqual([...values].sort(), ["zeta", "Ω", "😀", ""], "plain JS sort would disagree with PostgreSQL");
});
test("code point order: prefixes first, equal strings 0", () => {
  assert.equal(compareCodePoints("ab", "abc"), -1);
  assert.equal(compareCodePoints("abc", "ab"), 1);
  assert.equal(compareCodePoints("x", "x"), 0);
});

// ---- cleanText (stored text) ----
test("cleanText: trims, keeps inner newlines, CRLF to LF, tabs/controls to spaces, NFC", () => {
  assert.equal(cleanText("  line1\r\nline2\rline3  "), "line1\nline2\nline3");
  assert.equal(cleanText("a\tb\u0007c\u0000d"), "a b c d");
  assert.equal(cleanText("Café"), "Café");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText(12.5), "12.5");
});
test("cleanText keeps fingerprints stable (control char becomes a space, as 0013 would collapse it)", () => {
  assert.equal(fingerprintNormalize(cleanText("a\u0007b")), fingerprintNormalize("a\u0007b"));
});

// ---- ids / codes ----
test("parseUuid: canonical lowercase or null", () => {
  assert.equal(parseUuid(" DDDDDDDD-0000-4000-8000-000000000001 "), "dddddddd-0000-4000-8000-000000000001");
  for (const bad of ["", "123", "dddddddd-0000-4000-8000-00000000000", "not-a-uuid", "{dddddddd-0000-4000-8000-000000000001}", null]) assert.equal(parseUuid(bad), null, String(bad));
});
test("normalizeCode: case and spaces ignored", () => {
  assert.equal(normalizeCode("  spi-101 "), "SPI-101");
});

// ---- question type ----
test("question type: the three types in any case / separator", () => {
  for (const [input, type] of [["single_choice", "single_choice"], ["Single Choice", "single_choice"], ["MULTIPLE-CHOICE", "multiple_choice"], ["multiple choice", "multiple_choice"], ["True/False", "true_false"], ["true_false", "true_false"], ["TRUE FALSE", "true_false"]]) {
    assert.deepEqual(parseQuestionType(input), { ok: true, type }, input);
  }
});
test("question type: missing vs invalid; no guessing of other names", () => {
  assert.deepEqual(parseQuestionType(""), { ok: false, reason: "missing" });
  assert.deepEqual(parseQuestionType(null), { ok: false, reason: "missing" });
  for (const bad of ["MCQ", "TF", "single", "choice", "essay", "matching", "fill_in_the_blank", "numerical", "multiple_choices"]) {
    assert.deepEqual(parseQuestionType(bad), { ok: false, reason: "invalid" }, bad);
  }
});

// ---- marks ----
test("marks: valid values", () => {
  for (const [input, marks] of [["1", 1], ["1.5", 1.5], ["0.25", 0.25], [2, 2], [0.5, 0.5], ["9999.99", 9999.99], ["01.50", 1.5], ["3.10", 3.1], [" 4 ", 4]]) {
    assert.deepEqual(parseMarks(input), { ok: true, marks }, String(input));
  }
});
test("marks: missing is an error and is never defaulted", () => {
  for (const blank of [null, undefined, "", "   "]) {
    const r = parseMarks(blank);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing", String(blank));
  }
});
test("marks: invalid values are refused, not repaired", () => {
  for (const bad of ["0", 0, "-1", -2, "1,5", "1.234", "10000", 10000, "abc", "2 marks", "1e2", 1e-7, ".5", "5.", "+3", Number.NaN, Infinity, "½", "１"]) {
    const r = parseMarks(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.reason, "invalid", String(bad));
  }
});
test("marks: boundary 9999.99 ok, 9999.991 refused, 0.01 ok", () => {
  assert.equal(parseMarks("9999.99").ok, true);
  assert.equal(parseMarks("9999.991").ok, false);
  assert.equal(parseMarks("0.01").ok, true);
});

// ---- status column ----
test("status: draft/active/archived recognised (any case); blank fine; others unrecognised", () => {
  assert.deepEqual(parseStatus(""), { requested: null, recognised: true, raw: "" });
  assert.deepEqual(parseStatus("Active"), { requested: "active", recognised: true, raw: "Active" });
  assert.deepEqual(parseStatus("ARCHIVED"), { requested: "archived", recognised: true, raw: "ARCHIVED" });
  assert.deepEqual(parseStatus("draft"), { requested: "draft", recognised: true, raw: "draft" });
  assert.equal(parseStatus("published").recognised, false);
});
