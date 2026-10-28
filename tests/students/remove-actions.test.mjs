// Phase 7 P3.11-B — Remove student / trainer (source-level). Remove = deactivate (suspend) after an explicit
// confirmation; nothing is deleted. The browser sends only the account id to a dedicated server action; the
// service re-checks Super Admin, the target's role and (trainer) current assignments; the existing
// admin_set_account_status function does the change. No service role, no direct table writes, no deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const DIALOG = "src/components/modules/RemoveAccountDialog.tsx";
const TRAINERS = "src/app/admin/trainers/TrainersTable.tsx";
const ACTIONS = "src/services/users.actions.ts";
const SERVICE = "src/services/users.service.core.ts";
const REPO = "src/repositories/users.repository.core.ts";

test("dialog: explicit confirmation; explains deactivation and that nothing is deleted; id only; no duplicate submits", () => {
  const d = strip(src(DIALOG));
  assert.match(d, /^"use client";/);
  assert.match(d, /import \{ removeStudentAccountAction, removeTrainerAccountAction \} from "@\/services\/users\.actions";/);
  assert.match(d, /kind === "student" \? await removeStudentAccountAction\(target\.id\) : await removeTrainerAccountAction\(target\.id\)/, "only the id is sent");
  assert.match(d, /title: "Remove this student\?"/);
  assert.match(d, /title: "Remove this trainer\?"/);
  assert.match(d, /account is deactivated: they can no longer sign in/);
  assert.equal((d.match(/Nothing is deleted\./g) ?? []).length, 2, "both texts say nothing is deleted");
  assert.match(d, /current batches or scheduled classes can't be removed until those are reassigned/);
  assert.match(d, /isLoading=\{isPending\} disabled=\{isPending\} onClick=\{confirm\}/, "the confirm button is disabled while pending");
  assert.match(d, /if \(!target \|\| isPending\) return;/, "a second click while pending does nothing");
  assert.match(d, /onClose=\{isPending \? \(\) => undefined : onClose\}/, "cannot be dismissed mid-request");
  assert.match(d, /role="alert"/, "a refusal (e.g. reassign first) stays readable in the dialog");
  assert.doesNotMatch(d, /setAccountStatusAction|\.delete\(|deleteUser|createSupabase|supabase\.from|service_role/i, "no other path to the database");
});

test("Trainers table: the Remove placeholder is replaced by the confirmed Remove (trainer kind) for removable accounts", () => {
  const t = strip(src(TRAINERS));
  assert.doesNotMatch(t, /notImplemented\("Remove trainer"\)/);
  assert.match(t, /\{canRemove\(t\) && \(\s*<DropdownItem onClick=\{\(\) => setRemoveTarget\(\{ id: t\.id, name: t\.name \}\)\} className="text-signal-red">\s*<Trash2 className="h-3\.5 w-3\.5" \/> Remove\s*<\/DropdownItem>\s*\)\}/);
  assert.match(t, /<RemoveAccountDialog kind="trainer" target=\{removeTarget\} onClose=\{\(\) => setRemoveTarget\(null\)\} \/>/);
  assert.match(t, /return t\.accountStatus !== "suspended" && t\.accountStatus !== "invited";/, "not offered for suspended or invited accounts");
  assert.match(t, /return t\.accountStatus === "suspended" \? "suspended" : t\.status;/, "a removed trainer shows as Suspended");
  assert.doesNotMatch(t, /setAccountStatus|Action\(|delete/i, "no lifecycle call in the table itself");
  // P3.11-C: View profile / Edit trainer are real now (see tests/user-management/trainer-actions.test.mjs).
  assert.doesNotMatch(t, /notImplemented/);
});

test("server actions: one per list, id only, through the users service (session), revalidating the list", () => {
  const a = strip(src(ACTIONS));
  assert.match(a, /^"use server";/);
  assert.match(a, /export async function removeStudentAccountAction\(userId: string\): Promise<UserActionResult> \{\s*return run\("removeStudent", \(\) => usersService\.removeStudent\(userId\), \["\/admin\/students"\]\);/);
  assert.match(a, /export async function removeTrainerAccountAction\(userId: string\): Promise<UserActionResult> \{\s*return run\("removeTrainer", \(\) => usersService\.removeTrainer\(userId\), \["\/admin\/trainers"\]\);/);
});

test("service and repository: role from the database, trainer blockers, the existing status function — never a deletion", () => {
  const s = strip(src(SERVICE));
  assert.match(s, /const viewer = await requireSuperAdmin\(`Only Super Admins can remove \$\{REMOVE_LABEL\[kind\]\}s\.`\);/);
  assert.match(s, /if \(record\.role !== kind\) throw new UsersActionError/, "target role checked server-side");
  assert.match(s, /deps\.repository\.setAccountStatus\(id, "suspended", REMOVE_AUDIT_REASON\[kind\]\)/, "deactivation only, through admin_set_account_status");
  const r = strip(src(REPO));
  assert.match(r, /from\("batches"\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("trainer_id", trainerId\)\.in\("status", \["upcoming", "ongoing"\]\)/);
  assert.match(r, /from\("classes"\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("trainer_id", trainerId\)\.in\("status", \["scheduled", "live"\]\)/);
  for (const code of [s, r, strip(src(DIALOG)), strip(src(ACTIONS))]) {
    assert.doesNotMatch(code, /deleteUser|\.delete\(|createSupabaseAdminClient|SERVICE_ROLE/, "no deletion, no service role");
  }
});
