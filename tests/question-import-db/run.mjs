// Bulk Question Import — repository/service integration tests against a
// throwaway local PostgreSQL with migrations 0001–0031 (+0029a) (never Supabase).
//   PG_BIN="C:\Program Files\PostgreSQL\18\bin" node tests/question-import-db/run.mjs
// Creates a temporary cluster, applies the Supabase role/auth stand-in
// (fixtures/bootstrap.sql), every migration, and the seed; transpiles the
// real repository/service code with the project's `typescript`; runs the
// tests; always deletes the cluster.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));
const BARE = Object.fromEntries(["exceljs", "papaparse", "pdfjs-dist/legacy/build/pdf.min.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs"].map((p) => [p, pathToFileURL(requireFromRoot.resolve(p)).href]));
const pgBin = process.env.PG_BIN ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "/usr/lib/postgresql/18/bin");
const exe = (name) => path.join(pgBin, process.platform === "win32" ? `${name}.exe` : name);
if (!fs.existsSync(exe("psql"))) {
  console.error(`PostgreSQL client tools not found in ${pgBin}. Set PG_BIN.`);
  process.exit(2);
}
const port = Number(process.env.PG_TEST_PORT ?? 55449);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "question-import-db-"));
const data = path.join(work, "data");
const env = { ...process.env, PGCLIENTENCODING: "UTF8" };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", env, ...opts });
const psql = (args) => sh(exe("psql"), ["-X", "-q", "-h", "localhost", "-p", String(port), "-U", "postgres", ...args]);

