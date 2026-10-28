// Staff exam monitoring view (Anti-Malpractice Step 4): the real ExamMonitoringView rendered to
// HTML with react-dom/server, plus the page/route wiring checked in the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.EXAM_MONITORING_BUILD;
if (!build) throw new Error("Run through tests/exam-monitoring/run.mjs");
const { renderToStaticMarkup } = await import(process.env.EXAM_MONITORING_REACT_DOM_SERVER);
const React = await import(process.env.EXAM_MONITORING_REACT);
const { ExamMonitoringView } = await import(`${build}/components/modules/ExamMonitoringView.mjs`);
const events = await import(`${build}/lib/exam-monitoring/events.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const BASE = "/trainer/exam-monitoring";

function data(overrides = {}) {
  return {
    role: "trainer",
    filters: { batchId: null, testId: null, studentId: null, attemptId: null, eventType: null, category: "review", from: null, to: null },
    outOfScope: false,
    options: {
      batches: [{ value: "b1", label: "B1 — Instrumentation" }],
      tests: [{ value: "t1", label: "Unit quiz (B1)" }],
      students: [{ value: "s1", label: "Asha Rao (ST-01)" }],
      eventTypes: events.EVENT_TYPES.map((t) => ({ value: t, label: events.eventMeta(t).label, category: events.eventMeta(t).category })),
    },
    activeAttempts: [
      {
        attemptId: A1, attemptNumber: 1, status: "in_progress", studentName: "Asha Rao", studentCode: "ST-01", testTitle: "Unit quiz", batchLabel: "B1 — Instrumentation",
        startedAt: "2026-09-30T04:30:00Z", effectiveDeadline: "2026-09-30T05:15:00Z", minutesLeft: 42, reviewSignals: 3,
      },
    ],
    timelines: [
      {
        attempt: { attemptId: A1, attemptNumber: 1, status: "in_progress", studentName: "Asha Rao", studentCode: "ST-01", testTitle: "Unit quiz", batchLabel: "B1 — Instrumentation" },
        counts: { server: 1, browser: 2, info: 0 },
        events: [
          { id: 10, occurredAt: "2026-09-30T04:31:00Z", type: "client_hidden", label: events.eventMeta("client_hidden").label, category: "browser", facts: events.summarizeEventDetail("client_hidden", { source: "client", client: { phase: "visible", hiddenSeconds: 95 } }) },
          { id: 11, occurredAt: "2026-09-30T04:32:00Z", type: "client_paste", label: events.eventMeta("client_paste").label, category: "browser", facts: events.summarizeEventDetail("client_paste", { source: "client", client: {} }) },
          { id: 12, occurredAt: "2026-09-30T04:33:00Z", type: "concurrent_session", label: events.eventMeta("concurrent_session").label, category: "server", facts: events.summarizeEventDetail("concurrent_session", { operation: "save", session_id: "aaaaaaaa-0000-4000-8000-000000000000", started_session_id: "bbbbbbbb-0000-4000-8000-000000000000" }) },
        ],
      },
      {
        attempt: { attemptId: A2, attemptNumber: 2, status: "submitted", studentName: "Ravi Kumar", studentCode: null, testTitle: "Unit quiz", batchLabel: "B1 — Instrumentation" },
        counts: { server: 0, browser: 1, info: 0 },
        events: [{ id: 20, occurredAt: "2026-09-30T04:40:00Z", type: "client_offline", label: events.eventMeta("client_offline").label, category: "browser", facts: [] }],
      },
    ],
    eventsTruncated: false,
    eventLimit: 300,
    generatedAt: "2026-09-30T04:33:00Z",
    ...overrides,
  };
}
const render = (d, basePath = BASE) => renderToStaticMarkup(React.createElement(ExamMonitoringView, { data: d, basePath }));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("active attempts: student, test, batch, start, server deadline with time left, status, review signals and a timeline link", () => {
  const html = render(data());
  const t = text(html);
  const row = html.slice(html.indexOf(`data-attempt="${A1}"`), html.indexOf("</tr>", html.indexOf(`data-attempt="${A1}"`)));
  assert.ok(row.length > 0);
  for (const s of ["Asha Rao (ST-01)", "Unit quiz", "Attempt 1", "B1 — Instrumentation", "30 Sept 2026, 10:00 am", "30 Sept 2026, 10:45 am", "42 min left", "In progress"]) {
    assert.ok(text(row).includes(s), s);
  }
  assert.match(row, new RegExp(`href="${BASE}\\?attempt=${A1}"`), "timeline link keeps to the same page");
  assert.match(t, /Attempts in progress 1/);
  assert.equal(text(render(data({ activeAttempts: [{ ...data().activeAttempts[0], minutesLeft: 0 }] }))).includes("Time limit reached"), true);
  assert.equal(text(render(data({ activeAttempts: [{ ...data().activeAttempts[0], minutesLeft: 135 }] }))).includes("2 h 15 min left"), true);
});

test("timeline: one card per attempt, events in the given (oldest-first) order, category badges, counts and facts", () => {
  const html = render(data());
  const card = html.slice(html.indexOf(`data-timeline="${A1}"`), html.indexOf(`data-timeline="${A2}"`));
  const order = [...card.matchAll(/data-event-type="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["client_hidden", "client_paste", "concurrent_session"]);
  const t = text(card);
  for (const s of ["Asha Rao (ST-01)", "In progress", "Server security event: 1", "Browser activity signal: 2",
    "Page hidden (tab or window switched)", "Returned after about 1 min", "Paste in the test area", "Concurrent session detected",
    "During: saving an answer", "Reported by the browser"]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(!t.includes("Informational: 0"), "zero counts are not shown");
  assert.match(card, /data-category="server"/);
  assert.match(card, /data-category="browser"/);
  assert.ok(!card.includes("aaaaaaaa-0000") && !card.includes("bbbbbbbb-0000"), "session ids never shown");
  const second = text(html.slice(html.indexOf(`data-timeline="${A2}"`)));
  assert.ok(second.includes("Ravi Kumar") && second.includes("Submitted") && second.includes("Browser went offline"));
});

test("distinct presentation for server events, browser signals and informational events", () => {
  const html = render(data({ filters: { ...data().filters, category: "all" }, timelines: [{
    attempt: null, counts: { server: 1, browser: 1, info: 1 },
    events: [
      { id: 1, occurredAt: "2026-09-30T04:00:00Z", type: "invalid_attempt_access", label: "Attempt access refused", category: "server", facts: [] },
      { id: 2, occurredAt: "2026-09-30T04:01:00Z", type: "client_print", label: "Print started", category: "browser", facts: [] },
      { id: 3, occurredAt: "2026-09-30T04:02:00Z", type: "attempt_started", label: "Attempt started", category: "info", facts: [] },
    ] }] }));
  const badge = (label) => new RegExp(`<span class="[^"]*(bg-[a-z-]+Soft|bg-surface-sunken)[^"]*">${label}</span>`).exec(html)?.[1];
  assert.equal(badge("Server security event"), "bg-signal-blueSoft");
  assert.equal(badge("Browser activity signal"), "bg-signal-amberSoft");
  assert.equal(badge("Informational"), "bg-surface-sunken");
  assert.ok(text(html).includes("Not linked to an attempt"));
  assert.ok(text(html).includes("All events"));
});

test("empty states, out-of-scope notice and truncation notice", () => {
  const empty = text(render(data({ activeAttempts: [], timelines: [] })));
  assert.ok(empty.includes("No attempts in progress"));
  assert.ok(empty.includes("No matching activity"));
  const scoped = text(render(data({ outOfScope: true, activeAttempts: [], timelines: [] })));
  assert.ok(scoped.includes("isn't in your monitoring scope, so nothing is shown"));
  assert.ok(!text(render(data())).includes("monitoring scope"));
  assert.ok(text(render(data({ eventsTruncated: true }))).includes("Showing the 300 most recent matching events"));
});

test("filter form: a GET form on the same page with the current values selected", () => {
  const html = render(data({ filters: { ...data().filters, batchId: "b1", category: "browser", eventType: "client_copy", from: "2026-09-01", attemptId: A1 } }), "/admin/exam-monitoring");
  assert.match(html, /<form method="get" action="\/admin\/exam-monitoring"/);
  assert.match(html, /<option value="b1" selected="">B1 — Instrumentation<\/option>/);
  assert.match(html, /<option value="browser" selected="">Browser activity signals<\/option>/);
  assert.match(html, /<option value="client_copy" selected="">Copy in the test area · Browser activity signal<\/option>/);
  assert.match(html, /name="from"[^>]*value="2026-09-01"|value="2026-09-01"[^>]*name="from"/);
  assert.match(html, new RegExp(`<input type="hidden" name="attempt" value="${A1}"/>`));
  assert.ok(text(html).includes("Show all attempts"));
  assert.match(html, /href="\/admin\/exam-monitoring\?batch=b1&amp;type=client_copy&amp;category=browser&amp;from=2026-09-01"/, "clearing the attempt keeps the other filters");
});

test("neutral language: no guilt score, verdict or accusation anywhere on the page", () => {
  const t = text(render(data({ filters: { ...data().filters, category: "all" } }))).toLowerCase();
  for (const word of ["cheat", "guilt", "guilty", "malpractice", "violation", "offender", "suspect", "caught", "penalty", "risk score", "integrity score", "disqualif"]) {
    assert.ok(!t.includes(word), word);
  }
  assert.ok(t.includes("review signals only: nothing here changes an attempt, a score or a result"));
  for (const t2 of events.EVENT_TYPES) assert.doesNotMatch(events.eventMeta(t2).label.toLowerCase(), /cheat|suspicious|violation|malpractice/);
  assert.ok(t.includes("you see the batches you currently teach"), "trainer scope explained");
  assert.ok(!text(render(data({ role: "admin" }))).includes("batches you currently teach"));
});

test("privacy: the detail summariser keeps only whitelisted facts", () => {
  const sensitive = { reason: "invalid_options", test_question_id: "q-uuid", option_count: 2, client_seq: 99, requested_attempt_id: "r-uuid", score: 5, max_score: 6, session_id: "s-uuid" };
  const facts = JSON.stringify(events.summarizeEventDetail("blocked_answer_save", sensitive));
  assert.equal(facts, JSON.stringify([{ label: "Reason", value: "answer not valid for the question" }]));
  assert.equal(JSON.stringify(events.summarizeEventDetail("auto_submit", { reason: "deadline", score: 3, max_score: 6 })), JSON.stringify([{ label: "Reason", value: "time limit passed" }]));
  assert.deepEqual(events.summarizeEventDetail("answer_saved", { test_question_id: "q", option_count: 1, client_seq: 5 }), []);
  assert.deepEqual(events.summarizeEventDetail("client_copy", { source: "client", client: { cut: true, text: "SECRET", questionText: "Q" } }), [
    { label: "Source", value: "Reported by the browser" }, { label: "Action", value: "Cut" },
  ]);
  assert.deepEqual(events.summarizeEventDetail("suspicious_repeated_access", { rule: "audit_throttle", throttled_event: "answer_saved", limit_per_minute: 121 }), [
    { label: "Rule", value: "Audit rate limit reached; further entries of this kind were summarised" }, { label: "Entries", value: "Answer saved" }, { label: "Per minute", value: "121" },
  ]);
  assert.deepEqual(events.summarizeEventDetail("invalid_attempt_access", "not an object"), []);
});

test("routes and wiring: staff-only layouts, server-side service, no client Supabase, navigation entries", () => {
  for (const role of ["admin", "trainer"]) {
    const page = src(`src/app/${role}/exam-monitoring/page.tsx`);
    assert.match(page, /examMonitoringService\.getMonitoring\(searchParams\)/);
    assert.match(page, /export const dynamic = "force-dynamic";/);
    assert.doesNotMatch(page, /"use client"|supabase/i);
    assert.match(src(`src/app/${role}/exam-monitoring/loading.tsx`), /LoadingState/);
    assert.match(src(`src/app/${role}/layout.tsx`), new RegExp(`<RoleGuard allowedRoles=\\{\\["${role}"\\]\\}>`));
    assert.match(src("src/config/navigation.ts"), new RegExp(`\\{ label: "Exam Monitoring", href: "/${role}/exam-monitoring", icon: ShieldCheck \\}`));
  }
  assert.ok(!fs.existsSync(path.join(root, "src/app/student/exam-monitoring")), "no student route");
  assert.doesNotMatch(src("src/config/navigation.ts").split("student: [")[1], /exam-monitoring/);
  const view = src("src/components/modules/ExamMonitoringView.tsx");
  assert.doesNotMatch(view, /"use client"|supabase|service_role/i);
  const service = src("src/services/exam-monitoring.service.core.ts");
  assert.match(service, /if \(user\.role !== "admin" && user\.role !== "trainer"\) throw new ExamMonitoringAuthorizationError\(\);/);
  const repo = src("src/repositories/exam-monitoring.repository.core.ts") + src("src/repositories/exam-monitoring.repository.ts");
  assert.match(repo, /createExamMonitoringRepository\(createSupabaseServerClient\)/);
  assert.doesNotMatch(repo, /service_role|SERVICE_ROLE|createServiceRole|is_correct|\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});
