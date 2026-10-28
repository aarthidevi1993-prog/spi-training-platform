// Trainer dashboard (P4.2) — the pure read model, the service core with fake dependencies, and the
// repository core against a recording fake client. No database (see tests/question-import-db for RLS).
import { test } from "node:test";
import assert from "node:assert/strict";

const build = process.env.TRAINER_DASHBOARD_BUILD;
const L = await import(`${build}/lib/dashboard/trainer-dashboard.mjs`);
const { createTrainerDashboardService, TrainerDashboardAuthorizationError } = await import(`${build}/services/trainer-dashboard.service.core.mjs`);
const { createTrainerDashboardRepository, TrainerDashboardRepositoryError } = await import(`${build}/repositories/trainer-dashboard.repository.core.mjs`);

// 2026-10-08 12:00 in India (06:30 UTC).
const NOW = new Date("2026-10-08T06:30:00Z");
const TODAY = "2026-10-08";
const iso = (d) => new Date(d).toISOString();
const hoursAgo = (h) => iso(NOW.getTime() - h * 3600e3);
const hoursAhead = (h) => iso(NOW.getTime() + h * 3600e3);

const batch = (id, status = "ongoing") => ({ id, batch_code: id.toUpperCase(), name: `Batch ${id}`, status, course_title: "SPI" });
const enrol = (batch_id, student_id, enrollment_status = "enrolled") => ({ batch_id, student_id, enrollment_status, full_name: `Student ${student_id}`, student_code: student_id.toUpperCase() });
const cls = (id, over = {}) => ({
  id, title: `Class ${id}`, class_date: TODAY, start_time: "10:00:00", end_time: "11:00:00", status: "scheduled", class_type: "online",
  batch_id: "b1", batch_name: "Batch b1", batch_code: "B1", course_title: "SPI", ...over,
});
const mark = (class_id, student_id, status = "present", batch_id = "b1") => ({ class_id, student_id, batch_id, status });
const tst = (id, over = {}) => ({
  id, title: `Test ${id}`, test_type: "quiz", status: "scheduled", available_from: null, available_until: null, batch_id: "b1", class_id: "c1",
  batch_name: "Batch b1", course_title: "SPI", ...over,
});
const res = (test_id, student_id, percentage, over = {}) => ({ test_id, batch_id: "b1", student_id, percentage, passed: percentage >= 50, finalized_at: hoursAgo(10), ...over });

// ---------------------------------------------------------------- India time

test("India time: today, clock and window use Asia/Kolkata, never the UTC date", () => {
  const lateUtc = new Date("2026-10-07T20:00:00Z"); // 01:30 on 8 Oct in India
  assert.equal(L.indiaDate(lateUtc), "2026-10-08");
  assert.equal(L.indiaClock(lateUtc), "01:30");
  assert.deepEqual(L.dashboardWindow(lateUtc), { today: "2026-10-08", from: "2026-09-09", to: "2026-10-15" });
  assert.equal(L.indiaClock(NOW), "12:00");
  assert.equal(L.indiaDate(new Date("2026-10-08T18:29:00Z")), "2026-10-08");
  assert.equal(L.indiaDate(new Date("2026-10-08T18:30:00Z")), "2026-10-09");
});

test("effective test status mirrors the database rule (draft/closed as stored; time moves scheduled → active → closed)", () => {
  assert.equal(L.effectiveTestStatus(tst("t", { status: "draft", available_from: hoursAgo(1) }), NOW), "draft");
  assert.equal(L.effectiveTestStatus(tst("t", { status: "closed" }), NOW), "closed");
  assert.equal(L.effectiveTestStatus(tst("t", { available_from: hoursAhead(1) }), NOW), "scheduled");
  assert.equal(L.effectiveTestStatus(tst("t", { available_from: hoursAgo(1), available_until: hoursAhead(1) }), NOW), "active");
  assert.equal(L.effectiveTestStatus(tst("t", { status: "active", available_until: hoursAgo(1) }), NOW), "closed");
  assert.equal(L.isReleased(tst("t", { status: "active", available_until: hoursAgo(1) }), NOW), true);
  assert.equal(L.isReleased(tst("t", { status: "active" }), NOW), false);
});

