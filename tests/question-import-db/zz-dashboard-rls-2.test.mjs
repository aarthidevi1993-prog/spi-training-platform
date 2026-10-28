// 0026 — six more SELECT policies evaluate their Super Admin check once per statement
// ((select public.is_super_admin())): batches_select, batch_students_select, tests_trainer_select,
// test_questions_staff_select, test_attempt_answers_staff_select, assignment_submissions_trainer_select.
// Catalogue: still permissive SELECT policies for authenticated without WITH CHECK, the non-Super-Admin
// condition unchanged, every other policy on the six tables untouched, helpers untouched, 0026 contains only
// the six ALTER POLICY statements and the dashboard_analytics cap. Isolation: Super Admin (active / suspended),
// current / former / out-of-scope / invited trainer, active / suspended / withdrawn student, anonymous.
// Equivalence: each user's complete row sets of the six tables — and the outcome of INSERT / UPDATE / DELETE
// attempts — are compared with the pre-0026 policies restored inside transactions that are rolled back.
// Own fixtures only (dq_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const M0026 = fs.readFileSync(path.resolve(here, "../../supabase/migrations/0026_dashboard_rls_performance_2.sql"), "utf8");

const X = {};
const id = (k) => (X[k] ??= randomUUID());
// account → [role, account status]
const ACCOUNTS = {
  SAS: ["super_admin", "suspended"],
  TA: ["trainer", "active"],    // current trainer of batch BA
  TX: ["trainer", "active"],    // former trainer: taught class CA3 of BA before the batch was reassigned
  TB: ["trainer", "active"],    // trainer of BB only (out of scope for BA)
  INV: ["trainer", "invited"],  // invited account, set as the trainer of BI
  SA: ["student", "active"],    // enrolled in BA
  SS: ["student", "suspended"], // enrolled in BA, account suspended
  SW: ["student", "active"],    // withdrawn from BA
  SB: ["student", "active"],    // enrolled in BB
};
const SIX = {
  batches: "batches_select",
  batch_students: "batch_students_select",
  tests: "tests_trainer_select",
  test_questions: "test_questions_staff_select",
  test_attempt_answers: "test_attempt_answers_staff_select",
  assignment_submissions: "assignment_submissions_trainer_select",
};

/** The six USING expressions before 0026 (as pg_policies printed them), restored only inside rolled-back transactions. */
const PRE_0026 = {
  batches_select: "(is_super_admin() OR is_batch_trainer(id) OR is_class_trainer_in_batch(id) OR is_enrolled_in_batch(id))",
  batch_students_select: "(is_super_admin() OR (is_batch_trainer(batch_id) AND (enrollment_status <> 'withdrawn'::enrollment_status)) OR ((student_id = ( SELECT auth.uid() AS uid)) AND (current_app_role() = 'student'::text)))",
  tests_trainer_select: "(is_batch_trainer(batch_id) OR is_class_trainer(class_id))",
  test_questions_staff_select: "(EXISTS ( SELECT 1 FROM tests t WHERE ((t.id = test_questions.test_id) AND (is_super_admin() OR is_batch_trainer(t.batch_id)))))",
  test_attempt_answers_staff_select: "(EXISTS ( SELECT 1 FROM test_attempts a WHERE ((a.id = test_attempt_answers.attempt_id) AND (( SELECT is_super_admin() AS is_super_admin) OR is_current_batch_trainer(a.batch_id)))))",
  assignment_submissions_trainer_select: "is_batch_trainer(batch_id)",
};
const SA_ONCE = "( SELECT is_super_admin() AS is_super_admin)";
const norm = (s) => s.replace(/\s+/g, " ");
const restoreSql = () => Object.entries(SIX).map(([t, p]) => `alter policy ${p} on public.${t} using (${PRE_0026[p]});`).join("\n");

const asUser = (uid) => (uid === null ? "set local role anon;" : `set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid })}', true);`);
const users = () => ({ super_admin: ids.A, ...Object.fromEntries(Object.keys(ACCOUNTS).map((k) => [k, X[k]])) });
const rowsetSql = (t) => `select count(*) || ':' || md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.${t} x`;

