// Phase 7 P4.2 — trainer dashboard: the real trainer dashboard repository + service exactly as /trainer uses
// them, against the local database, each caller through their OWN session client (never the service role).
// RLS decides what is visible; the service scopes to the trainer's current batches and own classes; "today" is
// the India date. Own fixtures only (td_*), dated relative to the database's India today.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createTrainerDashboardRepository } = await import(`${build}/repositories/trainer-dashboard.repository.core.mjs`);
const { createTrainerDashboardService, TrainerDashboardAuthorizationError } = await import(`${build}/services/trainer-dashboard.service.core.mjs`);

const X = {};
const id = (k) => (X[k] ??= randomUUID());
const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
let T; // the database's India today

const repoAs = (uid) => createTrainerDashboardRepository(async () => db.client({ role: "authenticated", userId: uid }));
/**
 * Stand-in for classesService.listClasses({ dateRange: "custom" }) (server-only, not loadable here): the same
 * query the Classes repository runs for a trainer — trainer_id = caller, class_date in [from, to] — through the
 * caller's own session, so RLS applies exactly as in the app.
 */
const classesAs = (uid) => async (from, to) => {
  const { data, error } = await db
    .client({ role: "authenticated", userId: uid })
    .from("classes")
    .select("id, title, class_date, start_time, end_time, status, class_type, batch_id, batches ( name ), courses ( title )")
    .eq("trainer_id", uid)
    .gte("class_date", from)
    .lte("class_date", to);
  if (error) throw new Error(error.message);
  return data.map((c) => ({ ...c, batch_name: c.batches?.name ?? "", batch_code: "", course_title: c.courses?.title ?? "" }));
};
const svcAs = (key, role, isActive = true) =>
  createTrainerDashboardService({
    repository: repoAs(X[key] ?? ids[key]),
    listClasses: classesAs(X[key] ?? ids[key]),
    getCurrentUser: async () => ({ id: X[key] ?? ids[key], email: `${key}@td.test`, fullName: key, role, isActive, createdAt: "2026-01-01" }),
    getModulePerformance: async () => [],
    getNotifications: async () => ({ unreadCount: 0, notifications: [] }),
  });

