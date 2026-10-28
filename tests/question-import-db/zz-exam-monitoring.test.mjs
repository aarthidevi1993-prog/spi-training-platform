// Integration (Anti-Malpractice Step 4): staff exam monitoring — the real repository/service
// cores against the local 0001–0016 database, each viewer on their own session (RLS).
// Super Admin sees everything; a trainer only the batches they currently teach; students and
// signed-out users are refused, and RLS gives them no rows even when the repository is called directly.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { USERS, clientFor, db } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createExamMonitoringRepository } = await import(`${build}/repositories/exam-monitoring.repository.core.mjs`);
const { createExamMonitoringService, ExamMonitoringAuthorizationError } = await import(`${build}/services/exam-monitoring.service.core.mjs`);

const repoFor = (u) => createExamMonitoringRepository(async () => clientFor(u));
const serviceFor = (u) => createExamMonitoringService({ repository: repoFor(u), getCurrentUser: async () => u });
const monitor = (u, params = {}) => serviceFor(u).getMonitoring(params);

const Q1 = "EM: Which instrument measures flow?";
const Q1_OPTIONS = ["EM flow transmitter", "EM level switch"];
const Q2 = "EM: Which loop is closed?";
const SECRET = "EM-SECRET-CLIPBOARD-TEXT";
const S1 = randomUUID();
const S2 = randomUUID();

