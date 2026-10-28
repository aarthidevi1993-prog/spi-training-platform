import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mjs";

const { parseOptions, parseCorrectAnswer } = core;
const codes = (r) => r.issues.map((i) => i.code);
const LETTERS = "ABCDEFGHIJ".split("");

// ---- options ----
test("options: 2 to 10 options A–J accepted, trimmed, in order", () => {
  for (let n = 2; n <= 10; n++) {
    const r = parseOptions(LETTERS.slice(0, n).map((l) => ` opt ${l} `), "multiple_choice");
    assert.deepEqual(r.issues, [], `n=${n}`);
    assert.deepEqual(r.texts, LETTERS.slice(0, n).map((l) => `opt ${l}`));
  }
});
test("options: fewer than 2 refused", () => {
  assert.deepEqual(codes(parseOptions(["Only"], "single_choice")), ["options_too_few"]);
  assert.deepEqual(codes(parseOptions([], "single_choice")), ["options_too_few"]);
  assert.deepEqual(codes(parseOptions(undefined, "single_choice")), ["options_too_few"]);
});
test("options: a gap (blank B, filled C) is an error, never reordered", () => {
  const r = parseOptions(["A text", "", "C text"], "single_choice");
  assert.ok(codes(r).includes("option_gap"));
  assert.match(r.issues[0].message, /Option B is blank/);
});
test("options: trailing blanks are fine", () => {
  assert.deepEqual(parseOptions(["a", "b", "", "", null, undefined], "single_choice"), { texts: ["a", "b"], issues: [] });
});
test("options: J is the last column (11th value ignored beyond A–J)", () => {
  const r = parseOptions([...LETTERS, "K"], "multiple_choice");
  assert.equal(r.texts.length, 10);
});
test("options: repeated option text (case/space-insensitive) refused", () => {
  const r = parseOptions(["Flow  meter", "Pump", "flow meter"], "single_choice");
  assert.deepEqual(codes(r), ["option_repeated"]);
  assert.match(r.issues[0].message, /Options A and C/);
});
test("options: over 1000 characters refused", () => {
  assert.deepEqual(codes(parseOptions(["x".repeat(1001), "b"], "single_choice")), ["option_too_long"]);
  assert.deepEqual(parseOptions(["x".repeat(1000), "b"], "single_choice").issues, []);
});
test("options: numbers and booleans from spreadsheets become text", () => {
  assert.deepEqual(parseOptions([4, 20, true], "single_choice").texts, ["4", "20", "true"]);
});
test("true/false: blank or exactly True/False (any case) → fixed True, False", () => {
  for (const cells of [[], ["", ""], ["True", "False"], ["TRUE", "false"]]) {
    assert.deepEqual(parseOptions(cells, "true_false"), { texts: ["True", "False"], issues: [] }, JSON.stringify(cells));
  }
});
test("true/false: other option text is refused, not replaced", () => {
  for (const cells of [["Yes", "No"], ["False", "True"], ["True", ""], ["True", "False", "Maybe"]]) {
    assert.deepEqual(codes(parseOptions(cells, "true_false")), ["true_false_options"], JSON.stringify(cells));
  }
});

// ---- correct answer ----
test("single choice: one letter, any case, A–J", () => {
  assert.deepEqual(parseCorrectAnswer("A", "single_choice", 4), { correct: [0], issues: [], missing: false });
  assert.deepEqual(parseCorrectAnswer(" c ", "single_choice", 4).correct, [2]);
  assert.deepEqual(parseCorrectAnswer("J", "single_choice", 10).correct, [9]);
});
test("single choice: two letters refused", () => {
  assert.deepEqual(codes(parseCorrectAnswer("A,C", "single_choice", 4)), ["answer_count"]);
});
test("multiple choice: comma / semicolon / space separated", () => {
  for (const input of ["A,C", "a, c", "A;C", "A C", " C , A ", "A,,C"]) {
    assert.deepEqual(parseCorrectAnswer(input, "multiple_choice", 4), { correct: [0, 2], issues: [], missing: false }, input);
  }
  assert.deepEqual(parseCorrectAnswer("A,B,C,D,E,F,G,H,I,J", "multiple_choice", 10).correct, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test("multiple choice: a single correct option is allowed (0007 rule)", () => {
  assert.deepEqual(parseCorrectAnswer("B", "multiple_choice", 3).issues, []);
});
test("answer naming a blank/nonexistent option refused", () => {
  assert.deepEqual(codes(parseCorrectAnswer("E", "single_choice", 4)), ["answer_blank_option"]);
  assert.deepEqual(codes(parseCorrectAnswer("A,E", "multiple_choice", 4)), ["answer_blank_option"]);
});
test("malformed / ambiguous answers are refused, never guessed", () => {
  for (const input of ["AC", "1", "2,3", "K", "A and C", "A-C", "A|C", "option A", "Flow transmitter", "A.", "(A)", "True"]) {
    assert.deepEqual(codes(parseCorrectAnswer(input, "multiple_choice", 4)), ["answer_invalid"], input);
  }
});
test("repeated letter refused", () => {
  assert.ok(codes(parseCorrectAnswer("A,A", "multiple_choice", 4)).includes("answer_repeated"));
  assert.ok(codes(parseCorrectAnswer("b, B", "single_choice", 4)).includes("answer_repeated"));
});
test("missing answer flagged as missing", () => {
  for (const blank of ["", "  ", null, undefined]) {
    const r = parseCorrectAnswer(blank, "single_choice", 4);
    assert.equal(r.missing, true);
    assert.deepEqual(codes(r), ["answer_missing"]);
  }
});
test("true/false: TRUE / FALSE (any case) or spreadsheet boolean", () => {
  assert.deepEqual(parseCorrectAnswer("TRUE", "true_false", 2).correct, [0]);
  assert.deepEqual(parseCorrectAnswer("false", "true_false", 2).correct, [1]);
  assert.deepEqual(parseCorrectAnswer(true, "true_false", 2).correct, [0]);
  assert.deepEqual(parseCorrectAnswer(false, "true_false", 2).correct, [1]);
});
test("true/false: letters, T/F, yes/no, 1/0 refused", () => {
  for (const input of ["A", "B", "T", "F", "yes", "no", "1", "0", 1, "TRUE,FALSE"]) {
    assert.deepEqual(codes(parseCorrectAnswer(input, "true_false", 2)), ["answer_invalid"], String(input));
  }
  assert.equal(parseCorrectAnswer("", "true_false", 2).missing, true);
});