before(async () => {
  T = await db.admin("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')");
  const people = ["TR", "TR2", "S1", "S2", "S3", "S4", "SW", "SC", "SX"];
  const students = people.filter((k) => k.startsWith("S"));
  for (const k of people) id(k);
  await db.exec(`
    insert into auth.users (id, email) values ${people.map((k) => `(${q(X[k])}, '${k.toLowerCase()}@td.test')`).join(", ")};
    update public.profiles set account_status = 'active', role = 'student' where id in (${students.map((k) => q(X[k])).join(", ")});
    update public.profiles set account_status = 'active', role = 'trainer' where id in (${q(X.TR)}, ${q(X.TR2)});
    insert into public.trainers (id, trainer_code, full_name) values (${q(X.TR)}, 'TD-TR', 'TD Trainer'), (${q(X.TR2)}, 'TD-TR2', 'TD Other');
    insert into public.students (id, student_code, full_name) values ${students.map((k) => `(${q(X[k])}, 'TD-${k}', 'TD ${k}')`).join(", ")};`, ids.A);

  const cls = (k, batch, trainer, offset, status, start = "09:00") =>
    `(${q(id(k))}, ${q(X.C)}, ${q(X[batch])}, ${q(X[trainer])}, 'TD ${k}', date '${T}' + ${offset}, '${start}', '23:59', '${status}')`;
  const att = (cls, student, status, batch = "BO") => `(${q(X[cls])}, ${q(X[student])}, ${q(X[batch])}, '${status}', ${q(X.TR)})`;
  const tst = (k, batch, cls, status, from, until) =>
    `(${q(id(k))}, ${q(X[cls])}, ${q(X[batch])}, 'quiz', 'TD ${k}', '${status}', 60, 30, 2, ${from}, ${until}, ${q(ids.A)}, ${q(ids.A)})`;
  const attempt = (test, student, pct, batch = "BO") =>
    `(gen_random_uuid(), ${q(X[test])}, ${q(X[batch])}, ${q(X[student])}, 1, 'submitted', now() - interval '20 days', now() - interval '20 days' + interval '1 hour', 5, 100, now() - interval '20 days' + interval '30 minutes', 'student_submit', ${pct}, ${pct}, ${pct >= 60}, now() - interval '20 days' + interval '30 minutes')`;

  await db.exec(`
    set session_replication_role = replica;
    insert into public.courses (id, course_code, title, level) values (${q(id("C"))}, 'TD-101', 'TD Course', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (${q(id("BO"))}, 'TD-BO', ${q(X.C)}, ${q(X.TR)},  'TD ongoing',   date '${T}' - 60, date '${T}' + 60, 'ongoing',   30),
      (${q(id("BU"))}, 'TD-BU', ${q(X.C)}, ${q(X.TR)},  'TD upcoming',  date '${T}' + 10, date '${T}' + 90, 'upcoming',  30),
      (${q(id("BC"))}, 'TD-BC', ${q(X.C)}, ${q(X.TR)},  'TD completed', date '${T}' - 200, date '${T}' - 100, 'completed', 30),
      (${q(id("BX"))}, 'TD-BX', ${q(X.C)}, ${q(X.TR2)}, 'TD other',     date '${T}' - 60, date '${T}' + 60, 'ongoing',   30);
    insert into public.batch_students (batch_id, student_id, enrollment_status, completed_at) values
      (${q(X.BO)}, ${q(X.S1)}, 'enrolled', null), (${q(X.BO)}, ${q(X.S2)}, 'enrolled', null), (${q(X.BO)}, ${q(X.S3)}, 'enrolled', null),
      (${q(X.BO)}, ${q(X.SW)}, 'withdrawn', null), (${q(X.BU)}, ${q(X.S4)}, 'enrolled', null),
      (${q(X.BC)}, ${q(X.SC)}, 'completed', now()), (${q(X.BX)}, ${q(X.SX)}, 'enrolled', null);
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time, status) values
      ${[
        cls("KP", "BO", "TR", -3, "completed"),   // held, never marked → attendance to mark
        cls("KM", "BO", "TR", -2, "completed"),
        cls("KM2", "BO", "TR", -5, "completed"),
        cls("KM3", "BO", "TR", -6, "completed"),
        cls("KCAN", "BO", "TR", -1, "cancelled"), // cancelled: never to mark
        cls("KT", "BO", "TR", 0, "live", "00:00"), // today, started → to mark
        cls("KF", "BO", "TR", 2, "scheduled"),     // upcoming
        cls("KOLD", "BO", "TR", -45, "completed"), // before the 30-day window
        cls("KC", "BC", "TR", -1, "completed"),   // completed batch: out of scope
        cls("KX", "BX", "TR2", 0, "scheduled"),    // another trainer's class
      ].join(",\n      ")};
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values
      ${[
        att("KM", "S1", "present"), att("KM2", "S1", "present"), att("KM3", "S1", "present"),
        att("KM", "S2", "absent"), att("KM2", "S2", "absent"), att("KM3", "S2", "absent"),
        att("KM", "S3", "late"), att("KM2", "S3", "present"), att("KM3", "S3", "present"),
        att("KC", "SC", "absent", "BC"),
      ].join(", ")};
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values (${q(X.KX)}, ${q(X.SX)}, ${q(X.BX)}, 'absent', ${q(X.TR2)});
    insert into public.class_assignments (id, class_id, batch_id, title, status, max_score, created_by, updated_by) values
      (${q(id("A1"))}, ${q(X.KM)}, ${q(X.BO)}, 'TD assignment', 'published', 10, ${q(X.TR)}, ${q(X.TR)}),
      (${q(id("AX"))}, ${q(X.KX)}, ${q(X.BX)}, 'TD other assignment', 'published', 10, ${q(X.TR2)}, ${q(X.TR2)});
    insert into public.assignment_submissions (assignment_id, student_id, batch_id, submission_url, status, score, reviewed_by, reviewed_at) values
      (${q(X.A1)}, ${q(X.S1)}, ${q(X.BO)}, 'https://example.com/s1', 'submitted', null, null, null),
      (${q(X.A1)}, ${q(X.S2)}, ${q(X.BO)}, 'https://example.com/s2', 'returned', 8, ${q(X.TR)}, now()),
      (${q(X.AX)}, ${q(X.SX)}, ${q(X.BX)}, 'https://example.com/sx', 'submitted', null, null, null);
    insert into public.tests (id, class_id, batch_id, test_type, title, status, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by) values
      ${[
        tst("TOPEN", "BO", "KM", "active", "now() - interval '1 hour'", "now() + interval '2 hours'"),
        tst("TCL1", "BO", "KM", "closed", "now() - interval '3 days'", "now() - interval '2 days'"),
        tst("TCL2", "BO", "KM", "closed", "now() - interval '11 days'", "now() - interval '10 days'"),
        tst("TSCHED", "BO", "KM", "scheduled", "now() + interval '1 day'", "now() + interval '2 days'"),
        tst("TDRAFT", "BO", "KM", "draft", "null", "null"),
        tst("TX", "BX", "KX", "active", "now() - interval '1 hour'", "now() + interval '2 hours'"),
      ].join(",\n      ")};
    insert into public.test_attempts (id, test_id, batch_id, student_id, attempt_number, status, started_at, deadline_at, question_count, max_score, finalized_at, finalize_reason, score, percentage, passed, graded_at) values
      ${[
        attempt("TOPEN", "S1", 90), attempt("TOPEN", "S2", 70), attempt("TOPEN", "SW", 99),
        attempt("TCL1", "S1", 80), attempt("TCL1", "S2", 40), attempt("TCL1", "S3", 30),
        attempt("TCL2", "S2", 50), attempt("TCL2", "S3", 40),
        attempt("TX", "SX", 100, "BX"),
      ].join(",\n      ")};
    set session_replication_role = origin;`);
});

