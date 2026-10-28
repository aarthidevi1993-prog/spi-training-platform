// Super Admin dashboard (D1 / D2a / D2b-2A) — source-level tests for the page, the view and the data
// boundary: real data only (no mock imports), Super Admin service, session client only (no service role),
// no client-side database access, fixed error messages, accessible structure, no fake trends, no greeting
// or emoji, no private fields, links only to existing workflows. D2b-2A deliberately changes three earlier
// rules: the header now has a real period selector (server links), the performance summary and Weak Topics
// are period-based from dashboard_analytics (streamed in their own Suspense boundaries), and Training
// health shows six lines with an overall worst-line status. D2b-2B adds the batch and course comparison panels
// (same single response, name order, no status bands, links to the existing batch / course / performance pages).
// D2b-2C adds the Student Performance (Top 5) panel: the current ranking (0027 students.current) with the period's trend.
// D2b-2D adds Course Progress (current-state delivery and enrolment per course) and the attendance-definition note.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

const PAGE = "src/app/admin/page.tsx";
const VIEW = "src/components/dashboard/AdminDashboard.tsx";
const CHART = "src/components/dashboard/TrendChart.tsx";
const LIB = "src/lib/dashboard/admin-dashboard.ts";
const ANALYTICS = "src/lib/dashboard/analytics.ts";
const REPO_CORE = "src/repositories/dashboard.repository.core.ts";
const REPO = "src/repositories/dashboard.repository.ts";
const SVC_CORE = "src/services/dashboard.service.core.ts";
const SVC = "src/services/dashboard.service.ts";
const DASHBOARD_FILES = [PAGE, VIEW, CHART, LIB, ANALYTICS, REPO_CORE, REPO, SVC_CORE, SVC];

test("page: dynamic; loads through the Super Admin dashboard service with ?period=; the current-state half first, analytics streamed; fixed error message", () => {
  const page = strip(src(PAGE));
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /load = await adminDashboardService\.load\(period\);\s*data = await load\.core;/, "waits for the current-state half only");
  assert.match(page, /<AdminDashboard data=\{data\} analytics=\{load\.analytics\} \/>/, "the analytics promise streams into the view");
  assert.match(page, /<DashboardContent period=\{searchParams\.period\} \/>/, "the raw value goes to the service, which validates it");
  assert.match(page, /<Suspense fallback=\{<AdminDashboardSkeleton \/>\}>/, "loading state scoped to this page");
  assert.ok(!exists("src/app/admin/loading.tsx"), "no admin-wide loading.tsx (it would replace every other /admin page's loading state)");
  assert.match(page, /<ErrorState title="We couldn't load the dashboard" description="Please try again\." \/>/);
  assert.match(page, /console\.error\("\[admin\/dashboard\] load failed:", err instanceof Error \? err\.name : "unknown error"\)/, "error name only");
  for (const spec of importsOf(page)) {
    assert.ok(["react", "@/components/layout/PageHeader", "@/components/ui/ErrorState", "@/components/dashboard/AdminDashboard", "@/services/dashboard.service"].includes(spec), `page imports ${spec}`);
  }
  assert.match(src("src/app/admin/layout.tsx"), /<RoleGuard allowedRoles=\{\["admin"\]\}>/, "the admin RoleGuard still wraps the page");
});