// ---------------------------------------------------------------- attendance to mark

test("attendance to mark: held, unmarked classes of current batches with enrolled students — never future, cancelled or not-yet-started", () => {
  const classes = [
    cls("past", { class_date: "2026-10-05" }),
    cls("marked", { class_date: "2026-10-05" }),
    cls("cancelled", { class_date: "2026-10-05", status: "cancelled" }),
    cls("future", { class_date: "2026-10-09" }),
    cls("startedToday", { start_time: "10:00:00" }),
    cls("laterToday", { start_time: "14:00:00" }),
    cls("liveEarly", { start_time: "14:00:00", status: "live" }),
    cls("otherBatch", { class_date: "2026-10-05", batch_id: "old" }),
    cls("emptyBatch", { class_date: "2026-10-05", batch_id: "b2" }),
    cls("beforeWindow", { class_date: "2026-09-01" }),
  ];
  const out = L.classesNeedingAttendance({
    classes,
    marks: [mark("marked", "s1")],
    currentBatchIds: new Set(["b1", "b2"]),
    enrolledByBatch: new Map([["b1", 3]]),
    today: TODAY,
    windowFrom: "2026-09-09",
    clock: "12:00",
  });
  assert.deepEqual(out.map((c) => c.id), ["past", "startedToday", "liveEarly"]);
});

test("today's and upcoming classes: India date, ordered by time; upcoming skips cancelled and is capped", () => {
  const classes = [cls("b", { start_time: "15:00:00" }), cls("a", { start_time: "09:00:00", status: "cancelled" }), cls("y", { class_date: "2026-10-07" })];
  const today = L.todayClasses(classes, TODAY, new Set(["b"]));
  assert.deepEqual(today.map((c) => [c.id, c.startTime, c.needsAttendance]), [["a", "09:00", false], ["b", "15:00", true]]);
  const many = Array.from({ length: 9 }, (_, i) => cls(`u${i}`, { class_date: `2026-10-1${i % 5}` }));
  const up = L.upcomingClasses([...many, cls("x", { class_date: "2026-10-09", status: "cancelled" })], TODAY);
  assert.equal(up.length, L.LIST_LIMIT.upcomingClasses);
  assert.ok(up.every((c) => c.date > TODAY && c.status !== "cancelled"));
  assert.deepEqual(up.map((c) => c.date), [...up.map((c) => c.date)].sort());
});

// ---------------------------------------------------------------- pending actions

test("pending actions: only derivable items, real counts; one item links straight to it, several to the list", () => {
  const empty = L.pendingActions({ needingAttendance: [], submissions: [], tests: [], results: [], now: NOW });
  assert.deepEqual(empty, [], "nothing pending → no actions (the UI shows 'No pending actions')");

  const actions = L.pendingActions({
    needingAttendance: [cls("c1", { class_date: "2026-10-05" })],
    submissions: [
      { assignment_id: "a1", batch_id: "b1", class_id: "c1" },
      { assignment_id: "a1", batch_id: "b1", class_id: "c1" },
      { assignment_id: "a2", batch_id: "b1", class_id: "c2" },
    ],
    tests: [
      tst("open", { available_from: hoursAgo(1), available_until: hoursAhead(1) }),
      tst("recent", { status: "closed", available_until: hoursAgo(24) }),
      tst("recentNoResults", { status: "closed", available_until: hoursAgo(24) }),
      tst("old", { status: "closed", available_until: hoursAgo(24 * 9) }),
    ],
    results: [res("recent", "s1", 70), res("old", "s1", 70), res("open", "s1", 50)],
    now: NOW,
  });
  const by = Object.fromEntries(actions.map((a) => [a.key, a]));
  assert.deepEqual(actions.map((a) => a.key), ["attendance", "assignments", "tests", "results"]);
  assert.equal(by.attendance.count, 1);
  assert.equal(by.attendance.href, "/trainer/classes/c1");
  assert.equal(by.assignments.count, 3);
  assert.equal(by.assignments.href, "/trainer/classes", "submissions across two classes → the class list");
  assert.match(by.assignments.explanation, /3 submissions waiting for your review across 2 classes/);
  assert.equal(by.tests.count, 1);
  assert.equal(by.tests.href, "/trainer/exam-monitoring");
  assert.equal(by.results.count, 1, "closed in the last 7 days AND with finished attempts only");
  assert.equal(by.results.href, "/trainer/tests/recent");
});

