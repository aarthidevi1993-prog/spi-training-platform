// Phase 7 P3.8 slice 3B — Withdraw / Mark completed / Re-enrol on the Super Admin roster (source-level tests).
// A client component that only calls setEnrollmentAction with one of three fixed statuses, after a
// confirmation: no Supabase, no RPC, no table access; name/code only; optional reason ≤ 500 with a
// counter; busy guard; fixed server message inside the dialog on failure; toast + refresh on success.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
const DIALOG = "src/components/modules/EnrollmentStatusDialog.tsx";

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
  assert.doesNotMatch(code, /email|phone|account_?status|accountStatus|organization|designation/i, "no private data");
});

test("mutation: one setEnrollmentAction call whose status comes only from the fixed three-entry mapping; no trainer action", () => {
  const code = strip(src(DIALOG));
  assert.equal((code.match(/setEnrollmentAction\(/g) ?? []).length, 1, "exactly one call");
  const calls = [...code.matchAll(/await setEnrollmentAction\(([\s\S]*?)\)\.catch\(/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(calls, [`batchId, student.studentId, change.status, reason.trim() || null`]);
  assert.match(code, /const change = CHANGES\[target\];/, "the status is looked up in the fixed table");
  const statuses = [...code.matchAll(/status: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(statuses, ["withdrawn", "completed", "enrolled"], "withdraw → withdrawn, complete → completed, re-enrol → enrolled");
  assert.match(code, /withdraw: \{ status: "withdrawn",/);
  assert.match(code, /complete: \{ status: "completed",/);
  assert.match(code, /reEnrol: \{ status: "enrolled",/);
  assert.match(code, /\} as const;\ntype ChangeKey = keyof typeof CHANGES;/, "keys limited to the table");
  assert.doesNotMatch(code, /trainerEnrolStudentAction|bulk/i);
  assert.match(code, /\.catch\(\(\) => \(\{\s*ok: false as const,\s*error: ENROLLMENT_GENERIC_ERROR,\s*\}\)\)/, "a thrown action becomes the generic sentence");
  assert.match(code, /if \(!result\.ok\) \{\s*setError\(result\.error\);\s*return;\s*\}/, "failure: the fixed sentence inside the dialog, which stays open");
});

test("controls: buttons only from the row's server-computed actions; nothing for a completed / cancelled row", () => {
  const code = strip(src(DIALOG));
  assert.match(code, /const available = ORDER\.filter\(\(key\) => student\.actions\[key\]\);/);
  assert.match(code, /if \(available\.length === 0\) return <span className="text-ink-faint">—<\/span>;/);
  assert.match(code, /onClick=\{\(\) => openDialog\(key\)\}/, "a row button only opens the confirmation");
  assert.equal((code.match(/onClick=\{submit\}/g) ?? []).length, 1, "the mutation runs only from the dialog's confirm button");
  assert.doesNotMatch(code, /seatsUsed >= maxSeats[^\n]*disabled|disabled=\{[^}]*seatsUsed/, "re-enrol is not disabled by the displayed seat count");
  assert.match(code, /Batch appears full; the database will check\./);
});

test("UX: titles, confirm labels, consequences, status change badges, reason ≤ 500 with counter, busy guard, toast + close + refresh", () => {
  const code = strip(src(DIALOG));
  for (const s of [
    `title: "Withdraw this student?", confirm: "Withdraw student"`,
    `title: "Mark enrolment as completed?", confirm: "Mark completed"`,
    `title: "Re-enrol this student?", confirm: "Re-enrol student"`,
    "leaves the active roster and frees a seat. Any test in progress is ended and graded now. They can't start tests or submit work in this batch. You can re-enrol them later while the batch is upcoming or ongoing (seats permitting). The change is kept in the enrolment history.",
    "Completion is final: it can't be withdrawn or undone. Any test in progress is ended and graded now. This doesn't issue a certificate; certificates follow the completion workflow. The change is kept in the enrolment history.",
    "returns to the active roster and takes a seat (${seatsUsed}/${maxSeats} used). Seats, the student's availability and the batch status are checked again when you confirm. The earlier withdrawal stays in the history; the original enrolment date is kept.",
  ]) {
    assert.ok(code.includes(s), `contains: ${s.slice(0, 50)}…`);
  }
  assert.match(code, /<StatusBadge status=\{student\.status\} \/>/, "current status");
  assert.match(code, /<StatusBadge status=\{change\.status\} \/>/, "new status");
  assert.match(code, /maxLength=\{REASON_MAX_LENGTH\}/);
  assert.match(code, /reason\.trim\(\)\.length > REASON_MAX_LENGTH/);
  assert.match(code, /\{reason\.trim\(\)\.length\}\/\{REASON_MAX_LENGTH\}/, "visible counter");
  assert.match(code, /if \(isPending \|\| !target \|\| !isUuid\(student\.studentId\)\) return;/, "no double submit");
  assert.match(code, /isLoading=\{isPending\} disabled=\{isPending\}/);
  assert.match(code, /function close\(\) \{\s*if \(!isPending\) setTarget\(null\);\s*\}/, "can't be dismissed mid-request");
  assert.match(code, /showToast\(\{ variant: "success", title: result\.message/, "the server's success sentence");
  assert.match(code, /setTarget\(null\);\s*router\.refresh\(\);/, "close, then re-render the server page");
  assert.doesNotMatch(code, /router\.(push|replace)|redirect\(/, "no navigation");
});

test("the status dialog is used only by the batch detail view", () => {
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && rel !== DIALOG && /EnrollmentStatusDialog/.test(src(rel))) users.push(rel);
    }
  };
  walk("src");
  assert.deepEqual(users, ["src/components/modules/BatchDetailView.tsx"]);
});
