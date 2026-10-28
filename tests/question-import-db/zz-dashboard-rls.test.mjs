// 0025 — the four classes / class_attendance SELECT policies gain the existing Super Admin condition as
// their first branch (evaluated once per statement). Catalogue: RLS on, still permissive SELECT policies
// with the prefix AND their original condition, every other policy untouched. Isolation: Super Admin,
// current trainer, former trainer (is_class_trainer path), unrelated trainer, enrolled student, student of
// another batch, student without enrolment. Equivalence: each user's complete row sets are compared with
// the pre-0025 policies restored inside a transaction that is rolled back (nothing persists).
// Own fixtures only (dr_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const M0025 = fs.readFileSync(path.resolve(here, "../../supabase/migrations/0025_dashboard_rls_performance.sql"), "utf8");

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const ACCOUNTS = { TA: "trainer", TX: "trainer", TB: "trainer", TN: "trainer", SA: "student", SB: "student", SN: "student" };

/** The four policies before 0025 (as pg_policies printed them), restored only inside rolled-back transactions. */
const PRE_0025 = {
  "classes.classes_trainer_select": "(current_app_role() = 'trainer' and trainer_id = auth.uid())",
  "classes.classes_student_select": "(current_app_role() = 'student' and is_enrolled_in_batch(batch_id))",
  "class_attendance.class_attendance_trainer_select": "(is_batch_trainer(batch_id) or is_class_trainer(class_id))",
  "class_attendance.class_attendance_student_select": "owns_student_record(student_id)",
};
const ROWSETS = {
  classes: "select count(*) || ':' || md5(coalesce(string_agg(id::text, ',' order by id), '')) from public.classes",
  class_attendance: "select count(*) || ':' || md5(coalesce(string_agg(class_id::text || student_id::text || status::text, ',' order by class_id, student_id), '')) from public.class_attendance",
};

const asUser = (uid) => `set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', true);`;
const users = () => ({ super_admin: ids.A, ...Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, X[k]])) });

/** Every user's complete row sets, read in ONE transaction; `restore` puts the pre-0025 policies back first. Always rolled back. */
async function rowsets(restore) {
  const lines = ["begin;"];
  if (restore) {
    for (const [key, using] of Object.entries(PRE_0025)) {
      const [table, policy] = key.split(".");
      lines.push(`alter policy ${policy} on public.${table} using (${using});`);
    }
  }
  for (const [u, uid] of Object.entries(users())) {
    for (const [r, sql] of Object.entries(ROWSETS)) lines.push(`${asUser(uid)} select '${u}.${r}|' || (${sql}); reset role;`);
  }
  lines.push("rollback;");
  const out = await db.run(lines.join("\n"));
  if (out.code) throw new Error(out.stderr);
  return Object.fromEntries(out.stdout.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => l.trim().split("|")));
}

const fixtureCount = async (uid, table) => {
  const filter = table === "classes" ? "id" : "class_id";
  const { data, error } = await db.client({ role: "authenticated", userId: uid }).sql(
    `select count(*) from public.${table} where ${filter} in ('${X.CA1}', '${X.CA2}', '${X.CA3}', '${X.CB1}')`
  );
  if (error) throw new Error(error.message);
  return Number(data);
};

