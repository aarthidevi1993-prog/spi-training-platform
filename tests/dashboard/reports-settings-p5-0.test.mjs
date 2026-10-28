// P5.0 — Reports and Settings show no mock data and no controls that do nothing (source-level).
// Reports (now implemented): real reports from reportsService — no sample report list, invented dates or
// figures, and every filter and Export control is backed by the server (tests/question-import-db/zz-reports
// proves the figures, exports and permissions against the database). Settings: no invented users, no fields or
// save buttons without storage — a link to the real Users page and honest copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const ADMIN_REPORTS = "src/app/admin/reports/page.tsx";
const TRAINER_REPORTS = "src/app/trainer/reports/page.tsx";
const VIEW = "src/components/modules/ReportsView.tsx";
const EXPORT = "src/components/modules/ReportExportButtons.tsx";
const LIB = "src/lib/reports/reports.ts";
const SETTINGS = "src/app/admin/settings/page.tsx";

test("reports: both portals render real reports from reportsService — no mock definitions, dates or figures", () => {
  for (const [rel, base] of [[ADMIN_REPORTS, "/admin/reports"], [TRAINER_REPORTS, "/trainer/reports"]]) {
    const code = strip(src(rel));
    assert.match(code, /await reportsService\.getReport\(searchParams\)/, `${rel}: data from the server-side service`);
    assert.match(code, new RegExp(`<ReportsView report=\\{report\\} basePath="${base}" \\/>`), rel);
    assert.match(code, /<ErrorState /, `${rel}: an error state`);
    assert.ok(exists(rel.replace("page.tsx", "loading.tsx")), `${rel}: a loading state`);
  }
  for (const rel of [ADMIN_REPORTS, TRAINER_REPORTS, VIEW, EXPORT, LIB]) {
    const code = strip(src(rel));
    assert.doesNotMatch(code, /lib\/mock|reportDefinitions|ReportsGrid|lastGenerated|Last generated/, `${rel}: no mock report data`);
    assert.doesNotMatch(code, /isn't wired up|presentation-only|Math\.random/, `${rel}: no dead actions or invented figures`);
    assert.doesNotMatch(code, /Instrumentation Basics|Control Systems|Batch A|Batch B/, `${rel}: no invented courses or batches`);
  }
  assert.ok(!exists("src/components/modules/ReportsGrid.tsx"), "the mock grid stays removed");
  assert.ok(!exists("src/lib/mock/reports.mock.ts"), "the mock report definitions stay removed");
  assert.ok(!exists("src/components/modules/ReportsUnavailable.tsx"), "the placeholder is replaced");
});

test("reports: the only actions are a server-validated GET filter form and exports of the table shown", () => {
  const view = strip(src(VIEW));
  assert.match(view, /<form method="get" action=\{basePath\}/, "filters are a GET form the server re-validates");
  assert.doesNotMatch(view, /"use client"|onClick|showToast/, "the view itself has no client behaviour");
  assert.match(view, /<ReportExportButtons type=\{report\.type\} table=\{report\.table\} \/>/, "exports receive the exact table shown");
  const exp = strip(src(EXPORT));
  assert.match(exp, /const sheet = toExportTable\(table\);/);
  assert.match(exp, /downloadFile\(await toXlsxBytes\(sheet, "Report"\), name, XLSX_MIME\)/);
  assert.match(exp, /downloadFile\(toCsvText\(sheet\), name, CSV_MIME\)/);
  assert.match(exp, /disabled=\{busy \|\| empty\}/, "no download of an empty report");
  assert.doesNotMatch(exp, /fetch\(|Action\(/, "nothing is re-fetched or recomputed for the file");
});

test("settings: no invented users, no editable fields or save buttons without storage; Users link and honest copy", () => {
  const code = strip(src(SETTINGS));
  assert.ok(!exists("src/app/admin/settings/SettingsTabs.tsx"), "the mock settings tabs are removed");
  assert.doesNotMatch(code, /usersMock|Rajesh Kumar|Arun Kumar|Admin User|@spi-training\.local/, "no invented user records");
  assert.doesNotMatch(code, /<Input|<Select|<Button|type="checkbox"|type="password"|onClick|showToast|Save changes|Update password|Edit permissions/, "no controls that save nothing");
  assert.doesNotMatch(code, /"use client"|lib\/mock|siteConfig/, "no placeholder company values presented as settings");
  assert.match(code, /href="\/admin\/users"/, "links to the real Users page");
  assert.ok(exists("src/app/admin/users/page.tsx"));
  assert.match(code, /can&apos;t be changed here\s+yet\./, "says what isn't available");
  assert.match(code, /Forgot your\s+password\?/, "points to the existing password reset flow without changing it");
  assert.ok(exists("src/app/forgot-password/page.tsx") || exists("src/app/(auth)/forgot-password/page.tsx"), "that flow exists");
});

test("navigation is unchanged: Reports and Settings stay where they were", () => {
  const nav = src("src/config/navigation.ts");
  assert.match(nav, /\{ label: "Reports", href: "\/admin\/reports"/);
  assert.match(nav, /\{ label: "Settings", href: "\/admin\/settings"/);
  assert.match(nav, /\{ label: "Reports", href: "\/trainer\/reports"/);
});
