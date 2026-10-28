// Anti-Malpractice Step 3 — browser activity signals on the student test page.
// Runs the real src/lib/student-tests modules with Node's own EventTarget and
// BroadcastChannel standing in for the browser (see run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lib = process.env.EXAM_LIB;
if (!lib) throw new Error("Run through tests/student-exam/run.mjs");
const { createClientEventReporter, attachExamMonitors, attemptChannelName } = await import(`${lib}/exam-monitor.mjs`);
const { REPORTED_CLIENT_EVENTS, MAX_EVENTS_PER_REPORT, sanitizeClientEventDetail, isReportedClientEventKind } = await import(`${lib}/client-events.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until the condition holds (fails after 3 s). */
async function waitFor(condition, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out waiting for a BroadcastChannel message");
    await sleep(5);
  }
}
const ATTEMPT = "11111111-2222-4333-8444-555555555555";

/** A recording reporter (what the monitors ask to report). */
function recorder() {
  const events = [];
  let flushes = 0;
  return { events, get flushes() { return flushes; }, report: (kind, detail) => events.push(detail ? { kind, detail } : { kind }), flush: async () => { flushes++; } };
}
function fakeBrowser() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  const area = new EventTarget();
  let t = 1000;
  return { win, doc, area, clock: { now: () => t, advance: (ms) => { t += ms; } } };
}
function attach(b, rec, extra = {}) {
  return attachExamMonitors({ attemptId: ATTEMPT, tabId: "tab-A", reporter: rec, win: b.win, doc: b.doc, area: b.area, now: b.clock.now, channelFactory: null, ...extra });
}
const cancelable = (type) => new Event(type, { cancelable: true });
function setVisibility(b, state) {
  b.doc.visibilityState = state;
  b.doc.dispatchEvent(new Event("visibilitychange"));
}

// ---------------------------------------------------------------- monitors

test("visibility: hidden is reported, and on return the hidden duration (seconds only)", () => {
  const b = fakeBrowser();
  const rec = recorder();
  const detach = attach(b, rec);
  setVisibility(b, "hidden");
  setVisibility(b, "hidden"); // repeated hidden: still one
  b.clock.advance(12_400);
  setVisibility(b, "visible");
  setVisibility(b, "visible"); // no second "visible" without a hide
  assert.deepEqual(rec.events, [
    { kind: "client_hidden", detail: { phase: "hidden" } },
    { kind: "client_hidden", detail: { phase: "visible", hiddenSeconds: 12 } },
  ]);
  detach();
  setVisibility(b, "hidden");
  assert.equal(rec.events.length, 2, "nothing after detach");
});

test("offline/online are reported; coming back online sends what is pending", () => {
  const b = fakeBrowser();
  const rec = recorder();
  const detach = attach(b, rec);
  b.win.dispatchEvent(new Event("offline"));
  b.win.dispatchEvent(new Event("online"));
  assert.deepEqual(rec.events, [{ kind: "client_offline" }, { kind: "client_online" }]);
  assert.equal(rec.flushes, 1);
  detach();
});

test("copy / cut / paste inside the question area are reported and never blocked; outside the area they are ignored", () => {
  const b = fakeBrowser();
  const rec = recorder();
  const detach = attach(b, rec);
  const copy = cancelable("copy");
  copy.clipboardData = { getData: () => "What does FT stand for?" };
  b.area.dispatchEvent(copy);
  b.area.dispatchEvent(cancelable("cut"));
  const paste = cancelable("paste");
  b.area.dispatchEvent(paste);
  assert.deepEqual(rec.events, [{ kind: "client_copy" }, { kind: "client_copy", detail: { cut: true } }, { kind: "client_paste" }]);
  assert.equal(copy.defaultPrevented, false, "copy is not interfered with");
  assert.equal(paste.defaultPrevented, false, "paste is not interfered with");
  b.doc.dispatchEvent(cancelable("copy"));
  b.win.dispatchEvent(cancelable("paste"));
  assert.equal(rec.events.length, 3, "outside the test area: nothing");
  detach();
  b.area.dispatchEvent(cancelable("copy"));
  assert.equal(rec.events.length, 3);
});

test("print: beforeprint is reported once per print (no prevention)", () => {
  const b = fakeBrowser();
  const rec = recorder();
  const detach = attach(b, rec);
  b.win.dispatchEvent(new Event("beforeprint"));
  b.win.dispatchEvent(new Event("beforeprint"));
  b.clock.advance(5000);
  b.win.dispatchEvent(new Event("beforeprint"));
  assert.deepEqual(rec.events, [{ kind: "client_print" }, { kind: "client_print" }]);
  detach();
});

test("print CSS: the question area and exam notes are hidden when printed (not a security boundary)", () => {
  const runner = src("src/app/student/tests/TestRunner.tsx");
  assert.match(runner, /className="grid grid-cols-1 gap-4 print:hidden/);
  assert.match(runner, /hidden text-sm text-ink-muted print:block">Test questions are not included when this page is printed/);
});

test("leave-page warning: registered while the attempt is open, removed afterwards", () => {
  const b = fakeBrowser();
  const detach = attach(b, recorder());
  const e1 = cancelable("beforeunload");
  b.win.dispatchEvent(e1);
  assert.equal(e1.defaultPrevented, true);
  // (e.returnValue = "" is also set for older browsers; Node models returnValue as a boolean.)
  detach();
  const e2 = cancelable("beforeunload");
  b.win.dispatchEvent(e2);
  assert.equal(e2.defaultPrevented, false, "no warning once finished");
});

test("multiple tabs: the same attempt in two tabs is noted once per tab by both; other attempts are ignored", async () => {
  const factory = (name) => new BroadcastChannel(name);
  const [bA, bB, bC] = [fakeBrowser(), fakeBrowser(), fakeBrowser()];
  const [rA, rB, rC] = [recorder(), recorder(), recorder()];
  const seenA = [];
  const seenB = [];
  const dA = attach(bA, rA, { tabId: "tab-A", channelFactory: factory, onOtherTabs: (n) => seenA.push(n) });
  await sleep(30);
  assert.deepEqual(rA.events, [], "alone: nothing");
  const dB = attach(bB, rB, { tabId: "tab-B", channelFactory: factory, onOtherTabs: (n) => seenB.push(n) });
  const dC = attach(bC, rC, { tabId: "tab-C", attemptId: "99999999-2222-4333-8444-555555555555", channelFactory: factory });
  // Delivery is asynchronous (and slower on a busy machine): wait for the outcome instead of a fixed time.
  await waitFor(() => rA.events.length >= 1 && rB.events.length >= 1);
  assert.deepEqual(rA.events, [{ kind: "client_multiple_tabs", detail: { otherTabs: 1 } }]);
  assert.deepEqual(rB.events, [{ kind: "client_multiple_tabs", detail: { otherTabs: 1 } }]);
  assert.deepEqual(seenA, [1]);
  // Spoofed/garbage messages are ignored (the attempt is never terminated here). A final valid
  // hello/bye from the same sender arrives after them (same-sender order is kept), so once it is
  // seen, the junk has been processed too.
  const spoof = new BroadcastChannel(attemptChannelName(ATTEMPT));
  spoof.postMessage({ type: "hello", tabId: 42 });
  spoof.postMessage("junk");
  spoof.postMessage(null);
  spoof.postMessage({ type: "terminate", tabId: "tab-Z" });
  spoof.postMessage({ type: "hello", tabId: "tab-Z" });
  await waitFor(() => rA.events.length >= 2);
  spoof.postMessage({ type: "bye", tabId: "tab-Z" });
  await waitFor(() => seenA.length >= 3);
  assert.deepEqual(rA.events.map((e) => e.detail.otherTabs), [1, 2], "only the valid hello counted");
  assert.deepEqual(seenA, [1, 2, 1]);
  spoof.close();
  dB();
  await waitFor(() => seenA.length >= 4);
  assert.deepEqual(seenA, [1, 2, 1, 0], "the notice clears when the other tab closes");
  assert.deepEqual(rC.events, [], "a different attempt is not the same test");
  dA();
  dC();
});

test("BroadcastChannel unavailable or throwing: monitoring continues without tab detection", () => {
  const b = fakeBrowser();
  const rec = recorder();
  const detach = attach(b, rec, { channelFactory: () => { throw new Error("blocked"); } });
  b.win.dispatchEvent(new Event("offline"));
  assert.deepEqual(rec.events, [{ kind: "client_offline" }]);
  detach();
});

// ---------------------------------------------------------------- reporter (queue, batching, failures)

test("batching: a burst becomes one request after the delay; at most MAX_EVENTS_PER_REPORT per request", async () => {
  const sent = [];
  const r = createClientEventReporter({ send: async (events) => { sent.push(events); }, delayMs: 20 });
  for (let i = 0; i < 12; i++) r.report("client_copy");
  assert.equal(sent.length, 0, "no request per event");
  await sleep(80);
  assert.deepEqual(sent.map((b) => b.length), [MAX_EVENTS_PER_REPORT, 2]);
  assert.equal(r.pending, 0);
});

test("bounded memory: the queue keeps at most maxQueue events (oldest dropped)", async () => {
  const sent = [];
  const r = createClientEventReporter({ send: async (events) => { sent.push(...events); }, delayMs: 10, maxQueue: 20 });
  for (let i = 0; i < 500; i++) r.report(i % 2 ? "client_copy" : "client_paste");
  assert.equal(r.pending, 20);
  await sleep(60);
  assert.equal(sent.length, 20);
});

test("offline: nothing is sent while offline; the queued events go out when back online", async () => {
  let online = false;
  const sent = [];
  const r = createClientEventReporter({ send: async (events) => { sent.push(...events.map((e) => e.kind)); }, delayMs: 10, isOnline: () => online });
  r.report("client_offline");
  await sleep(40);
  assert.deepEqual(sent, []);
  assert.equal(r.pending, 1);
  online = true;
  r.report("client_online");
  await r.flush();
  assert.deepEqual(sent, ["client_offline", "client_online"]);
});

test("failures are swallowed and retried a bounded number of times, then dropped", async () => {
  let calls = 0;
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const r = createClientEventReporter({ send: () => { calls++; if (calls % 2) throw new Error("sync failure"); return Promise.reject(new Error("network")); }, delayMs: 5, maxTries: 3 });
  r.report("client_hidden", { phase: "hidden" });
  await sleep(100);
  process.off("unhandledRejection", onUnhandled);
  assert.equal(calls, 3, "three tries, then the event is dropped");
  assert.equal(r.pending, 0);
  assert.deepEqual(unhandled, []);
});

test("a failing reporter never breaks answer saving or submission (they run independently)", async () => {
  // The same shape as TestRunner: reporting is fire-and-forget; save and submit are awaited on their own.
  const r = createClientEventReporter({ send: () => Promise.reject(new Error("server down")), delayMs: 1 });
  const saved = [];
  const saveAnswer = async (q) => { r.report("client_copy"); await sleep(5); saved.push(q); return { ok: true }; };
  const submit = async () => { r.report("client_print"); await sleep(5); return { ok: true, status: "submitted" }; };
  const results = await Promise.all([saveAnswer("q1"), saveAnswer("q2")]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.deepEqual(await submit(), { ok: true, status: "submitted" });
  assert.deepEqual(saved, ["q1", "q2"]);
  r.stop();

  // And in the real component, reporting is only the useExamIntegrity hook: the save and submit
  // paths never reference it, and the action never throws or returns error text.
  const runner = src("src/app/student/tests/TestRunner.tsx");
  const saveBody = runner.slice(runner.indexOf("const saveNow = useCallback"), runner.indexOf("/** Save now, or shortly"));
  const submitBody = runner.slice(runner.indexOf("const submit = useCallback"), runner.indexOf("// Countdown (display only)"));
  for (const body of [saveBody, submitBody]) assert.doesNotMatch(body, /recordAttemptClientEventsAction|useExamIntegrity|reporter/);
  assert.match(runner, /useExamIntegrity\(paper\.attemptId, !finished, areaRef\)/);
  const actions = src("src/services/student-tests.actions.ts");
  const action = actions.slice(actions.indexOf("export async function recordAttemptClientEventsAction"), actions.indexOf("export interface SubmitAttemptResult"));
  assert.match(action, /catch \(err\) \{[\s\S]*return \{ ok: false \};/);
  assert.doesNotMatch(action, /error:/, "no error text reaches the page");
});

test("after the attempt finishes nothing is sent: stop() drops the queue; a server 'stop' ends reporting", async () => {
  const sent = [];
  const r = createClientEventReporter({ send: async (events) => { sent.push(...events); }, delayMs: 10 });
  r.report("client_copy");
  r.stop();
  r.report("client_paste");
  await r.flush();
  await sleep(40);
  assert.deepEqual(sent, []);
  assert.equal(r.pending, 0);

  const sent2 = [];
  const r2 = createClientEventReporter({ send: async (events) => { sent2.push(...events); return { stop: true }; }, delayMs: 5 });
  r2.report("client_copy");
  await sleep(30);
  assert.equal(r2.stopped, true);
  r2.report("client_paste");
  await sleep(30);
  assert.deepEqual(sent2.map((e) => e.kind), ["client_copy"]);

  // The hook only runs while the attempt is open, and TestRunner marks it finished on submit or when the server ends it.
  const runner = src("src/app/student/tests/TestRunner.tsx");
  assert.equal((runner.match(/stopped\.current = true;\n\s+setFinished\(true\);/g) ?? []).length, 2);
  const hook = src("src/app/student/tests/useExamIntegrity.ts");
  assert.match(hook, /if \(!active\) return;/);
  assert.match(hook, /detach\(\);\s+if \(activeRef\.current\) void reporter\.flush\(\);\s+reporter\.stop\(\);/);
});

test("no sensitive content: details are reduced to known numbers/flags — never question, answer, clipboard or time values", async () => {
  const sent = [];
  const r = createClientEventReporter({ send: async (events) => { sent.push(...events); }, delayMs: 5 });
  const sensitive = { questionText: "What does FT stand for?", answer: "Flow transmitter", optionIds: ["x"], clipboard: "secret", occurred_at: "2000-01-01", score: 5 };
  for (const kind of REPORTED_CLIENT_EVENTS) r.report(kind, { ...sensitive, phase: "visible", hiddenSeconds: 3.7, cut: true, otherTabs: 2 });
  await sleep(40);
  assert.deepEqual(sent, [
    { kind: "client_hidden", detail: { phase: "visible", hiddenSeconds: 3 } },
    { kind: "client_offline" },
    { kind: "client_online" },
    { kind: "client_copy", detail: { cut: true } },
    { kind: "client_paste" },
    { kind: "client_print" },
    { kind: "client_multiple_tabs", detail: { otherTabs: 2 } },
  ]);
  const text = JSON.stringify(sent);
  for (const s of ["FT stand", "Flow transmitter", "secret", "2000-01-01", "optionIds", "score"]) assert.ok(!text.includes(s), s);
  // The same reduction runs on the server for whatever a browser sends.
  assert.deepEqual(sanitizeClientEventDetail("client_hidden", { phase: "visible", hiddenSeconds: 1e12, questionText: "x" }), { phase: "visible", hiddenSeconds: 86400 });
  assert.deepEqual(sanitizeClientEventDetail("client_hidden", { phase: "hidden", hiddenSeconds: 5 }), { phase: "hidden" });
  assert.deepEqual(sanitizeClientEventDetail("client_multiple_tabs", { otherTabs: 999 }), { otherTabs: 10 });
  assert.deepEqual(sanitizeClientEventDetail("client_copy", { cut: "yes", text: "a" }), {});
  assert.deepEqual(sanitizeClientEventDetail("client_paste", ["a"]), {});
  assert.deepEqual(sanitizeClientEventDetail("client_print", "text"), {});
  const service = src("src/services/student-tests.service.ts");
  assert.match(service, /sanitizeClientEventDetail\(e\.kind, e\.detail\)/);
});

test("allow-list: only the seven reported kinds (no full-screen event without a full-screen mode)", () => {
  assert.deepEqual([...REPORTED_CLIENT_EVENTS], ["client_hidden", "client_offline", "client_online", "client_copy", "client_paste", "client_print", "client_multiple_tabs"]);
  for (const k of ["client_fullscreen_exit", "answer_saved", "submit", "concurrent_session", "", null, 1]) assert.equal(isReportedClientEventKind(k), false, String(k));
  const service = src("src/services/student-tests.service.ts");
  assert.match(service, /if \(!isReportedClientEventKind\(e\.kind\)\) continue;/);
  assert.match(service, /events\.slice\(0, MAX_EVENTS_PER_REPORT\)/);
});

test("boundary: events go page → server action → service → repository → record_attempt_client_event, never a service-role or browser DB client", () => {
  const hook = src("src/app/student/tests/useExamIntegrity.ts");
  assert.match(hook, /recordAttemptClientEventsAction\(attemptId, events\)/);
  assert.doesNotMatch(hook, /supabase|createClient\(|service_role/i);
  const monitor = src("src/lib/student-tests/exam-monitor.ts") + src("src/lib/student-tests/client-events.ts");
  assert.doesNotMatch(monitor, /supabase|fetch\(|service_role/i);
  const repo = src("src/repositories/student-tests.repository.ts");
  assert.match(repo, /supabase\.rpc\("record_attempt_client_event", \{ p_attempt_id: attemptId, p_kind: kind, p_detail: detail \}\)/);
  assert.match(repo, /import "server-only";/);
  assert.doesNotMatch(repo, /service_role|SERVICE_ROLE|createServiceRole/);
  assert.match(src("src/services/student-tests.actions.ts"), /^"use server";/);
});

test("exam information is present and non-alarming", () => {
  const runner = src("src/app/student/tests/TestRunner.tsx");
  for (const s of ["The official timer is kept by the server", "Your answers are saved automatically", "some browser activity is noted", "for your trainer to review", "don&apos;t change your answers or your score"]) {
    assert.ok(runner.includes(s), s);
  }
  const shown = runner.slice(runner.indexOf("About this test"), runner.indexOf("Test questions are not included"));
  assert.ok(shown.length > 200);
  assert.doesNotMatch(shown, /cheat|malpractice|penal|violation|suspicious|terminat|disqualif/i);
});