// ---------------------------------------------------------------- students needing attention

test("students needing attention: thresholds from existing product rules, minimum evidence, conservative priorities", () => {
  const batches = [batch("b1")];
  const tests = [1, 2, 3].map((n) => tst(`t${n}`, { status: "closed", available_until: hoursAgo(24 * (10 - n)) }));
  tests.push(tst("open", { available_from: hoursAgo(1), available_until: hoursAhead(5) }));
  const results = [
    // crit: low tests (40, 50) and low attendance → critical
    res("t1", "crit", 40), res("t2", "crit", 50),
    // lowp: low tests only → attention
    res("t1", "lowp", 55), res("t2", "lowp", 60),
    // fail: fine average but failed the latest (t3) → monitor
    res("t1", "fail", 90), res("t2", "fail", 90), res("t3", "fail", 45, { passed: false }),
    // one: a single low result is not enough evidence; passed the latest → not listed
    res("t1", "one", 30, { passed: true }),
    // ok: unreleased low result (open test) is ignored
    res("t1", "ok", 90), res("t2", "ok", 90), res("open", "ok", 10),
    // wd: withdrawn student never listed
    res("t1", "wd", 10), res("t2", "wd", 10),
  ];
  const marks = [
    ...["c1", "c2", "c3", "c4"].map((c, i) => mark(c, "crit", i === 0 ? "present" : "absent")),
    ...["c1", "c2", "c3", "c4"].map((c, i) => mark(c, "lowa", i < 2 ? "absent" : "late")),
    mark("c1", "few", "absent"), mark("c2", "few", "absent"), // only 2 marks → not enough evidence
    ...["c1", "c2", "c3"].map((c) => mark(c, "ok", "excused")),
  ];
  const enrolments = ["crit", "lowp", "lowa", "fail", "one", "ok", "few"].map((s) => enrol("b1", s)).concat([enrol("b1", "wd", "withdrawn"), enrol("b1", "done", "completed")]);
  const { rows, total } = L.studentsNeedingAttention({ enrolments, batches, results, tests, marks, now: NOW });

  assert.deepEqual(rows.map((r) => [r.studentId, r.priority]), [["crit", "critical"], ["lowp", "attention"], ["lowa", "attention"], ["fail", "monitor"]]);
  assert.equal(total, 4);
  const crit = rows[0];
  assert.equal(crit.performance, 45);
  assert.equal(crit.attendance, 25);
  assert.deepEqual(crit.weakArea, { title: "Test t1", percent: 40 });
  assert.equal(crit.batchName, "B1 — Batch b1");
  assert.equal(crit.href, "/trainer/performance?batch=b1&student=crit");
  assert.equal(rows.find((r) => r.studentId === "lowa").attendance, 50);
  assert.match(rows.find((r) => r.studentId === "fail").reasons.join(), /Did not pass the latest test \(Test t3\)/);
  assert.ok(!rows.some((r) => ["one", "ok", "few", "wd", "done"].includes(r.studentId)));
});

