import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mjs";

const { mapHeaders, TEMPLATE_HEADERS } = core;
const CANONICAL = [
  "Question ID", "Course Code", "Module Code", "Question Text", "Type", "Marks",
  "Option A", "Option B", "Option C", "Option D", "Option E", "Option F", "Option G", "Option H", "Option I", "Option J",
  "Correct Answer", "Explanation", "Status", "Revision",
];

test("template has the approved canonical columns (Type, Options A–J, Revision)", () => {
  assert.deepEqual(TEMPLATE_HEADERS.map((h) => h.header), CANONICAL);
});
test("full template header row maps every column by position", () => {
  const map = mapHeaders(CANONICAL);
  assert.deepEqual(map.errors, []);
  assert.equal(map.columns.questionText, 3);
  assert.equal(map.columns.questionType, 4);
  assert.equal(map.columns.optionJ, 15);
  assert.equal(map.columns.status, 18);
  assert.equal(map.columns.revision, 19);
});
test("headers matched without case, spaces, underscores or hyphens; any order", () => {
  const map = mapHeaders(["MARKS", "question_text", "Correct-Answer", "course code", "OPTION A", "option_b", "TYPE"]);
  assert.deepEqual(map.errors, []);
  assert.equal(map.columns.marks, 0);
  assert.equal(map.columns.optionB, 5);
  assert.equal(map.columns.questionType, 6);
});
test('alias: "Question Type" is accepted for Type', () => {
  const map = mapHeaders(["Course Code", "Question Type", "Question Text", "Option A", "Option B", "Correct Answer", "Marks"]);
  assert.deepEqual(map.errors, []);
  assert.equal(map.columns.questionType, 1);
});
test("missing required columns reported by name", () => {
  const map = mapHeaders(["Course Code", "Question Text", "Option A"]);
  assert.equal(map.errors.length, 1);
  assert.match(map.errors[0], /Type, Option B, Correct Answer, Marks/);
});
test("Course Code is optional when the course is chosen in the import screen", () => {
  const cols = ["Type", "Question Text", "Option A", "Option B", "Correct Answer", "Marks"];
  assert.match(mapHeaders(cols).errors[0], /Course Code/);
  assert.deepEqual(mapHeaders(cols, { courseChosenInUi: true }).errors, []);
});
test("repeated column (also via its alias) is an error; unknown columns are ignored and listed", () => {
  const map = mapHeaders(["Course Code", "Type", "Question Text", "Option A", "Option B", "Correct Answer", "Marks", "marks", "Difficulty", ""]);
  assert.equal(map.errors.length, 1);
  assert.match(map.errors[0], /appears more than once/);
  assert.deepEqual(map.ignored, ["Difficulty"]);
  assert.match(mapHeaders(["Type", "Question Type"]).errors[0], /appears more than once/);
});
