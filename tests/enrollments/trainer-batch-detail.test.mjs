// Phase 7 P3.10-A — trainer batch detail + trainer enrolment (source-level tests). The new
// /trainer/batches/[batchId] page sits behind the trainer-only RoleGuard, validates the id, reads only
// through enrollmentService (which returns only the trainer's own batches), 404s on anything else and
// renders the shared BatchDetailView; the trainer batches table opens it; the dialog's trainer mode calls
// only trainerEnrolStudentAction. The behaviour against the database is in
// tests/question-import-db/zz-trainer-batch-detail.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const importsOf = (code) => [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);

const PAGE = "src/app/trainer/batches/[batchId]/page.tsx";

test("route: trainer-only layout; dynamic; id validated first; service read only; 404 for missing, other trainers' and non-trainer views", () => {
  assert.match(src("src/app/trainer/layout.tsx"), /<RoleGuard allowedRoles=\{\["trainer"\]\}>/, "the layout admits trainers only");
  const page = strip(src(PAGE));
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.ok(page.indexOf("if (!isUuid(params.batchId)) notFound();") > -1, "invalid id → 404");
  assert.ok(page.indexOf("isUuid(params.batchId)") < page.indexOf("enrollmentService.getBatchDetail"), "validated before any read");
  assert.match(page, /if \(!detail \|\| detail\.mode !== "trainer"\) notFound\(\);/, "out of scope (service answers null) → 404; never a non-trainer view");
  assert.match(page, /<BatchDetailView detail=\{detail\} backHref="\/trainer\/batches" \/>/, "the shared view, back to the trainer list");
  assert.match(page, /console\.error\("\[trainer\/batches\/detail\] load failed:", err instanceof Error \? err\.name : "unknown error"\)/, "logs the error name only");
  assert.match(page, /<ErrorState title="We couldn't load this batch" description="Please try again\." \/>/);
  for (const spec of importsOf(page)) {
    assert.ok(
      ["next/navigation", "@/components/layout/PageHeader", "@/components/ui/ErrorState", "@/components/modules/BatchDetailView", "@/services/enrollment.service", "@/lib/enrollments/enrollment"].includes(spec),
      `page imports ${spec}`
    );
  }
  assert.doesNotMatch(page, /\.from\(|\.rpc\(|createSupabase|supabase\/admin|service_role|enrollment\.actions|repositories/, "no database access, no service role, no mutations in the page");
});

test("service wiring: the page's service resolves the caller from the session; the trainer view is limited to the trainer's own batches", () => {
  const wiring = strip(src("src/services/enrollment.service.ts"));
  assert.match(wiring, /getCurrentUser: \(\) => authService\.getCurrentUser\(\)/, "identity from the session, never the browser");
  assert.doesNotMatch(wiring, /supabase\/admin|createSupabaseAdminClient/);
  const core = strip(src("src/services/enrollment.service.core.ts"));
  assert.match(core, /if \(mode === "trainer" && header\.trainer_id !== user\.id\) return null;/, "another trainer's batch → null → 404");
  assert.match(core, /if \(user\.role !== "trainer"\) throw new EnrollmentAuthorizationError\("Only trainers can add students to their batches here\."\);/);
});

test("trainer list: 'View batch' opens /trainer/batches/<id> only from the trainer page; the Super Admin table is unchanged", () => {
  const table = strip(src("src/components/modules/BatchesTable.tsx"));
  assert.match(table, /trainerDetail = false,/, "off by default — the Super Admin page does not pass it");
  assert.match(src("src/app/trainer/batches/page.tsx"), /<BatchesTable rows=\{batches\} trainerDetail \/>/);
  assert.match(src("src/app/admin/batches/page.tsx"), /<BatchesTable rows=\{batches\} assignment=\{\{ trainers \}\} \/>/, "admin page unchanged");
  assert.doesNotMatch(src("src/app/admin/batches/page.tsx"), /trainerDetail/);
});

test("dialog trainer mode: no reason field, trainer wording for an empty list, admin is the default; the roster status dialog stays Super Admin only", () => {
  const dialog = strip(src("src/components/modules/EnrollStudentDialog.tsx"));
  assert.match(dialog, /mode\?: "admin" \| "trainer";/);
  assert.match(dialog, /New students join through an invitation\./, "explains where trainer candidates come from");
  const view = strip(src("src/components/modules/BatchDetailView.tsx"));
  assert.match(view, /\{isAdmin && \(\s*<TableCell className="text-right">\s*<EnrollmentStatusDialog/, "withdraw / complete / re-enrol remain Super Admin only");
  assert.match(view, /\{isAdmin && <TableHeaderCell className="text-right">Actions<\/TableHeaderCell>\}/);
});

test("revalidation: the existing enrolment actions already refresh the trainer batch pages", () => {
  const actions = strip(src("src/services/enrollment.actions.ts"));
  assert.match(actions, /revalidatePath\("\/trainer\/batches"\);/);
  assert.match(actions, /revalidatePath\(`\/trainer\/batches\/\$\{batchId\}`\);/);
  assert.match(actions, /export async function trainerEnrolStudentAction\(batchId: string, studentId: string\)/, "ids only from the browser");
});