test("students needing attention: capped list with the real total; students outside the current batches are ignored", () => {
  const tests = [tst("t1", { status: "closed" }), tst("t2", { status: "closed" })];
  const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const results = ids.flatMap((s, i) => [res("t1", s, 30 + i), res("t2", s, 30 + i)]);
  const out = L.studentsNeedingAttention({
    enrolments: [...ids.map((s) => enrol("b1", s)), enrol("gone", "x")],
    batches: [batch("b1")],
    results: [...results, res("t1", "x", 1, { batch_id: "gone" })],
    tests,
    marks: [],
    now: NOW,
  });
  assert.equal(out.rows.length, L.LIST_LIMIT.attention);
  assert.equal(out.total, 12);
  assert.equal(out.rows[0].studentId, "s00", "lowest average first within a priority");
});

// ---------------------------------------------------------------- tests, top 3, overviews

test("upcoming tests: open first, then scheduled by start; no drafts or closed tests; capped", () => {
  const tests = [
    tst("s2", { available_from: hoursAhead(48) }),
    tst("s1", { available_from: hoursAhead(2) }),
    tst("a", { available_from: hoursAgo(1), available_until: hoursAhead(1) }),
    tst("d", { status: "draft", available_from: hoursAhead(1) }),
    tst("c", { status: "closed" }),
    ...Array.from({ length: 6 }, (_, i) => tst(`z${i}`, { available_from: hoursAhead(100 + i) })),
  ];
  const up = L.upcomingTests(tests, NOW);
  assert.equal(up.length, L.LIST_LIMIT.upcomingTests);
  assert.deepEqual(up.slice(0, 3).map((t) => [t.id, t.effectiveStatus]), [["a", "active"], ["s1", "scheduled"], ["s2", "scheduled"]]);
  assert.ok(!up.some((t) => t.id === "d" || t.id === "c"));
});

test("current test Top 3: an open test with results first, else the latest closed (≤ 30 days); one test, enrolled names, ties by earliest finish", () => {
  const enrolments = ["s1", "s2", "s3", "s4"].map((s) => enrol("b1", s)).concat([enrol("b1", "wd", "withdrawn")]);
  const closed = tst("closed", { status: "closed", available_until: hoursAgo(48) });
  const open = tst("open", { available_from: hoursAgo(2), available_until: hoursAhead(2) });
  const results = [
    res("open", "wd", 99),
    res("open", "s1", 80, { finalized_at: hoursAgo(1) }),
    res("open", "s2", 80, { finalized_at: hoursAgo(2) }),
    res("open", "s3", 95),
    res("open", "s4", 10),
    res("closed", "s4", 100),
  ];
  const top = L.currentTestTop({ tests: [closed, open], results, enrolments, now: NOW });
  assert.equal(top.testId, "open");
  assert.equal(top.effectiveStatus, "active");
  assert.equal(top.resultCount, 4, "the withdrawn student's attempt is neither ranked nor counted");
  assert.deepEqual(top.top.map((s) => [s.rank, s.name, s.percentage]), [[1, "Student s3", 95], [2, "Student s2", 80], [3, "Student s1", 80]]);

  const fallback = L.currentTestTop({ tests: [closed, tst("noResults", { available_from: hoursAgo(1) })], results, enrolments, now: NOW });
  assert.equal(fallback.testId, "closed");
  assert.equal(fallback.effectiveStatus, "closed");
  assert.deepEqual(fallback.top.map((s) => s.name), ["Student s4"]);

  const stale = tst("stale", { status: "closed", available_until: hoursAgo(24 * 31) });
  assert.equal(L.currentTestTop({ tests: [stale], results: [res("stale", "s1", 50)], enrolments, now: NOW }), null);
  assert.equal(L.currentTestTop({ tests: [], results: [], enrolments, now: NOW }), null);
});

