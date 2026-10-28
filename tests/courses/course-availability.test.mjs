// Option A for archived courses: no NEW batches; existing upcoming/ongoing batches continue (class scheduling
// included). Pure rules plus source-level wiring; the database side is in tests/question-import-db.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.COURSES_BUILD) throw new Error("Run through tests/courses/run.mjs");
const av = await import(`${process.env.COURSES_BUILD}/lib/courses/course-availability.mjs`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("new batches: only a published course", () => {
  assert.equal(av.isCourseOpenForNewBatches("published"), true);
  for (const s of ["archived", "draft", undefined, null, "PUBLISHED"]) assert.equal(av.isCourseOpenForNewBatches(s), false, String(s));
});

test("class scheduling: published always; archived only while it has an upcoming/ongoing batch; draft never", () => {
  assert.equal(av.isCourseOpenForScheduling("published", false), true);
  assert.equal(av.isCourseOpenForScheduling("archived", true), true, "existing training continues");
  assert.equal(av.isCourseOpenForScheduling("archived", false), false, "a retired course with no current batch");
  assert.equal(av.isCourseOpenForScheduling("draft", true), false);
  assert.equal(av.isCourseOpenForScheduling(undefined, true), false);
  assert.deepEqual(["upcoming", "ongoing", "completed", "cancelled", null].map(av.isCurrentBatchStatus), [true, true, false, false, false]);
});

test("wiring: class options use the scheduling rule; Add Batch uses the new-batch rule (archived never offered)", () => {
  const options = src("src/lib/classes/filter-options.ts");
  assert.match(options, /selectable: isCourseOpenForScheduling\(c\.status, coursesWithCurrentBatch\.has\(c\.id\)\)/);
  assert.match(options, /filter\(\(b\) => isCurrentBatchStatus\(b\.status\)\)/);
  const batches = src("src/services/batches.service.ts");
  assert.match(batches, /selectable: c\.status === undefined \? c\.selectable : isCourseOpenForNewBatches\(c\.status\)/);
  // Batches of an archived course are still limited to upcoming/ongoing ones in the class form and service.
  assert.match(src("src/components/modules/ClassForm.tsx"), /\(b\.selectable \|\| b\.id === initial\?\.batchId\)/);
  assert.match(src("src/services/classes.service.ts"), /errors\.batchId = "This batch is completed or cancelled\."/);
});
