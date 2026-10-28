// Phase 7 P3.8 slice 1 — enrolment application layer (pure, fake-dependency and source tests).
// The real modules (transpiled by run.mjs): input rules, messages and action availability; the
// repository against a stand-in Supabase client; the service's role checks, scoping and mapping;
// and source-level security boundaries of every new file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.ENROLLMENTS_BUILD;
if (!build) throw new Error("Run through tests/enrollments/run.mjs");
const lib = await import(`${build}/lib/enrollments/enrollment.mjs`);
const { createEnrollmentRepository, EnrollmentPermissionError, EnrollmentRepositoryError } = await import(`${build}/repositories/enrollment.repository.core.mjs`);
const { createEnrollmentService, EnrollmentAuthorizationError } = await import(`${build}/services/enrollment.service.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const B = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";
const user = (role, id = `u-${role}`) => ({ id, email: `${role}@x.test`, fullName: role, role, isActive: true, createdAt: "2026-01-01" });
const quiet = async (fn) => {
  const saved = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = saved; }
};

// ---------------------------------------------------------------- input rules

test("input: UUIDs, the three statuses and an optional reason (trimmed, blank → null, ≤ 500)", () => {
  assert.deepEqual(lib.parseAdminEnrollmentInput(B, S, "enrolled", "  Joined  "), { ok: true, value: { batchId: B, studentId: S, status: "enrolled", reason: "Joined" } });
  for (const st of ["enrolled", "withdrawn", "completed"]) assert.equal(lib.parseAdminEnrollmentInput(B, S, st, null).ok, true, st);
  for (const st of ["active", "", null, "ENROLLED", "pending", 1]) assert.equal(lib.parseAdminEnrollmentInput(B, S, st, null).ok, false, String(st));
  for (const [b, s] of [["x", S], [B, "x"], [null, S], [B, undefined], [`${B} `, S], ["'; drop table batch_students; --", S]]) {
    assert.equal(lib.parseAdminEnrollmentInput(b, s, "enrolled", null).ok, false, `${b}/${s}`);
    assert.equal(lib.parseTrainerEnrollmentInput(b, s).ok, false, `${b}/${s}`);
  }
  assert.deepEqual(lib.parseReason("   "), { ok: true, value: null });
  assert.deepEqual(lib.parseReason(undefined), { ok: true, value: null });
  assert.equal(lib.parseReason("r".repeat(500)).ok, true);
  assert.equal(lib.parseReason("r".repeat(501)).ok, false);
  assert.equal(lib.parseReason(42).ok, false);
  assert.deepEqual(lib.parseTrainerEnrollmentInput(B, S), { ok: true, value: { batchId: B, studentId: S } });
});

test("messages: every database reason maps to a fixed sentence; anything else is generic; success wording", () => {
  for (const r of ["unchanged", "transition_not_allowed", "batch_cancelled", "batch_not_current", "batch_full", "not_found", "student_not_available"]) {
    assert.equal(lib.enrollmentRefusalMessage(r), lib.ENROLLMENT_REASON_MESSAGE[r], r);
  }
  assert.match(lib.enrollmentRefusalMessage("student_not_available"), /active student record with an active account/);
  for (const r of ["weird", "toString", "__proto__", "constructor", undefined, 7]) assert.equal(lib.enrollmentRefusalMessage(r), lib.ENROLLMENT_GENERIC_ERROR, String(r));
  assert.equal(lib.enrollmentSuccessMessage(null, "enrolled"), "Student enrolled.");
  assert.equal(lib.enrollmentSuccessMessage("withdrawn", "enrolled"), "Student re-enrolled.");
  assert.equal(lib.enrollmentSuccessMessage("enrolled", "withdrawn"), "Enrolment withdrawn.");
  assert.equal(lib.enrollmentSuccessMessage("enrolled", "completed"), "Enrolment marked as completed.");
});

test("action availability: Super Admin by batch and enrolment status (G3 in the UI), trainer enrol only, nothing in cancelled batches", () => {
  const a = (bs, es) => lib.enrollmentActions("admin", bs, es);
  const t = (bs, es) => lib.enrollmentActions("trainer", bs, es);
  const none = { enrol: false, reEnrol: false, withdraw: false, complete: false };
  assert.deepEqual(a("upcoming", null), { ...none, enrol: true });
  assert.deepEqual(a("ongoing", null), { ...none, enrol: true });
  assert.deepEqual(a("completed", null), none);
  assert.deepEqual(a("upcoming", "enrolled"), { ...none, withdraw: true }, "no completion before the batch starts");
  assert.deepEqual(a("ongoing", "enrolled"), { ...none, withdraw: true, complete: true });
  assert.deepEqual(a("completed", "enrolled"), { ...none, complete: true });
  assert.deepEqual(a("ongoing", "withdrawn"), { ...none, reEnrol: true });
  assert.deepEqual(a("completed", "withdrawn"), none);
  for (const bs of ["upcoming", "ongoing", "completed"]) assert.deepEqual(a(bs, "completed"), none, `completed is final (${bs})`);
  for (const es of [null, "enrolled", "withdrawn", "completed"]) assert.deepEqual(a("cancelled", es), none, `cancelled ${es}`);
  assert.deepEqual(t("ongoing", null), { ...none, enrol: true });
  assert.deepEqual(t("upcoming", null), { ...none, enrol: true });
  for (const [bs, es] of [["completed", null], ["ongoing", "enrolled"], ["ongoing", "withdrawn"], ["cancelled", null]]) assert.deepEqual(t(bs, es), none, `trainer ${bs}/${es}`);
  assert.deepEqual(a("bogus", null), none);
});

// ---------------------------------------------------------------- repository (stand-in client)

function fakeClient({ rpc } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) { calls.push(["rpc", fn, args]); return rpc ? rpc(fn, args) : { data: { ok: true, previous: null, status: "enrolled" }, error: null }; },
  };
}
const repoWith = (c) => createEnrollmentRepository(async () => c);

test("repository: only the two approved RPCs, with exactly the documented arguments; results and errors mapped", async () => {
  const c = fakeClient();
  assert.deepEqual(await repoWith(c).setEnrollment(B, S, "withdrawn", "Moved"), { ok: true, previous: null, status: "enrolled" });
  assert.deepEqual(c.calls[0], ["rpc", "admin_set_enrollment", { p_batch_id: B, p_student_id: S, p_status: "withdrawn", p_reason: "Moved" }]);
  const t = fakeClient({ rpc: () => ({ data: { ok: true, status: "enrolled" }, error: null }) });
  assert.deepEqual(await repoWith(t).trainerEnrol(B, S), { ok: true, previous: null, status: "enrolled" });
  assert.deepEqual(t.calls[0], ["rpc", "trainer_enroll_student", { p_batch_id: B, p_student_id: S }]);
  assert.deepEqual(await repoWith(fakeClient({ rpc: () => ({ data: { ok: false, reason: "student_not_available" }, error: null }) })).setEnrollment(B, S, "enrolled", null),
    { ok: false, reason: "student_not_available" });
  await quiet(async () => {
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: null, error: { code: "42501", message: "You can only enrol…" } }) })).trainerEnrol(B, S), EnrollmentPermissionError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "raw" } }) })).setEnrollment(B, S, "enrolled", null), EnrollmentRepositoryError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: "odd", error: null }) })).setEnrollment(B, S, "enrolled", null), EnrollmentRepositoryError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => { throw new Error("down"); } })).trainerEnrol(B, S), EnrollmentRepositoryError);
    await assert.rejects(createEnrollmentRepository(async () => null).setEnrollment(B, S, "enrolled", null), EnrollmentRepositoryError);
  });
});

// ---------------------------------------------------------------- service (fake repository)

function service(role, over = {}, id) {
  const calls = [];
  const repository = {
    async setEnrollment(...a) { calls.push(["setEnrollment", ...a]); if (over.throws) throw over.throws; return over.result ?? { ok: true, previous: null, status: a[2] }; },
    async trainerEnrol(...a) { calls.push(["trainerEnrol", ...a]); if (over.throws) throw over.throws; return over.result ?? { ok: true, previous: null, status: "enrolled" }; },
    async getBatchHeader(b) { calls.push(["getBatchHeader", b]); return over.header === undefined ? { id: B, batch_code: "B-1", name: "Batch", status: "ongoing", start_date: "2026-01-01", end_date: "2026-12-31", max_seats: 10, trainer_id: T, course: "Course", trainer_name: "Tess" } : over.header; },
    async listRoster() { calls.push(["listRoster"]); return over.roster ?? []; },
    async listHistory() { calls.push(["listHistory"]); return over.history ?? []; },
    async listStudents() { calls.push(["listStudents"]); return over.students ?? []; },
    async listTrainerScope(tid) { calls.push(["listTrainerScope", tid]); return over.scope ?? []; },
  };
  return { calls, svc: createEnrollmentService({ repository, getCurrentUser: async () => (role ? user(role, id) : null) }) };
}

test("service: Super Admin only for setEnrollment, trainer only for trainerEnrol — refused before any database call", async () => {
  for (const role of ["trainer", "student", null]) {
    const { calls, svc } = service(role);
    await assert.rejects(svc.setEnrollment(B, S, "enrolled", null), EnrollmentAuthorizationError, String(role));
    assert.deepEqual(calls, []);
  }
  for (const role of ["admin", "student", null]) {
    const { calls, svc } = service(role);
    await assert.rejects(svc.trainerEnrol(B, S), EnrollmentAuthorizationError, String(role));
    assert.deepEqual(calls, []);
  }
  for (const role of ["student", null]) await assert.rejects(service(role).svc.getBatchDetail(B), EnrollmentAuthorizationError);
});

test("service: invalid input never reaches the database; outcomes become fixed sentences; raw errors never surface", async () => {
  let { calls, svc } = service("admin");
  assert.equal((await svc.setEnrollment("x", S, "enrolled", null)).ok, false);
  assert.equal((await svc.setEnrollment(B, S, "bogus", null)).ok, false);
  assert.equal((await svc.setEnrollment(B, S, "enrolled", "r".repeat(501))).ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await svc.setEnrollment(B, S, "withdrawn", " Moved "), { ok: true, message: "Enrolment withdrawn." });
  assert.deepEqual(calls, [["setEnrollment", B, S, "withdrawn", "Moved"]]);
  for (const reason of ["unchanged", "transition_not_allowed", "batch_cancelled", "batch_not_current", "batch_full", "not_found", "student_not_available", "brand_new"]) {
    assert.deepEqual(await service("admin", { result: { ok: false, reason } }).svc.setEnrollment(B, S, "enrolled", null), { ok: false, error: lib.enrollmentRefusalMessage(reason) }, reason);
  }
  assert.deepEqual(await service("admin", { throws: new EnrollmentPermissionError() }).svc.setEnrollment(B, S, "enrolled", null), { ok: false, error: lib.ENROLLMENT_ADMIN_ONLY_ERROR });
  assert.deepEqual(await service("admin", { throws: new Error("raw db text") }).svc.setEnrollment(B, S, "enrolled", null), { ok: false, error: lib.ENROLLMENT_GENERIC_ERROR });
  ({ calls, svc } = service("trainer"));
  assert.equal((await svc.trainerEnrol(B, "nope")).ok, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await svc.trainerEnrol(B, S), { ok: true, message: "Student enrolled." });
  assert.deepEqual(await service("trainer", { throws: new EnrollmentPermissionError() }).svc.trainerEnrol(B, S), { ok: false, error: lib.ENROLLMENT_TRAINER_SCOPE_ERROR });
});

test("service: batch detail — admin candidates are AVAILABLE students not yet in the batch; trainers see only their own batches and in-scope candidates", async () => {
  const roster = [
    { student_id: "s-in", enrollment_status: "enrolled", enrolled_at: "2026-01-02", completed_at: null, student_code: "STU-1", full_name: "In Batch" },
    { student_id: "s-wd", enrollment_status: "withdrawn", enrolled_at: "2026-01-03", completed_at: null, student_code: "STU-2", full_name: "Withdrawn" },
  ];
  const students = [
    { id: "s-ok", student_code: "STU-3", full_name: "Available", status: "active", role: "student", account_status: "active" },
    { id: "s-in", student_code: "STU-1", full_name: "In Batch", status: "active", role: "student", account_status: "active" },
    { id: "s-wd", student_code: "STU-2", full_name: "Withdrawn", status: "active", role: "student", account_status: "active" },
    { id: "s-sus", student_code: "STU-4", full_name: "Suspended", status: "active", role: "student", account_status: "suspended" },
    { id: "s-inv", student_code: "STU-5", full_name: "Invited", status: "active", role: "student", account_status: "invited" },
    { id: "s-ina", student_code: "STU-6", full_name: "Inactive", status: "inactive", role: "student", account_status: "active" },
    { id: "s-tr", student_code: "STU-7", full_name: "Now Trainer", status: "inactive", role: "trainer", account_status: "active" },
  ];
  const admin = await service("admin", { roster, students }).svc.getBatchDetail(B);
  assert.equal(admin.mode, "admin");
  assert.equal(admin.canEnrol, true);
  assert.deepEqual(admin.candidates, [{ id: "s-ok", code: "STU-3", name: "Available" }], "only available students not already in this batch (withdrawn → re-enrol from the roster)");
  assert.equal(admin.seatsUsed, 1);
  assert.deepEqual(admin.roster.map((r) => [r.studentId, r.actions]), [
    ["s-in", { enrol: false, reEnrol: false, withdraw: true, complete: true }],
    ["s-wd", { enrol: false, reEnrol: true, withdraw: false, complete: false }],
  ]);

  // A completed batch offers no new enrolment and loads no candidates.
  const done = service("admin", { header: { id: B, batch_code: "B", name: "B", status: "completed", start_date: "a", end_date: "b", max_seats: 1, trainer_id: T, course: "C", trainer_name: null }, roster, students });
  const doneDetail = await done.svc.getBatchDetail(B);
  assert.equal(doneDetail.canEnrol, false);
  assert.deepEqual(doneDetail.candidates, []);
  assert.ok(!done.calls.some((c) => c[0] === "listStudents"));

  // Trainer: someone else's batch → null (nothing else read).
  const other = service("trainer", { header: { id: B, batch_code: "B", name: "B", status: "ongoing", start_date: "a", end_date: "b", max_seats: 1, trainer_id: "someone-else", course: "C", trainer_name: null } }, T);
  assert.equal(await other.svc.getBatchDetail(B), null);
  assert.deepEqual(other.calls.map((c) => c[0]), ["getBatchHeader"]);

  // Trainer: own batch → candidates from their other CURRENT batches, active records, not already here.
  const scope = [
    { student_id: "s-a", batch_id: "other-1", batch_status: "ongoing", batch_trainer_id: T, student_code: "STU-A", full_name: "Alpha", student_status: "active" },
    { student_id: "s-a", batch_id: "other-2", batch_status: "upcoming", batch_trainer_id: T, student_code: "STU-A", full_name: "Alpha", student_status: "active" },
    { student_id: "s-in", batch_id: "other-1", batch_status: "ongoing", batch_trainer_id: T, student_code: "STU-1", full_name: "In Batch", student_status: "active" },
    { student_id: "s-old", batch_id: "old", batch_status: "completed", batch_trainer_id: T, student_code: "STU-O", full_name: "Old", student_status: "active" },
    { student_id: "s-ina", batch_id: "other-1", batch_status: "ongoing", batch_trainer_id: T, student_code: "STU-I", full_name: "Inactive", student_status: "inactive" },
    { student_id: "s-here", batch_id: B, batch_status: "ongoing", batch_trainer_id: T, student_code: "STU-H", full_name: "Here", student_status: "active" },
  ];
  const mine = await service("trainer", { roster, scope }, T).svc.getBatchDetail(B);
  assert.equal(mine.mode, "trainer");
  assert.deepEqual(mine.candidates, [{ id: "s-a", code: "STU-A", name: "Alpha" }]);
  assert.ok(mine.roster.every((r) => !r.actions.withdraw && !r.actions.complete && !r.actions.reEnrol), "trainers get no withdraw / complete / re-enrol");

  assert.equal(await service("admin", { header: null }).svc.getBatchDetail(B), null, "not visible → null");
  assert.equal(await service("admin").svc.getBatchDetail("not-a-uuid"), null);
});

// ---------------------------------------------------------------- source boundaries

const FILES = [
  "src/lib/enrollments/enrollment.ts",
  "src/repositories/enrollment.repository.core.ts",
  "src/repositories/enrollment.repository.ts",
  "src/services/enrollment.service.core.ts",
  "src/services/enrollment.service.ts",
  "src/services/enrollment.actions.ts",
];
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("boundary: no service role, no admin client, no Auth Admin in any enrolment file", () => {
  for (const rel of FILES) {
    const code = strip(src(rel));
    for (const spec of importsOf(code)) assert.doesNotMatch(spec, /supabase\/admin|auth-admin/, `${rel} imports ${spec}`);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role|createSupabaseAdminClient|auth\.admin/, rel);
  }
  assert.match(src("src/repositories/enrollment.repository.ts"), /createSupabaseServerClient/);
  for (const rel of ["src/repositories/enrollment.repository.ts", "src/services/enrollment.service.ts"]) assert.match(src(rel), /^import "server-only";/, rel);
});

test("boundary: only the two approved RPCs; batch_students / enrollment_events are never written", () => {
  const repo = strip(src("src/repositories/enrollment.repository.core.ts"));
  assert.deepEqual([...repo.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]).sort(), ["admin_set_enrollment", "trainer_enroll_student"]);
  for (const rel of FILES) {
    const code = strip(src(rel));
    assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/, `${rel}: no table writes`);
    if (rel !== "src/repositories/enrollment.repository.core.ts") assert.doesNotMatch(code, /\.rpc\(|\.from\(/, `${rel}: database access only in the repository`);
  }
  const lib = strip(src("src/lib/enrollments/enrollment.ts"));
  assert.deepEqual(importsOf(lib), [], "the pure library imports nothing");
});

test("actions: server-only module exporting exactly the two actions; ids/status/reason only; error names only in logs", () => {
  const actions = src("src/services/enrollment.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.deepEqual([...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["setEnrollmentAction", "trainerEnrolStudentAction"]);
  assert.match(actions, /setEnrollmentAction\(batchId: string, studentId: string, status: string, reason\?: string \| null\)/);
  assert.match(actions, /trainerEnrolStudentAction\(batchId: string, studentId: string\)/);
  assert.match(actions, /console\.error\(`\[enrollment\.actions\] \$\{context\}:`, err instanceof Error \? err\.name : "unknown error"\)/);
  for (const spec of importsOf(actions)) assert.ok(["next/cache", "./enrollment.service", "@/lib/enrollments/enrollment"].includes(spec), spec);
  // No client component imports the server layer (none exists yet in this slice).
  const clientFiles = execListClientFiles();
  for (const f of clientFiles) assert.doesNotMatch(src(f), /@\/(repositories\/enrollment|services\/enrollment\.service)/, f);
});

function execListClientFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && /^["']use client["'];/.test(src(rel))) out.push(rel);
    }
  };
  walk("src");
  return out;
}

test("0030: an archived course's upcoming batch refusal (course_archived) has its own message; never the generic one", () => {
  assert.match(lib.enrollmentRefusalMessage("course_archived"), /course is inactive, so it takes no new students/);
  assert.match(lib.enrollmentRefusalMessage("course_archived"), /Ongoing batches of inactive courses still accept enrolments/);
  assert.notEqual(lib.enrollmentRefusalMessage("course_archived"), lib.ENROLLMENT_GENERIC_ERROR);
});

test("0030 UI rule: an archived course's UPCOMING batch offers no enrol / re-enrol (withdraw stays); ongoing batches are unchanged", () => {
  const a = (bs, es, cs) => lib.enrollmentActions("admin", bs, es, cs);
  const t = (bs, es, cs) => lib.enrollmentActions("trainer", bs, es, cs);
  assert.equal(a("upcoming", null, "archived").enrol, false);
  assert.equal(a("upcoming", "withdrawn", "archived").reEnrol, false);
  assert.equal(a("upcoming", "enrolled", "archived").withdraw, true, "withdrawal is not an enrolment");
  assert.equal(t("upcoming", null, "archived").enrol, false);
  for (const [bs, cs] of [["ongoing", "archived"], ["upcoming", "published"], ["upcoming", undefined]]) {
    assert.equal(a(bs, null, cs).enrol, true, `${bs}/${cs}`);
    assert.equal(t(bs, null, cs).enrol, true, `${bs}/${cs} trainer`);
  }
  assert.equal(lib.isEnrolmentClosedForCourse("upcoming", "archived"), true);
  assert.equal(lib.isEnrolmentClosedForCourse("ongoing", "archived"), false);
});

test("0030 batch page: upcoming batch of an archived course — no Enrol button, no candidates loaded, the reason shown", async () => {
  const header = { id: B, batch_code: "B-1", name: "Batch", status: "upcoming", start_date: "2027-01-01", end_date: "2027-12-31", max_seats: 10, trainer_id: T, course: "Course", course_status: "archived", trainer_name: "Tess" };
  const roster = [{ student_id: S, student_code: "S-1", full_name: "Sam", enrollment_status: "enrolled", enrolled_at: "2026-01-01", completed_at: null }];
  const { svc, calls } = service("admin", { header, roster, students: [{ id: "x", student_code: "X", full_name: "X", status: "active", role: "student", account_status: "active" }] });
  const d = await svc.getBatchDetail(B);
  assert.equal(d.canEnrol, false);
  assert.deepEqual(d.candidates, []);
  assert.match(d.enrolmentNote, /course is inactive, so it takes no new students/);
  assert.equal(d.roster[0].actions.withdraw, true, "existing students can still be withdrawn");
  assert.ok(!calls.some((c) => c[0] === "listStudents"), "candidates aren't even loaded");
  // The same batch once the course is reactivated: enrolment reopens, no note.
  const reopened = await service("admin", { header: { ...header, course_status: "published" }, students: [] }).svc.getBatchDetail(B);
  assert.equal(reopened.canEnrol, true);
  assert.equal(reopened.enrolmentNote, undefined);
  // An ongoing batch of an archived course still enrols.
  const ongoing = await service("admin", { header: { ...header, status: "ongoing" }, students: [] }).svc.getBatchDetail(B);
  assert.equal(ongoing.canEnrol, true);
  assert.equal(ongoing.enrolmentNote, undefined);
});

test("0030 wiring: the batch header reads the course status; the student-invitation picker skips upcoming batches of archived courses", () => {
  assert.match(src("src/repositories/enrollment.repository.core.ts"), /courses \( title, status \)/);
  assert.match(src("src/repositories/batches.repository.ts"), /courses \( title, status \),/);
  assert.match(src("src/app/admin/students/page.tsx"), /!isEnrolmentClosedForCourse\(b\.status, b\.courseStatus\)/);
  assert.match(src("src/components/modules/BatchDetailView.tsx"), /\{detail\.enrolmentNote && \(/);
});
