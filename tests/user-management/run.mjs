// Users view + lifecycle actions (Phase 7 P3.2/P3.3) — pure tests for src/lib/user-management and the users service.
//   node tests/user-management/run.mjs
// Transpiles with the project's own `typescript` into a temp folder and runs
// Node's built-in test runner (no extra packages, no package.json scripts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "user-management-tests-"));
const sources = [
  "src/types/user.ts",
  "src/types/user-management.ts",
  "src/lib/supabase/paging.ts",
  "src/lib/auth/roles.ts",
  "src/lib/user-management/users.ts",
  "src/lib/user-management/lifecycle.ts",
  "src/repositories/users.repository.core.ts",
  "src/services/users.service.core.ts",
  // P3.4 invitation sending
  "src/lib/user-management/invitations.ts",
  "src/repositories/invitations.repository.core.ts",
  "src/repositories/auth-admin.repository.core.ts",
  "src/services/invitations.service.core.ts",
];
for (const rel of sources) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = path.join(out, rel.replace(/^src\//, "").replace(/\.ts$/, ".mjs"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    code.replace(/(from\s+["'])(@\/[^"']+|\.{1,2}\/[^"']+)(["'])/g, (_, a, spec, b) => {
      const abs = spec.startsWith("@/") ? path.join(out, spec.slice(2)) : path.resolve(path.dirname(target), spec);
      let rel2 = path.relative(path.dirname(target), abs + ".mjs").split(path.sep).join("/");
      if (!rel2.startsWith(".")) rel2 = "./" + rel2;
      return a + rel2 + b;
    })
  );
}
const tests = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(here, f));
const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  env: { ...process.env, UM_BUILD: pathToFileURL(out).href },
});
fs.rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
