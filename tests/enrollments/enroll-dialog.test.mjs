// Phase 7 P3.8 slice 3A — "+ Enrol student" dialog (source-level tests).
// A client component that only calls setEnrollmentAction(…, "enrolled", …): no Supabase, no RPC, no
// table writes, no other enrolment action; name/code only; one student; optional reason ≤ 500;
// busy guard; fixed server message on failure; toast + refresh on success; "Batch full" when full.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const DIALOG = "src/components/modules/EnrollStudentDialog.tsx";

test("boundary: a client component importing only React/Next navigation, icons, UI, the server action and the pure lib", () => {
  const raw = src(DIALOG);
  assert.match(raw, /^"use client";/);
  for (const spec of importsOf(raw)) {
    assert.ok(
      ["react", "next/navigation", "lucide-react", "@/services/enrollment.actions", "@/lib/enrollments/enrollment"].includes(spec) || spec.startsWith("@/components/ui/"),
      `imports ${spec}`
    );
  }
  const code = strip(raw);
  assert.doesNotMatch(code, /supabase|\.from\(|\.rpc\(|batch_students|enrollment_events|service_role|SUPABASE_SERVICE_ROLE_KEY|@\/repositories|enrollment\.service/i, "no database access of any kind");
  assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/);
});

test("mutation: admin mode only setEnrollmentAction(batchId, student.id, \"enrolled\", reason); trainer mode (P3.10-A) only trainerEnrolStudentAction(batchId, student.id) — no withdraw / complete / re-enrol", () => {
  const code = strip(src(DIALOG));
  assert.equal((code.match(/setEnrollmentAction\(/g) ?? []).length, 1, "exactly one admin call");
  const calls = [...code.matchAll(/await setEnrollmentAction\(([\s\S]*?)\)\.catch\(/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(calls, [`batchId, student.id, "enrolled", reason.trim() || null`]);
  assert.equal((code.match(/trainerEnrolStudentAction\(/g) ?? []).length, 1, "exactly one trainer call");
  assert.match(code, /await trainerEnrolStudentAction\(batchId, student\.id\)\.catch\(failed\)/, "trainer: ids only — no status, no reason");
  assert.match(code, /const trainer = mode === "trainer";/);
  assert.match(code, /mode = "admin",/, "admin is the default — existing callers are unchanged");
  assert.match(code, /const result = trainer\s*\? await trainerEnrolStudentAction/, "the mode alone picks the action");
  assert.doesNotMatch(code, /"withdrawn"|"completed"|reEnrol|bulk/);
  assert.match(code, /const failed = \(\) => \(\{ ok: false as const, error: ENROLLMENT_GENERIC_ERROR \}\);/, "a thrown action becomes the generic sentence");
  assert.equal((code.match(/\.catch\(failed\)/g) ?? []).length, 2, "both actions");
  assert.match(code, /\{!trainer && \(\s*<label/, "the reason field is admin-only (the trainer function takes none)");
  assert.match(code, /setError\(result\.error\)/, "failure: the server's fixed sentence only");
});

test("UX: name and code only; search by name or code; one selection (radio); optional reason ≤ 500; busy guard; toast + refresh; Batch full", () => {
  const code = strip(src(DIALOG));
  assert.doesNotMatch(code, /email|phone|account_?status|organization|designation/i, "no private data");
  assert.match(code, /placeholder="Search by name or student code"/);
  assert.match(code, /c\.name\.toLowerCase\(\)\.includes\(q\) \|\| c\.code\.toLowerCase\(\)\.includes\(q\)/);
  assert.match(code, /type="radio"/);
  assert.match(code, /const \[selectedId, setSelectedId\] = useState<string \| null>\(null\)/, "a single selected id");
  assert.match(code, /maxLength=\{REASON_MAX_LENGTH\}/);
  assert.match(code, /reason\.trim\(\)\.length > REASON_MAX_LENGTH/);
  assert.match(code, /if \(isPending \|\| !selected \|\| !isUuid\(selected\.id\)\) return;/, "no double submit, nothing without a selection");
  assert.match(code, /disabled=\{isPending \|\| !selected\}/, "submit disabled until a student is selected and while busy");
  assert.match(code, /showToast\(\{ variant: "success", title: result\.message/);
  assert.match(code, /setOpen\(false\);\s*router\.refresh\(\);/, "close, then re-render the server page (roster, seats, candidates, history)");
  assert.match(code, /const full = seatsUsed >= maxSeats;/);
  assert.match(code, /disabled=\{full\}/);
  assert.match(code, /\{full \? "Batch full" : "Enrol student"\}/);
});

test("the dialog is used only by the batch detail view", () => {
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && rel !== DIALOG && /EnrollStudentDialog/.test(src(rel))) users.push(rel);
    }
  };
  walk("src");
  assert.deepEqual(users, ["src/components/modules/BatchDetailView.tsx"]);
});
