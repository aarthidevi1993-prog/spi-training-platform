// Student Dashboard Phase 1 — the KPI row is the student's OWN metrics from the student-scoped
// performance service; missing data is "—" (never 0), failures are an error state (never zeros),
// no mock numbers reach the page, and the module tiles link to the real student routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.DASHBOARD_BUILD;
if (!build) throw new Error("Run through tests/dashboard/run.mjs");
const sd = await import(`${build}/lib/dashboard/student-dashboard.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const metrics = (over = {}) => ({
  testAverage: null, releasedResults: 0, passedResults: 0, passRate: null,
  attendancePercent: null, attendanceMarked: 0, attendanceAttended: 0,
  assignmentAverage: null, assignmentsScored: 0, ...over,
});
const studentData = (m) => ({ role: "student", metrics: metrics(m), trend: [], modules: null, strongModules: [], weakModules: [], studentResults: [], filters: null, scopeLabel: "x" });

test("real metrics: the four KPIs use the Performance definitions and formatting, with what each is based on", () => {
  const kpis = sd.studentDashboardKpis(metrics({
    attendancePercent: 87.5, attendanceMarked: 8, attendanceAttended: 7,
    testAverage: 72.33, releasedResults: 3, passedResults: 2, passRate: 66.67,
    assignmentAverage: 90, assignmentsScored: 1,
  }));
  assert.deepEqual(kpis.map((k) => [k.key, k.value, k.hint]), [
    ["attendance", "87.5%", "7 of 8 classes attended"],
    ["testAverage", "72.33%", "Across 3 released results"],
    ["passRate", "66.67%", "2 of 3 results passed"],
    ["assignmentAverage", "90%", "Across 1 returned assignment"],
  ]);
});

test("missing data is '—' with a reason; a genuine 0 is shown as 0%", () => {
  const empty = sd.studentDashboardKpis(metrics());
  assert.deepEqual(empty.map((k) => k.value), ["—", "—", "—", "—"]);
  assert.deepEqual(empty.map((k) => k.hint), ["No attendance marked yet", "No released results yet", "No released results yet", "No returned assignments yet"]);
  const zeros = sd.studentDashboardKpis(metrics({ attendancePercent: 0, attendanceMarked: 2, attendanceAttended: 0, testAverage: 0, releasedResults: 1, passRate: 0, passedResults: 0, assignmentAverage: 0, assignmentsScored: 1 }));
  assert.deepEqual(zeros.map((k) => k.value), ["0%", "0%", "0%", "0%"], "a real zero is not hidden as missing");
});

test("loading: success → ready; demo (null) → unavailable; failure → error (logged, never zeros); non-student scope → error", async () => {
  const ok = await sd.loadStudentDashboardKpis(async () => studentData({ attendancePercent: 100, attendanceMarked: 1, attendanceAttended: 1 }));
  assert.equal(ok.kind, "ready");
  assert.equal(ok.kpis[0].value, "100%");
  assert.deepEqual(await sd.loadStudentDashboardKpis(async () => null), { kind: "unavailable" });

  const logs = [];
  const failed = await sd.loadStudentDashboardKpis(async () => { throw Object.assign(new Error("boom: secret-ish detail"), { name: "PerformanceRepositoryError" }); }, (m) => logs.push(m));
  assert.deepEqual(failed, { kind: "error" }, "no kpis at all — so no zeros can be shown");
  assert.deepEqual(logs, ["PerformanceRepositoryError"], "only the error name is logged, not its message");

  assert.deepEqual(await sd.loadStudentDashboardKpis(async () => ({ ...studentData({}), role: "admin" }), () => undefined), { kind: "error" }, "staff-scoped data is never shown as the student's");
  assert.match(sd.STUDENT_KPI_ERROR, /couldn't load/);
});

test("the page reads only the student-scoped performance service; no mock numbers; no service role", () => {
  const page = strip(src("src/app/student/page.tsx"));
  assert.doesNotMatch(page, /lib\/mock|studentKpis/, "no mock statistics on the dashboard");
  // Phase 3: the KPIs and Recent results share ONE call to the student-scoped performance service.
  assert.match(page, /const getPerformance = \(\) => \(performance \?\?= performanceService\.getPerformance\(\)\);/);
  assert.match(page, /loadStudentDashboardKpis\(getPerformance, log\("metrics"\)\)/);
  assert.equal((page.match(/performanceService\.getPerformance\(\)/g) ?? []).length, 1, "one performance read per page load");
  assert.doesNotMatch(page, /@\/repositories\/|@\/lib\/supabase\/|createSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY/, "the page never queries the database directly");
  assert.match(page, /kpis=\{kpiState\.kind === "ready" \? kpiState\.kpis : undefined\}/, "numbers only when ready");
  // The service's student branch: own rows only (RLS), released results via student_available_tests().
  const svc = src("src/services/performance.service.ts");
  assert.match(svc, /if \(user\.role === "student"\) return studentPerformance\(user\);/);
  assert.match(svc, /const own: RowFilter = \{ ownStudentId: user\.id \};/);
  assert.doesNotMatch(svc, /createSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  // The student layout still guards the whole portal.
  assert.match(src("src/app/student/layout.tsx"), /<RoleGuard allowedRoles=\{\["student"\]\}>/);
});

test("module tiles: no placeholder or 'Coming soon'; every tile links to an existing student route", () => {
  const shell = strip(src("src/components/layout/PortalDashboard.tsx"));
  assert.doesNotMatch(shell, /Coming soon|Module placeholder/);
  assert.match(shell, /navigationByRole\[role\]/, "tiles come from the same navigation config as the sidebar");
  const nav = src("src/config/navigation.ts");
  const studentBlock = nav.slice(nav.indexOf("student:"));
  const hrefs = [...studentBlock.matchAll(/href: "(\/student[^"]*)"/g)].map((m) => m[1]).filter((h) => h !== "/student");
  assert.ok(hrefs.length >= 8, `student module routes found: ${hrefs.join(", ")}`);
  for (const href of [...new Set(hrefs)]) {
    if (href.endsWith("/settings")) continue; // filtered out of the tiles
    assert.ok(fs.existsSync(path.join(root, "src/app", href, "page.tsx")), `${href} has a page`);
  }
});

test("KpiCard: the trend is optional (no fake trends); cards with a trend render as before", () => {
  const card = src("src/components/dashboard/KpiCard.tsx");
  assert.match(card, /trend\?: number;/);
  assert.match(card, /hasTrend \? \(/);
  assert.match(card, /\) : hint \? \(/);
  assert.match(src("src/app/student/loading.tsx"), /<LoadingState \/>/);
});

test("mobile UX: concise greeting with the account shown separately; KPI labels never truncated", () => {
  const shell = strip(src("src/components/layout/PortalDashboard.tsx"));
  assert.match(shell, /title=\{"Welcome back!\\u00a0👋"\}/, "short heading; the emoji can't wrap onto its own line");
  assert.doesNotMatch(shell, /Good morning/, "no time-of-day guess (rendered on the server, whatever the student's local time)");
  assert.doesNotMatch(shell, /title=\{`[^`]*\$\{/, "no name or email in the heading");
  assert.match(shell, /Signed in as <span className="font-medium text-ink">\{signedInAs\}<\/span>/);
  assert.match(shell, /\[overflow-wrap:anywhere\]/, "a long email wraps instead of overflowing");
  const page = strip(src("src/app/student/page.tsx"));
  assert.match(page, /signedInAs=\{user\?\.fullName \|\| undefined\}/, "the account's own name/email — nothing invented");

  const card = strip(src("src/components/dashboard/KpiCard.tsx"));
  assert.doesNotMatch(card, /truncate/, "labels wrap; no 'TEST AVER…'");
  assert.match(card, /className="break-words text-2xs font-semibold uppercase leading-tight tracking-wide text-ink-muted">\{label\}/);
  assert.match(card, /flex flex-col items-start gap-2 sm:flex-row sm:gap-3/, "phones: icon above the label so it has the full card width");
  assert.match(card, /text-2xl font-bold text-ink sm:text-kpi/);

  assert.deepEqual(sd.studentDashboardKpis(metrics()).map((k) => k.label), ["Attendance", "Test Average", "Tests Passed", "Assignment Average"]);
});

// ---------------------------------------------------------------- Phase 2: upcoming classes / pending assignments

const cls = (over = {}) => ({ id: "c1", title: "Class", courseTitle: "Course", classDate: "2026-10-20", startTime: "09:00:00", status: "scheduled", ...over });
const asg = (over = {}) => ({ id: "a1", classId: "c1", title: "Task", dueAt: "2026-10-21T10:00:00Z", status: "published", classTitle: "Class", classStatus: "scheduled", ...over });

test("upcoming classes: today or later, not cancelled, soonest first, at most 5, with the real total and class links", () => {
  const today = "2026-10-13";
  const input = [
    cls({ id: "past", classDate: "2026-10-12" }),
    cls({ id: "cancelled", classDate: "2026-10-14", status: "cancelled" }),
    cls({ id: "later", classDate: "2026-10-30" }),
    cls({ id: "today-late", classDate: today, startTime: "15:00:00" }),
    cls({ id: "today-early", classDate: today, startTime: "08:30:00", status: "live" }),
    ...[1, 2, 3, 4].map((n) => cls({ id: `x${n}`, classDate: `2026-10-2${n}` })),
  ];
  const r = sd.pickUpcomingClasses(input, today);
  assert.equal(r.total, 7, "past and cancelled are not counted");
  assert.deepEqual(r.items.map((c) => c.id), ["today-early", "today-late", "x1", "x2", "x3"]);
  assert.equal(r.items[0].startTime, "08:30");
  assert.equal(r.items[0].href, "/student/classes/today-early");
  assert.equal(sd.pickUpcomingClasses([cls({ id: "a b/c" })], today).items[0].href, "/student/classes/a%20b%2Fc", "ids are URL-encoded");
  assert.deepEqual(sd.pickUpcomingClasses([], today), { items: [], total: 0 });
});

test("pending assignments: published, class not cancelled, not yet submitted; due soonest first, no due date last; past-due flagged", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const input = [
    asg({ id: "draft", status: "draft" }),
    asg({ id: "closed", status: "closed" }),
    asg({ id: "cancelled-class", classStatus: "cancelled" }),
    asg({ id: "submitted" }),
    asg({ id: "no-due", dueAt: null, title: "B" }),
    asg({ id: "overdue", dueAt: "2026-10-10T09:00:00Z" }),
    asg({ id: "soon", dueAt: "2026-10-14T09:00:00Z", classId: "k9" }),
  ];
  const r = sd.pickPendingAssignments(input, new Set(["submitted"]), now);
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((a) => [a.id, a.pastDue]), [["overdue", true], ["soon", false], ["no-due", false]]);
  assert.equal(r.items[1].href, "/student/classes/k9", "opens the class page that holds the assignment");
  assert.equal(sd.pickPendingAssignments(Array.from({ length: 8 }, (_, i) => asg({ id: `p${i}` })), new Set(), now).items.length, 5, "at most 5 shown");
});

test("list loading: success → ready (items + total); null → unavailable; failure → error (only the error name logged)", async () => {
  assert.deepEqual(await sd.loadStudentDashboardList(async () => ({ items: [1], total: 9 })), { kind: "ready", items: [1], total: 9 });
  assert.deepEqual(await sd.loadStudentDashboardList(async () => null), { kind: "unavailable" });
  const logs = [];
  assert.deepEqual(await sd.loadStudentDashboardList(async () => { throw Object.assign(new Error("db detail"), { name: "ClassRepositoryError" }); }, (m) => logs.push(m)), { kind: "error" });
  assert.deepEqual(logs, ["ClassRepositoryError"]);
});

test("page wiring: the session's student only — no id from the URL; existing services; each section independent", () => {
  const page = strip(src("src/app/student/page.tsx"));
  assert.doesNotMatch(page, /searchParams|params|studentId|lib\/mock|@\/repositories\/|@\/lib\/supabase\/|SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(page, /pickUpcomingClasses\(await classesService\.listClasses\(\{ dateRange: "upcoming" \}\), today\)/);
  assert.match(page, /loadStudentDashboardList\(\(\) => assignmentsService\.listPendingForStudent\(\), log\("pending assignments"\)\)/);
  assert.match(page, /await Promise\.all\(\[/);

  const svc = src("src/services/assignments.service.ts");
  const fn = svc.slice(svc.indexOf("async listPendingForStudent("), svc.indexOf("async getClassPanel("));
  assert.match(fn, /listPendingForStudent\(now: Date = new Date\(\)\)/, "no student id parameter");
  assert.match(fn, /const user = await requireUser\(\);\s*if \(user\.role !== "student"\) throw new AssignmentAuthorizationError/);
  assert.match(fn, /classesRepository\.findEnrolledBatchIds\(user\.id\)/);
  assert.match(fn, /submissions\.filter\(\(s\) => s\.student_id === user\.id\)/, "only the student's own submissions count");
  assert.match(fn, /classStatus: cls\?\.status \?\? "cancelled"/, "an unreadable class is never treated as open");
  const repo = src("src/repositories/assignments.repository.ts");
  assert.match(repo, /findPublishedInBatches\(batchIds: string\[\]\)[\s\S]*?\.eq\("status", "published"\)/);
  assert.doesNotMatch(repo + svc, /createSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  // Classes: the existing student scope (enrolled batches) is unchanged.
  assert.match(src("src/services/classes.service.ts"), /case "student":[\s\S]*?classesRepository\.findEnrolledBatchIds\(user\.id\)/);
});

test("sections UI: empty, error and demo states; item and 'view all' links go to existing student routes", () => {
  const ui = strip(src("src/components/dashboard/StudentDashboardSections.tsx"));
  assert.match(ui, /empty="No upcoming classes scheduled\."/);
  assert.match(ui, /empty="No assignments waiting for you to submit\."/);
  assert.match(ui, /list\.kind === "error" \? \(\s*<Notice tone="error"/);
  assert.match(ui, /list\.kind === "unavailable" \? \(\s*<Notice tone="info"/);
  assert.match(ui, /href: "\/student\/classes"/);
  assert.match(ui, /<Link href=\{c\.href\}/);
  assert.match(ui, /<Link href=\{a\.href\}/);
  assert.match(ui, /min-w-0 break-words/, "long titles wrap instead of overflowing");
  assert.ok(fs.existsSync(path.join(root, "src/app/student/classes/[classId]/page.tsx")), "the class page the items link to exists");
  assert.match(strip(src("src/components/layout/PortalDashboard.tsx")), /\{sections\}/);
});

// ---------------------------------------------------------------- Phase 3: recent results

const withResults = (results, role = "student") => ({ ...studentData({}), role, studentResults: results });
const res = (testId, percentage, passed, title = `Test ${testId}`) => ({ testId, title, percentage, passed });

test("recent results: the service's released results as given (newest first), at most 3, values unchanged, with the real total", () => {
  const r = sd.studentRecentResults(withResults([res("t4", 0, false), res("t3", 72.5, true), res("t2", 40, false), res("t1", 90, true)]));
  assert.equal(r.total, 4);
  assert.deepEqual(r.items.map((i) => [i.testId, i.percentage, i.passed]), [["t4", 0, false], ["t3", 72.5, true], ["t2", 40, false]], "a real 0% stays 0%; order is the service's");
  assert.equal(r.items[0].href, "/student/tests/t4");
  assert.equal(sd.studentRecentResults(withResults([res("a b/c", 50, true)])).items[0].href, "/student/tests/a%20b%2Fc");
  assert.deepEqual(Object.keys(r.items[0]).sort(), ["href", "passed", "percentage", "testId", "title"], "no score, answers or explanations are carried");
});

test("recent results: none released → empty (not an error); demo → unavailable; non-student scope → error; failure → error", async () => {
  assert.deepEqual(sd.studentRecentResults(withResults([])), { items: [], total: 0 });
  assert.deepEqual(sd.studentRecentResults(withResults(null)), { items: [], total: 0 });
  assert.equal(sd.studentRecentResults(null), null);
  assert.throws(() => sd.studentRecentResults(withResults([res("t1", 50, true)], "admin")), /unexpected performance scope/);

  assert.deepEqual(await sd.loadStudentDashboardList(async () => sd.studentRecentResults(null)), { kind: "unavailable" });
  const logs = [];
  assert.deepEqual(await sd.loadStudentDashboardList(async () => sd.studentRecentResults(withResults([], "trainer")), (m) => logs.push(m)), { kind: "error" });
  assert.deepEqual(await sd.loadStudentDashboardList(async () => { throw Object.assign(new Error("db"), { name: "PerformanceRepositoryError" }); }, (m) => logs.push(m)), { kind: "error" });
  assert.deepEqual(logs, ["UnexpectedScopeError", "PerformanceRepositoryError"], "only error names are logged");
});

test("recent results: released-only source and safe display; page wiring; links to existing routes", () => {
  // Released results only: performanceService builds studentResults from student_available_tests(), released + best result.
  const perf = src("src/services/performance.service.ts");
  assert.match(perf, /const released = tests\.filter\(\(t\) => t\.resultsAvailable && t\.bestResult\);/);
  assert.match(perf, /studentResults: \[\.\.\.dated\]\.reverse\(\)\.map\(\(\{ testId, title, percentage, passed \}\) => \(\{ testId, title, percentage, passed \}\)\)/);

  const page = strip(src("src/app/student/page.tsx"));
  assert.match(page, /loadStudentDashboardList\(async \(\) => studentRecentResults\(await getPerformance\(\)\), log\("recent results"\)\)/);
  assert.match(page, /recentResults=\{recentResults\}/);

  const ui = strip(src("src/components/dashboard/StudentDashboardSections.tsx"));
  assert.match(ui, /title="Recent results"/);
  assert.match(ui, /empty="No released results yet\. Results appear once a test closes\."/);
  assert.match(ui, /viewAll=\{\{ href: "\/student\/results", label: "View all" \}\}/);
  assert.match(ui, /<Link href=\{r\.href\}/);
  const recent = ui.slice(ui.indexOf('title="Recent results"'));
  assert.doesNotMatch(recent, /answer|explanation|correct|score/i, "only title, percentage and passed are shown");
  for (const route of ["src/app/student/results/page.tsx", "src/app/student/tests/[testId]/page.tsx"]) {
    assert.ok(fs.existsSync(path.join(root, route)), route);
  }
});