let status = 1;
let started = false;
try {
  // 1. Cluster + database
  let r = sh(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"]);
  if (r.status !== 0) throw new Error(`initdb failed: ${r.stderr}`);
  // No pipes: the server process would inherit them and spawnSync would never return.
  r = sh(exe("pg_ctl"), ["-D", data, "-o", `-p ${port} -c listen_addresses=localhost`, "-l", path.join(work, "server.log"), "-w", "start"], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`pg_ctl start failed (see ${path.join(work, "server.log")})`);
  started = true;
  r = psql(["-d", "postgres", "-c", "create database qi_test"]);
  if (r.status !== 0) throw new Error(r.stderr);

  // 2. Supabase stand-in, migrations 0001–0031 (+0029a), seed
  const files = [
    path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => /^00(0\d|1\d|2\d|3[01])[a-z]?_.*\.sql$/.test(f)).sort().map((f) => path.join(root, "supabase/migrations", f)),
    path.join(here, "fixtures/seed.sql"),
  ];
  for (const file of files) {
    r = psql(["-d", "qi_test", "-v", "ON_ERROR_STOP=1", "-f", file]);
    if (r.status !== 0) throw new Error(`${path.basename(file)} failed:\n${r.stderr}`);
  }
  console.log(`database ready: ${files.length - 2} migrations (0001–0031 (+0029a)) + seed`);

  // 3. Transpile the real modules under test
  const out = path.join(work, "build");
  const sources = [
    "src/lib/supabase/paging.ts",
    "src/lib/supabase/types.ts",
    "src/types/question.ts",
    "src/types/question-import.ts",
    "src/types/auth.ts",
    "src/types/user.ts",
    ...fs.readdirSync(path.join(root, "src/lib/question-import")).filter((f) => f.endsWith(".ts")).map((f) => `src/lib/question-import/${f}`),
    "src/repositories/question-import.repository.core.ts",
    "src/services/question-import.service.core.ts",
    // Exam monitoring (Anti-Malpractice Step 4)
    "src/types/exam-monitoring.ts",
    "src/lib/student-tests/client-events.ts",
    "src/lib/exam-monitoring/events.ts",
    "src/repositories/exam-monitoring.repository.core.ts",
    "src/services/exam-monitoring.service.core.ts",
    // Sign-in / session role lookup (0016 account status)
    "src/lib/auth/profile-role.ts",
    "src/lib/auth/roles.ts",
    // Users view + lifecycle actions (Phase 7 P3.2/P3.3)
    "src/types/user-management.ts",
    "src/lib/user-management/users.ts",
    "src/lib/user-management/lifecycle.ts",
    "src/repositories/users.repository.core.ts",
    "src/services/users.service.core.ts",
    // Invitation sending (Phase 7 P3.4)
    "src/lib/user-management/invitations.ts",
    "src/repositories/invitations.repository.core.ts",
    "src/repositories/auth-admin.repository.core.ts",
    "src/services/invitations.service.core.ts",
    // Invitation acceptance (Phase 7 P3.5)
    "src/lib/auth/invite-acceptance.ts",
    "src/repositories/invitation-acceptance.repository.core.ts",
    "src/services/invitation-acceptance.service.core.ts",
    // Invitation recovery (P5.2)
    "src/lib/auth/invitation-recovery.ts",
    "src/services/invitation-recovery.service.core.ts",
    "src/repositories/recovery-mailer.repository.core.ts",
    // Batch trainer assignment (Phase 7 P3.6)
    "src/lib/batches/assign-trainer.ts",
    "src/repositories/batch-trainer.repository.core.ts",
    "src/services/batch-trainer.service.core.ts",
    // Student Dashboard Phase 2
    "src/lib/dashboard/student-dashboard.ts",
    // Course Management (0030)
    "src/types/course.ts",
    "src/lib/courses/course-management.ts",
    "src/repositories/course-management.repository.core.ts",
    "src/services/course-management.service.core.ts",
    "src/lib/batches/create-batch.ts",
    "src/types/batch.ts",
    // Enrolment application layer (Phase 7 P3.8)
    "src/lib/enrollments/enrollment.ts",
    "src/repositories/enrollment.repository.core.ts",
    "src/services/enrollment.service.core.ts",
    // Trainer student editing (Phase 7 P3.10-B)
    "src/lib/students/trainer-edit.ts",
    "src/repositories/students.repository.core.ts",
    "src/services/students.service.core.ts",
    // Super Admin dashboard reads (D1)
    "src/types/performance.ts",
    "src/lib/dashboard/periods.ts",
    "src/lib/dashboard/admin-dashboard.ts",
    "src/lib/dashboard/analytics.ts",
    "src/repositories/dashboard.repository.core.ts",
    // Trainer dashboard reads (Phase 7 P4.2)
    "src/lib/dashboard/trainer-dashboard.ts",
    "src/repositories/trainer-dashboard.repository.core.ts",
    "src/services/trainer-dashboard.service.core.ts",
    // Reports (attendance, performance, test results, assignment completion)
    "src/lib/reports/reports.ts",
    "src/repositories/reports.repository.core.ts",
    "src/services/reports.service.core.ts",
  ];
  for (const rel of sources) {
    const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
    }).outputText;
    const target = path.join(out, rel.replace(/^src\//, "").replace(/\.ts$/, ".mjs"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      code.replace(/((?:from\s+|import\(\s*)["'])([^"']+)(["'])/g, (whole, a, spec, b) => {
        if (BARE[spec]) return a + BARE[spec] + b; // project packages (exceljs, papaparse, pdfjs-dist)
        if (!spec.startsWith("@/") && !spec.startsWith(".")) return whole;
        const abs = spec.startsWith("@/") ? path.join(out, spec.slice(2)) : path.resolve(path.dirname(target), spec);
        let rel2 = path.relative(path.dirname(target), abs + ".mjs").split(path.sep).join("/");
        if (!rel2.startsWith(".")) rel2 = "./" + rel2;
        return a + rel2 + b;
      })
    );
  }

  // 4. Tests
  const tests = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(here, f));
  r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    stdio: "inherit",
    env: {
      ...env,
      QI_BUILD: pathToFileURL(out).href,
      QI_EXCELJS: BARE.exceljs,
      QI_PSQL: exe("psql"),
      QI_PORT: String(port),
      QI_DB: "qi_test",
    },
  });
  status = r.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  status = 1;
} finally {
  if (started) sh(exe("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`throwaway cluster ${fs.existsSync(work) ? "NOT removed" : "removed"}`);
}
process.exit(status);
