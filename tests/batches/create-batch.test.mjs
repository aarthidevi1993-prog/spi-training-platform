import { test } from "node:test";
import assert from "node:assert/strict";

if (!process.env.BATCHES_CORE) throw new Error("Run through tests/batches/run.mjs");
const { validateCreateBatchInput, createBatchWith, classifyBatchInsertError, isIsoDate, BatchCreateAuthorizationError, BatchCreateValidationError } = await import(process.env.BATCHES_CORE);

const COURSE = "c0000000-0000-4000-8000-000000000001";
const DRAFT_COURSE = "c0000000-0000-4000-8000-000000000002";
const TRAINER = "70000000-0000-4000-8000-000000000001";
const INACTIVE_TRAINER = "70000000-0000-4000-8000-000000000002";
const OPTIONS = {
  courses: [{ id: COURSE, title: "Instrumentation Fundamentals", selectable: true }, { id: DRAFT_COURSE, title: "Draft course", selectable: false }],
  trainers: [{ id: TRAINER, name: "Trainer One", selectable: true }, { id: INACTIVE_TRAINER, name: "Old Trainer", selectable: false }],
};
const valid = (over = {}) => ({ batchCode: "  SPI-2026-B04 ", name: " October batch ", courseId: COURSE, trainerId: TRAINER, startDate: "2026-10-05", endDate: "2026-12-18", maxSeats: 30, ...over });
const user = (role) => ({ id: "a0000000-0000-4000-8000-000000000001", email: "x@test", fullName: "X", role, isActive: true, createdAt: "2026-01-01" });

/** Fake deps recording what would be inserted. */
function deps({ role = "admin", insert } = {}) {
  const calls = [];
  return {
    calls,
    d: {
      getCurrentUser: async () => (role ? user(role) : null),
      getOptions: async () => OPTIONS,
      insert: insert ?? (async (clean, createdBy) => { calls.push({ clean, createdBy }); return "b0000000-0000-4000-8000-000000000001"; }),
      classify: classifyBatchInsertError,
    },
  };
}

// ---- valid creation ----
test("valid batch: trimmed, inserted once with the admin as creator", async () => {
  const { d, calls } = deps();
  const res = await createBatchWith(d, valid());
  assert.deepEqual(res, { id: "b0000000-0000-4000-8000-000000000001" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].clean, { batchCode: "SPI-2026-B04", name: "October batch", courseId: COURSE, trainerId: TRAINER, startDate: "2026-10-05", endDate: "2026-12-18", maxSeats: 30 });
  assert.equal(calls[0].createdBy, user("admin").id);
  assert.ok(!("status" in calls[0].clean), "status is never taken from input (the repository always writes 'upcoming')");
});
test("a status field sent by a client is ignored", async () => {
  const { d, calls } = deps();
  await createBatchWith(d, { ...valid(), status: "completed" });
  assert.ok(!("status" in calls[0].clean));
});
test("optional trainer: blank or null → unassigned (null)", async () => {
  for (const trainerId of [null, "", "   "]) {
    const { d, calls } = deps();
    await createBatchWith(d, valid({ trainerId }));
    assert.equal(calls[0].clean.trainerId, null, JSON.stringify(trainerId));
  }
});
test("start and end on the same day is allowed", () => {
  assert.deepEqual(validateCreateBatchInput(valid({ startDate: "2026-10-05", endDate: "2026-10-05" }), OPTIONS).errors, {});
});

// ---- required fields ----
test("missing code / name → field errors, nothing inserted", async () => {
  for (const [field, over] of [["batchCode", { batchCode: "  " }], ["name", { name: "" }], ["batchCode", { batchCode: undefined }], ["name", { name: null }]]) {
    const { d, calls } = deps();
    await assert.rejects(createBatchWith(d, valid(over)), (e) => e instanceof BatchCreateValidationError && typeof e.errors[field] === "string");
    assert.equal(calls.length, 0);
  }
});
test("code / name length limits", () => {
  assert.ok(validateCreateBatchInput(valid({ batchCode: "X".repeat(51) }), OPTIONS).errors.batchCode);
  assert.ok(validateCreateBatchInput(valid({ name: "N".repeat(151) }), OPTIONS).errors.name);
  assert.deepEqual(validateCreateBatchInput(valid({ batchCode: "X".repeat(50), name: "N".repeat(150) }), OPTIONS).errors, {});
});