/** Every user's complete row sets of the six tables, read in ONE transaction; `restore` puts the pre-0026 policies back first. Always rolled back. */
async function rowsets(restore) {
  const lines = ["begin;"];
  if (restore) lines.push(restoreSql());
  for (const [u, uid] of Object.entries(users())) {
    for (const t of Object.keys(SIX)) lines.push(`${asUser(uid)} select '${u}.${t}|' || (${rowsetSql(t)}); reset role;`);
  }
  lines.push("rollback;");
  const out = await db.run(lines.join("\n"));
  if (out.code) throw new Error(out.stderr);
  return Object.fromEntries(out.stdout.split(/\r?\n/).filter((l) => l.includes("|")).map((l) => l.trim().split("|")));
}

/** One statement as a user (or anon), in a transaction that is always rolled back: "ok:<rows>" or the SQLSTATE. */
async function attempt(uid, statement, restore) {
  const out = await db.run(`begin;\n${restore ? restoreSql() : ""}\n${asUser(uid)}\nwith w as (${statement} returning 1) select 'rows|' || count(*) from w;\nrollback;`);
  if (out.code) return (/ERROR:\s+([0-9A-Z]{5})/.exec(out.stderr) ?? [, "error"])[1];
  return `ok:${out.stdout.split(/\r?\n/).find((l) => l.startsWith("rows|")).split("|")[1]}`;
}

const fixtureCount = async (uid, table, column, keys) => {
  const out = await db.run(`begin; ${asUser(uid)} select 'n|' || count(*) from public.${table} where ${column} in (${keys.map((k) => `'${X[k]}'`).join(", ")}); rollback;`);
  if (out.code) return (/ERROR:\s+([0-9A-Z]{5})/.exec(out.stderr) ?? [, "error"])[1];
  return Number(out.stdout.split(/\r?\n/).find((l) => l.startsWith("n|")).split("|")[1]);
};