test("view: a server component rendering the read model only — no mock data, services, repositories or database access", () => {
  for (const rel of [VIEW, CHART]) {
    const raw = src(rel);
    assert.doesNotMatch(raw, /^["']use client["'];/, `${rel}: server component`);
    for (const spec of importsOf(raw)) {
      assert.ok(
        ["next/link", "react", "lucide-react", "@/components/layout/PageHeader", "@/components/dashboard/TrendChart", "@/utils/format", "@/lib/dashboard/admin-dashboard", "@/lib/dashboard/periods", "@/lib/dashboard/analytics"].includes(spec) ||
          spec.startsWith("@/components/ui/"),
        `${rel} imports ${spec}`
      );
    }
    const view = strip(raw);
    assert.doesNotMatch(view, /lib\/mock|dashboard\.mock|@\/services|@\/repositories|supabase|\.from\(\s*["'`]|\.rpc\(/i, `${rel} (Array.from in the skeleton is not a table read)`);
    assert.doesNotMatch(view, /onClick|<form|formAction|useState|useEffect|"use server"/, `${rel}: no mutations or client behaviour (Panel's action={{ href, label }} is a link)`);
  }
});

test("view: no greeting, emoji, invented trend widgets, hard-coded colours or private fields; arrows only for real comparisons", () => {
  const view = strip(src(VIEW));
  assert.doesNotMatch(view, /Good (morning|afternoon|evening)|welcomeName/i);
  assert.doesNotMatch(view, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji");
  assert.doesNotMatch(view, /KpiCard|TrendingUp|TrendingDown|trendLabel|vs last month/i, "no invented trend widgets");
  // Arrows only inside ComparisonLine (D2a KPI comparisons) and ComparisonText (D2b-2A period comparisons in pp).
  const arrows = [...view.matchAll(/\bArrow(Up|Down)\b/g)].map((m) => m.index);
  const spans = [["function ComparisonLine", "function Metrics("], ["function ComparisonText", "async function PerformancePanel"]].map(([a, b]) => [view.indexOf(a), view.indexOf(b)]);
  assert.ok(arrows.length > 0 && arrows.every((i) => i < 400 || spans.some(([a, b]) => i > a && i < b)), "arrows only in the import, ComparisonLine and ComparisonText");
  assert.match(view, /const cmp = m\.key === "classesToday" \|\| m\.key === "completionsAwaitingApproval" \? section\.data\.comparisons\[m\.key\] : null;/);
  assert.match(view, /function ComparisonLine\(\{ cmp \}: \{ cmp: Comparison \}\)/);
  assert.match(view, /cmp\.percent !== null && cmp\.direction !== "same"/, "a percentage only when there is a baseline");
  assert.match(view, /function ComparisonText\(\{ c \}: \{ c: RateComparison \}\)/);
  for (const rel of [VIEW, CHART]) assert.doesNotMatch(strip(src(rel)), /#[0-9a-fA-F]{6}\b/, `${rel}: theme tokens only`);
  assert.doesNotMatch(view, /email|phone|account_?status|accountStatus|organization|designation/i);
  assert.doesNotMatch(view, /at-risk|at risk|needs follow-up/i, "no D3 content");
});

test("accessibility: one h1 (PageHeader), each section an h2 inside a labelled region, the trend has a caption and a table alternative", () => {
  const view = strip(src(VIEW));
  const chart = strip(src(CHART));
  assert.doesNotMatch(view, /<h1/, "the only h1 comes from PageHeader");
  assert.equal((view.match(/<PageHeader\b/g) ?? []).length, 1);
  assert.match(view, /<section aria-labelledby=\{id\}/);
  assert.match(view, /<h2 id=\{id\} className=/);
  for (const id of ["dash-metrics", "dash-attention"]) assert.match(view, new RegExp(`<h2 id="${id}"`), id);
  for (const id of ["dash-today", "dash-upcoming-classes", "dash-tests", "dash-overview", "dash-performance", "dash-health", "dash-topics", "dash-batches", "dash-courses", "dash-students", "dash-progress", "dash-activity", "dash-actions", "dash-approvals"]) {
    assert.match(view, new RegExp(`id="${id}"`), id);
  }
  assert.match(view, /<figure aria-labelledby="dash-trend-caption">/);
  assert.match(view, /<TrendChart points=\{panels\.data\.trend\} captionId="dash-trend-caption" \/>/);
  assert.match(chart, /<svg viewBox=\{`0 0 \$\{W\} \$\{H\}`\} className="h-56 w-full" preserveAspectRatio="none" aria-hidden="true">/, "the SVG is decorative…");
  assert.match(chart, /<summary className="cursor-pointer text-xs font-medium text-signal-blue">View the trend as a table<\/summary>/, "…the figures are a keyboard-reachable table");
  for (const l of ["Test average", "Pass rate", "Attendance", "Assignment average"]) assert.ok(chart.includes(`label: "${l}"`), `legend: ${l}`);
  assert.match(chart, /strokeDasharray=\{s\.dash \|\| undefined\}/, "series differ by line pattern, not colour alone");
  assert.match(view, /aria-busy="true"/, "skeletons announce loading");
  assert.match(view, /\{t\.state === "open" \? "Open" : "Scheduled"\}/, "status as text, not colour alone");
  assert.match(view, />\s*Unread\s*</);
  for (const label of ["View all classes", "View all tests", "View all batches", "View detailed performance", "View all notifications", "View module performance", "Review all completions", "View all courses", "View performance"]) {
    assert.ok(view.includes(label), label);
  }
  assert.match(view, /<Badge tone=\{BAND_TONE\[t\.band\]\}>\{TOPIC_BAND_LABEL\[t\.band\]\}<\/Badge>/, "topic band as text, not only the bar colour");
  assert.match(view, /<TableHeaderCell>Batch<\/TableHeaderCell>/, "pending approvals is a semantic table");
  assert.match(view, /<span className="sr-only">Action<\/span>/);
  assert.match(view, /Review \{b\.batchName\}/, "descriptive per-row link");
});

test("header: the approved title and subtitle; a real period selector (server links, current marked) showing the period and the comparison period", () => {
  const view = strip(src(VIEW));
  assert.match(view, /export const DASHBOARD_TITLE = "Training Intelligence & Operations";/);
  assert.match(view, /export const DASHBOARD_SUBTITLE = "Track performance, manage operations, and ensure successful training outcomes\.";/);
  // D2b-2F: the selector sits beside / under the title in the dashboard's own row (it was clipped inside PageHeader's shrink-0 actions slot)
  assert.match(view, /<PageHeader title=\{DASHBOARD_TITLE\} description=\{DASHBOARD_SUBTITLE\} className="min-w-0 pb-0" \/>\s*<PeriodSelector period=\{data\.period\} today=\{data\.today\} \/>/);
  assert.doesNotMatch(view, /actions=\{<PeriodSelector/);
  assert.match(view, /<nav aria-label="Reporting period" className="max-w-full">/);
  assert.match(view, /\{PERIOD_KEYS\.map\(\(key\) => \{/, "exactly the four supported periods");
  assert.match(view, /href=\{`\/admin\?period=\$\{key\}`\}/, "server links; no client state");
  assert.match(view, /aria-current=\{selected \? "page" : undefined\}/);
  assert.match(view, /\{period\.label\} · \{formatDateRange\(period\.from, period\.to\)\}/);
  assert.match(view, /vs \{formatDateRange\(period\.prevFrom, period\.prevTo\)\}/);
  assert.match(view, /<time dateTime=\{today\}>/, "the India date stays visible");
  assert.doesNotMatch(view, /<select|<Select|useRouter|searchParams/i, "no client-side period state");
  assert.match(strip(src(PAGE)), /<PageHeader title=\{DASHBOARD_TITLE\} \/>/, "the page-level error keeps the title");
});

test("performance summary and weak topics: management-level, period-based, never the Performance page's detail", () => {
  const view = strip(src(VIEW));
  assert.match(view, /title="Training performance"/);
  assert.match(view, /action=\{\{ href: "\/admin\/performance", label: "View detailed performance" \}\}/, "the detail stays on the existing Performance page");
  assert.match(view, /\{panels\.data\.performance\.map\(\(m\) =>/, "the four summary figures");
  assert.match(view, /if \(c\.state === "no_comparison"\) return <span className="text-ink-faint">No comparison<\/span>;/, "D2b-2F cleanup: short on-screen wording");
  assert.match(view, /title="No activity in this period"/);
  assert.doesNotMatch(view, /strongModules|weakModules|studentResults|Stronger modules|Weaker modules|filters\.batches|PerformanceFilters|PerformanceView/, "no module / student / batch detail");
  assert.match(view, /title="Weak Topics"/);
  assert.match(view, /title="Insufficient data"/);
  assert.match(view, /<Compact title="Not enough data yet" description="Not enough graded answers this period\." \/>/, "D2b-2F cleanup: compact Weak Topics no-data state (the rule — 5 graded answers per module — is unchanged in the read model)");
  assert.doesNotMatch(view + strip(src(ANALYTICS)), /"Weak"|"Developing"|"Strong"|"developing"/, "one vocabulary: Healthy / Watch / Attention");
});

test("training health: six lines, each with its reason; overall worst line wins with 'Based on X of 6'; never a numeric score", () => {
  const view = strip(src(VIEW));
  assert.match(view, /<Badge tone=\{HEALTH_TONE\[h\.status\]\}>\{HEALTH_LABEL\[h\.status\]\}<\/Badge>/, "health status as text");
  assert.match(view, /<p className="mt-0\.5 pl-4 text-xs text-ink-muted">\{healthReason\(h\)\}<\/p>/, "every status shows its reason (D2b-2F cleanup: in short form)");
  assert.match(view, /Overall: \{health\.data\.overall\.status === "no_data" \? "No data" : HEALTH_LABEL\[health\.data\.overall\.status\]\}/);
  assert.match(view, /Based on \{health\.data\.overall\.basedOn\} of \{health\.data\.overall\.total\} indicators/);
  assert.match(view, /no_data: "neutral", unavailable: "neutral"/, "No data / Unavailable are neutral, not failures");
  assert.doesNotMatch(view, /health score|score\}|\/100/i, "no numeric score");
  assert.doesNotMatch(view, /top performers|ranking|course-wise|batch-wise/i, "no 'top performers' / ranking wording in the view (Student Performance (Top 5) is the approved D2b-2C title)");
});

test("streaming and isolation: each analytics panel has its own Suspense boundary and a fixed unavailable state; current-state sections render without them", () => {
  const view = strip(src(VIEW));
  for (const [panel, key] of [["PerformancePanel", "performance"], ["TrainingHealthPanel", "health"], ["WeakTopicsPanel", "topics"], ["BatchComparisonPanel", "batches"], ["CourseComparisonPanel", "courses"], ["StudentPerformancePanel", "students"], ["CourseProgressPanel", "progress"]]) {
    assert.match(view, new RegExp(`<Suspense key=\\{\`${key}-\\$\\{data\\.period\\.key\\}\`\\} fallback=\\{<PanelLoading `), `${panel}: own fallback, re-shown when the period changes`);
    assert.match(view, new RegExp(`async function ${panel}\\(`), `${panel} awaits the analytics promise itself`);
  }
  assert.match(view, /function AnalyticsUnavailable\(\) \{\s*return <SectionError \/>;/, "fixed message — no SQL or stack detail (audit: the same compact section error)");
  for (const s of ["<Metrics section={data.metrics} />", "<Attention section={data.attention} />", "<Overview section={data.overview} />", "<TodayClasses section={data.todayClasses}", "<PendingApprovalsPanel section={data.approvals}"]) {
    assert.ok(view.includes(s), `${s} renders from the current-state half`);
  }
});

test("sections: empty and error states; attention hidden when nothing needs attention; responsive grids; reading order", () => {
  const view = strip(src(VIEW));
  assert.match(view, /if \(section\.status === "ok" && section\.data\.length === 0\) return null;/);
  assert.match(view, /<p className="text-sm font-medium text-ink">Unable to load this section\.<\/p>\s*<p className="text-xs text-ink-muted">Refresh to retry\.<\/p>/);
  for (const t of ["No classes today", "No upcoming classes", "No upcoming tests", "No recent activity"]) assert.ok(view.includes(t), t);
  assert.match(view, /grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6/, "2 / 3 / 6 metrics per row (D2b-2F: wide enough for full labels)");
  assert.match(view, /grid grid-flow-row-dense grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3/, "1 / 2 / 3 content columns; each panel keeps its own content height (QA fix #2/#3)");
  const order = ["<Attention", "<Metrics", "<PerformancePanel", "<TrainingHealthPanel", "<BatchComparisonPanel", "<CourseProgressPanel", "<CourseComparisonPanel", "<StudentPerformancePanel", "<WeakTopicsPanel", "<Overview", "<QuickActions", "<TodayClasses", "<UpcomingClasses", "<UpcomingTests", "<Activity", "<PendingApprovalsPanel"];
  const positions = order.map((s) => view.lastIndexOf(s));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "D2b-2F rows: Attention, KPIs, performance + health, batches + progress, courses + students, topics + overview + actions, classes + tests, activity + approvals");
});

test("quick actions and links: only existing /admin routes, no new mutation workflows", () => {
  const view = strip(src(VIEW)) + strip(src(LIB)) + strip(src(ANALYTICS)) + strip(src(SVC_CORE));
  const hrefs = [...view.matchAll(/href: "([^"]+)"/g)].map((m) => m[1].split("?")[0]);
  assert.ok(hrefs.length >= 10);
  const routes = {
    "/admin/users": "src/app/admin/users/page.tsx",
    "/admin/batches": "src/app/admin/batches/page.tsx",
    "/admin/courses": "src/app/admin/courses/page.tsx",
    "/admin/batches/new": "src/app/admin/batches/new/page.tsx",
    "/admin/classes": "src/app/admin/classes/page.tsx",
    "/admin/classes/new": "src/app/admin/classes/new/page.tsx",
    "/admin/tests": "src/app/admin/tests/page.tsx",
    "/admin/exam-monitoring": "src/app/admin/exam-monitoring/page.tsx",
    "/admin/certificates": "src/app/admin/certificates/page.tsx",
    "/admin/performance": "src/app/admin/performance/page.tsx",
    "/admin/notifications": "src/app/admin/notifications/page.tsx",
    "/admin/attendance": "src/app/admin/attendance/page.tsx",
  };
  for (const h of hrefs) {
    assert.ok(routes[h], `known route ${h}`);
    assert.ok(exists(routes[h]), `${h} exists`);
  }
  assert.match(view, /href=\{`\/admin\/classes\/\$\{encodeURIComponent\(c\.id\)\}`\}/);
  assert.match(view, /href=\{`\/admin\/tests\/\$\{encodeURIComponent\(t\.id\)\}`\}/);
  assert.match(view, /href=\{`\/admin\/certificates\/\$\{encodeURIComponent\(b\.batchId\)\}`\}/);
  assert.ok(exists("src/app/admin/certificates/[batchId]/page.tsx"), "the per-batch completion page exists");
  // D2b-2B links (built in the read model): batch / course detail and the Performance page's batch filter
  assert.ok(view.includes("href: `/admin/batches/${encodeURIComponent(b.id)}`"), "batch detail link");
  assert.ok(view.includes("performanceHref: `/admin/performance?batch=${encodeURIComponent(b.id)}`"), "Performance page, filtered to the batch");
  assert.ok(view.includes("href: `/admin/courses/${encodeURIComponent(c.id)}`"), "course detail link");
  assert.ok(exists("src/app/admin/batches/[batchId]/page.tsx") && exists("src/app/admin/courses/[courseId]/page.tsx"), "the detail pages exist");
  assert.ok(src("src/app/admin/performance/page.tsx").includes("batchId: first(searchParams.batch)"), "the Performance page reads ?batch=");
});

test("boundary: session client only — no service role, no admin client, no writes; exactly ONE database function call (dashboard_analytics, in the repository)", () => {
  for (const rel of DASHBOARD_FILES) {
    const code = strip(src(rel));
    assert.doesNotMatch(code, /supabase\/admin|createSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY|service_role|auth\.admin|auth-admin/i, rel);
    assert.doesNotMatch(code, /\.(insert|update|upsert|delete)\(/, `${rel}: reads only`);
  }
  const rpcs = DASHBOARD_FILES.flatMap((rel) => [...strip(src(rel)).matchAll(/\.rpc\(([^,)]*)/g)].map((m) => `${rel}:${m[1]}`));
  assert.deepEqual(rpcs, [`${REPO_CORE}:"dashboard_analytics"`], "the analytics RPC only, only in the repository");
  assert.match(src(REPO), /^import "server-only";/);
  assert.match(src(REPO), /createSupabaseServerClient\(\)/, "the caller's own session");
  assert.match(src(SVC), /^import "server-only";/);
  assert.match(strip(src(REPO_CORE)), /\{ count: "exact", head: true \}/, "totals are database counts");
  assert.match(strip(src(REPO_CORE)), /readAllByKeyset/, "the current-batch read is paged");
  assert.doesNotMatch(strip(src(SVC)), /listBatches\(|listStudents\(|listClasses\(|getSummary\(|getOverview\(/, "no unpaged list endpoints for totals");
  for (const f of fs.readdirSync(path.join(root, "src/components/dashboard"))) {
    const code = src(`src/components/dashboard/${f}`);
    if (/^["']use client["'];/.test(code)) assert.doesNotMatch(code, /@\/(services|repositories)|supabase/, `${f}: no server code in client components`);
  }
  assert.match(strip(src(ANALYTICS)), /export function parseAnalytics\(json: unknown\)/, "RPC JSON is validated, not cast");
  assert.match(strip(src(SVC_CORE)), /parseAnalytics\(await fetchAnalytics\(period, today\)\)/);
});

test("the dashboard no longer depends on the Performance service; the dedicated Performance page keeps it", () => {
  for (const rel of [SVC, SVC_CORE, VIEW, PAGE]) assert.doesNotMatch(src(rel), /performanceService|performance\.service|getPerformance/, rel);
  assert.match(src("src/app/admin/performance/page.tsx"), /performanceService/, "the Performance page still uses its own service");
  assert.ok(exists("src/services/performance.service.ts") && exists("src/repositories/performance.repository.ts"));
});

test("the old mock dashboard is gone from the Super Admin page; the shared KpiCard and portal dashboards are untouched", () => {
  assert.doesNotMatch(src(PAGE) + src(VIEW), /dashboard\.mock|adminKpis|recentTestResults|recentActivity|courseProgressSegments/);
  assert.match(src("src/components/dashboard/KpiCard.tsx"), /trend: number|trend,/i, "KpiCard keeps its existing contract for the trainer/student portals");
  // Student Dashboard Phase 1 replaced the portal dashboard's mock KPIs with the student's real metrics
  // (tests/dashboard/student-dashboard.test.mjs); it still renders the shared KpiCard and never mock data.
  const portal = src("src/components/layout/PortalDashboard.tsx");
  assert.match(portal, /<KpiCard/);
  assert.doesNotMatch(portal, /dashboard\.mock/);
});

test("batch and course comparison (D2b-2B): from the one analytics response, name order, evidence and comparison wording, current completion, no status bands", () => {
  const view = strip(src(VIEW));
  const lib = strip(src(ANALYTICS));
  const panel = (name, next) => view.slice(view.indexOf(`async function ${name}(`), view.indexOf(next));
  const batches = panel("BatchComparisonPanel", "async function CourseComparisonPanel(");
  const courses = panel("CourseComparisonPanel", "function PendingApprovalsPanel(");
  assert.match(batches, /title="Batch comparison"/);
  assert.match(courses, /title="Course comparison"/);
  assert.match(batches, /\{panels\.data\.batches\.rows\.map\(\(b\) =>/);
  assert.match(courses, /\{panels\.data\.courses\.rows\.map\(\(c\) =>/);
  for (const p of [batches, courses]) {
    assert.match(p, /const \{ panels \} = await analytics;/, "the shared analytics promise — no further call");
    assert.match(p, /panels\.status === "error" \? \(\s*<AnalyticsUnavailable \/>/, "the existing unavailable state");
    assert.doesNotMatch(p, /Badge|BAND_TONE|HEALTH_LABEL|TOPIC_BAND_LABEL|Healthy|Watch|Attention/, "no status bands on batches / courses");
    assert.doesNotMatch(p, /\.sort\(|\.reverse\(/, "rows are never re-ordered");
    // D2b-2F: a compact table from md; below md each row stacks into label / value pairs — never a scrolling wide table
    assert.match(p, /<table className=\{CMP_TABLE\}>/);
    assert.match(p, /<thead className="hidden border-b border-surface-border bg-surface-sunken min-\[900px\]:table-header-group">/);
    assert.doesNotMatch(p, /overflow-x|min-w-\[|whitespace-nowrap|<Table\b/, "no wide or scrolling table");
  }
  assert.match(batches, /title="No batch activity in this period"/);
  assert.match(courses, /title="No course activity in this period"/);
  assert.match(batches, /<th scope="col" className=\{`\$\{CMP_HEAD\} text-right`\}>Completion \(current\)<\/th>/, "completion is labelled a current figure");
  assert.match(batches, /<td data-label="Completion \(current\)" className=\{CMP_FIGURE\}>/);
  assert.match(batches, /Completion \(current\) is of enrolments now, not this period\./);
  assert.match(batches, /<Link href=\{b\.href\}/);
  assert.match(batches, /<Link href=\{b\.performanceHref\}[\s\S]*?View performance<span className="sr-only"> of \{b\.name\}<\/span>/, "descriptive per-row link");
  assert.match(courses, /<Link href=\{c\.href\}/);
  assert.match(batches, /description=\{panels\.status === "ok" \? periodShort\(panels\.data\.period\) : undefined\}/, "audit: the exact dates are shown once, in the header");
  assert.match(courses, /description=\{panels\.status === "ok" \? periodShort\(panels\.data\.period\) : undefined\}/);
  assert.match(view, /<p className="mt-2 text-2xs text-ink-faint">\{text\} · listed by \{order\}<\/p>/, "the order is still stated when a list is cut");
  assert.match(view, /<ShownText text=\{panels\.data\.batches\.shownText\} order="name" \/>/);
  assert.match(view, /<ShownText text=\{panels\.data\.courses\.shownText\} order="title" \/>/);
  // responsive: stacked label / value pairs below 900px (labels from data-label), table cells from 900px (QA fix #1:
  // at 768–860 the sidebar leaves a ~450–540px panel, narrower than the six-column batch table)
  assert.match(view, /const CMP_FIGURE =\s*"flex items-baseline justify-between gap-3 py-0\.5 before:text-2xs before:text-ink-muted before:content-\[attr\(data-label\)\] min-\[900px\]:table-cell/);
  for (const c of ["CMP_TABLE", "CMP_ROW", "CMP_NAME", "CMP_FIGURE"]) {
    const def = view.slice(view.indexOf(`const ${c} =`), view.indexOf(";", view.indexOf(`const ${c} =`)));
    assert.match(def, /min-\[900px\]:/, `${c} switches at 900px`);
    assert.doesNotMatch(def, /\b(sm|md|lg):/, `${c}: no earlier table breakpoint`);
  }
  for (const [p, labels] of [[batches, ["Test average", "Pass rate", "Attendance", "Assignment average"]], [courses, ["Test average", "Pass rate", "Attendance", "Assignment average"]]]) {
    assert.deepEqual([...p.matchAll(/<FigureCell label="([^"]+)"/g)].map((m) => m[1]), labels, "the same four figures, same order");
  }
  // D2b-2F cleanup: insufficient data shows "—" on screen; the read model's wording and the record count are read out
  assert.match(view, /<span aria-hidden="true">—<\/span>\s*<span className="sr-only">Insufficient data, \{countText\(figure\.evidence, noun\)\}<\/span>/, "audit: the count once, correct plural");
  assert.match(view, /<span className="block font-mono text-sm font-semibold text-ink">\{figure\.display\}<\/span>\s*<span className="sr-only">\{countText\(figure\.evidence, noun\)\}<\/span>/, "real values unchanged, from the read model");
  assert.match(batches, /<FigureCell label="Test average" figure=\{b\.testAvg\} noun="released results" change=\{b\.testAvgChange\} \/>/);
  assert.match(batches, /<FigureCell label="Attendance" figure=\{b\.attendance\} noun="attendance records" change=\{b\.attendanceChange\} \/>/);
  assert.match(courses, /<FigureCell label="Test average" figure=\{c\.testAvg\} noun="released results" change=\{c\.testAvgChange\} \/>/);
  // Step B: both comparison panels sit in the one analytics grid, two columns wide from lg
  assert.match(view, /<Suspense key=\{`batches-\$\{data\.period\.key\}`\} fallback=\{<PanelLoading id="dash-batches" title="Batch comparison" className="lg:col-span-2" \/>\}>\s*<BatchComparisonPanel analytics=\{analytics\} className="lg:col-span-2" \/>/);
  assert.match(view, /<Suspense key=\{`courses-\$\{data\.period\.key\}`\} fallback=\{<PanelLoading id="dash-courses" title="Course comparison" className="lg:col-span-2" \/>\}>\s*<CourseComparisonPanel analytics=\{analytics\} className="lg:col-span-2" \/>/);
  // wording comes from the read model: insufficient evidence and missing comparisons are explicit
  assert.match(lib, /`Insufficient data \(\$\{evidence\}\)`/);
  assert.match(lib, /comparison\.state === "change" \? formatPoints\(comparison\) : "No comparison data"/);
  assert.match(view, /if \(change\.comparison\.state !== "change"\) return <span className="sr-only">No comparison data<\/span>;/, "still explicit (never 0 pp), but read out instead of printed in every cell");
  assert.match(lib, /shownText: total > rows\.length \? `Showing \$\{rows\.length\} of \$\{total\}` : null/);
  assert.doesNotMatch(lib.slice(lib.indexOf("export function batchComparison"), lib.indexOf("const hasAny")), /\.sort\(/, "no ranking in the read model");
  // D2b-2D not built (student results are D2b-2C, tested below)
  assert.doesNotMatch(view, /datasets\./, "the view renders the read models only, never the raw analytics lists (Course Progress, D2b-2D, uses panels.data.progress)");
});

test("Student Performance (Top 5) (D2b-2C): students.current (0027) in database order — #, name, Test Avg, trend arrow with its pp value and a text label; one analytics response", () => {
  const view = strip(src(VIEW));
  const lib = strip(src(ANALYTICS));
  const panel = view.slice(view.indexOf("const TREND_ARROW ="), view.indexOf("function ChangeText("));
  assert.ok(panel.includes("async function StudentPerformancePanel("), "the panel is inside the D2b-2C section");
  assert.match(panel, /title="Student Performance \(Top 5\)" action=\{\{ href: "\/admin\/performance", label: "View detailed performance" \}\}/, "exact title, subtitle and the existing Performance page link");
  assert.match(panel, /const \{ panels \} = await analytics;/, "the shared analytics promise — no further call");
  assert.match(panel, /panels\.status === "error" \? \(\s*<AnalyticsUnavailable \/>/, "the existing unavailable state");
  assert.match(view, /<Suspense key=\{`students-\$\{data\.period\.key\}`\} fallback=\{<PanelLoading id="dash-students" title="Student Performance \(Top 5\)" \/>\}>\s*<StudentPerformancePanel analytics=\{analytics\} \/>/, "keyed Suspense, same place");
  // exactly four columns, in order
  const heads = [...panel.matchAll(/<th scope="col" className=\{.*?\}>\s*([^<]+?)\s*(?:<span|<\/th>)/g)].map((m) => m[1]);
  assert.deepEqual(heads, ["Rank", "Student", "Average score", "Trend"], "D2b-2F header wording");
  assert.match(panel, /Average score<span className="sm:hidden lg:inline"> \/ Trend<\/span>/, "where the trend is stacked, the header says so");
  assert.equal((panel.match(/<col\b/g) ?? []).length, 4);
  assert.match(panel, /<caption className="sr-only">Student Performance \(Top 5\), by average score<\/caption>/);
  // rows: database order and rank, name with the code beneath, one-decimal average, trend cell
  assert.match(panel, /\{panels\.data\.students\.rows\.map\(\(s\) =>/);
  assert.match(panel, /font-semibold text-ink">\{s\.rank\}<\/span>/, "the database rank number");
  assert.match(panel, /<span className="block break-words font-medium text-ink">\{s\.name\}<\/span>\s*\{s\.code && <span className="block break-words font-mono text-2xs text-ink-faint">\{s\.code\}<\/span>\}/, "QA fix #5: the code breaks only if it cannot fit, never mid-identifier by default");
  // QA fix #5: the panel is one narrow grid column below sm and from lg — the trend sits under the average there;
  // the separate Trend column shows only where the panel is wide (sm–lg). Exactly one of the two is displayed.
  assert.match(panel, /const SP_TREND_COLUMN = "hidden sm:table-cell lg:hidden";/);
  assert.match(panel, /const SP_TREND_STACKED = "mt-0\.5 block font-sans font-normal sm:hidden lg:block";/);
  assert.match(panel, /\{s\.averageDisplay\}\s*<span className=\{SP_TREND_STACKED\}>\s*<TrendCell row=\{s\} \/>\s*<\/span>\s*<\/td>/);
  assert.match(panel, /<td className=\{`px-2 py-2 text-right align-top \$\{SP_TREND_COLUMN\}`\}>\s*<TrendCell row=\{s\} \/>/);
  assert.match(panel, /<th scope="col" className=\{`\$\{SP_HEAD\} text-right \$\{SP_TREND_COLUMN\}`\}>Trend<\/th>/);
  assert.equal((panel.match(/<TrendCell row=\{s\} \/>/g) ?? []).length, 2);
  // trend: arrow (decorative) + text label (screen readers) + the pp value — never colour alone; null → "No comparison"
  assert.match(panel, /const TREND_ARROW = \{ up: "↑", down: "↓", neutral: "→", none: "" \} as const;/);
  assert.match(panel, /<span aria-hidden="true">\{TREND_ARROW\[row\.trendDirection\]\}<\/span>\s*<span className="sr-only">\{row\.directionLabel\}:<\/span>\s*<span>\{row\.trendDisplay\}<\/span>/);
  assert.match(panel, /if \(row\.trendDirection === "none"\) return <span className="text-xs text-ink-faint">\{row\.trendDisplay\}<\/span>;/);
  assert.match(lib, /trendDisplay: s\.trend === null \? "No comparison" : formatTrendPoints\(s\.trend\)/);
  assert.match(lib, /if \(points >= TREND_THRESHOLD_PP\) return "up";\s*if \(points <= -TREND_THRESHOLD_PP\) return "down";\s*return "neutral";/, "±1 pp thresholds, inclusive");
  assert.match(lib, /up: "Up", down: "Down", neutral: "No meaningful change", none: "No comparison"/);
  // empty state and caption
  assert.match(panel, /panels\.data\.students\.insufficient \? \(\s*<Compact title="Insufficient data" description="Needs 3\+ released results per student \(last 366 days\)" \/>/, "the rule stays visible: it explains the empty panel");
  assert.match(panel, /<p className="mt-3 text-2xs text-ink-faint">\{STUDENT_CAPTION\}<\/p>/);
  assert.match(panel, /const STUDENT_CAPTION = "Ranked over the last 366 days · trend vs previous period";/, "audit: shorter caption, same ranking window and trend basis");
  assert.match(lib, /caption: `Current ranking: last 366 days · trend: \$\{periodLabel\} vs previous`/);
  // the current ranking comes from students.current only — never substituted from the period-based lists
  assert.match(lib, /students: studentPerformance\(raw\.students\.current, raw\.students\.current_window, PERIOD_LABEL\[key\]\)/);
  assert.doesNotMatch(lib.slice(lib.indexOf("export function studentPerformance"), lib.indexOf("const hasAny")), /\.sort\(|\.reverse\(|students\.(top|improving|declining)/, "never re-ranked or substituted");
  // wording: none of the retired / banned labels; no per-student links
  assert.doesNotMatch(view, /Student results|Highest test averages|"Improving"|"Declining"|Top performers|View all students/i);
  assert.doesNotMatch(panel, /<Link|href=\{|\?student=|\/admin\/users|\/admin\/students/, "no per-student URL");
  assert.doesNotMatch(panel, /at-risk|at risk|follow-up|intervention|Badge|HEALTH_LABEL/i);
  // responsive (~400 px): a fixed-layout table that fits — wrapping names, narrow fixed columns, no horizontal overflow
  assert.match(panel, /<table className="w-full table-fixed border-collapse text-sm">/);
  assert.match(panel, /<col className="w-12" \/>\s*<col \/>\s*<col className="w-28 sm:w-24 lg:w-28" \/>\s*<col className="w-0 sm:w-28 lg:w-0" \/>/, "narrow panel: 48 + 112 px fixed; wide panel: 48 + 96 + 112 px; the name column takes the rest");
  assert.doesNotMatch(panel, /overflow-x|min-w-\[|w-\[|whitespace-nowrap|truncate|<Table\b/, "no wide, clipped or scrolling layout");
});

test("Course Progress (D2b-2D): current-state delivery (primary) and enrolment completion (secondary) per course from the one analytics response — evidence only, no status labels", () => {
  const view = strip(src(VIEW));
  const lib = strip(src(ANALYTICS));
  const panel = view.slice(view.indexOf("function NotAvailable("), view.indexOf("const TREND_ARROW ="));
  assert.ok(panel.includes("async function CourseProgressPanel("), "the panel is inside the D2b-2D section");
  assert.match(panel, /title="Course Progress" description="Current delivery and enrolment progress" action=\{\{ href: "\/admin\/courses", label: "View all courses" \}\}/, "exact title, current-state subtitle and the courses link");
  assert.match(panel, /const \{ panels \} = await analytics;/, "the shared analytics promise — no further call");
  assert.match(panel, /panels\.status === "error" \? \(\s*<AnalyticsUnavailable \/>/, "the existing unavailable state");
  assert.match(view, /<BatchComparisonPanel analytics=\{analytics\} className="lg:col-span-2" \/>\s*<\/Suspense>\s*<Suspense key=\{`progress-\$\{data\.period\.key\}`\} fallback=\{<PanelLoading id="dash-progress" title="Course Progress" \/>\}>\s*<CourseProgressPanel analytics=\{analytics\} \/>\s*<\/Suspense>/, "own keyed Suspense; D2b-2F: in the batch-comparison row");
  // rows from the read model (never the raw lists), one heading per course
  assert.match(panel, /\{panels\.data\.progress\.rows\.map\(\(r\) => \(\s*<CourseProgressItem key=\{r\.courseId\} row=\{r\} \/>/);
  assert.match(panel, /<h3 className="min-w-0 break-words text-sm font-medium text-ink">\{row\.course\}<\/h3>/);
  // primary: delivery % with the counts behind it; overdue; secondary: enrolment completion — all as text (the bar is decorative)
  assert.match(panel, /<span className="sr-only">Delivery progress: <\/span>\s*\{d \? d\.percentDisplay : <NotAvailable \/>\}/);
  assert.match(panel, /<div className="mt-1 h-1\.5 w-full overflow-hidden rounded-sm bg-surface-sunken" aria-hidden="true">/, "the bar is decorative; the % is text");
  assert.match(panel, /\{d && d\.percent !== null && \(/, "no bar without a planned class (no misleading 0 %)");
  assert.match(panel, /<dt className="inline text-ink-muted">Delivered: <\/dt>\s*<dd className="inline text-ink">\{d \? `\$\{d\.delivered\} \/ \$\{d\.planned\} classes` : <NotAvailable \/>\}<\/dd>/);
  assert.match(panel, /<dt className="inline text-ink-muted">Overdue: <\/dt>/);
  assert.match(panel, /<dt className="inline text-ink-muted">Enrolment completion: <\/dt>\s*<dd className="inline text-ink">\{e \? `\$\{e\.completed\} \/ \$\{e\.active\} · \$\{e\.percentDisplay\}` : <NotAvailable \/>\}<\/dd>/);
  assert.match(panel, /—<span className="sr-only"> not available<\/span>/, "a missing value is announced, not just a dash");
  // evidence only: no status labels or status colours
  assert.doesNotMatch(panel, /On Track|Delayed|At Risk|Badge|HEALTH_LABEL|BAND_TONE|signal-red|signal-amber|signal-green|Healthy|Watch|Attention/i);
  // empty state, subset notes, current-state note
  assert.match(panel, /panels\.data\.progress\.empty \? \(\s*<Compact title="No course progress yet"/);
  assert.match(panel, /\{panels\.data\.progress\.deliveryShownText && <p className="mt-3 text-2xs text-ink-faint">\{panels\.data\.progress\.deliveryShownText\}<\/p>\}/);
  assert.match(panel, /\{panels\.data\.progress\.enrolmentShownText && <p className="mt-1 text-2xs text-ink-faint">\{panels\.data\.progress\.enrolmentShownText\}<\/p>\}/);
  assert.match(panel, /Current state — not affected by the reporting period\./);
  // the read model: joined by course_id (never by position), percentages computed once from the counts, never re-sorted
  assert.match(lib, /const enrolmentById = new Map\(enrolment\.map\(\(e\) => \[e\.course_id, e\]\)\);/);
  assert.match(lib, /\.\.\.enrolment\.filter\(\(e\) => !deliveryIds\.has\(e\.course_id\)\)/, "enrolment-only courses are kept, not discarded");
  assert.match(lib, /const percent = progressPercent\(d\.delivered, d\.planned\);/);
  assert.match(lib, /const percent = progressPercent\(e\.completed, e\.active\);/);
  assert.doesNotMatch(lib.slice(lib.indexOf("export function courseProgress"), lib.indexOf("const hasAny")), /\.sort\(|\.reverse\(/, "authoritative order kept");
  assert.match(lib, /progress: courseProgress\(raw\.delivery, raw\.delivery_total, raw\.enrolment, raw\.enrolment_total\)/);
  // responsive (~400 px): wrapping course names, stacked figures on a phone, no fixed widths or horizontal scrolling
  assert.match(panel, /<dl className="mt-1\.5 grid grid-cols-1 gap-x-4 gap-y-0\.5 text-2xs sm:grid-cols-3">/);
  assert.doesNotMatch(panel, /overflow-x|min-w-\[|w-\[|whitespace-nowrap|truncate|<table|<Table\b/);
  // no per-course link
  assert.doesNotMatch(panel, /<Link|href=\{/);
});

test("attendance-definition note (D2b-2D): one page-level note, both definitions stated, neither calculation changed", () => {
  const view = strip(src(VIEW));
  const lib = strip(src(ANALYTICS));
  assert.match(lib, /export const ATTENDANCE_DEFINITION_NOTE =\s*"Attendance on this dashboard excludes excused absences; the Performance Tracker counts excused absences as attended\.";/);
  assert.match(view, /<p role="note" className="-mt-3 text-2xs text-ink-faint">\s*\{ATTENDANCE_DEFINITION_NOTE\}\s*<\/p>/);
  assert.equal((view.match(/\{ATTENDANCE_DEFINITION_NOTE\}/g) ?? []).length, 1);
  assert.match(view, /<Metrics section=\{data\.metrics\} \/>\s*<p role="note"/, "Step B: directly under the KPI cards, before the analytics grid that holds Training performance / Training health");
  // the definitions themselves are untouched: the Performance Tracker still documents excused as attended
  assert.match(src("src/types/performance.ts"), /Attendance:\s+\(present \+ late \+ excused\) \/ marked records × 100\./);
});

test("Step B visual conformity: Attention cards, KPI icon tiles and panel icons are decorative additions — same data, links and states", () => {
  const view = strip(src(VIEW));
  // panels: an optional decorative icon tile; heading structure unchanged (section → h2)
  assert.match(view, /function Panel\(\{ id, title, description, action, icon: Icon, children, className \}/);
  assert.match(view, /\{Icon && \(\s*<span className="mt-0\.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-600" aria-hidden="true">/);
  for (const [id, icon] of [["dash-performance", "LineChart"], ["dash-health", "HeartPulse"], ["dash-students", "GraduationCap"], ["dash-batches", "Layers"], ["dash-courses", "BookOpen"], ["dash-progress", "ListChecks"], ["dash-topics", "Target"], ["dash-today", "CalendarDays"], ["dash-tests", "FileCheck2"], ["dash-upcoming-classes", "CalendarClock"], ["dash-activity", "Bell"], ["dash-actions", "Zap"], ["dash-overview", "LayoutGrid"], ["dash-approvals", "Award"]]) {
    assert.match(view, new RegExp(`<Panel\\s+id="${id}" icon=\\{${icon}\\}`), id);
  }
  // KPI cards: an icon tile (decorative, hidden on the narrowest screens) next to the same label / value / comparison
  assert.match(view, /const METRIC_ICON: Record<MetricKey, \{ icon: LucideIcon; tile: string \}> = \{/);
  assert.match(view, /<span className=\{`flex h-6 w-6 shrink-0 items-center justify-center rounded \$\{tile\}`\} aria-hidden="true">/);
  assert.match(view, /\{cmp \? <ComparisonLine cmp=\{cmp\} \/> : m\.note && <span className="mt-1 block text-2xs text-ink-faint">\{m\.note\}<\/span>\}/, "comparisons only where they exist (no invented KPI trends)");
  // Attention Required: one card per existing item, with its count, title, reason and link; hidden when empty
  assert.match(view, /<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">\s*\{section\.data\.map\(\(item\) => \(/);
  assert.match(view, /\{item\.count\}<\/span>[\s\S]*?\{item\.title\}<\/p>[\s\S]*?\{ATTENTION_REASON\[item\.key\] \?\? item\.reason\}<\/p>[\s\S]*?<Link href=\{item\.href\}/);
  assert.match(view, /if \(section\.status === "ok" && section\.data\.length === 0\) return null;/);
  // one analytics / operations grid: 1 / 2 / 3 columns; wide panels span two
  const page = view.slice(view.indexOf("export function AdminDashboard("), view.indexOf("export function AdminDashboardSkeleton("));
  assert.equal((page.match(/<div className="grid grid-flow-row-dense grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">/g) ?? []).length, 1, "one grid on the page (the skeleton mirrors it)");
  assert.match(view, /<PendingApprovalsPanel section=\{data\.approvals\} className="lg:col-span-2" \/>/);
  // no reference sample content was copied: no at-risk panel, no rooms, no invented KPI comparisons
  assert.doesNotMatch(view, /At-risk|Improving Students|Room|vs last month|vs 37/i);
});

test("D2b-2F refinement: full KPI labels, small empty states, compact shortcuts — presentation only, same data and links", () => {
  const view = strip(src(VIEW));
  const metrics = view.slice(view.indexOf("function ComparisonLine("), view.indexOf("function Attention("));
  // KPI labels, notes and comparisons wrap — never cut off with an ellipsis
  assert.doesNotMatch(metrics, /truncate|line-clamp|whitespace-nowrap/, "no clipped KPI text");
  assert.match(metrics, /<span className="min-w-0 pt-0\.5 text-xs font-medium leading-tight text-ink-muted">\{m\.label\}<\/span>/);
  assert.match(metrics, /<span className="flex min-h-8 items-start gap-2">/, "QA fix #4: a two-line label area, so every value sits on the same line");
  assert.match(metrics, /<span className="mt-2 block text-kpi text-ink">\{section\.data\[m\.key\]\}<\/span>/, "the value dominates");
  // empty states: one small inline component (icon, short title, short explanation) — no large EmptyState boxes
  assert.match(view, /function Compact\(\{ title, description \}: \{ title: string; description\?: string \}\) \{\s*return \(\s*<div className="flex items-start gap-2\.5 rounded-md bg-surface-sunken px-3 py-2\.5">/);
  assert.doesNotMatch(view, /<EmptyState|components\/ui\/EmptyState/);
  // Weak Topics: thresholds moved from the subtitle to a footer legend (same thresholds)
  assert.match(view, /Healthy ≥ 80% · Watch ≥ 65% · Attention &lt; 65%/);
  // Training health: a decorative status dot beside the label; the Badge text still carries the status
  assert.match(view, /<span className=\{`h-2 w-2 shrink-0 rounded-full \$\{HEALTH_DOT\[h\.status\]\}`\} aria-hidden="true" \/>/);
  // quick actions: the same seven existing routes, compact two-column shortcuts
  assert.equal((view.match(/\{ href: "\/admin\/[^"]*", label: "[^"]+", icon: \w+ \}/g) ?? []).length, 7, "the same seven shortcuts (audit: labels only, no notes)");
  assert.match(view, /<ul className="grid grid-cols-2 gap-2">\s*\{QUICK_ACTIONS\.map/);
  // the analytics panels still read one shared promise and nothing new was invented
  assert.doesNotMatch(view, /Delivery rate|Enrollment rate|Enrolment rate|At-risk|Room/i);
});

test("D2b-2F information-density cleanup: answer first, method detail off the main view — same statuses, values and links", () => {
  const view = strip(src(VIEW));
  const lib = strip(src(LIB)) + strip(src(ANALYTICS));
  // Training performance: value, change in pp, one count line; "vs X% before" and the count change are read out only
  assert.match(view, /<span className="sr-only">vs \{formatPercent\(c\.previous\)\} before<\/span>/);
  assert.match(view, /<dd className="text-2xs text-ink-faint">\s*\{countText\(m\.evidence\.current, m\.evidenceNoun\)\}\s*<\/dd>/);
  assert.match(view, /const countText = \(n: number, pluralNoun: string\) =>/);
  // Training health: the status is the read model's; only the on-screen wording is shortened
  assert.match(view, /function healthReason\(h: HealthLine\): string \{/);
  assert.match(view, /if \(h\.status === "no_data" && HEALTH_NO_DATA_REASON\[h\.key\]\)/, "a short phrase only for 'No data' lines");
  assert.match(view, /return h\.reason\.replace\(\/\\s\*\\\(\[\^\)\]\*\\\)\/g, ""\);/, "judged lines keep their reason minus parenthetical method detail");
  assert.doesNotMatch(view, /Worst line wins|database fact behind it/);
  // the rules themselves are untouched in the read model (thresholds and minimum evidence)
  assert.match(lib, /Fewer than 5 attendance records in this period/);
  assert.match(lib, /\(Healthy ≥ 85%, Watch ≥ 75%\)/);
  // comparison tables: "—" plus one footer legend; no per-cell "Insufficient data (n)" / "No comparison data" / "n = …"
  assert.match(view, /const EVIDENCE_NOTE = "— = not enough data this period\.";/);
  assert.doesNotMatch(view, /n = \{figure\.evidence\}|released results: n =/);
  // Weak Topics: the band legend only accompanies real bands
  assert.match(view, /panels\.status === "ok" && panels\.data\.topics\.length > 0 && <p className="mt-3 text-2xs text-ink-faint">Healthy ≥ 80% · Watch ≥ 65% · Attention &lt; 65%<\/p>/);
  // no fake fill-ins for missing metrics
  assert.doesNotMatch(view, /\?\? 0\b|\|\| 0\b|"0%"/, "a missing figure is never shown as 0");
});

test("approved information-density audit: one source for dates, title-only empty states, collapsed health groups — same data, statuses and links", () => {
  const view = strip(src(VIEW));
  // dates: the header is the single visible source; panels say the period only; sr table captions keep the dates
  assert.match(view, /const periodShort = \(p: AnalyticsPeriod\) => `\$\{p\.label\} vs previous period`;/);
  assert.equal((view.match(/description=\{panels\.status === "ok" \? periodShort\(panels\.data\.period\) : undefined\}/g) ?? []).length, 3, "performance, batch and course subtitles");
  assert.match(view, /description=\{panels\.status === "ok" \? panels\.data\.period\.label : undefined\}/, "weak topics: the period name only");
  assert.match(view, /<caption className="sr-only">Batch comparison, \{periodText\(panels\.data\.period\)\}<\/caption>/);
  // KPI: no notes that restate the label
  assert.doesNotMatch(view, /In progress now|Not started yet|accounts that can sign in/);
  // attention: one shorter reason, the read model unchanged
  assert.match(view, /const ATTENTION_REASON: Partial<Record<AttentionItem\["key"\], string>> = \{ missing_records: "Role has no matching record\." \};/);
  assert.match(strip(src(LIB)), /reason: "The account's role needs a matching student or trainer record\."/);
  // training health: judged lines in full; No data / Unavailable collapse into one row each; the Unavailable message once
  assert.match(view, /health\.data\.lines\.filter\(\(h\) => h\.status !== "no_data" && h\.status !== "unavailable"\)\.map/);
  assert.match(view, /<HealthGroup status="no_data" lines=\{health\.data\.lines\} \/>/);
  assert.match(view, /<HealthGroup status="unavailable" lines=\{health\.data\.lines\} note="Unable to load this section\. Refresh to retry\." \/>/);
  assert.match(view, /<span className="font-medium">\{HEALTH_LABEL\[status\]\}:<\/span>/, "the status stays as text");
  assert.match(view, /\{!note && <span className="sr-only"> \(\{healthReason\(h\)\.replace\(\/\\\.\$\/, ""\)\}\)<\/span>\}/, "each indicator's reason is read out");
  assert.match(view, /students: "Not enough attendance per student\."/);
  assert.doesNotMatch(view, /Overall status follows the weakest indicator/);
  // empty states: the title alone where a sentence would only repeat it
  for (const t of ["No classes today", "No upcoming classes", "No upcoming tests", "Nothing awaiting approval"]) assert.match(view, new RegExp(`<Compact title="${t}" \\/>`), t);
  assert.match(view, /<Compact title="No recent activity" description="Your notifications appear here\." \/>/);
  assert.equal((view.match(/description="No results, attendance or assignments this period\."/g) ?? []).length, 2);
  // subtitles
  assert.match(view, /description="Open or opening soon"/);
  assert.match(view, /description="Trainer completion recommendations"/);
  assert.match(view, /<Panel id="dash-overview" icon=\{LayoutGrid\} title="Training overview" description="Batches by status">/, "no duplicate 'View all batches'");
  // batch rows: the code only when it differs from the name; concise screen-reader figures
  assert.match(view, /\{b\.code !== b\.name && \(/);
  assert.match(view, /<span className="sr-only">Insufficient data, \{countText\(figure\.evidence, noun\)\}<\/span>/);
  // weak topics: answer counts are read out, not shown
  assert.match(view, /<span className="sr-only">\{countText\(t\.answers, "graded answers"\)\}<\/span>/);
  // untouched: Course Progress wording (D2b-2D) and the attendance definition
  assert.match(view, /Current state — not affected by the reporting period\./);
  assert.match(view, /title="Course Progress" description="Current delivery and enrolment progress"/);
});