// ---- course / trainer references ----
test("course: missing, unknown, or not published → error", () => {
  assert.equal(validateCreateBatchInput(valid({ courseId: "" }), OPTIONS).errors.courseId, "Select a course.");
  assert.equal(validateCreateBatchInput(valid({ courseId: "c0000000-0000-4000-8000-00000000dead" }), OPTIONS).errors.courseId, "Select a valid course.");
  assert.match(validateCreateBatchInput(valid({ courseId: DRAFT_COURSE }), OPTIONS).errors.courseId, /isn't active/);
});
test("trainer: unknown or inactive → error", () => {
  assert.match(validateCreateBatchInput(valid({ trainerId: "70000000-0000-4000-8000-00000000dead" }), OPTIONS).errors.trainerId, /valid trainer/);
  assert.match(validateCreateBatchInput(valid({ trainerId: INACTIVE_TRAINER }), OPTIONS).errors.trainerId, /isn't active/);
});

// ---- dates ----
test("invalid dates: missing, malformed, impossible, end before start", () => {
  assert.ok(validateCreateBatchInput(valid({ startDate: "" }), OPTIONS).errors.startDate);
  assert.ok(validateCreateBatchInput(valid({ endDate: "18/12/2026" }), OPTIONS).errors.endDate);
  assert.ok(validateCreateBatchInput(valid({ startDate: "2026-02-30" }), OPTIONS).errors.startDate, "Feb 30 is not a date");
  assert.equal(validateCreateBatchInput(valid({ startDate: "2026-12-18", endDate: "2026-10-05" }), OPTIONS).errors.endDate, "The end date can't be before the start date.");
  assert.equal(isIsoDate("2028-02-29"), true, "leap day");
  assert.equal(isIsoDate("2026-13-01"), false);
});

// ---- max seats ----
test("invalid max seats: 0, negative, decimal, NaN, text, missing, too large", () => {
  for (const maxSeats of [0, -5, 2.5, Number.NaN, "30", undefined, null, 10001]) {
    assert.ok(validateCreateBatchInput(valid({ maxSeats }), OPTIONS).errors.maxSeats, String(maxSeats));
  }
  assert.deepEqual(validateCreateBatchInput(valid({ maxSeats: 1 }), OPTIONS).errors, {});
  assert.deepEqual(validateCreateBatchInput(valid({ maxSeats: 10000 }), OPTIONS).errors, {});
});

// ---- authorization ----
test("unauthorized roles: trainer and student refused, nothing inserted", async () => {
  for (const role of ["trainer", "student"]) {
    const { d, calls } = deps({ role });
    await assert.rejects(createBatchWith(d, valid()), (e) => e instanceof BatchCreateAuthorizationError && /Super Admin/.test(e.message));
    assert.equal(calls.length, 0);
  }
});
test("signed-out caller refused", async () => {
  const { d, calls } = deps({ role: null });
  await assert.rejects(createBatchWith(d, valid()), (e) => e instanceof BatchCreateAuthorizationError && /signed in/.test(e.message));
  assert.equal(calls.length, 0);
});

// ---- database outcomes ----
test("duplicate batch code (unique violation 23505) → friendly field error, no raw database text", async () => {
  const { d } = deps({ insert: async () => { const e = new Error('duplicate key value violates unique constraint "batches_batch_code_key"'); e.code = "23505"; throw e; } });
  await assert.rejects(createBatchWith(d, valid()), (e) => e instanceof BatchCreateValidationError && e.errors.batchCode === "A batch with this code already exists. Use a different code." && !/constraint/.test(JSON.stringify(e.errors)));
});
test("RLS refusal (42501) → authorization error; FK (23503) and check (23514) → form errors", async () => {
  const fail = (code) => deps({ insert: async () => { const e = new Error("db"); e.code = code; throw e; } }).d;
  await assert.rejects(createBatchWith(fail("42501"), valid()), (e) => e instanceof BatchCreateAuthorizationError);
  await assert.rejects(createBatchWith(fail("23503"), valid()), (e) => e instanceof BatchCreateValidationError && /no longer exists/.test(e.errors.form));
  await assert.rejects(createBatchWith(fail("23514"), valid()), (e) => e instanceof BatchCreateValidationError && /rejected/.test(e.errors.form));
});
test("an unexpected error is passed through (the action turns it into a generic message)", async () => {
  const boom = new Error("network down");
  const { d } = deps({ insert: async () => { throw boom; } });
  await assert.rejects(createBatchWith(d, valid()), (e) => e === boom);
});
test("classifyBatchInsertError maps codes", () => {
  assert.equal(classifyBatchInsertError({ code: "23505" }), "duplicate_code");
  assert.equal(classifyBatchInsertError({ code: "23503" }), "invalid_reference");
  assert.equal(classifyBatchInsertError({ code: "22007" }), "rejected");
  assert.equal(classifyBatchInsertError({ code: "42501" }), "permission");
  assert.equal(classifyBatchInsertError(new Error("x")), null);
  assert.equal(classifyBatchInsertError(null), null);
});

test("0030: a course that isn't published (archived / draft since the form loaded) → course field error", async () => {
  assert.equal(classifyBatchInsertError({ code: "23514", hint: "course_not_published" }), "course_unavailable");
  assert.equal(classifyBatchInsertError({ code: "23514", hint: "" }), "rejected", "other check violations unchanged");
  const { d } = deps({ insert: async () => { throw Object.assign(new Error("x"), { code: "23514", hint: "course_not_published" }); } });
  await assert.rejects(createBatchWith(d, valid()), (err) => err instanceof BatchCreateValidationError && /isn't active/.test(err.errors.courseId));
});
