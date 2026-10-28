// 0027 — dashboard_analytics students.current: the CURRENT student ranking (independent of the selected period)
// and each ranked student's trend for the selected period (period average − comparison-period average, in pp).
// Current window: India today − 365 → today (366 days). Rules reused: released = effective status 'closed' dated by
// available_until (India), best finished attempt per student × test, at least 3 results, top 5, deterministic order.
// Every call runs as the Super Admin inside a transaction that first sets every OTHER released test to draft (so data
// from other test files cannot reach the ranking) and is always rolled back. Own fixtures only (dcr_*), dated
// relative to the database's India today.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, ids } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const M0027 = fs.readFileSync(path.resolve(here, "../../supabase/migrations/0027_dashboard_current_student_ranking.sql"), "utf8");

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
let T; // the database's India today (YYYY-MM-DD)
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Released tests k days before today; DRAFT (never released); OPEN (active, closes later: not released).
const TESTS = { t5: 5, t50: 50, t100: 100, t150: 150, t365: 365, t366: 366 };
const STUDENTS = { HAL: "DCR Hal", ALI: "DCR Ali", BOB: "DCR Bob", CAR: "DCR Car", DAN: "DCR Dan", EVE: "DCR Eve", FAY: "DCR Fay", GUS: "DCR Gus", KIM: "DCR Kim", IVY: "DCR Ivy", JAY: "DCR Jay" };
// student, test, attempt number, percentage (null = in progress)
const ATTEMPTS = [
  ["HAL", "t5", 1, 20], ["HAL", "t5", 2, 100], ["HAL", "t100", 1, 100], ["HAL", "t150", 1, 100], // best of t5 = 100 → avg 100, 3 results
  ["ALI", "t5", 1, 95], ["ALI", "t50", 1, 85], ["ALI", "t100", 1, 90],                          // avg 90
  ["BOB", "t5", 1, 80], ["BOB", "t50", 1, 80], ["BOB", "t100", 1, 80], ["BOB", "t150", 1, 80],   // avg 80, 4 results
  ["CAR", "t50", 1, 80], ["CAR", "t100", 1, 80], ["CAR", "t150", 1, 80],                         // avg 80, 3 results (after BOB)
  ["DAN", "t50", 1, 60], ["DAN", "t100", 1, 75], ["DAN", "t150", 1, 75],                         // avg 70, 3 results
  ["EVE", "t50", 1, 70], ["EVE", "t100", 1, 70], ["EVE", "t150", 1, 70],                         // avg 70, 3 results — tie with DAN, name after → 6th
  ["FAY", "t5", 1, 60], ["FAY", "t50", 1, 60], ["FAY", "t100", 1, 60],                           // eligible, 7th
  ["GUS", "t5", 1, 100], ["GUS", "t50", 1, 100], ["GUS", "DRAFT", 1, 100], ["GUS", "OPEN", 1, 100], // only 2 released
  ["KIM", "t5", 1, null], ["KIM", "t50", 1, 100], ["KIM", "t100", 1, 100],                       // in progress ignored → 2
  ["IVY", "t365", 1, 95], ["IVY", "t150", 1, 95], ["IVY", "t5", 1, 95],                          // boundary: today − 365 counts
  ["JAY", "t366", 1, 99], ["JAY", "t150", 1, 99], ["JAY", "t5", 1, 99],                          // boundary: today − 366 does not
];
const MAIN = ["t5", "t50", "t100", "t150", "DRAFT", "OPEN"]; // the tests left as they are in the ranking scenarios
const BOUNDARY = ["t5", "t150", "t365", "t366"];

/** dashboard_analytics as the active Super Admin, with only `keep` among released tests (+ optional fixture tweak); always rolled back. */
async function analytics(keep, from, to, tweak = "") {
  const out = await db.run(`begin;
set session_replication_role = replica;
update public.tests set status = 'draft' where status <> 'draft' and id not in (${keep.map((k) => q(X[k])).join(", ")});
${tweak}
set session_replication_role = origin;
set local role authenticated;
select set_config('request.jwt.claims', '${JSON.stringify({ sub: ids.A })}', true);
select 'json|' || public.dashboard_analytics(${q(from)}, ${q(to)}, 10)::text;
rollback;`);
  if (out.code) return { error: (/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(out.stderr) ?? [, "error", out.stderr]).slice(1, 3) };
  return JSON.parse(out.stdout.split(/\r?\n/).find((l) => l.startsWith("json|")).slice(5));
}
const ranking = (r) => r.students.current.map((s) => [s.rank, s.name, s.average, s.results]);
const who = (uid) => Object.keys(STUDENTS).find((k) => X[k] === uid);

