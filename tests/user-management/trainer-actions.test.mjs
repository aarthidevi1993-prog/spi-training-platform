// Phase 7 P3.11-C — Super Admin Trainers list: View profile and Edit trainer (source-level + the real link helpers).
// Both reuse the existing Users account panel (/admin/users?user=<id>); Edit opens that panel's existing details
// form (&edit=details), which saves through updateUserDetailsAction → usersService.updateDetails →
// admin_update_trainer. Edit is offered only when the account's current role is trainer (a stale trainer record
// would otherwise open the account's other record). No new editing system, no status or role change.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.UM_BUILD;
if (!build) throw new Error("Run through tests/user-management/run.mjs");
const U = await import(`${build}/lib/user-management/users.mjs`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const TABLE = "src/app/admin/trainers/TrainersTable.tsx";
const PANEL = "src/components/modules/UserDetailPanel.tsx";
const PAGE = "src/app/admin/users/page.tsx";
const ID = "0b3e3bff-fbfa-4298-8b6f-85405cbf6bb3";

test("link helpers: View profile → /admin/users?user=<id>; Edit → the same panel with &edit=details (id encoded)", () => {
  assert.equal(U.userDetailHref("/admin/users", U.DEFAULT_USER_FILTERS, ID), `/admin/users?user=${ID}`);
  assert.equal(U.userEditDetailsHref("/admin/users", U.DEFAULT_USER_FILTERS, ID), `/admin/users?user=${ID}&edit=details`);
  assert.equal(U.userEditDetailsHref("/admin/users", U.DEFAULT_USER_FILTERS, "a b&c"), "/admin/users?user=a%20b%26c&edit=details");
  assert.equal(U.EDIT_DETAILS_PARAM, "details");
  // The edit param never leaks into the list filters (they are parsed from a whitelist).
  assert.deepEqual(U.parseUserListFilters({ user: ID, edit: "details" }), U.DEFAULT_USER_FILTERS);
});

test("Trainers table: each row's own id; View profile for every row; Edit only for a current trainer; no placeholders", () => {
  const t = strip(src(TABLE));
  assert.doesNotMatch(t, /notImplemented|isn't wired up/, "no presentation-only toast left");
  assert.match(t, /<DropdownItem onClick=\{\(\) => router\.push\(userDetailHref\(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, t\.id\)\)\}>\s*<Eye className="h-3\.5 w-3\.5" \/> View profile/);
  assert.match(
    t,
    /\{canEditAsTrainer\(t\) && \(\s*<DropdownItem onClick=\{\(\) => router\.push\(userEditDetailsHref\(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, t\.id\)\)\}>\s*<Pencil className="h-3\.5 w-3\.5" \/> Edit\s*<\/DropdownItem>\s*\)\}/
  );
  assert.match(t, /function canEditAsTrainer\(t: TrainerSummary\): boolean \{\s*return t\.accountRole === "trainer";\s*\}/, "stale trainer records are not offered Edit");
  assert.match(t, /const ADMIN_USERS_PATH = "\/admin\/users";/);
  assert.match(t, /<TableRow key=\{t\.id\}>/);
  assert.doesNotMatch(t, /updateUserDetailsAction|setAccountStatus|changeUserRole|supabase/i, "the table performs no change itself");
  // Remove (P3.11-B) unchanged.
  assert.match(t, /\{canRemove\(t\) && \(\s*<DropdownItem onClick=\{\(\) => setRemoveTarget\(\{ id: t\.id, name: t\.name \}\)\} className="text-signal-red">/);
});

test("Users page and panel: &edit=details opens the existing details form only where the panel offers editing", () => {
  const page = strip(src(PAGE));
  assert.match(page, /const editDetails = searchParams\.edit === EDIT_DETAILS_PARAM;/);
  assert.match(page, /<UserDetailPanel detail=\{detail\} closeHref=\{usersHref\(BASE_PATH, data\.filters\)\} initialEdit=\{editDetails\} \/>/);
  assert.match(page, /if \(selected\) detail = await usersService\.getUserDetail\(selected\);/, "the account comes from the server (Super Admin re-checked)");
  const panel = strip(src(PANEL));
  assert.match(panel, /const canStartEditing = initialEdit && a\.editDetails && detail\.contact !== null;/);
  assert.match(panel, /const \[editing, setEditing\] = useState\(canStartEditing\);/);
  // The form is the existing one: populated from the record, saved through the existing server action.
  assert.match(panel, /const \[fullName, setFullName\] = useState\(contact\.fields\.fullName\);/);
  assert.match(panel, /run\(\(\) => updateUserDetailsAction\(detail\.user\.id, details\), onCancel\);/);
  // Editing offers no status / role fields.
  const form = panel.slice(panel.indexOf("function DetailsForm("), panel.indexOf("function DetailsView("));
  assert.doesNotMatch(form, /setAccountStatusAction|changeUserRoleAction|account_?status|role/i);
});

test("trainer list rows carry the account's role from the profile (stale trainer records are detectable)", () => {
  const repo = src("src/repositories/trainers.repository.ts");
  assert.match(repo, /profiles!trainers_id_fkey \( account_status, role \),/);
  assert.match(repo, /accountRole: accountRoleOf\(row\.profiles\),/);
});