before(async () => {
  for (const k of Object.keys(ACCOUNTS)) id(k);
  const keys = Object.keys(ACCOUNTS);
  await db.exec(`
    insert into auth.users (id, email) values ${keys.map((k) => `('${X[k]}', '${k.toLowerCase()}@dq.test')`).join(", ")};
    ${keys.map((k) => `update public.profiles set role = '${ACCOUNTS[k][0]}', account_status = '${ACCOUNTS[k][1]}' where id = '${X[k]}';`).join("\n    ")}
    insert into public.trainers (id, trainer_code, full_name) values
      ('${X.TA}', 'DQ-TA', 'DQ Current Trainer'), ('${X.TX}', 'DQ-TX', 'DQ Former Trainer'), ('${X.TB}', 'DQ-TB', 'DQ Other Trainer'), ('${X.INV}', 'DQ-INV', 'DQ Invited Trainer');
    insert into public.students (id, student_code, full_name) values
      ('${X.SA}', 'DQ-SA', 'DQ Student A'), ('${X.SS}', 'DQ-SS', 'DQ Suspended Student'), ('${X.SW}', 'DQ-SW', 'DQ Withdrawn Student'), ('${X.SB}', 'DQ-SB', 'DQ Student B');`, ids.A);
  // Written as the superuser in replication mode (this psql session only) so the historical state is kept:
  // CA3 / its test were taught by TX before batch BA was assigned to TA.
  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values ('${id("C")}', 'DQ-101', 'DQ Course', 'foundation');
    insert into public.questions (id, course_id, module_id, question_text, question_type, marks, status, revision, created_by, updated_by) values
      ('${id("Q1")}', '${X.C}', null, 'DQ q1', 'true_false', 1, 'active', 1, '${ids.A}', '${ids.A}'),
      ('${id("Q2")}', '${X.C}', null, 'DQ q2', 'true_false', 1, 'active', 1, '${ids.A}', '${ids.A}');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      ('${id("BA")}', 'DQ-BA', '${X.C}', '${X.TA}', 'DQ Batch A', '2026-01-01', '2026-12-31', 'ongoing', 10),
      ('${id("BB")}', 'DQ-BB', '${X.C}', '${X.TB}', 'DQ Batch B', '2026-01-01', '2026-12-31', 'ongoing', 10),
      ('${id("BI")}', 'DQ-BI', '${X.C}', '${X.INV}', 'DQ Batch I', '2026-01-01', '2026-12-31', 'ongoing', 10);
    insert into public.batch_students (batch_id, student_id, enrollment_status) values
      ('${X.BA}', '${X.SA}', 'enrolled'), ('${X.BA}', '${X.SS}', 'enrolled'), ('${X.BA}', '${X.SW}', 'withdrawn'), ('${X.BB}', '${X.SB}', 'enrolled');
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      ('${id("CA1")}', '${X.C}', '${X.BA}', '${X.TA}', 'DQ A1', '2026-02-01', '09:00', '10:00', 'completed'),
      ('${id("CA3")}', '${X.C}', '${X.BA}', '${X.TX}', 'DQ A3 (former trainer)', '2026-01-15', '09:00', '10:00', 'completed'),
      ('${id("CB1")}', '${X.C}', '${X.BB}', '${X.TB}', 'DQ B1', '2026-02-01', '09:00', '10:00', 'completed'),
      ('${id("CI1")}', '${X.C}', '${X.BI}', '${X.INV}', 'DQ I1', '2026-02-01', '09:00', '10:00', 'completed');
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ('${id("TA1")}', '${X.CA1}', '${X.BA}', 'quiz', 'DQ test A1', 'closed', 50, 30, 1, '2026-02-01T03:30:00Z', '2026-02-02T03:30:00Z', '${X.TA}', '${X.TA}'),
      ('${id("TA3")}', '${X.CA3}', '${X.BA}', 'quiz', 'DQ test A3', 'closed', 50, 30, 1, '2026-01-15T03:30:00Z', '2026-01-16T03:30:00Z', '${X.TX}', '${X.TX}'),
      ('${id("TB1")}', '${X.CB1}', '${X.BB}', 'quiz', 'DQ test B1', 'closed', 50, 30, 1, '2026-02-01T03:30:00Z', '2026-02-02T03:30:00Z', '${X.TB}', '${X.TB}'),
      ('${id("TI1")}', '${X.CI1}', '${X.BI}', 'quiz', 'DQ test I1', 'closed', 50, 30, 1, '2026-02-01T03:30:00Z', '2026-02-02T03:30:00Z', '${ids.A}', '${ids.A}');
    insert into public.test_questions (id, test_id, position, source_question_id, source_revision, question_text, question_type, marks, added_by) values
      ${["TA1", "TA3", "TB1", "TI1"].flatMap((t) => [1, 2].map((n) => `('${id(`${t}Q${n}`)}', '${X[t]}', ${n}, '${X[`Q${n}`]}', 1, 'DQ tq', 'true_false', 1, '${ids.A}')`)).join(",\n      ")};
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at) values
      ('${id("AT_SA")}', '${X.TA1}', '${X.BA}', '${X.SA}', 1, 'submitted', '2026-02-01T04:00:00Z', '2026-02-01T04:30:00Z', 2, 2, '2026-02-01T04:20:00Z', 'student_submit', 1, 50, true, '2026-02-01T04:20:00Z'),
      ('${id("AT_SS")}', '${X.TA1}', '${X.BA}', '${X.SS}', 1, 'submitted', '2026-02-01T04:00:00Z', '2026-02-01T04:30:00Z', 2, 2, '2026-02-01T04:20:00Z', 'student_submit', 2, 100, true, '2026-02-01T04:20:00Z'),
      ('${id("AT_SB")}', '${X.TB1}', '${X.BB}', '${X.SB}', 1, 'submitted', '2026-02-01T04:00:00Z', '2026-02-01T04:30:00Z', 2, 2, '2026-02-01T04:20:00Z', 'student_submit', 0, 0, false, '2026-02-01T04:20:00Z');
    insert into public.test_attempt_questions (attempt_id, test_id, test_question_id, position, option_order) values
      ${[["AT_SA", "TA1"], ["AT_SS", "TA1"], ["AT_SB", "TB1"]].flatMap(([a, t]) => [1, 2].map((n) => `('${X[a]}', '${X[t]}', '${X[`${t}Q${n}`]}', ${n}, array[gen_random_uuid(), gen_random_uuid()])`)).join(",\n      ")};
    insert into public.test_attempt_answers (attempt_id, test_question_id, is_correct, marks_awarded) values
      ${[["AT_SA", "TA1"], ["AT_SS", "TA1"], ["AT_SB", "TB1"]].flatMap(([a, t]) => [1, 2].map((n) => `('${X[a]}', '${X[`${t}Q${n}`]}', ${n === 1}, ${n === 1 ? 1 : 0})`)).join(",\n      ")};
    insert into public.class_assignments (id, class_id, batch_id, title, due_at, max_score, status, created_by, updated_by) values
      ('${id("AA1")}', '${X.CA1}', '${X.BA}', 'DQ work A', null, 10, 'published', '${X.TA}', '${X.TA}'),
      ('${id("AB1")}', '${X.CB1}', '${X.BB}', 'DQ work B', null, 10, 'published', '${X.TB}', '${X.TB}');
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at, score, reviewed_by, reviewed_at) values
      ('${X.AA1}', '${X.SA}', '${X.BA}', 'https://dq.test/a', 'returned', '2026-02-03', 8, '${X.TA}', '2026-02-04'),
      ('${X.AA1}', '${X.SS}', '${X.BA}', 'https://dq.test/s', 'submitted', '2026-02-03', null, null, null),
      ('${X.AB1}', '${X.SB}', '${X.BB}', 'https://dq.test/b', 'returned', '2026-02-03', 5, '${X.TB}', '2026-02-04');
    set session_replication_role = origin;`);
});

// ---------------------------------------------------------------- A. catalogue

test("catalogue: the six policies are permissive SELECT policies for authenticated, no WITH CHECK; the Super Admin check is once per statement and the rest is unchanged", async () => {
  const p = await db.admin(`select json_object_agg(policyname, json_build_object('cmd', cmd, 'permissive', permissive, 'roles', roles, 'qual', qual, 'check', with_check))
    from pg_policies where schemaname = 'public' and policyname in (${Object.values(SIX).map((n) => `'${n}'`).join(", ")})`);
  assert.equal(Object.keys(p).length, 6);
  for (const name of Object.values(SIX)) {
    const x = p[name];
    assert.deepEqual([x.cmd, x.permissive, x.roles, x.check], ["SELECT", "PERMISSIVE", ["authenticated"], null], name);
    assert.ok(norm(x.qual).startsWith(`(${SA_ONCE} OR `), `${name}: Super Admin check first, once per statement — ${x.qual}`);
  }
  // batches / batch_students: exactly the old expression with its leading is_super_admin() evaluated once.
  for (const name of ["batches_select", "batch_students_select"]) {
    assert.equal(norm(p[name].qual), PRE_0026[name].replace(/^\(is_super_admin\(\) OR /, `(${SA_ONCE} OR `), `${name}: every other branch unchanged`);
  }
  // The other four: (Super Admin once) OR <the old expression, unchanged>.
  for (const name of ["tests_trainer_select", "test_questions_staff_select", "test_attempt_answers_staff_select", "assignment_submissions_trainer_select"]) {
    const old = PRE_0026[name];
    const inner = old.startsWith("(") ? old : `${old}`;
    assert.equal(norm(p[name].qual), `(${SA_ONCE} OR ${inner})`, `${name}: the old condition kept as one unchanged branch`);
  }
});

test("catalogue: every other policy on the six tables is exactly as before (INSERT / UPDATE / DELETE / ALL / other SELECT); helpers untouched; 0026 is six ALTER POLICY + the cap", async () => {
  const p = await db.admin(`select json_object_agg(tablename || '.' || policyname, json_build_array(cmd, permissive, roles, qual, with_check))
    from pg_policies where schemaname = 'public' and tablename in (${Object.keys(SIX).map((t) => `'${t}'`).join(", ")}) and policyname not in (${Object.values(SIX).map((n) => `'${n}'`).join(", ")})`);
  const A = ["authenticated"];
  const expected = {
    "assignment_submissions.assignment_submissions_admin_all": ["ALL", "PERMISSIVE", A, "is_super_admin()", "is_super_admin()"],
    "assignment_submissions.assignment_submissions_student_insert": ["INSERT", "PERMISSIVE", A, null, "(owns_student_record(student_id) AND is_enrolled_in_batch(batch_id))"],
    "assignment_submissions.assignment_submissions_student_select": ["SELECT", "PERMISSIVE", A, "owns_student_record(student_id)", null],
    "assignment_submissions.assignment_submissions_student_update": ["UPDATE", "PERMISSIVE", A, "(owns_student_record(student_id) AND (status = 'submitted'::submission_status))", "(owns_student_record(student_id) AND (status = 'submitted'::submission_status))"],
    "assignment_submissions.assignment_submissions_trainer_update": ["UPDATE", "PERMISSIVE", A, "is_batch_trainer(batch_id)", "is_batch_trainer(batch_id)"],
    "batch_students.batch_students_admin_write": ["ALL", "PERMISSIVE", A, "is_super_admin()", "is_super_admin()"],
    "batches.batches_admin_write": ["ALL", "PERMISSIVE", A, "is_super_admin()", "is_super_admin()"],
    "tests.tests_admin_all": ["ALL", "PERMISSIVE", A, "is_super_admin()", "is_super_admin()"],
    "tests.tests_trainer_delete_draft": ["DELETE", "PERMISSIVE", A, "((current_app_role() = 'trainer'::text) AND is_current_batch_trainer(batch_id) AND (status = 'draft'::test_status))", null],
    "tests.tests_trainer_insert": ["INSERT", "PERMISSIVE", A, null, "((current_app_role() = 'trainer'::text) AND is_current_batch_trainer(batch_id))"],
    "tests.tests_trainer_update": ["UPDATE", "PERMISSIVE", A, "((current_app_role() = 'trainer'::text) AND is_current_batch_trainer(batch_id))", "((current_app_role() = 'trainer'::text) AND is_current_batch_trainer(batch_id))"],
  };
  assert.deepEqual(p, expected, "no policy added, dropped or changed besides the six; no INSERT / UPDATE / DELETE permission added");
  const restrictive = await db.admin(`select json_object_agg(tablename || '.' || policyname, json_build_array(cmd, qual, with_check)) from pg_policies where schemaname = 'public' and permissive = 'RESTRICTIVE'`);
  assert.deepEqual(Object.keys(restrictive).sort(), ["notifications.notifications_active_account_only", "profiles.profiles_active_account_only"], "the restrictive policies: none on the six tables, none added");
  assert.deepEqual(restrictive["profiles.profiles_active_account_only"], ["SELECT", "(( SELECT current_app_role() AS current_app_role) IS NOT NULL)", null], "unchanged");
  assert.doesNotMatch(M0026.replace(/--.*$/gm, ""), /restrictive|active_account_only|notifications|profiles_/i, "0026 never touches a restrictive policy");
  const helpers = await db.admin(`select json_object_agg(proname, json_build_array(prosecdef, provolatile)) from pg_proc
    where pronamespace = 'public'::regnamespace and proname in ('is_super_admin', 'current_app_role', 'is_batch_trainer', 'is_class_trainer', 'is_class_trainer_in_batch',
      'is_current_batch_trainer', 'is_enrolled_in_batch', 'owns_student_record')`);
  assert.deepEqual(helpers, { is_super_admin: [false, "s"], current_app_role: [true, "s"], is_batch_trainer: [true, "s"], is_class_trainer: [true, "s"], is_class_trainer_in_batch: [true, "s"],
    is_current_batch_trainer: [true, "s"], is_enrolled_in_batch: [true, "s"], owns_student_record: [true, "s"] }, "helpers as before");
  const rls = await db.admin(`select json_agg(relrowsecurity order by relname) from pg_class where relnamespace = 'public'::regnamespace and relname in (${Object.keys(SIX).map((t) => `'${t}'`).join(", ")})`);
  assert.deepEqual(rls, [true, true, true, true, true, true], "RLS still on");
  // The migration: six ALTER POLICY statements on exactly these policies, one CREATE OR REPLACE of dashboard_analytics; nothing else.
  const ddl = M0026.replace(/--.*$/gm, "");
  const fn = ddl.slice(ddl.indexOf("create or replace function public.dashboard_analytics("), ddl.indexOf("$$;", ddl.indexOf("as $$")) + 3);
  const rest = ddl.replace(fn, "");
  assert.equal((ddl.match(/create or replace function/gi) ?? []).length, 1);
  assert.deepEqual([...rest.matchAll(/alter policy (\w+) on public\.(\w+)/gi)].map((m) => `${m[2]}.${m[1]}`).sort(), Object.entries(SIX).map(([t, n]) => `${t}.${n}`).sort());
  assert.doesNotMatch(rest, /create\s|drop\s|grant\s|revoke\s|alter\s+(table|function|index|role)|disable|force|bypassrls|security\s+definer|with\s+check\s*\(/i, "only ALTER POLICY … USING and the function");
});

// ---------------------------------------------------------------- B. isolation (fixture rows)

test("isolation: Super Admin, suspended Super Admin, current / former / other / invited trainer, active / suspended / withdrawn student see exactly what they should", async () => {
  // [batches, batch_students, tests, test_questions, answers, submissions] among the dq_ fixture rows
  const scope = async (uid) => [
    await fixtureCount(uid, "batches", "id", ["BA", "BB", "BI"]),
    await fixtureCount(uid, "batch_students", "batch_id", ["BA", "BB"]),
    await fixtureCount(uid, "tests", "id", ["TA1", "TA3", "TB1", "TI1"]),
    await fixtureCount(uid, "test_questions", "test_id", ["TA1", "TA3", "TB1", "TI1"]),
    await fixtureCount(uid, "test_attempt_answers", "attempt_id", ["AT_SA", "AT_SS", "AT_SB"]),
    await fixtureCount(uid, "assignment_submissions", "assignment_id", ["AA1", "AB1"]),
  ];
  const expect = {
    super_admin: [ids.A, [3, 4, 4, 8, 6, 3]],
    super_admin_suspended: [X.SAS, [0, 0, 0, 0, 0, 0]],
    trainer_current: [X.TA, [1, 2, 2, 4, 4, 2]],  // BA; its non-withdrawn enrolments; both BA tests; answers of BA attempts; BA submissions
    trainer_former: [X.TX, [1, 0, 1, 0, 0, 0]],   // class-trainer path only: the batch and the test of the class they taught
    trainer_other: [X.TB, [1, 1, 1, 2, 2, 1]],
    trainer_invited: [X.INV, [0, 0, 0, 0, 0, 0]], // assigned to BI but not active
    student: [X.SA, [1, 1, 0, 0, 0, 1]],          // own batch / enrolment / submission; no staff tables
    student_suspended: [X.SS, [0, 0, 0, 0, 0, 0]],
    student_withdrawn: [X.SW, [0, 1, 0, 0, 0, 0]], // their own (withdrawn) enrolment row only
    anon: [null, ["42501", "42501", "42501", "42501", "42501", "42501"]],
  };
  for (const [who, [uid, counts]] of Object.entries(expect)) assert.deepEqual(await scope(uid), counts, who);
});

// ---------------------------------------------------------------- C. equivalence with the pre-0026 policies

test("equivalence: every user's complete row sets of the six tables are identical with and without 0026", async () => {
  const now = await rowsets(false);
  const pre = await rowsets(true);
  assert.equal(Object.keys(now).length, Object.keys(SIX).length * Object.keys(users()).length);
  assert.deepEqual(now, pre, "zero authorization differences (row counts and complete row content)");
  assert.ok(Number(now["super_admin.test_attempt_answers"].split(":")[0]) >= 6);
  // Restoring was transactional: the 0026 expressions are still in place.
  assert.ok(norm(await db.admin("select qual from pg_policies where policyname = 'tests_trainer_select'")).startsWith(`(${SA_ONCE} OR `));
});

test("equivalence: anonymous stays blocked on all six tables, with and without 0026", async () => {
  for (const restore of [false, true]) {
    for (const t of Object.keys(SIX)) {
      const out = await db.run(`begin;\n${restore ? restoreSql() : ""}\n${asUser(null)} select count(*) from public.${t};\nrollback;`);
      assert.match(out.stderr, /ERROR:\s+42501/, `${t} (restore=${restore})`);
    }
  }
});

test("equivalence: INSERT / UPDATE / DELETE outcomes are identical with and without 0026 for every user (no write permission added)", async () => {
  const fresh = () => randomUUID();
  const writes = () => ({
    "insert batches": `insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values ('${fresh()}', 'DQ-NEW-${fresh().slice(0, 6)}', '${X.C}', '${X.TA}', 'DQ new', '2026-01-01', '2026-12-31', 'upcoming', 10)`,
    "insert batch_students": `insert into public.batch_students (batch_id, student_id, enrollment_status) values ('${X.BB}', '${X.SA}', 'enrolled')`,
    "insert tests": `insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, created_by, updated_by) values ('${fresh()}', '${X.CA1}', '${X.BA}', 'quiz', 'DQ new test', 50, 30, 1, '${X.TA}', '${X.TA}')`,
    "insert test_questions": `insert into public.test_questions (id, test_id, position, source_question_id, source_revision, question_text, question_type, marks, added_by) values ('${fresh()}', '${X.TB1}', 9, '${X.Q1}', 1, 'DQ new tq', 'true_false', 1, '${X.TB}')`,
    "insert test_attempt_answers": `insert into public.test_attempt_answers (attempt_id, test_question_id, is_correct, marks_awarded) values ('${X.AT_SB}', '${X.TA1Q1}', true, 1)`,
    "insert assignment_submissions": `insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, submitted_at) values ('${X.AB1}', '${X.SA}', '${X.BB}', 'https://dq.test/x', 'submitted', now())`,
    "update batches": `update public.batches set name = name where id in ('${X.BA}', '${X.BB}', '${X.BI}')`,
    "update batch_students": `update public.batch_students set enrollment_status = enrollment_status where batch_id in ('${X.BA}', '${X.BB}')`,
    "update tests": `update public.tests set title = title where id in ('${X.TA1}', '${X.TA3}', '${X.TB1}', '${X.TI1}')`,
    "update test_questions": `update public.test_questions set position = position where test_id in ('${X.TA1}', '${X.TB1}')`,
    "update test_attempt_answers": `update public.test_attempt_answers set marks_awarded = marks_awarded where attempt_id in ('${X.AT_SA}', '${X.AT_SB}')`,
    "update assignment_submissions": `update public.assignment_submissions set score = score where assignment_id in ('${X.AA1}', '${X.AB1}')`,
    "delete batch_students": `delete from public.batch_students where batch_id = '${X.BB}'`,
    "delete tests": `delete from public.tests where id = '${X.TI1}'`,
    "delete test_attempt_answers": `delete from public.test_attempt_answers where attempt_id = '${X.AT_SB}'`,
    "delete assignment_submissions": `delete from public.assignment_submissions where assignment_id = '${X.AB1}'`,
  });
  const outcomes = {};
  const who = { ...Object.fromEntries(Object.entries(users()).filter(([u]) => u !== "super_admin")), anon: null };
  for (const [u, uid] of Object.entries(who)) {
    for (const [w, sql] of Object.entries(writes())) {
      const now = await attempt(uid, sql, false);
      const pre = await attempt(uid, sql, true);
      assert.equal(now, pre, `${u}: ${w} — same outcome with and without 0026`);
      outcomes[`${u}: ${w}`] = now;
    }
  }
  // Spot checks of the expected (pre-existing) rights: only in-scope writes the old policies already allowed succeed.
  assert.equal(outcomes["anon: insert batches"], "42501");
  assert.equal(outcomes["TB: update assignment_submissions"], "ok:1", "a trainer reviews only their batch's submissions");
  assert.equal(outcomes["TA: update assignment_submissions"], "ok:2");
  assert.equal(outcomes["TX: update assignment_submissions"], "ok:0", "the former trainer cannot");
  assert.equal(outcomes["TB: delete tests"], "ok:0");
  assert.equal(outcomes["INV: update batches"], "ok:0", "invited account: nothing");
  assert.equal(outcomes["SAS: update batches"], "ok:0", "suspended Super Admin: nothing");
  for (const [k, v] of Object.entries(outcomes)) {
    if (/^(SAS|INV|SS|TX|anon): (update|delete) /.test(k)) assert.ok(v === "ok:0" || /^[0-9A-Z]{5}$/.test(v), `${k}: no row written (${v})`);
    if (/^(SAS|INV|SS|anon): insert /.test(k)) assert.notEqual(v.slice(0, 3), "ok:", `${k}: insert refused (${v})`);
  }
});