test("attendance overview and performance overview use the Performance page's definitions", () => {
  const a = L.attendanceOverview([mark("c1", "s1", "present"), mark("c1", "s2", "late"), mark("c2", "s1", "absent"), mark("c2", "s2", "excused")]);
  assert.deepEqual(a, { present: 1, late: 1, absent: 1, excused: 1, marked: 4, rate: 75, classesHeld: 2 });
  assert.equal(L.attendanceOverview([]).rate, null);

  const tests = [tst("c", { status: "closed" }), tst("o", { available_from: hoursAgo(1) })];
  const p = L.performanceOverview([res("c", "s1", 80), res("c", "s2", 40, { passed: false }), res("o", "s1", 0)], tests, NOW);
  assert.deepEqual(p, { average: 60, releasedResults: 2, passRate: 50 });
  assert.deepEqual(L.performanceOverview([], tests, NOW), { average: null, releasedResults: 0, passRate: null });
});

test("weak topics: modules below the Performance page's weak threshold, weakest first, capped", () => {
  const out = L.weakTopics([
    { title: "A", percent: 64.99, answers: 3 },
    { title: "B", percent: 65, answers: 3 },
    { title: "C", percent: 20, answers: 3 },
    { title: "D", percent: 10, answers: 0 },
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Z${i}`, percent: 30 + i, answers: 1 })),
  ]);
  assert.equal(out.length, L.LIST_LIMIT.weakTopics);
  assert.deepEqual(out.slice(0, 2).map((t) => t.title), ["C", "Z0"]);
  assert.ok(!out.some((t) => t.title === "B" || t.title === "D"));
});

test("KPIs: real counts only (no trends)", () => {
  const k = L.trainerKpis({
    batches: [batch("b1"), batch("b2", "upcoming")],
    enrolments: [enrol("b1", "s1"), enrol("b2", "s1"), enrol("b1", "s2"), enrol("b1", "s3", "completed")],
    todayRows: L.todayClasses([cls("a", { status: "completed" }), cls("b"), cls("c", { status: "cancelled" })], TODAY, new Set()),
    performance: { average: 72.5, releasedResults: 4, passRate: 75 },
  });
  assert.deepEqual(k, { currentBatches: 2, ongoingBatches: 1, upcomingBatches: 1, activeStudents: 2, classesToday: 2, classesTodayCompleted: 1, averagePerformance: 72.5, releasedResults: 4 });
  assert.ok(!("trend" in k));
});

// ---------------------------------------------------------------- service core (fake dependencies)

const TRAINER = { id: "tr1", email: "t@x", fullName: "T", role: "trainer", isActive: true, createdAt: "2026-01-01" };

function fakeRepo(over = {}) {
  const calls = [];
  const rec = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(...args) : value;
  };
  const repo = {
    listCurrentBatches: rec("listCurrentBatches", [batch("b1"), batch("b2", "upcoming")]),
    listEnrolments: rec("listEnrolments", [enrol("b1", "s1"), enrol("b1", "s2")]),
    listClasses: rec("listClasses", [
      cls("past", { class_date: "2026-10-06" }),
      cls("today", { start_time: "09:00:00" }),
      cls("cancelled", { class_date: "2026-10-06", status: "cancelled" }),
      cls("future", { class_date: "2026-10-10" }),
      cls("foreign", { class_date: "2026-10-06", batch_id: "old" }),
    ]),
    listAttendance: rec("listAttendance", [mark("past", "s1", "present"), mark("past", "s2", "absent")]),
    listPendingSubmissions: rec("listPendingSubmissions", [{ assignment_id: "a", batch_id: "b1", class_id: "past" }]),
    listTests: rec("listTests", [tst("t1", { status: "closed", available_until: hoursAgo(5) })]),
    listBestResults: rec("listBestResults", [res("t1", "s1", 90), res("t1", "s2", 70)]),
  };
  for (const [k, v] of Object.entries(over)) repo[k] = rec(k, v);
  return { repo, calls };
}

const FEED = {
  unreadCount: 3,
  notifications: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}`, body: "b", link: null, createdAt: hoursAgo(i), readAt: i < 3 ? null : hoursAgo(0) })),
};
const service = (repo, user = TRAINER, modules = async () => [{ title: "M1", percent: 40, answers: 2 }], notifications = async () => FEED) =>
  createTrainerDashboardService({
    repository: repo,
    // The existing Classes service is injected; the fake repo records it like the other reads.
    listClasses: (from, to) => repo.listClasses(from, to),
    getCurrentUser: async () => user,
    getModulePerformance: modules,
    getNotifications: notifications,
    now: () => NOW,
  });