before(async () => {
  for (const k of Object.keys(ACCOUNTS)) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${Object.keys(ACCOUNTS).map((k) => `('${X[k]}', '${k.toLowerCase()}@dr.test')`).join(", ")};
    update public.profiles set account_status = 'active' where id in (${Object.keys(ACCOUNTS).map((k) => `'${X[k]}'`).join(", ")});
    update public.profiles set role = 'trainer' where id in ('${X.TA}', '${X.TX}', '${X.TB}', '${X.TN}');
    insert into public.trainers (id, trainer_code, full_name) values
      ('${X.TA}', 'DR-TA', 'DR Current Trainer'), ('${X.TX}', 'DR-TX', 'DR Former Trainer'), ('${X.TB}', 'DR-TB', 'DR Other Trainer'), ('${X.TN}', 'DR-TN', 'DR Idle Trainer');
    insert into public.students (id, student_code, full_name) values ('${X.SA}', 'DR-SA', 'DR Student A'), ('${X.SB}', 'DR-SB', 'DR Student B'), ('${X.SN}', 'DR-SN', 'DR Student N');`, ids.A);
  // CA3 was taught by TX before the batch was reassigned to TA (the is_class_trainer path); written as the
  // superuser in replication mode so the class keeps its historical trainer.
  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values ('${id("C")}', 'DR-101', 'DR Course', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      ('${id("BA")}', 'DR-BA', '${X.C}', '${X.TA}', 'DR Batch A', '2026-01-01', '2026-12-31', 'ongoing', 10),
      ('${id("BB")}', 'DR-BB', '${X.C}', '${X.TB}', 'DR Batch B', '2026-01-01', '2026-12-31', 'ongoing', 10);
    insert into public.batch_students (batch_id, student_id) values ('${X.BA}', '${X.SA}'), ('${X.BB}', '${X.SB}');
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      ('${id("CA1")}', '${X.C}', '${X.BA}', '${X.TA}', 'DR A1', '2026-02-01', '09:00', '10:00', 'completed'),
      ('${id("CA2")}', '${X.C}', '${X.BA}', '${X.TA}', 'DR A2', '2026-02-08', '09:00', '10:00', 'completed'),
      ('${id("CA3")}', '${X.C}', '${X.BA}', '${X.TX}', 'DR A3 (former trainer)', '2026-01-15', '09:00', '10:00', 'completed'),
      ('${id("CB1")}', '${X.C}', '${X.BB}', '${X.TB}', 'DR B1', '2026-02-01', '09:00', '10:00', 'completed');
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by, marked_at) values
      ('${X.CA1}', '${X.SA}', '${X.BA}', 'present', '${X.TA}', now()), ('${X.CA2}', '${X.SA}', '${X.BA}', 'absent', '${X.TA}', now()),
      ('${X.CA3}', '${X.SA}', '${X.BA}', 'late', '${X.TX}', now()), ('${X.CB1}', '${X.SB}', '${X.BB}', 'present', '${X.TB}', now());
    set session_replication_role = origin;`);
});

// ---------------------------------------------------------------- A. catalogue

