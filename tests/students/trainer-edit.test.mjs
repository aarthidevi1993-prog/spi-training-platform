// Phase 7 P3.10-B — trainer student editing: the patch rules (only typed, non-blank values; never another key;
// blank optional fields keep the unseen existing values), the trainer-only service with fake dependencies,
// the server action with a fake service and next/cache, and source boundaries for the new UI and wiring.
// Database behaviour (scope, audit, privacy) is in tests/question-import-db/zz-trainer-student-edit.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const build = process.env.STUDENTS_BUILD;
if (!build) throw new Error("Run through tests/students/run.mjs");
const E = await import(`${build}/lib/students/trainer-edit.mjs`);
const { StudentsFunctionError, StudentsWriteRepositoryError } = await import(`${build}/repositories/students.repository.core.mjs`);
const { createTrainerStudentEditService, StudentEditAuthorizationError } = await import(`${build}/services/students.service.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const ID = "88888888-8888-4888-8888-888888888888";
const TRAINER = { id: "99999999-9999-4999-8999-999999999999", email: "t@test", fullName: "T", role: "trainer", isActive: true, createdAt: "2026-01-01" };

// ---------------------------------------------------------------- patch rules
test("patch: the name only when changed and never blank; optional fields only when typed (blank keeps the unseen value); no other key", () => {
  assert.deepEqual(E.buildTrainerStudentPatch("Asha Rao", { fullName: " Asha  K Rao ", phone: " 98765 ", organization: "", designation: "   " }), {
    ok: true,
    patch: { full_name: "Asha  K Rao", phone: "98765" },
  });
  assert.deepEqual(E.buildTrainerStudentPatch("Asha Rao", { fullName: "Asha Rao", phone: "", organization: "", designation: "" }), { ok: false, error: E.NOTHING_CHANGED, unchanged: true });
  assert.deepEqual(E.buildTrainerStudentPatch("Asha Rao", {}), { ok: false, error: E.NOTHING_CHANGED, unchanged: true });
  assert.deepEqual(E.buildTrainerStudentPatch("Asha Rao", { fullName: "  " }).ok, false, "a blank name is refused");
  assert.match(E.buildTrainerStudentPatch("Asha Rao", { fullName: "  " }).error, /can't be empty/);
  // Forged keys are never forwarded.
  const forged = E.buildTrainerStudentPatch("A", { fullName: "B", student_code: "HACK", email: "x@y.z", role: "super_admin", status: "inactive", full_name: "C" });
  assert.deepEqual(forged, { ok: true, patch: { full_name: "B" } });
  // Lengths mirror the database (0017 user_mgmt_text): name 200, phone 40, organization/designation 200.
  assert.equal(E.buildTrainerStudentPatch("A", { fullName: "x".repeat(201) }).ok, false);
  assert.equal(E.buildTrainerStudentPatch("A", { phone: "1".repeat(41) }).ok, false);
  assert.equal(E.buildTrainerStudentPatch("A", { organization: "o".repeat(201) }).ok, false);
  assert.equal(E.buildTrainerStudentPatch("A", { designation: "d".repeat(201) }).ok, false);
  assert.deepEqual(E.buildTrainerStudentPatch("A", { phone: "1".repeat(40) }), { ok: true, patch: { phone: "1".repeat(40) } });
  // Wrong types are refused, not coerced.
  assert.equal(E.buildTrainerStudentPatch("A", { phone: 123 }).ok, false);
  assert.equal(E.buildTrainerStudentPatch("A", { fullName: ["x"] }).ok, false);
  assert.deepEqual(E.buildTrainerStudentPatch("A", null), { ok: false, error: E.NOTHING_CHANGED, unchanged: true });
});

test("messages: database reasons and SQLSTATEs map to fixed sentences; unknown ones never pass through", () => {
  assert.equal(E.trainerEditReasonMessage("not_found"), E.TRAINER_EDIT_MESSAGE.notFound);
  assert.equal(E.trainerEditReasonMessage("unchanged"), E.NOTHING_CHANGED);
  assert.equal(E.trainerEditReasonMessage("no_contact_record"), E.TRAINER_EDIT_MESSAGE.noContactRecord);
  assert.equal(E.trainerEditReasonMessage("something_new"), E.TRAINER_EDIT_MESSAGE.generic);
  assert.equal(E.trainerEditErrorMessage("42501"), E.TRAINER_EDIT_MESSAGE.scope);
  assert.equal(E.trainerEditErrorMessage("22023"), E.TRAINER_EDIT_MESSAGE.invalid);
  assert.equal(E.trainerEditErrorMessage("XX000"), E.TRAINER_EDIT_MESSAGE.generic);
  assert.deepEqual([...E.EDITABLE_BATCH_STATUSES], ["upcoming", "ongoing"], "mirrors is_current_batch_trainer (0008)");
});

// ---------------------------------------------------------------- service (fake repository)
function harness(o = {}) {
  const log = [];
  const repository = {
    readStudentName: async (id) => (log.push(["read", id]), o.read ? o.read(id) : "Asha Rao"),
    trainerUpdateStudent: async (id, patch) => (log.push(["update", id, patch]), o.update ? o.update(id, patch) : { ok: true, fields: Object.keys(patch) }),
  };
  const svc = createTrainerStudentEditService({ repository, getCurrentUser: async () => (o.user === undefined ? TRAINER : o.user), isDemoMode: () => o.demo ?? false });
  return { svc, log };
}

test("service: only a signed-in trainer; Super Admins, students and signed-out callers are refused before any call", async () => {
  for (const user of [null, { ...TRAINER, role: "admin" }, { ...TRAINER, role: "student" }]) {
    const h = harness({ user });
    await assert.rejects(h.svc.updateAsTrainer(ID, { fullName: "X" }), StudentEditAuthorizationError);
    assert.deepEqual(h.log, []);
  }
});

test("service: demo mode, bad ids, invalid values and 'nothing changed' stop before the update; unreadable students are 'not found'", async () => {
  assert.deepEqual(await harness({ demo: true }).svc.updateAsTrainer(ID, { fullName: "X" }), { ok: false, error: E.TRAINER_EDIT_MESSAGE.demo });
  const h = harness();
  assert.deepEqual(await h.svc.updateAsTrainer("not-a-uuid", { fullName: "X" }), { ok: false, error: E.TRAINER_EDIT_MESSAGE.notFound });
  assert.deepEqual(await h.svc.updateAsTrainer(ID, { fullName: "Asha Rao", phone: "" }), { ok: false, error: E.NOTHING_CHANGED });
  assert.equal((await h.svc.updateAsTrainer(ID, { fullName: "" })).ok, false);
  assert.ok(h.log.every((c) => c[0] !== "update"), "no update call for any of these");
  const hidden = harness({ read: () => null });
  assert.deepEqual(await hidden.svc.updateAsTrainer(ID, { fullName: "X" }), { ok: false, error: E.TRAINER_EDIT_MESSAGE.notFound });
  assert.ok(hidden.log.every((c) => c[0] !== "update"));
});

test("service: sends exactly the built patch; database answers and raised errors become fixed sentences", async () => {
  const h = harness();
  assert.deepEqual(await h.svc.updateAsTrainer(ID, { fullName: "Asha K Rao", designation: " Lead " }), { ok: true, message: E.TRAINER_EDIT_MESSAGE.saved });
  assert.deepEqual(h.log.at(-1), ["update", ID, { full_name: "Asha K Rao", designation: "Lead" }]);
  for (const [answer, expected] of [
    [{ ok: false, reason: "not_found" }, E.TRAINER_EDIT_MESSAGE.notFound],
    [{ ok: false, reason: "no_contact_record" }, E.TRAINER_EDIT_MESSAGE.noContactRecord],
    [{ ok: false, reason: "unchanged" }, E.NOTHING_CHANGED],
  ]) assert.deepEqual(await harness({ update: () => answer }).svc.updateAsTrainer(ID, { phone: "1" }), { ok: false, error: expected });
  for (const [code, expected] of [["42501", E.TRAINER_EDIT_MESSAGE.scope], ["22023", E.TRAINER_EDIT_MESSAGE.invalid], [null, E.TRAINER_EDIT_MESSAGE.generic]]) {
    const r = await harness({ update: () => { throw new StudentsFunctionError(code); } }).svc.updateAsTrainer(ID, { phone: "1" });
    assert.deepEqual(r, { ok: false, error: expected }, String(code));
  }
  const broken = await harness({ read: () => { throw new StudentsWriteRepositoryError(); } }).svc.updateAsTrainer(ID, { phone: "1" });
  assert.deepEqual(broken, { ok: false, error: E.TRAINER_EDIT_MESSAGE.generic });
});

// ---------------------------------------------------------------- server action (fake service, fake next/cache)
async function loadActions() {
  const { createRequire } = await import("node:module");
  const os = await import("node:os");
  const ts = createRequire(path.join(root, "package.json"))("typescript");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "students-actions-"));
  fs.writeFileSync(path.join(dir, "next-cache.mjs"), "export const calls = []; export function revalidatePath(p) { calls.push(p); }\n");
  fs.writeFileSync(
    path.join(dir, "fake-service.mjs"),
    [
      "export class StudentEditAuthorizationError extends Error { constructor(m = \"Only trainers can edit their students here.\") { super(m); this.name = \"StudentEditAuthorizationError\"; } }",
      "export const received = [];",
      "export const control = { next: null };",
      "export const studentsService = { updateAsTrainer: async (id, input) => { received.push({ id, input }); const n = control.next; return typeof n === \"function\" ? n() : n; } };",
    ].join("\n")
  );
  const out = ts.transpileModule(src("src/services/students.actions.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const rewired = out
    .replace(/from\s+["']next\/cache["']/, `from "${pathToFileURL(path.join(dir, "next-cache.mjs")).href}"`)
    .replace(/from\s+["']\.\/students\.service["']/, `from "${pathToFileURL(path.join(dir, "fake-service.mjs")).href}"`)
    .replace(/from\s+["']@\/lib\/students\/trainer-edit["']/, `from "${build}/lib/students/trainer-edit.mjs"`);
  assert.doesNotMatch(rewired, /from\s+["'](@\/|\.\/)/, "every runtime import was replaced");
  fs.writeFileSync(path.join(dir, "actions.mjs"), rewired);
  const actions = await import(pathToFileURL(path.join(dir, "actions.mjs")).href);
  const service = await import(pathToFileURL(path.join(dir, "fake-service.mjs")).href);
  const cache = await import(pathToFileURL(path.join(dir, "next-cache.mjs")).href);
  return { actions, service, cache, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("action: only the id and the four values are forwarded (role/scope/other fields dropped); the list is refreshed on success only; safe errors", async () => {
  const { actions, service, cache, cleanup } = await loadActions();
  const saved = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    service.control.next = { ok: true, message: E.TRAINER_EDIT_MESSAGE.saved };
    const r = await actions.trainerUpdateStudentAction(ID, { fullName: "N", phone: "1", organization: "O", designation: "D", role: "admin", trainerId: "x", student_code: "HACK", email: "e@x" });
    assert.deepEqual(r, { ok: true, message: E.TRAINER_EDIT_MESSAGE.saved });
    assert.deepEqual(service.received.at(-1), { id: ID, input: { fullName: "N", phone: "1", organization: "O", designation: "D" } });
    assert.deepEqual(cache.calls.splice(0), ["/trainer/students"]);

    service.control.next = { ok: false, error: E.NOTHING_CHANGED };
    assert.deepEqual(await actions.trainerUpdateStudentAction(ID, "not an object"), { ok: false, error: E.NOTHING_CHANGED });
    assert.deepEqual(service.received.at(-1).input, { fullName: undefined, phone: undefined, organization: undefined, designation: undefined });
    assert.deepEqual(cache.calls, [], "no refresh after a refusal");

    service.control.next = () => { throw new service.StudentEditAuthorizationError(); };
    assert.deepEqual(await actions.trainerUpdateStudentAction(ID, {}), { ok: false, error: "Only trainers can edit their students here." });
    service.control.next = () => { const e = new Error("secret detail +91 99999 (phone)"); throw e; };
    assert.deepEqual(await actions.trainerUpdateStudentAction(ID, {}), { ok: false, error: E.TRAINER_EDIT_MESSAGE.generic });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /secret|99999|phone/, "the log carries the error name only");
  } finally {
    console.error = saved;
    cleanup();
  }
});

// ---------------------------------------------------------------- sources
test("sources: page → service → repository → session RPC; no service role, no browser database access; the admin Students page is unchanged", () => {
  const core = strip(src("src/repositories/students.repository.core.ts"));
  assert.deepEqual([...core.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]), ["trainer_update_student"], "the existing function only");
  assert.doesNotMatch(core, /\.(insert|update|upsert|delete)\(|supabase\/admin|service_role|auth\.admin/);
  const repo = strip(src("src/repositories/students.repository.ts"));
  assert.match(repo, /createStudentsWriteRepository\(\(\) => createSupabaseServerClient\(\)\)/, "the caller's own session client");
  assert.match(repo, /editable: scope\.kind === "trainer" && current\.some\(\(b\) => \(EDITABLE_BATCH_STATUSES as readonly string\[\]\)\.includes\(b\.status\)\)/, "editable is computed on the server");
  const svc = strip(src("src/services/students.service.ts"));
  assert.match(svc, /getCurrentUser: \(\) => authService\.getCurrentUser\(\)/);
  assert.doesNotMatch(strip(src("src/services/students.service.core.ts")), /\.rpc\(|\.from\(|lib\/supabase\//, "the service only sequences repository calls");
  const actions = src("src/services/students.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(strip(actions), /@\/repositories|@\/lib\/supabase|role:|trainerId/);

  const dialog = strip(src("src/components/modules/TrainerEditStudentDialog.tsx"));
  assert.match(src("src/components/modules/TrainerEditStudentDialog.tsx"), /^"use client";/);
  assert.doesNotMatch(dialog, /@\/services\/(?!students\.actions)|@\/repositories\/|@\/lib\/supabase\/|SUPABASE_SERVICE_ROLE_KEY/, "the dialog only calls the server action");
  assert.equal((dialog.match(/trainerUpdateStudentAction\(/g) ?? []).length, 1);
  assert.match(dialog, /if \(submitting\.current \|\| isPending\) return;/, "duplicate-submission guard");
  assert.match(dialog, /their current values aren&apos;t shown to trainers/, "explains the private fields");
  assert.match(dialog, /leave a field empty to keep\s+its current value unchanged/);
  assert.equal((dialog.match(/placeholder="Leave empty to keep the current value"/g) ?? []).length, 3);
  assert.match(dialog, /setPhone\(""\);\s*setOrganization\(""\);\s*setDesignation\(""\);/, "the private fields always start empty");
  assert.deepEqual([...dialog.matchAll(/<Input\s+name="([a-zA-Z]+)"/g)].map((m) => m[1]), ["fullName", "phone", "organization", "designation"], "exactly the four editable fields");
  assert.doesNotMatch(dialog, /email|student_code|account_?status/i, "no other field is offered");
  assert.match(dialog, /onClose\(\);\s*router\.refresh\(\);/, "close, then re-render the list (the new name shows at once)");

  const table = strip(src("src/components/modules/StudentsTable.tsx"));
  assert.match(table, /trainerEdit = false/, "off unless the trainer page asks");
  // P3.11-A: the Super Admin Edit opens the student's account panel (Users page) — never the trainer dialog.
  assert.match(table, /\{!trainerEdit \? \(\s*canEditAsStudent\(s\) \? \(\s*<DropdownItem onClick=\{\(\) => editAccount\(s\.id\)\}>/, "the Super Admin Edit is separate from the trainer edit");
  assert.match(table, /\) : s\.editable === true \? \(\s*<DropdownItem onClick=\{\(\) => setEditTarget\(\{ id: s\.id, name: s\.name \}\)\}>/, "Edit only on editable trainer rows");
  assert.match(src("src/app/trainer/students/page.tsx"), /<StudentsTable rows=\{students\} trainerEdit \/>/);
  assert.doesNotMatch(src("src/app/admin/students/page.tsx"), /trainerEdit/);
  // Locked decision: no trainer invitation anywhere in the trainer student UI.
  for (const f of ["src/components/modules/StudentsTable.tsx", "src/components/modules/TrainerEditStudentDialog.tsx", "src/app/trainer/students/page.tsx", "src/services/students.actions.ts"]) {
    assert.doesNotMatch(src(f), /InviteUser|invitations\.(actions|service)|inviteStudent|resendInvitation|revokeInvitation/, f);
  }
});