test("service: only an active trainer may load the dashboard", async () => {
  for (const user of [null, { ...TRAINER, role: "admin" }, { ...TRAINER, role: "student" }, { ...TRAINER, isActive: false }]) {
    const { repo, calls } = fakeRepo();
    await assert.rejects(service(repo, user).load(), TrainerDashboardAuthorizationError);
    assert.equal(calls.length, 0, "nothing is read for a refused caller");
  }
});

test("service: every read is scoped to the session trainer and their current batches; attendance only for held classes in scope", async () => {
  const { repo, calls } = fakeRepo();
  const data = await service(repo).load();
  const call = (name) => calls.find((c) => c[0] === name);
  assert.deepEqual(call("listCurrentBatches"), ["listCurrentBatches", "tr1"]);
  assert.deepEqual(call("listClasses"), ["listClasses", "2026-09-09", "2026-10-15"], "India-date window, scope resolved by the Classes service itself");
  for (const n of ["listEnrolments", "listPendingSubmissions", "listTests", "listBestResults"]) assert.deepEqual(call(n), [n, ["b1", "b2"]]);
  assert.deepEqual(call("listAttendance"), ["listAttendance", ["past", "today"]], "no future, cancelled or out-of-scope classes");
  assert.equal(calls.length, 7, "one read each — no per-row queries");

  assert.equal(data.today, TODAY);
  assert.deepEqual(data.kpis, { status: "ok", data: { currentBatches: 2, ongoingBatches: 1, upcomingBatches: 1, activeStudents: 2, classesToday: 1, classesTodayCompleted: 0, averagePerformance: 80, releasedResults: 2 } });
  assert.deepEqual(data.pending.data.map((a) => [a.key, a.count]), [["attendance", 1], ["assignments", 1], ["results", 1]], "today's 09:00 class has started and is unmarked");
  assert.deepEqual(data.todayClasses.data.map((c) => [c.id, c.needsAttendance]), [["today", true]]);
  assert.deepEqual(data.upcomingClasses.data.map((c) => c.id), ["future"]);
  assert.equal(data.currentTest.data.top[0].name, "Student s1");
  assert.equal(data.attendance.data.rate, 50);
  assert.deepEqual(data.weakTopics, { status: "ok", data: [{ title: "M1", percent: 40, answers: 2 }] });
  assert.equal(data.noCurrentBatches, false);
  assert.equal(data.notifications.data.unreadCount, 3);
  assert.deepEqual(data.notifications.data.latest.map((n) => n.id), ["n0", "n1", "n2", "n3"], "the newest few only");
});

test("service: a failed read fails only the sections that depend on it", async () => {
  const { repo } = fakeRepo({ listPendingSubmissions: new Error("boom"), listBestResults: new Error("boom") });
  const data = await service(repo, TRAINER, async () => null, async () => { throw new Error("down"); }).load();
  assert.equal(data.pending.status, "error");
  assert.equal(data.kpis.status, "error");
  assert.equal(data.attention.status, "error");
  assert.equal(data.currentTest.status, "error");
  assert.equal(data.performance.status, "error");
  assert.equal(data.weakTopics.status, "error", "Performance service unavailable → its section only");
  assert.equal(data.notifications.status, "error", "Notifications service down → its section only");
  for (const k of ["todayClasses", "upcomingClasses", "upcomingTests", "attendance"]) assert.equal(data[k].status, "ok", k);
});