let W; // ids
const student = (key) => ({ id: W[key], email: `${key}@test`, fullName: key, role: "student", isActive: true, createdAt: "2026-01-01" });
const as = (key, sessionId) => db.client(sessionId ? { role: "authenticated", userId: W[key], sessionId } : { role: "authenticated", userId: W[key] });
async function call(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code} ${error.message}`);
  return data;
}
function todayIst(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}
const allEvents = (data) => data.timelines.flatMap((t) => t.events);
const timelineOf = (data, attemptId) => data.timelines.find((t) => t.attempt?.attemptId === attemptId);

before(async () => {
  const I = await db.admin("select json_object_agg(k, v) from t.ids");
  await db.exec(`
    insert into t.ids (k, v) select 'em_' || k, gen_random_uuid() from unnest(array['EM1','EM2','EM3','CL1','CL2','X1','X2']) k;
    insert into auth.users (id) select v from t.ids where k in ('em_EM1','em_EM2','em_EM3');
    update public.profiles set account_status = 'active' where id in (select v from t.ids where k in ('em_EM1','em_EM2','em_EM3'));
    insert into public.students (id, student_code, full_name) values
      (t.id('em_EM1'), 'EM1', 'Monitor Student One'), (t.id('em_EM2'), 'EM2', 'Monitor Student Two'), (t.id('em_EM3'), 'EM3', 'Monitor Student Three');
    insert into public.batch_students (batch_id, student_id) values
      ((select id from public.batches where batch_code = 'B1'), t.id('em_EM1')),
      ((select id from public.batches where batch_code = 'B1'), t.id('em_EM2')),
      ((select id from public.batches where batch_code = 'B2'), t.id('em_EM3'));
    insert into public.classes (id, course_id, batch_id, trainer_id, title, class_date, start_time, end_time) values
      (t.id('em_CL1'), t.id('C1'), (select id from public.batches where batch_code = 'B1'), t.id('T1'), 'Monitoring class B1', current_date, '09:00', '10:00'),
      (t.id('em_CL2'), t.id('C2'), (select id from public.batches where batch_code = 'B2'), t.id('T2'), 'Monitoring class B2', '2027-01-10', '09:00', '10:00');
    insert into t.ids values
      ('em_q1', public.save_question(t.p(t.id('C1'), 'single_choice', 1, t.opts('${Q1_OPTIONS[0]}*', '${Q1_OPTIONS[1]}'), '${Q1}'))),
      ('em_q2', public.save_question(t.p(t.id('C2'), 'single_choice', 1, t.opts('EM open loop', 'EM feedback loop*'), '${Q2}')));
    select public.set_question_status(t.id('em_q1'), 'active');
    select public.set_question_status(t.id('em_q2'), 'active');`, I.A);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
  W.B1 = await db.admin("select id from public.batches where batch_code = 'B1'");
  W.B2 = await db.admin("select id from public.batches where batch_code = 'B2'");
  W.B3 = await db.admin("select id from public.batches where batch_code = 'B3'");
  for (const [test, cls, q, trainer] of [["em_X1", "em_CL1", "em_q1", W.T1], ["em_X2", "em_CL2", "em_q2", W.T2]]) {
    await db.exec(`
      insert into public.tests (id, class_id, batch_id, test_type, title, pass_mark_percent, time_limit_minutes, attempt_limit, available_from, available_until, created_by, updated_by)
      select t.id('${test}'), t.id('${cls}'), c.batch_id, 'quiz', 'Monitoring ${test.slice(3)}', 50, 45, 2, now() - interval '1 minute', now() + interval '30 minutes', '${trainer}', '${trainer}'
        from public.classes c where c.id = t.id('${cls}');
      select public.add_test_questions(t.id('${test}'), array[t.id('${q}')]);
      update public.tests set status = 'active' where id = t.id('${test}');`, trainer);
  }

  // EM1 on X1 (B1): in progress, answers, browser signals (one with sensitive junk sent directly), a second session.
  const c1 = as("em_EM1", S1);
  W.a1 = (await call(c1, "start_test_attempt", { p_test_id: W.em_X1 })).attempt_id;
  const paper = await call(c1, "get_attempt_paper", { p_attempt_id: W.a1 });
  const q = paper.questions[0];
  await call(c1, "save_test_answer", { p_attempt_id: W.a1, p_test_question_id: q.test_question_id, p_option_ids: [q.options[0].id], p_client_seq: 1 });
  W.tq1 = q.test_question_id;
  W.opt1 = q.options[0].id;
  for (const [kind, detail] of [
    ["client_hidden", { phase: "hidden" }],
    ["client_hidden", { phase: "visible", hiddenSeconds: 12, questionText: SECRET, answer: Q1_OPTIONS[0] }],
    ["client_copy", { clipboard: SECRET }],
    ["client_paste", {}],
    ["client_print", {}],
    ["client_multiple_tabs", { otherTabs: 1 }],
  ]) await call(c1, "record_attempt_client_event", { p_attempt_id: W.a1, p_kind: kind, p_detail: detail });
  await call(as("em_EM1", S2), "get_attempt_paper", { p_attempt_id: W.a1 }); // concurrent_session
  await call(c1, "get_attempt_paper", { p_attempt_id: randomUUID() }); // invalid_attempt_access, not linked to an attempt

  // EM2 on X1: finished.
  const c2 = as("em_EM2", randomUUID());
  W.a2 = (await call(c2, "start_test_attempt", { p_test_id: W.em_X1 })).attempt_id;
  await call(c2, "record_attempt_client_event", { p_attempt_id: W.a2, p_kind: "client_offline" });
  await call(c2, "submit_test_attempt", { p_attempt_id: W.a2 });

  // EM3 on X2 (B2, taught by T2): in progress with one browser signal.
  const c3 = as("em_EM3", randomUUID());
  W.a3 = (await call(c3, "start_test_attempt", { p_test_id: W.em_X2 })).attempt_id;
  await call(c3, "record_attempt_client_event", { p_attempt_id: W.a3, p_kind: "client_hidden", p_detail: { phase: "hidden" } });
});

// ---------------------------------------------------------------- access

test("Super Admin: every batch — active attempts of B1 and B2, their timelines, and events not linked to an attempt", async () => {
  const data = await monitor(USERS.A);
  assert.equal(data.role, "admin");
  assert.equal(data.outOfScope, false);
  const active = data.activeAttempts.map((a) => a.attemptId);
  assert.ok(active.includes(W.a1) && active.includes(W.a3), "both in-progress attempts");
  assert.ok(!active.includes(W.a2), "a submitted attempt is not active");
  assert.ok(timelineOf(data, W.a1) && timelineOf(data, W.a2) && timelineOf(data, W.a3));
  assert.ok(data.timelines.some((t) => t.attempt === null && t.events.some((e) => e.type === "invalid_attempt_access")), "unlinked server events (super admin only)");
  for (const b of [W.B1, W.B2, W.B3]) assert.ok(data.options.batches.some((o) => o.value === b));
});

test("Trainer (authorized scope): T1 sees only B1, the batch they currently teach — not B2, not completed B3", async () => {
  const data = await monitor(USERS.T1);
  assert.equal(data.role, "trainer");
  assert.deepEqual(data.options.batches.map((o) => o.value), [W.B1]);
  assert.ok(data.options.tests.some((o) => o.value === W.em_X1) && !data.options.tests.some((o) => o.value === W.em_X2));
  assert.ok(data.options.students.some((o) => o.value === W.em_EM1) && !data.options.students.some((o) => o.value === W.em_EM3));
  const active = data.activeAttempts.map((a) => a.attemptId);
  assert.ok(active.includes(W.a1));
  assert.ok(!active.includes(W.a3), "no B2 attempt");
  assert.equal(timelineOf(data, W.a3), undefined, "no B2 events");
  // Every row T1 can read is in B1 (RLS) — never another batch, never one without a batch.
  const rows = await repoFor(USERS.T1).listEvents({ batchIds: null, testId: null, studentId: null, attemptId: null, attemptIds: null, types: null, fromIso: null, toIso: null, limit: 100000 });
  assert.ok(rows.length > 0);
  assert.deepEqual([...new Set(rows.map((r) => r.batch_id))], [W.B1]);
  assert.ok(!data.timelines.some((t) => t.attempt === null && t.events.some((e) => e.type === "invalid_attempt_access")), "EM1's batch-less probe is not visible to a trainer");

  const t2 = await monitor(USERS.T2);
  assert.deepEqual(t2.options.batches.map((o) => o.value), [W.B2]);
  assert.deepEqual(t2.activeAttempts.map((a) => a.attemptId), [W.a3]);
  assert.deepEqual(t2.timelines.map((t) => t.attempt?.attemptId), [W.a3]);
});

test("Trainer (unauthorized scope): filters outside their batches show nothing — never widened, never leaked", async () => {
  for (const params of [{ batch: W.B1 }, { test: W.em_X1 }, { student: W.em_EM1 }, { batch: W.B3 }]) {
    const data = await monitor(USERS.T2, params);
    assert.equal(data.outOfScope, true, JSON.stringify(params));
    assert.deepEqual(data.activeAttempts, []);
    assert.deepEqual(data.timelines, []);
  }
  // An attempt id from another batch: RLS returns nothing (no error, no data).
  const byAttempt = await monitor(USERS.T2, { attempt: W.a1, category: "all" });
  assert.deepEqual(byAttempt.activeAttempts, []);
  assert.deepEqual(byAttempt.timelines, []);
  // A trainer with no current batch sees nothing at all.
  const t3 = await monitor(USERS.T3, { category: "all" });
  assert.deepEqual([t3.options.batches, t3.options.tests, t3.options.students, t3.activeAttempts, t3.timelines], [[], [], [], [], []]);
});

test("Students and signed-out users are refused; RLS gives students no attempt or event rows (not even their own)", async () => {
  for (const u of [USERS.ST1, student("em_EM1")]) {
    await assert.rejects(monitor(u), (e) => e instanceof ExamMonitoringAuthorizationError && /Only Super Admins and trainers/.test(e.message));
  }
  await assert.rejects(monitor(null), (e) => e instanceof ExamMonitoringAuthorizationError && /signed in/.test(e.message));
  // Even calling the repository directly on a student's session: nothing.
  for (const key of ["em_EM1", "em_EM3"]) {
    const repo = repoFor(student(key));
    const q = { batchIds: null, testId: null, studentId: null, attemptId: null, limit: 100 };
    assert.deepEqual(await repo.listActiveAttempts(q), []);
    assert.deepEqual(await repo.listEvents({ ...q, attemptIds: null, types: null, fromIso: null, toIso: null }), []);
    assert.deepEqual(await repo.attemptsByIds([W.a1, W.a2, W.a3]), []);
  }
  // Anonymous: no table privileges at all.
  await assert.rejects(repoFor(null).listEvents({ batchIds: null, testId: null, studentId: null, attemptId: null, attemptIds: null, types: null, fromIso: null, toIso: null, limit: 5 }));
});

// ---------------------------------------------------------------- filtering and rendering data

test("filtering: category, event type, attempt, student, test and date range", async () => {
  const types = (data) => new Set(allEvents(data).map((e) => e.type));
  const browser = await monitor(USERS.A, { test: W.em_X1, category: "browser" });
  assert.ok([...types(browser)].every((t) => t.startsWith("client_")));
  assert.ok(types(browser).has("client_copy") && types(browser).has("client_offline"));

  const server = await monitor(USERS.A, { test: W.em_X1, category: "server" });
  assert.ok(types(server).has("concurrent_session"));
  assert.ok([...types(server)].every((t) => !t.startsWith("client_") && !["answer_saved", "attempt_started", "submit"].includes(t)));

  const info = await monitor(USERS.A, { test: W.em_X1, category: "info" });
  assert.deepEqual([...types(info)].sort(), ["answer_saved", "attempt_started", "submit"]);

  const review = await monitor(USERS.A, { test: W.em_X1 }); // default: server + browser
  assert.equal(review.filters.category, "review");
  assert.ok(!types(review).has("answer_saved"), "routine saves are not review signals");

  const copy = await monitor(USERS.T1, { type: "client_copy", test: W.em_X1 });
  assert.deepEqual([...types(copy)], ["client_copy"]);
  assert.deepEqual(copy.timelines.map((t) => t.attempt?.attemptId), [W.a1]);
  const mismatch = await monitor(USERS.A, { type: "client_copy", category: "server" });
  assert.deepEqual(mismatch.timelines, [], "a type outside the chosen category matches nothing");

  const one = await monitor(USERS.T1, { attempt: W.a1, category: "all" });
  assert.deepEqual(one.timelines.map((t) => t.attempt?.attemptId), [W.a1]);
  assert.deepEqual(one.activeAttempts.map((a) => a.attemptId), [W.a1]);

  const byStudent = await monitor(USERS.T1, { student: W.em_EM2, category: "all" });
  assert.deepEqual(byStudent.timelines.map((t) => t.attempt?.attemptId), [W.a2]);
  assert.deepEqual(byStudent.activeAttempts, []);

  const today = await monitor(USERS.T1, { test: W.em_X1, from: todayIst(), to: todayIst() });
  assert.ok(allEvents(today).length > 0);
  const tomorrow = await monitor(USERS.T1, { test: W.em_X1, from: todayIst(1) });
  assert.deepEqual(tomorrow.timelines, []);
  const yesterdayOnly = await monitor(USERS.T1, { test: W.em_X1, to: todayIst(-1) });
  assert.deepEqual(yesterdayOnly.timelines, []);

  // Malformed filter values are ignored, not trusted.
  const junk = await monitor(USERS.T1, { batch: "'; drop table x; --", type: "not_a_type", category: "everything", from: "2026-13-45", attempt: "x" });
  assert.deepEqual(junk.filters, { batchId: null, testId: null, studentId: null, attemptId: null, eventType: null, category: "review", from: null, to: null });
});

test("timeline: oldest first, neutral labels, categories, counts and privacy-safe facts", async () => {
  const data = await monitor(USERS.T1, { attempt: W.a1, category: "all" });
  const t = timelineOf(data, W.a1);
  assert.equal(t.attempt.studentName, "Monitor Student One");
  assert.equal(t.attempt.studentCode, "EM1");
  assert.equal(t.attempt.testTitle, "Monitoring X1");
  assert.equal(t.attempt.status, "in_progress");
  assert.equal(t.attempt.attemptNumber, 1);
  const ids = t.events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "oldest first");
  assert.deepEqual(t.events.map((e) => e.type), [
    "attempt_started", "answer_saved", "client_hidden", "client_hidden", "client_copy", "client_paste", "client_print", "client_multiple_tabs", "concurrent_session",
  ]);
  assert.deepEqual(t.counts, { server: 1, browser: 6, info: 2 });
  const byType = (type) => t.events.filter((e) => e.type === type);
  assert.deepEqual(byType("client_hidden")[1].facts, [{ label: "Source", value: "Reported by the browser" }, { label: "State", value: "Returned after about 12 s" }]);
  assert.deepEqual(byType("client_multiple_tabs")[0].facts.at(-1), { label: "Other tabs", value: "1" });
  const cs = byType("concurrent_session")[0];
  assert.equal(cs.label, "Concurrent session detected");
  assert.equal(cs.category, "server");
  assert.deepEqual(cs.facts.map((f) => f.label), ["During", "Detail"]);
  assert.equal(byType("client_copy")[0].label, "Copy in the test area");
  assert.equal(byType("client_copy")[0].category, "browser");
});

test("active attempts: student, test, batch, start, server deadline, time left, status and review-signal count", async () => {
  const data = await monitor(USERS.T1);
  const a = data.activeAttempts.find((x) => x.attemptId === W.a1);
  const row = await db.admin(`select json_build_object('started', started_at, 'deadline', least(deadline_at, (select available_until from public.tests where id = a.test_id))) from public.test_attempts a where id = '${W.a1}'`);
  assert.equal(a.studentName, "Monitor Student One");
  assert.equal(a.testTitle, "Monitoring X1");
  assert.match(a.batchLabel, /^B1 — /);
  assert.equal(a.status, "in_progress");
  assert.equal(new Date(a.startedAt).getTime(), new Date(row.started).getTime());
  assert.equal(new Date(a.effectiveDeadline).getTime(), new Date(row.deadline).getTime(), "min(attempt deadline, test closing time)");
  assert.ok(a.minutesLeft >= 25 && a.minutesLeft <= 30, `closing time (30 min) is earlier than the 45-min limit: ${a.minutesLeft}`);
  assert.equal(a.reviewSignals, 7, "6 browser signals + 1 concurrent session");
});

test("no answer keys, answers, scores, session ids or raw client detail ever reach the monitoring output", async () => {
  // EM2's attempt was submitted in setup, so its stored finalize event holds a score.
  for (const [u, params] of [[USERS.A, { category: "all" }], [USERS.T1, { category: "all" }], [USERS.T1, { attempt: W.a1, category: "all" }]]) {
    const json = JSON.stringify(await monitor(u, params));
    for (const s of [SECRET, Q1, Q2, ...Q1_OPTIONS, S1, S2, W.tq1, W.opt1, "is_correct", "score", "max_score", "client_seq", "session_id", "requested_attempt_id", "marks"]) {
      assert.ok(!json.includes(s), `${s} must not appear`);
    }
  }
  // The stored events DO hold these (so the check above is meaningful).
  const stored = JSON.stringify(await db.admin(`select json_agg(detail) from public.test_security_events where attempt_id in ('${W.a1}', '${W.a2}')`));
  assert.ok(stored.includes(SECRET) && stored.includes(S2) && stored.includes("score"));
});

test("no cross-student access: filtering by one student never returns another's attempts or events", async () => {
  const one = await monitor(USERS.A, { student: W.em_EM1, category: "all" });
  assert.ok(one.timelines.length > 0);
  for (const t of one.timelines) assert.ok(t.attempt === null || t.attempt.studentName === "Monitor Student One");
  assert.ok(one.activeAttempts.every((a) => a.studentName === "Monitor Student One"));
  const three = await monitor(USERS.T2, { student: W.em_EM3, category: "all" });
  assert.deepEqual(three.timelines.map((t) => t.attempt?.attemptId), [W.a3]);
});