test("trainer dashboard: real counts from the trainer's current batches and own classes (India today)", async () => {
  const d = await svcAs("TR", "trainer").load();
  assert.equal(d.today, T);
  assert.deepEqual(d.kpis, {
    status: "ok",
    data: { currentBatches: 2, ongoingBatches: 1, upcomingBatches: 1, activeStudents: 4, classesToday: 1, classesTodayCompleted: 0, averagePerformance: 48, releasedResults: 5 },
  });
  const pending = Object.fromEntries(d.pending.data.map((a) => [a.key, a]));
  assert.equal(pending.attendance.count, 2, "KP and today's started class; not cancelled, future, old, marked or out-of-scope classes");
  assert.equal(pending.attendance.href, "/trainer/classes");
  assert.equal(pending.assignments.count, 1, "only the submitted (not returned) submission of the trainer's batch");
  assert.equal(pending.assignments.href, `/trainer/classes/${X.KM}`);
  assert.equal(pending.tests.count, 1);
  assert.equal(pending.results.count, 1, "closed in the last 7 days");
  assert.equal(pending.results.href, `/trainer/tests/${X.TCL1}`);

  assert.deepEqual(d.todayClasses.data.map((c) => [c.title, c.needsAttendance]), [["TD KT", true]]);
  assert.deepEqual(d.upcomingClasses.data.map((c) => c.title), ["TD KF"]);
  assert.deepEqual(d.upcomingTests.data.map((t) => [t.title, t.effectiveStatus]), [["TD TOPEN", "active"], ["TD TSCHED", "scheduled"]]);

  assert.equal(d.currentTest.data.title, "TD TOPEN");
  assert.deepEqual(d.currentTest.data.top.map((s) => [s.rank, s.name, s.percentage]), [[1, "TD S1", 90], [2, "TD S2", 70]], "the withdrawn student's attempt is not ranked");
  assert.equal(d.currentTest.data.resultCount, 2, "…nor counted, although staff RLS lets the trainer read it");

  assert.deepEqual(d.attendance.data, { present: 5, late: 1, absent: 3, excused: 0, marked: 9, rate: 66.7, classesHeld: 3 });
  assert.deepEqual(d.performance.data, { average: 48, releasedResults: 5, passRate: 20 });

  assert.deepEqual(d.attention.data.rows.map((r) => [r.name, r.priority, r.performance, r.attendance]), [["TD S2", "critical", 45, 0], ["TD S3", "attention", 35, 100]]);
  assert.equal(d.attention.data.rows[0].href, `/trainer/performance?batch=${X.BO}&student=${X.S2}`);
});

test("isolation: another trainer sees only their own batch; nothing of this trainer's data", async () => {
  const d = await svcAs("TR2", "trainer").load();
  assert.equal(d.kpis.data.currentBatches, 1);
  assert.equal(d.kpis.data.activeStudents, 1);
  const json = JSON.stringify(d);
  for (const k of ["S1", "S2", "S3", "S4", "KM", "KT", "TOPEN", "TCL1"]) assert.ok(!json.includes(X[k]) && !json.includes(`TD ${k}`), `${k} not visible to TR2`);
  assert.deepEqual(d.todayClasses.data.map((c) => c.title), ["TD KX"]);
  assert.equal(d.currentTest.data.top[0].name, "TD SX");
});

test("RLS is the boundary: the trainer's own session reads nothing of another trainer's batch, even when asked directly", async () => {
  const repo = repoAs(X.TR);
  assert.deepEqual(await repo.listEnrolments([X.BX]), []);
  assert.deepEqual(await repo.listBestResults([X.BX]), []);
  assert.deepEqual(await repo.listPendingSubmissions([X.BX]), []);
  assert.deepEqual(await repo.listAttendance([X.KX]), []);
  assert.deepEqual(await repo.listTests([X.BX]), []);
  // A completed batch is no longer current: not in scope, and its enrolment status is completed.
  const batches = await repo.listCurrentBatches(X.TR);
  assert.deepEqual(batches.map((b) => b.batch_code).sort(), ["TD-BO", "TD-BU"]);
  // Withdrawn enrolments are invisible to the trainer (0003 batch_students_select).
  const enrolments = await repo.listEnrolments([X.BO]);
  assert.ok(!enrolments.some((e) => e.student_id === X.SW));
  // A student's own session gets nothing of the class (no staff reads).
  const asStudent = repoAs(X.S1);
  assert.deepEqual(await asStudent.listBestResults([X.BO]), []);
  assert.equal((await asStudent.listPendingSubmissions([X.BO])).length, 1, "a student sees only their own submission, never the class's");
});

test("callers: Super Admins, students and inactive trainers are refused by the service before any read", async () => {
  await assert.rejects(svcAs("A", "admin").load(), TrainerDashboardAuthorizationError);
  await assert.rejects(svcAs("S1", "student").load(), TrainerDashboardAuthorizationError);
  await assert.rejects(svcAs("TR", "trainer", false).load(), TrainerDashboardAuthorizationError);
});