test("service: no current batches → empty, honest sections; unreadable batches → the page's error state", async () => {
  const { repo, calls } = fakeRepo({ listCurrentBatches: [], listClasses: [], listEnrolments: [], listTests: [], listBestResults: [], listPendingSubmissions: [], listAttendance: [] });
  const data = await service(repo, TRAINER, async () => []).load();
  assert.equal(data.kpis.data.currentBatches, 0);
  assert.equal(data.noCurrentBatches, true, "the page shows the 'No active batches' notice");
  assert.equal(data.kpis.data.averagePerformance, null);
  assert.deepEqual(data.pending.data, []);
  assert.deepEqual(data.attention.data, { rows: [], total: 0 });
  assert.equal(data.currentTest.data, null);
  assert.ok(calls.some((c) => c[0] === "listAttendance" && c[1].length === 0));

  const failing = fakeRepo({ listCurrentBatches: new Error("boom") });
  await assert.rejects(service(failing.repo).load());
});

// ---------------------------------------------------------------- repository core (recording fake client)

function recordingClient(rows = []) {
  const log = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    log.push(q);
    const b = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return (resolve) => resolve({ data: rows, error: null });
          return (...args) => {
            q.ops.push([prop, ...args]);
            return b;
          };
        },
      }
    );
    return b;
  };
  return { log, client: { from: (t) => builder(t), rpc: () => { throw new Error("no rpc expected"); } } };
}

test("repository: session client only, bounded filters, no rpc; refuses without a client", async () => {
  const { log, client } = recordingClient();
  const repo = createTrainerDashboardRepository(async () => client);
  await repo.listCurrentBatches("tr1");
  await repo.listEnrolments(["b1"]);
  await repo.listAttendance(["c1"]);
  await repo.listPendingSubmissions(["b1"]);
  await repo.listTests(["b1"]);
  await repo.listBestResults(["b1"]);
  const ops = (t) => log.find((q) => q.table === t).ops;
  const has = (t, op) => ops(t).some((o) => JSON.stringify(o) === JSON.stringify(op));
  assert.ok(has("batches", ["in", "trainer_id", ["tr1"]]) && has("batches", ["in", "status", ["upcoming", "ongoing"]]));
  assert.equal(repo.listClasses, undefined, "classes come from the existing Classes service, not a second query");
  assert.ok(!log.some((q) => q.table === "classes"));
  assert.ok(has("class_attendance", ["in", "class_id", ["c1"]]));
  assert.ok(has("assignment_submissions", ["eq", "status", "submitted"]) && has("assignment_submissions", ["in", "batch_id", ["b1"]]));
  assert.ok(has("tests", ["in", "status", ["scheduled", "active", "closed"]]), "drafts are never read");
  assert.ok(has("test_best_results", ["in", "batch_id", ["b1"]]));
  for (const q of log) assert.ok(q.ops.some((o) => o[0] === "range"), `${q.table} is paged`);

  const before = log.length;
  assert.deepEqual(await repo.listAttendance([]), []);
  assert.deepEqual(await repo.listBestResults([]), []);
  assert.equal(log.length, before, "empty scope → no query at all");

  await assert.rejects(createTrainerDashboardRepository(async () => null).listCurrentBatches("tr1"), TrainerDashboardRepositoryError);
  const failing = createTrainerDashboardRepository(async () => ({ from: () => ({ select: () => { throw Object.assign(new Error("x"), { code: "42501" }); } }) }));
  await assert.rejects(failing.listTests(["b1"]), TrainerDashboardRepositoryError);
});

test("notification summary: unread total and the newest few from the existing feed", () => {
  assert.deepEqual(L.notificationSummary({ unreadCount: -1, notifications: [] }), { unreadCount: 0, latest: [] });
  assert.equal(L.notificationSummary(FEED).latest.length, L.LIST_LIMIT.notifications);
});
