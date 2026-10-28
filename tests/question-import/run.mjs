// Runs the Bulk Question Import core tests with Node's built-in test runner.
//   node tests/question-import/run.mjs
// Transpiles the pure TypeScript core with the project's own `typescript`
// into a temporary folder (no extra packages, no package.json scripts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// The build folder is outside the project: point package imports at the project's node_modules.
const requireFromRoot = createRequire(path.join(root, "package.json"));
const BARE = Object.fromEntries(["exceljs", "papaparse", "pdfjs-dist/legacy/build/pdf.min.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs"].map((p) => [p, pathToFileURL(requireFromRoot.resolve(p)).href]));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "question-import-core-"));

const sources = [
  "src/types/question.ts",
  "src/types/question-import.ts",
  ...fs.readdirSync(path.join(root, "src/lib/question-import")).filter((f) => f.endsWith(".ts")).map((f) => `src/lib/question-import/${f}`),
];

for (const rel of sources) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = path.join(out, rel.replace(/^src\//, "").replace(/\.ts$/, ".mjs"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const rewritten = code.replace(/((?:from\s+|import\(\s*)["'])([^"']+)(["'])/g, (whole, a, spec, b) => {
    if (BARE[spec]) return a + BARE[spec] + b; // project packages (exceljs, papaparse, pdfjs-dist)
    if (!spec.startsWith("@/") && !spec.startsWith(".")) return whole;
    const abs = spec.startsWith("@/") ? path.join(out, spec.slice(2)) : path.resolve(path.dirname(target), spec);
    let rel2 = path.relative(path.dirname(target), abs + ".mjs").split(path.sep).join("/");
    if (!rel2.startsWith(".")) rel2 = "./" + rel2;
    return a + rel2 + b;
  });
  fs.writeFileSync(target, rewritten);
}

const tests = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(here, f));
const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  env: {
    ...process.env,
    QUESTION_IMPORT_CORE: pathToFileURL(path.join(out, "lib/question-import/index.mjs")).href,
    QUESTION_IMPORT_BUILD: pathToFileURL(path.join(out, "lib/question-import")).href,
    QUESTION_IMPORT_EXCELJS: BARE.exceljs,
  },
});
fs.rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