before(async () => {
  T = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  const keys = Object.keys(STUDENTS);
  await db.exec(`
    insert into auth.users (id, email) values ${[...keys, "TR", "SAS"].map((k) => `(${q(id(k))}, '${k.toLowerCase()}@dcr.test')`).join(", ")};
    update public.profiles set account_status = 'active', role = 'student' where id in (${keys.map((k) => q(X[k])).join(", ")});
    update public.profiles set account_status = 'active', role = 'trainer' where id = ${q(X.TR)};
    update public.profiles set account_status = 'suspended', role = 'super_admin' where id = ${q(X.SAS)};
    insert into public.trainers (id, trainer_code, full_name) values (${q(X.TR)}, 'DCR-TR', 'DCR Trainer');
    insert into public.students (id, student_code, full_name) values ${keys.map((k) => `(${q(X[k])}, 'DCR-${k}', ${q(STUDENTS[k])})`).join(", ")};`, ids.A);
  const until = (k) => `((date '${T}' - ${k}) + time '17:00') at time zone 'Asia/Kolkata'`;
  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values (${q(id("C"))}, 'DCR-101', 'DCR Course', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values (${q(id("B"))}, 'DCR-B', ${q(X.C)}, ${q(X.TR)}, 'DCR Batch', date '${T}' - 400, date '${T}' + 30, 'ongoing', 30);
    insert into public.batch_students (batch_id, student_id) values ${keys.map((k) => `(${q(X.B)}, ${q(X[k])})`).join(", ")};
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status)
      values (${q(id("K"))}, ${q(X.C)}, ${q(X.B)}, ${q(X.TR)}, 'DCR class', date '${T}' - 400, '09:00', '10:00', 'completed');
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ${Object.entries(TESTS).map(([k, d]) => `(${q(id(k))}, ${q(X.K)}, ${q(X.B)}, 'quiz', 'DCR ${k}', 'closed', 60, 30, 2, ${until(d)} - interval '1 day', ${until(d)}, ${q(ids.A)}, ${q(ids.A)})`).join(",\n      ")},
      (${q(id("DRAFT"))}, ${q(X.K)}, ${q(X.B)}, 'quiz', 'DCR draft', 'draft', 60, 30, 2, ${until(21)}, ${until(20)}, ${q(ids.A)}, ${q(ids.A)}),
      (${q(id("OPEN"))}, ${q(X.K)}, ${q(X.B)}, 'quiz', 'DCR open', 'active', 60, 30, 2, now() - interval '1 hour', now() + interval '2 hours', ${q(ids.A)}, ${q(ids.A)});
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at) values
      ${ATTEMPTS.map(([s, t, n, pct]) => (pct === null
        ? `(gen_random_uuid(), ${q(X[t] ?? id(t))}, ${q(X.B)}, ${q(X[s])}, ${n}, 'in_progress', now() - interval '1 hour', now() + interval '1 hour', 5, 100, null, null, null, null, null, null)`
        : `(gen_random_uuid(), ${q(X[t] ?? id(t))}, ${q(X.B)}, ${q(X[s])}, ${n}, 'submitted', now() - interval '400 days', now() - interval '400 days' + interval '1 hour', 5, 100, now() - interval '400 days' + interval '30 minutes', 'student_submit', ${pct}, ${pct}, ${pct >= 60}, now() - interval '400 days' + interval '30 minutes')`)).join(",\n      ")};
    set session_replication_role = origin;`);
});

// ---------------------------------------------------------------- ranking

test("current ranking: top 5 by the average of best released results in the current window; ≥ 3 results; deterministic order", async () => {
  const r = await analytics(MAIN, addDays(T, -29), T);
  assert.deepEqual(ranking(r), [
    [1, "DCR Hal", 100, 3], // best attempt per test counted once (20 → 100 on t5): 100, not 73.3 over 4
    [2, "DCR Ali", 90, 3],
    [3, "DCR Bob", 80, 4],  // tie on average: more results first
    [4, "DCR Car", 80, 3],
    [5, "DCR Dan", 70, 3],  // tie on average and results: name order (DCR Dan before DCR Eve)
  ], "at most 5; EVE and FAY eligible but outside the top 5");
  for (const s of r.students.current) {
    assert.equal(s.code, `DCR-${who(s.id)}`);
    assert.deepEqual(Object.keys(s).sort(), ["average", "code", "id", "name", "period_average", "period_results", "previous_average", "previous_results", "rank", "results", "trend"]);
  }
  const names = r.students.current.map((s) => s.name);
  assert.ok(!names.includes("DCR Gus"), "GUS: 4 results but only 2 released (draft and still-open tests do not count)");
  assert.ok(!names.includes("DCR Kim"), "KIM: an in-progress attempt is not a result → 2 results");
  assert.deepEqual(r.students.current_window, { from: addDays(T, -365), to: T });
  assert.deepEqual(Object.keys(r.students).sort(), ["current", "current_window", "declining", "improving", "ranked", "top"], "existing keys unchanged; two added");
});

test("current ranking: independent of the selected period (this month, 3 / 6 / 12 months, a past period, a single day)", async () => {
  const periods = [
    [addDays(T, -29), T], [addDays(T, -89), T], [addDays(T, -181), T], [addDays(T, -365), T],
    [addDays(T, -120), addDays(T, -91)], [addDays(T, -300), addDays(T, -300)],
  ];
  const results = [];
  for (const [from, to] of periods) results.push(await analytics(MAIN, from, to));
  for (const r of results) assert.deepEqual(ranking(r), ranking(results[0]), `${r.period.from} → ${r.period.to}: same current ranking`);
  // …while the period-based ranking (students.top) does change with the period.
  assert.notDeepEqual(results[0].students.top.map((s) => s.id), results[3].students.top.map((s) => s.id));
});

test("current window boundary: a result released on today − 365 counts; on today − 366 it does not", async () => {
  const r = await analytics(BOUNDARY, addDays(T, -29), T);
  assert.deepEqual(ranking(r), [[1, "DCR Ivy", 95, 3]], "IVY (today − 365) ranked; JAY (today − 366) has 2 results in the window; everyone else ≤ 2");
});

test("no student with 3 released results in the current window → an empty list (never invented)", async () => {
  const r = await analytics(["t366"], addDays(T, -29), T);
  assert.deepEqual(r.students.current, []);
  assert.deepEqual(r.students.current_window, { from: addDays(T, -365), to: T });
});

// ---------------------------------------------------------------- trend

test("trend: selected-period average − comparison-period average (pp), from the period's best released results; null without a comparison", async () => {
  const byName = (r) => Object.fromEntries(r.students.current.map((s) => [s.name, [s.period_average, s.period_results, s.previous_average, s.previous_results, s.trend]]));
  // 30 days: [T−29, T] vs [T−59, T−30]
  assert.deepEqual(byName(await analytics(MAIN, addDays(T, -29), T)), {
    "DCR Hal": [100, 1, null, 0, null],  // nothing in the comparison period → no trend
    "DCR Ali": [95, 1, 85, 1, 10],       // +10 pp
    "DCR Bob": [80, 1, 80, 1, 0],
    "DCR Car": [null, 0, 80, 1, null],   // nothing in the selected period → no trend
    "DCR Dan": [null, 0, 60, 1, null],
  });
  // 90 days: [T−89, T] vs [T−179, T−90]
  assert.deepEqual(byName(await analytics(MAIN, addDays(T, -89), T)), {
    "DCR Hal": [100, 1, 100, 2, 0],
    "DCR Ali": [90, 2, 90, 1, 0],
    "DCR Bob": [80, 2, 80, 2, 0],
    "DCR Car": [80, 1, 80, 2, 0],
    "DCR Dan": [60, 1, 75, 2, -15],      // −15 pp: negative movements are returned as they are
  });
  // A period with no results on either side: every trend null, the ranking unchanged.
  const empty = await analytics(MAIN, addDays(T, -300), addDays(T, -300));
  assert.ok(empty.students.current.every((s) => s.trend === null && s.period_results === 0 && s.previous_results === 0));
});

test("trend values are not thresholded or hidden: small movements are returned exactly (pp, two decimals)", async () => {
  // Inside the rolled-back transaction only: ALI's t5 result (selected period, 30 days) becomes 85.5 / 84.6 against t50 = 85.
  const ali = async (pct) => {
    const r = await analytics(MAIN, addDays(T, -29), T, `update public.test_attempts set percentage = ${pct} where test_id = ${q(X.t5)} and student_id = ${q(X.ALI)};`);
    const s = r.students.current.find((x) => x.name === "DCR Ali");
    return [s.period_average, s.previous_average, s.trend];
  };
  assert.deepEqual(await ali(85.5), [85.5, 85, 0.5], "+0.5 pp returned (the UI decides the arrow)");
  assert.deepEqual(await ali(84.6), [84.6, 85, -0.4], "−0.4 pp returned");
  // 182 days: DAN 60, 75, 75 → 70 against an empty comparison period → no trend.
  const r = await analytics(MAIN, addDays(T, -181), T);
  const dan = r.students.current.find((s) => s.name === "DCR Dan");
  assert.deepEqual([dan.period_average, dan.period_results, dan.previous_average, dan.previous_results, dan.trend], [70, 3, null, 0, null]);
});

// ---------------------------------------------------------------- limits, security, contract

test("period limits unchanged: 366 days accepted (with the current ranking); 367 days rejected (22023)", async () => {
  const ok = await analytics(MAIN, addDays(T, -365), T);
  assert.equal(ok.period.days, 366);
  assert.equal(ok.students.current.length, 5);
  const bad = await analytics(MAIN, addDays(T, -366), T);
  assert.deepEqual(bad.error, ["22023", "The period can be at most 366 days."]);
});

test("security: anon, trainer, student and a suspended Super Admin are still refused (42501); function attributes unchanged", async () => {
  for (const [label, client] of [["anon", db.client({ role: "anon" })], ["trainer", db.client({ role: "authenticated", userId: X.TR })], ["student", db.client({ role: "authenticated", userId: X.ALI })], ["suspended super admin", db.client({ role: "authenticated", userId: X.SAS })]]) {
    const { data, error } = await client.rpc("dashboard_analytics", { p_from: addDays(T, -29), p_to: T });
    assert.equal(data, null, label);
    assert.equal(error?.code, "42501", label);
  }
  const p = await db.admin(`select json_build_object('definer', prosecdef, 'volatility', provolatile, 'config', proconfig,
      'anon', has_function_privilege('anon', oid, 'execute'), 'authenticated', has_function_privilege('authenticated', oid, 'execute'),
      'public', exists (select 1 from aclexplode(proacl) a where a.grantee = 0), 'src', prosrc)
    from pg_proc where oid = 'public.dashboard_analytics(date, date, integer)'::regprocedure`);
  assert.deepEqual([p.definer, p.volatility, p.config, p.anon, p.authenticated, p.public], [false, "s", ['search_path=""'], false, true, false]);
  assert.match(p.src, /^\s*declare[\s\S]*?begin\s+if not public\.is_super_admin\(\) then\s+raise exception .* using errcode = '42501'/, "the Super Admin check is still the first statement");
  assert.match(p.src, /cur_rel_tests as \([\s\S]*?between v_cur_from and v_today[\s\S]*?test_effective_status/, "the current window is bounded and released-only");
  assert.doesNotMatch(p.src, /\bexecute\s|format\(|\binsert\s+into|\bupdate\s+public\.|\bdelete\s+from|security\s+definer|service_role/i);
});

test("migration 0027: one CREATE OR REPLACE of dashboard_analytics with pre/postflight; no table, view, index, policy, grant or other function", () => {
  const ddl = M0027.replace(/--.*$/gm, "");
  assert.equal((ddl.match(/create or replace function public\.dashboard_analytics\(/gi) ?? []).length, 1);
  assert.equal((ddl.match(/create\s/gi) ?? []).length, 1, "the only CREATE");
  assert.doesNotMatch(ddl, /drop\s|grant\s|revoke\s|alter\s+(table|function|index|role|policy)|policy\s|disable|bypassrls|security\s+definer|service_role/i);
  assert.match(ddl, /Preflight failed: public\.dashboard_analytics\(date, date, integer\) differs from the 0026 definition/);
  assert.match(ddl, /Postflight failed: dashboard_analytics body is not the expected 0027 body/);
});
