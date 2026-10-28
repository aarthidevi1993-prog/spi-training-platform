// Trainer dashboard (P4.2) — source-level guards: the page renders the real read model (no mock data,
// no placeholders), the data path is Page → Service → Repository → Supabase on the trainer's own session,
// and the sections appear in the agreed order with their empty states.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PAGE = "src/app/trainer/page.tsx";
const UI = "src/components/dashboard/TrainerDashboard.tsx";
const LIB = "src/lib/dashboard/trainer-dashboard.ts";
const REPO = "src/repositories/trainer-dashboard.repository.core.ts";
const REPO_WRAP = "src/repositories/trainer-dashboard.repository.ts";
const SVC = "src/services/trainer-dashboard.service.core.ts";
const SVC_WRAP = "src/services/trainer-dashboard.service.ts";

test("page: the real dashboard through the trainer dashboard service — no mock KPIs, no PortalDashboard", () => {
  const page = strip(src(PAGE));
  assert.match(page, /trainerDashboardService\.load\(\)/);
  assert.match(page, /<Suspense fallback=\{<TrainerDashboardSkeleton \/>\}>/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /<ErrorState title="We couldn't load your dashboard"/);
  assert.doesNotMatch(page, /mock|PortalDashboard|trainerKpis|KpiCard/);
  assert.ok(!fs.existsSync(path.join(root, "src/app/trainer/loading.tsx")), "no segment-wide loading.tsx (it would replace every /trainer page's loading state)");
});

test("data path: session client only — never the service role, Super Admin analytics or the admin dashboard service", () => {
  for (const rel of [PAGE, UI, LIB, REPO, REPO_WRAP, SVC, SVC_WRAP]) {
    const code = strip(src(rel));
    assert.doesNotMatch(code, /createSupabaseAdminClient|SERVICE_ROLE|service_role|supabase\/admin/, `${rel}: no service role`);
    assert.doesNotMatch(code, /adminDashboardService|dashboard_analytics|\/dashboard\.service(\.core)?"|\/dashboard\.repository(\.core)?"|getAnalytics/, `${rel}: no Super Admin dashboard path`);
    assert.doesNotMatch(code, /\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/, `${rel}: read-only`);
  }
  assert.match(src(REPO_WRAP), /^import "server-only";/);
  assert.match(src(SVC_WRAP), /^import "server-only";/);
  assert.match(strip(src(REPO_WRAP)), /createSupabaseServerClient\(\)/);
  assert.match(strip(src(SVC_WRAP)), /getCurrentUser: \(\) => authService\.getCurrentUser\(\)/);
  assert.match(strip(src(SVC)), /user\.role !== "trainer"/, "trainer-only, decided on the server");
  // The UI imports types/constants only from the read model, never a repository or service.
  assert.doesNotMatch(strip(src(UI)), /@\/(repositories|services)\//);
});

test("India time: computed in the read model, not with the classes service's UTC summary", () => {
  const lib = strip(src(LIB));
  assert.match(lib, /INDIA_TIME_ZONE/);
  assert.doesNotMatch(lib + strip(src(SVC)), /toISOString\(\)\.slice\(0, 10\)|getSummary/);
});

test("sections in the agreed order with exact headings", () => {
  const ui = strip(src(UI));
  assert.match(ui, /TRAINER_DASHBOARD_TITLE = "Trainer Dashboard"/);
  assert.match(ui, /TRAINER_DASHBOARD_SUBTITLE = "Overview of your training activities"/);
  const body = ui.slice(ui.indexOf("export function TrainerDashboard("));
  // P4.1 order: KPIs, today's classes, upcoming classes, pending actions, current test performance, students needing
  // attention, performance / weak topics, upcoming & open tests, notifications.
  const order = ["<Kpis ", "<TodayClasses ", "<UpcomingClasses ", "<PendingActions ", "<CurrentTestTop ", "<StudentsNeedingAttention ", "<PerformancePanel ", "<UpcomingTests ", "<NotificationsSummary "];
  const at = order.map((tag) => body.indexOf(tag));
  assert.ok(at.every((i) => i >= 0), "every section rendered");
  assert.deepEqual(at, [...at].sort((a, b) => a - b), "in order");
  for (const label of ['"Active batches"', '"Current students"', '"Classes today"', '"Average student score"', 'title="Pending actions"', 'title="Students needing attention"', `title="Today's classes"`, 'title="Upcoming classes"', 'title="Upcoming & open tests"', 'title="Current Test Performance"', 'title="Attendance overview"', 'title="Performance & weak topics"', 'title="Notifications"']) {
    assert.ok(ui.includes(label), label);
  }
  for (const head of ["Student", "Batch", "Performance", "Attendance", "Weak area", "Priority", "Time", "Class", "Course", "Status", "Test", "Date / time"]) {
    assert.match(ui, new RegExp(`>\\s*${head}\\s*<`), `column ${head}`);
  }
  assert.match(ui, /\{data\.noCurrentBatches && <NoBatchesNotice \/>\}/, "no batches → one explicit notice");
  assert.match(ui, />\s*No active batches\s*</);
  for (const p of ['label: "Critical"', 'label: "Attention"', 'label: "Monitor"']) assert.ok(ui.includes(p), p);
});

test("every empty state is explicit; no placeholders, greetings or invented trends", () => {
  const ui = strip(src(UI));
  for (const t of ["No pending actions", "No students need attention", "No classes today", "No upcoming classes", "No upcoming tests", "No current test results", "No attendance recorded", "No released results yet", "No weak topics", "No notifications"]) {
    assert.ok(ui.includes(`title="${t}"`), t);
  }
  assert.match(ui, /function SectionError\(\)/);
  assert.doesNotMatch(ui, /Coming soon|Module placeholder|placeholder|Good morning|👋/i);
  assert.doesNotMatch(ui, /ArrowUp|ArrowDown|trend/i, "no trend figures");
  assert.doesNotMatch(strip(src(LIB)), /risk ?score|riskScore/i, "no risk score");
});

test("layout guards: no fixed widths that could overflow narrow screens", () => {
  const ui = strip(src(UI));
  assert.doesNotMatch(ui, /min-w-\[\d{3,}px\]|w-\[\d{3,}px\]|whitespace-nowrap[^"]*text-sm font-medium/);
  assert.match(ui, /grid grid-cols-2 gap-3 lg:grid-cols-4/, "KPIs: 2 columns on phones, 4 on desktop");
  assert.match(ui, /grid grid-cols-1 items-start gap-4 xl:grid-cols-3/);
});

test("reuse: classes from the existing Classes service, notifications from the existing Notifications service", () => {
  const wrap = strip(src(SVC_WRAP));
  assert.ok(wrap.includes('classesService.listClasses({ dateRange: "custom", dateFrom: from, dateTo: to })'));
  assert.ok(wrap.includes("getNotifications: (limit) => notificationsService.listNotifications(limit)"));
  assert.ok(wrap.includes("performanceService.getPerformance()"));
  const repo = strip(src(REPO));
  assert.ok(!repo.includes('from("classes")') && !repo.includes('from("notifications")'), "no second classes / notifications query");
  assert.doesNotMatch(strip(src(UI)), /"use client"/, "server component: no browser-side scoping");
});
