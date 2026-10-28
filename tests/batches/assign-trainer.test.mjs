// Phase 7 P3.6 — batch trainer assignment (pure, fake-dependency and source tests).
// The real modules (transpiled by run.mjs): input/reason rules, the repository against a
// stand-in Supabase client, the service's Super Admin check and message mapping, the Add
// Batch refusal mapping for the 0021 guard, and source-level security boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.BATCHES_BUILD;
if (!build) throw new Error("Run through tests/batches/run.mjs");
const lib = await import(`${build}/lib/batches/assign-trainer.mjs`);
const { createBatchTrainerRepository, BatchTrainerPermissionError, BatchTrainerRepositoryError } = await import(`${build}/repositories/batch-trainer.repository.core.mjs`);
const { createBatchTrainerService, BatchTrainerAuthorizationError } = await import(`${build}/services/batch-trainer.service.core.mjs`);
const { createBatchWith, classifyBatchInsertError, BatchCreateValidationError } = await import(`${build}/lib/batches/create-batch.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const BATCH = "11111111-1111-4111-8111-111111111111";
const TRAINER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const user = (role) => ({ id: "u-" + role, email: `${role}@x.test`, fullName: role, role, isActive: true, createdAt: "2026-01-01" });
const quiet = async (fn) => {
  const saved = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = saved; }
};

// ---------------------------------------------------------------- pure rules

test("input: both ids must be UUIDs; no removal (a missing trainer is refused)", () => {
  assert.deepEqual(lib.parseAssignTrainerInput(BATCH, TRAINER), { ok: true, batchId: BATCH, trainerId: TRAINER });
  for (const [b, t] of [["x", TRAINER], [BATCH, ""], [BATCH, null], [BATCH, undefined], [null, TRAINER], [BATCH, `${TRAINER} `], [BATCH, "'; drop table batches; --"], [{}, []]]) {
    assert.equal(lib.parseAssignTrainerInput(b, t).ok, false, `${b} / ${t}`);
  }
});

test("rules: assignable statuses and trainer availability match the database", () => {
  assert.deepEqual([...lib.ASSIGNABLE_BATCH_STATUSES], ["upcoming", "ongoing"]);
  for (const s of ["upcoming", "ongoing"]) assert.equal(lib.isAssignableBatchStatus(s), true);
  for (const s of ["completed", "cancelled", "", null, "Upcoming"]) assert.equal(lib.isAssignableBatchStatus(s), false, String(s));
  assert.equal(lib.isTrainerAvailable({ status: "active", role: "trainer", accountStatus: "active" }), true);
  for (const row of [
    { status: "inactive", role: "trainer", accountStatus: "active" },
    { status: "active", role: "student", accountStatus: "active" },
    { status: "active", role: "super_admin", accountStatus: "active" },
    { status: "active", role: "trainer", accountStatus: "invited" },
    { status: "active", role: "trainer", accountStatus: "suspended" },
    { status: "active", role: "trainer" },
    null,
  ]) assert.equal(lib.isTrainerAvailable(row), false, JSON.stringify(row));
});

test("messages: every database reason maps to a fixed sentence; anything else is generic; success wording", () => {
  for (const r of ["not_found", "batch_not_current", "trainer_not_available", "unchanged"]) assert.equal(lib.assignRefusalMessage(r), lib.ASSIGN_REASON_MESSAGE[r]);
  for (const r of ["weird", "toString", "__proto__", "constructor", undefined, 1]) assert.equal(lib.assignRefusalMessage(r), lib.ASSIGN_GENERIC_ERROR, String(r));
  assert.equal(lib.assignSuccessMessage(null), "Trainer assigned.");
  assert.equal(lib.assignSuccessMessage(OTHER), "Trainer changed.");
});

// ---------------------------------------------------------------- repository (stand-in client)

function fakeClient({ rpc, trainers } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) { calls.push(["rpc", fn, args]); return rpc ? rpc(fn, args) : { data: { ok: true, previous: null, trainer_id: args.p_trainer_id }, error: null }; },
    from(table) {
      calls.push(["from", table]);
      const q = { select(cols) { calls.push(["select", cols]); return q; }, order() { return q; }, then(res, rej) { return Promise.resolve(trainers ?? { data: [], error: null }).then(res, rej); } };
      return q;
    },
  };
}
const repoWith = (c) => createBatchTrainerRepository(async () => c);

test("repository: calls only admin_assign_batch_trainer with exactly the two ids; maps results; 42501 → permission error", async () => {
  const c = fakeClient();
  assert.deepEqual(await repoWith(c).assignTrainer(BATCH, TRAINER), { ok: true, previousTrainerId: null, trainerId: TRAINER });
  assert.deepEqual(c.calls, [["rpc", "admin_assign_batch_trainer", { p_batch_id: BATCH, p_trainer_id: TRAINER }]]);
  const changed = fakeClient({ rpc: () => ({ data: { ok: true, previous: OTHER, trainer_id: TRAINER }, error: null }) });
  assert.deepEqual(await repoWith(changed).assignTrainer(BATCH, TRAINER), { ok: true, previousTrainerId: OTHER, trainerId: TRAINER });
  const refused = fakeClient({ rpc: () => ({ data: { ok: false, reason: "batch_not_current" }, error: null }) });
  assert.deepEqual(await repoWith(refused).assignTrainer(BATCH, TRAINER), { ok: false, reason: "batch_not_current" });
  await quiet(async () => {
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: null, error: { code: "42501", message: "nope" } }) })).assignTrainer(BATCH, TRAINER), BatchTrainerPermissionError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: null, error: { code: "XX000" } }) })).assignTrainer(BATCH, TRAINER), BatchTrainerRepositoryError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => ({ data: "odd", error: null }) })).assignTrainer(BATCH, TRAINER), BatchTrainerRepositoryError);
    await assert.rejects(repoWith(fakeClient({ rpc: () => { throw new Error("down"); } })).assignTrainer(BATCH, TRAINER), BatchTrainerRepositoryError);
    await assert.rejects(createBatchTrainerRepository(async () => null).assignTrainer(BATCH, TRAINER), BatchTrainerRepositoryError);
  });
});

test("repository: only available trainers are listed (record active, trainer role, active account)", async () => {
  const c = fakeClient({ trainers: { error: null, data: [
    { id: "a", full_name: "Ana", status: "active", profiles: { role: "trainer", account_status: "active" } },
    { id: "b", full_name: "Ben", status: "active", profiles: { role: "trainer", account_status: "suspended" } },
    { id: "c", full_name: "Cid", status: "active", profiles: { role: "trainer", account_status: "invited" } },
    { id: "d", full_name: "Dee", status: "inactive", profiles: { role: "trainer", account_status: "active" } },
    { id: "e", full_name: "Eve", status: "active", profiles: { role: "student", account_status: "active" } },
    { id: "f", full_name: "Fay", status: "active", profiles: null },
    { id: "g", full_name: "Gus", status: "active", profiles: [{ role: "trainer", account_status: "active" }] },
  ] } });
  assert.deepEqual(await repoWith(c).listAvailableTrainers(), [{ id: "a", name: "Ana" }, { id: "g", name: "Gus" }]);
  assert.deepEqual(c.calls.slice(0, 2), [["from", "trainers"], ["select", "id, full_name, status, profiles ( role, account_status )"]]);
});

// ---------------------------------------------------------------- service

function service(role, over = {}) {
  const calls = [];
  const repository = {
    async assignTrainer(b, t) { calls.push(["assign", b, t]); if (over.throws) throw over.throws; return over.result ?? { ok: true, previousTrainerId: null, trainerId: t }; },
    async listAvailableTrainers() { calls.push(["list"]); return [{ id: TRAINER, name: "T" }]; },
  };
  return { calls, svc: createBatchTrainerService({ repository, getCurrentUser: async () => (role ? user(role) : null) }) };
}

test("service: Super Admin only — trainers, students and signed-out callers are refused before the database", async () => {
  for (const role of ["trainer", "student", null]) {
    const { calls, svc } = service(role);
    await assert.rejects(svc.assignTrainer(BATCH, TRAINER), BatchTrainerAuthorizationError, String(role));
    await assert.rejects(svc.listAvailableTrainers(), BatchTrainerAuthorizationError, String(role));
    assert.deepEqual(calls, [], "nothing reached the repository");
  }
});

test("service: invalid ids never reach the database; outcomes become fixed sentences", async () => {
  let { calls, svc } = service("admin");
  assert.deepEqual(await svc.assignTrainer("nope", TRAINER), { ok: false, error: "Choose a valid batch." });
  assert.deepEqual(await svc.assignTrainer(BATCH, null), { ok: false, error: "Choose a trainer." });
  assert.deepEqual(calls, []);

  ({ calls, svc } = service("admin"));
  assert.deepEqual(await svc.assignTrainer(BATCH, TRAINER), { ok: true, message: "Trainer assigned." });
  assert.deepEqual(calls, [["assign", BATCH, TRAINER]]);
  assert.deepEqual(await service("admin", { result: { ok: true, previousTrainerId: OTHER, trainerId: TRAINER } }).svc.assignTrainer(BATCH, TRAINER), { ok: true, message: "Trainer changed." });
  for (const reason of ["not_found", "batch_not_current", "trainer_not_available", "unchanged", "brand_new"]) {
    assert.deepEqual(await service("admin", { result: { ok: false, reason } }).svc.assignTrainer(BATCH, TRAINER), { ok: false, error: lib.assignRefusalMessage(reason) }, reason);
  }
  assert.deepEqual(await service("admin", { throws: new BatchTrainerPermissionError() }).svc.assignTrainer(BATCH, TRAINER), { ok: false, error: lib.ASSIGN_PERMISSION_ERROR });
  assert.deepEqual(await service("admin", { throws: new Error("raw db text") }).svc.assignTrainer(BATCH, TRAINER), { ok: false, error: lib.ASSIGN_GENERIC_ERROR }, "raw errors never surface");
});

// ---------------------------------------------------------------- Add Batch: the 0021 refusal

test("Add Batch: the 0021 guard's refusal (23514 + hint trainer_not_available) becomes a trainer field error", async () => {
  assert.equal(classifyBatchInsertError({ code: "23514", hint: "trainer_not_available" }), "trainer_unavailable");
  assert.equal(classifyBatchInsertError({ code: "23514", hint: "" }), "rejected", "other check violations unchanged");
  assert.equal(classifyBatchInsertError({ code: "23514" }), "rejected");
  const deps = {
    getCurrentUser: async () => user("admin"),
    getOptions: async () => ({ courses: [{ id: "c1", name: "C", selectable: true }], trainers: [{ id: "t1", name: "T", selectable: true }] }),
    insert: async () => { throw Object.assign(new Error("x"), { code: "23514", hint: "trainer_not_available" }); },
    classify: classifyBatchInsertError,
  };
  const input = { batchCode: "B-1", name: "Batch", courseId: "c1", trainerId: "t1", startDate: "2027-01-01", endDate: "2027-02-01", maxSeats: 10 };
  await assert.rejects(createBatchWith(deps, input), (e) => e instanceof BatchCreateValidationError && /isn't available/.test(e.errors.trainerId));
});

// ---------------------------------------------------------------- source boundaries

const P36_FILES = [
  "src/lib/batches/assign-trainer.ts",
  "src/repositories/batch-trainer.repository.core.ts",
  "src/repositories/batch-trainer.repository.ts",
  "src/services/batch-trainer.service.core.ts",
  "src/services/batch-trainer.service.ts",
  "src/services/batches.actions.ts",
  "src/components/modules/AssignTrainerDialog.tsx",
  "src/components/modules/BatchesTable.tsx",
  "src/app/admin/batches/page.tsx",
  "src/repositories/batches.repository.ts",
  "src/services/batches.service.ts",
];
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

test("boundary: no service role, no admin client, no Auth Admin in any P3.6 file", () => {
  for (const rel of P36_FILES) {
    const code = strip(src(rel));
    for (const spec of importsOf(code)) assert.doesNotMatch(spec, /supabase\/admin|auth-admin/, `${rel} imports ${spec}`);
    assert.doesNotMatch(code, /SUPABASE_SERVICE_ROLE_KEY|service_role|createSupabaseAdminClient|auth\.admin/, rel);
  }
  assert.match(src("src/repositories/batch-trainer.repository.ts"), /createSupabaseServerClient/, "the session (cookie) client");
  for (const rel of ["src/repositories/batch-trainer.repository.ts", "src/services/batch-trainer.service.ts"]) assert.match(src(rel), /^import "server-only";/, rel);
});

test("boundary: the only RPC is admin_assign_batch_trainer; trainer_id is never written directly by the app", () => {
  const repo = strip(src("src/repositories/batch-trainer.repository.core.ts"));
  assert.deepEqual([...repo.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]), ["admin_assign_batch_trainer"]);
  assert.doesNotMatch(repo, /\.(insert|update|upsert|delete)\(/);
  for (const rel of P36_FILES) {
    const code = strip(src(rel));
    if (rel !== "src/repositories/batch-trainer.repository.core.ts") assert.doesNotMatch(code, /\.rpc\(/, `${rel}: no RPC outside the repository`);
    assert.doesNotMatch(code, /\.update\([^)]*trainer_id|unassign|removeTrainer|remove_trainer/i, `${rel}: no direct trainer write, no removal`);
  }
});

test("action: Super Admin service only, exactly two ids taken from the browser, fixed messages, error names only in logs", () => {
  const actions = src("src/services/batches.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.deepEqual([...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["createBatchAction", "assignBatchTrainerAction"]);
  assert.match(actions, /export async function assignBatchTrainerAction\(batchId: string, trainerId: string\)/);
  assert.match(actions, /batchTrainerService\.assignTrainer\(batchId, trainerId\)/);
  const assignPart = actions.slice(actions.indexOf("export async function assignBatchTrainerAction"));
  assert.match(assignPart, /console\.error\("\[batches\.actions\] assignBatchTrainer:", err instanceof Error \? err\.name : "unknown error"\)/);
});

test("client boundary: the dialog and table import only actions, pure rules and UI; the action item is admin-only", () => {
  for (const rel of ["src/components/modules/AssignTrainerDialog.tsx", "src/components/modules/BatchesTable.tsx"]) {
    const code = src(rel);
    assert.match(code, /^"use client";/, rel);
    for (const spec of importsOf(code)) {
      assert.ok(
        ["react", "next/navigation", "lucide-react", "@/services/batches.actions", "@/lib/batches/assign-trainer", "@/utils/format", "@/types/batch", "@/components/modules/AssignTrainerDialog"].includes(spec) ||
          spec.startsWith("@/components/ui/"),
        `${rel} imports ${spec}`
      );
    }
  }
  const table = strip(src("src/components/modules/BatchesTable.tsx"));
  assert.match(table, /\{assignment && \(\s*<DropdownItem\s+disabled=\{!isAssignableBatchStatus\(b\.status\)\}/, "only with the admin-only prop, disabled for completed/cancelled");
  assert.match(table, /assignment && b\.trainerUnavailable/, "unavailable trainers flagged (admin view)");
  assert.doesNotMatch(src("src/app/trainer/batches/page.tsx"), /assignment=/, "the trainer portal never gets the action");
  assert.match(src("src/app/admin/batches/page.tsx"), /<BatchesTable rows=\{batches\} assignment=\{\{ trainers \}\} \/>/);
});
