// Phase 7 P3.10-C / P3.11-A / P3.11-B — Students row actions (source-level, plus the real link helper).
// P3.10-C: trainers have no remove / deactivate / delete authority, so the trainer menu never offers Remove;
// the trainer Edit action (P3.10-B) is untouched. P3.11-A: in the Super Admin menu "View profile" and "Edit"
// open the student's existing account panel (/admin/users?user=<id>). P3.11-B: the Super Admin menu offers a
// confirmed Remove (deactivate — see remove-actions.test.mjs); the trainer menu still never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const TABLE = "src/components/modules/StudentsTable.tsx";
const users = await import(`${process.env.STUDENTS_BUILD}/lib/user-management/users.mjs`);

test("Remove only in the Super Admin menu (never in trainer mode); the table itself performs no lifecycle change", () => {
  const table = strip(src(TABLE));
  assert.doesNotMatch(table, /notImplemented\("Remove student"\)/, "the old placeholder is gone");
  assert.equal((table.match(/>\s*Remove\s*</g) ?? []).length, 1, "one Remove item");
  assert.match(
    table,
    /\{!trainerEdit && canRemove\(s\) && \(\s*<DropdownItem onClick=\{\(\) => setRemoveTarget\(\{ id: s\.id, name: s\.name \}\)\} className="text-signal-red">\s*<Trash2 className="h-3\.5 w-3\.5" \/> Remove\s*<\/DropdownItem>\s*\)\}/,
    "Remove only outside trainer mode, only for removable accounts, and it only opens the confirmation"
  );
  assert.match(table, /\{!trainerEdit && <RemoveAccountDialog kind="student" target=\{removeTarget\} onClose=\{\(\) => setRemoveTarget\(null\)\} \/>\}/, "the dialog never renders in trainer mode");
  assert.doesNotMatch(table, /Deactivate|Delete|setAccountStatus|deleteUser|setEnrollment|withdraw|Action\(/i, "no server action or lifecycle call in the table itself");
  assert.match(src("src/app/trainer/students/page.tsx"), /<StudentsTable rows=\{students\} trainerEdit \/>/, "the trainer page renders trainer mode");
});

test("trainer mode (P5.0): no View profile placeholder and never the Super Admin account panel; no empty menu", () => {
  const table = strip(src(TABLE));
  assert.match(
    table,
    /\{!trainerEdit && \(\s*<DropdownItem onClick=\{\(\) => openAccount\(s\.id\)\}>\s*<Eye className="h-3\.5 w-3\.5" \/> View profile\s*<\/DropdownItem>\s*\)\}/,
    "View profile is Super Admin only (trainers have no student profile page)"
  );
  assert.equal((table.match(/> View profile/g) ?? []).length, 1, "one View profile item");
  assert.doesNotMatch(table, /notImplemented|isn't wired up|presentation-only|useToast/, "no placeholder toasts left");
  assert.match(table, /\{\(!trainerEdit \|\| s\.editable === true\) && \(\s*<Dropdown/, "a trainer row without actions shows no menu");
  assert.equal((table.match(/openAccount\(s\.id\)/g) ?? []).length, 1, "the view-mode panel is opened only from the Super Admin View profile");
  assert.equal((table.match(/editAccount\(s\.id\)/g) ?? []).length, 1, "the edit-mode panel only from the Super Admin Edit");
});

test("Super Admin menu (P3.11-A): View profile and Edit open the student's existing account panel", () => {
  const table = strip(src(TABLE));
  const admin = src("src/app/admin/students/page.tsx");
  assert.match(admin, /<StudentsTable rows=\{students\} \/>/, "the admin page renders the default (Super Admin) mode");
  assert.doesNotMatch(admin, /trainerEdit/, "the admin page never enables trainer mode");
  assert.match(table, /trainerEdit = false/, "trainer mode is off by default — Super Admin rendering is the default");
  // P3.11-D: the Super Admin Edit opens the panel WITH its existing student details form open (&edit=details) —
  // before, it opened the view-only panel and the editor never appeared. Only for a current student account.
  assert.match(
    table,
    /\{!trainerEdit \? \(\s*canEditAsStudent\(s\) \? \(\s*<DropdownItem onClick=\{\(\) => editAccount\(s\.id\)\}>\s*<Pencil className="h-3\.5 w-3\.5" \/> Edit\s*<\/DropdownItem>\s*\) : null\s*\)/,
    "admin Edit opens the account panel's details form"
  );
  assert.match(table, /router\.push\(userEditDetailsHref\(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, studentId\)\)/);
  assert.match(table, /function canEditAsStudent\(s: StudentSummary\): boolean \{\s*return s\.accountRole === "student";\s*\}/, "stale student records are not offered Edit");
  assert.match(src("src/repositories/students.repository.ts"), /profiles!students_id_fkey \( account_status, role \),/);
  assert.equal(users.userEditDetailsHref("/admin/users", users.DEFAULT_USER_FILTERS, "e898f643-7ff5-42a2-ad26-17b703a64e90"), "/admin/users?user=e898f643-7ff5-42a2-ad26-17b703a64e90&edit=details");
  assert.match(table, /const ADMIN_USERS_PATH = "\/admin\/users";/);
  assert.match(table, /router\.push\(userDetailHref\(ADMIN_USERS_PATH, DEFAULT_USER_FILTERS, studentId\)\)/, "navigation reuses the Users page's own link helper");
  assert.doesNotMatch(table, /notImplemented\("Edit student"\)/, "the admin Edit placeholder is gone");

  // The real helper: exactly /admin/users?user=<id> (id encoded), the URL the Users page reads (?user=).
  assert.equal(users.userDetailHref("/admin/users", users.DEFAULT_USER_FILTERS, "8a2f6c1e-0000-4000-8000-000000000001"), "/admin/users?user=8a2f6c1e-0000-4000-8000-000000000001");
  assert.equal(users.userDetailHref("/admin/users", users.DEFAULT_USER_FILTERS, "a b&c"), "/admin/users?user=a%20b%26c");
  assert.match(src("src/app/admin/users/page.tsx"), /const selected = typeof searchParams\.user === "string" \? searchParams\.user : null;/, "the Users page opens the panel from ?user=");
});

test("trainer Edit (P3.10-B) untouched: still only on editable rows, still opens the trainer dialog", () => {
  const table = strip(src(TABLE));
  assert.match(table, /\) : s\.editable === true \? \(\s*<DropdownItem onClick=\{\(\) => setEditTarget\(\{ id: s\.id, name: s\.name \}\)\}>/);
  assert.match(table, /\{trainerEdit && <TrainerEditStudentDialog student=\{editTarget\} onClose=\{\(\) => setEditTarget\(null\)\} \/>\}/);
});