test("catalogue: RLS on; the four policies are permissive SELECT policies with the Super Admin branch FIRST and their original condition", async () => {
  assert.deepEqual(await db.admin("select json_agg(relrowsecurity order by relname) from pg_class where oid in ('public.classes'::regclass, 'public.class_attendance'::regclass)"), [true, true]);
  const p = await db.admin(`select json_object_agg(tablename || '.' || policyname, json_build_object('cmd', cmd, 'permissive', permissive, 'roles', roles, 'qual', qual, 'check', with_check))
    from pg_policies where schemaname = 'public' and tablename in ('classes', 'class_attendance')`);
  const four = {
    "classes.classes_trainer_select": [/^\(\(\s*SELECT\s+\(current_app_role\(\) = 'super_admin'::text\)\) OR /, "((current_app_role() = 'trainer'::text) AND (trainer_id = auth.uid()))"],
    "classes.classes_student_select": [/^\(\(\s*SELECT\s+\(current_app_role\(\) = 'super_admin'::text\)\) OR /, "((current_app_role() = 'student'::text) AND is_enrolled_in_batch(batch_id))"],
    "class_attendance.class_attendance_trainer_select": [/^\(\(\s*SELECT\s+is_super_admin\(\) AS is_super_admin\) OR /, "is_batch_trainer(batch_id) OR is_class_trainer(class_id)"],
    "class_attendance.class_attendance_student_select": [/^\(\(\s*SELECT\s+is_super_admin\(\) AS is_super_admin\) OR /, "owns_student_record(student_id)"],
  };
  for (const [key, [prefix, original]] of Object.entries(four)) {
    const x = p[key];
    assert.deepEqual([x.cmd, x.permissive, x.roles, x.check], ["SELECT", "PERMISSIVE", ["authenticated"], null], key);
    assert.match(x.qual, prefix, `${key}: Super Admin branch first`);
    assert.ok(x.qual.includes(original), `${key}: original condition kept — ${x.qual}`);
  }
});

test("catalogue: every other policy on the two tables is exactly as before; no function, table, index, trigger or grant DDL in 0025", async () => {
  const p = await db.admin(`select json_object_agg(tablename || '.' || policyname, json_build_array(cmd, permissive, qual, with_check))
    from pg_policies where schemaname = 'public' and tablename in ('classes', 'class_attendance')`);
  assert.equal(Object.keys(p).length, 10, "five policies per table, none added or dropped");
  assert.deepEqual(p["classes.classes_admin_all"], ["ALL", "PERMISSIVE", "(current_app_role() = 'super_admin'::text)", "(current_app_role() = 'super_admin'::text)"]);
  assert.deepEqual(p["classes.classes_trainer_insert"], ["INSERT", "PERMISSIVE", null, "((current_app_role() = 'trainer'::text) AND (trainer_id = auth.uid()) AND is_batch_trainer(batch_id))"]);
  assert.deepEqual(p["classes.classes_trainer_update"], ["UPDATE", "PERMISSIVE", "((current_app_role() = 'trainer'::text) AND (trainer_id = auth.uid()) AND is_batch_trainer(batch_id))", "((current_app_role() = 'trainer'::text) AND (trainer_id = auth.uid()) AND is_batch_trainer(batch_id))"]);
  assert.deepEqual(p["class_attendance.class_attendance_admin_all"], ["ALL", "PERMISSIVE", "is_super_admin()", "is_super_admin()"]);
  assert.deepEqual(p["class_attendance.class_attendance_trainer_insert"], ["INSERT", "PERMISSIVE", null, "((current_app_role() = 'trainer'::text) AND is_batch_trainer(batch_id))"]);
  assert.deepEqual(p["class_attendance.class_attendance_trainer_update"], ["UPDATE", "PERMISSIVE", "((current_app_role() = 'trainer'::text) AND is_batch_trainer(batch_id))", "((current_app_role() = 'trainer'::text) AND is_batch_trainer(batch_id))"]);
  const ddl = M0025.replace(/--.*$/gm, "");
  assert.doesNotMatch(ddl, /create\s|drop\s|grant\s|revoke\s|alter\s+(table|function|index|role)|disable|force|bypassrls|security\s+definer/i, "only ALTER POLICY statements");
  assert.equal((ddl.match(/alter policy /gi) ?? []).length, 4);
  const helpers = await db.admin(`select json_object_agg(proname, json_build_array(prosecdef, provolatile)) from pg_proc
    where pronamespace = 'public'::regnamespace and proname in ('is_super_admin', 'current_app_role', 'is_batch_trainer', 'is_class_trainer', 'owns_student_record', 'is_enrolled_in_batch')`);
  assert.deepEqual(helpers, { is_super_admin: [false, "s"], current_app_role: [true, "s"], is_batch_trainer: [true, "s"], is_class_trainer: [true, "s"], owns_student_record: [true, "s"], is_enrolled_in_batch: [true, "s"] }, "helpers as before");
});

// ---------------------------------------------------------------- B. isolation

test("isolation: Super Admin, current / former / other / idle trainer, enrolled / other / unenrolled student see exactly what they should", async () => {
  const expect = { // [classes, attendance] among the fixture rows
    [ids.A]: [4, 4],
    [X.TA]: [2, 3],   // own classes A1, A2 (not A3, taught by TX); all attendance of the batch they run
    [X.TX]: [1, 1],   // former trainer: the class they taught (A3) and its attendance — is_class_trainer path
    [X.TB]: [1, 1],
    [X.TN]: [0, 0],
    [X.SA]: [3, 3],   // every class of their batch, their own attendance
    [X.SB]: [1, 1],
    [X.SN]: [0, 0],
  };
  for (const [uid, [classes, attendance]] of Object.entries(expect)) {
    assert.deepEqual([await fixtureCount(uid, "classes"), await fixtureCount(uid, "class_attendance")], [classes, attendance], uid);
  }
  // Nothing at all outside their scope for the idle trainer and the unenrolled student (whole tables).
  const all = await rowsets(false);
  assert.deepEqual([all["TN.classes"], all["TN.class_attendance"], all["SN.classes"], all["SN.class_attendance"]].map((v) => v.split(":")[0]), ["0", "0", "0", "0"]);
});

// ---------------------------------------------------------------- C. equivalence with the pre-0025 policies

test("equivalence: every user's complete classes and class_attendance row sets are identical with and without 0025", async () => {
  const now = await rowsets(false);
  const pre = await rowsets(true);
  assert.equal(Object.keys(now).length, 2 * Object.keys(users()).length);
  assert.deepEqual(now, pre, "zero authorization differences");
  assert.ok(Number(now["super_admin.class_attendance"].split(":")[0]) >= 4);
  // Restoring was transactional: the 0025 expressions are still in place.
  assert.match(await db.admin("select qual from pg_policies where policyname = 'class_attendance_student_select'"), /^\(\(\s*SELECT\s+is_super_admin\(\)/);
});

test("equivalence: writes are unaffected — a trainer still cannot read or change another batch's attendance; the admin still can", async () => {
  const other = await db.client({ role: "authenticated", userId: X.TN }).execute(`update public.class_attendance set remarks = 'x' where class_id = '${X.CB1}'`);
  assert.equal(other.error, null);
  assert.equal(await db.admin(`select remarks from public.class_attendance where class_id = '${X.CB1}'`), null, "no row visible to update");
  const student = await db.client({ role: "authenticated", userId: X.SA }).execute(`update public.class_attendance set remarks = 'x' where class_id = '${X.CA1}'`);
  assert.ok(student.error || (await db.admin(`select remarks from public.class_attendance where class_id = '${X.CA1}'`)) === null, "students cannot change attendance");
});
