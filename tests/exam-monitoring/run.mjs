// Exam monitoring (Anti-Malpractice Step 4) — rendering tests for the staff view.
//   node tests/exam-monitoring/run.mjs
// Transpiles the real component tree (TSX) with the project's own `typescript` into a temp
// folder and renders it with react-dom/server under Node's built-in test runner
// (no extra packages, no package.json scripts). next/link is replaced by a plain <a>.
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "exam-monitoring-tests-"));

/** ESM entry of a package when it has one (lucide-react), else its resolved main. */
function resolveBare(spec) {
  if (spec === "lucide-react") {
    const pkgDir = path.dirname(requireFromRoot.resolve("lucide-react/package.json"));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    return pathToFileURL(path.join(pkgDir, pkg.module)).href;
  }
  return pathToFileURL(requireFromRoot.resolve(spec)).href;
}

const stub = path.join(out, "stubs/next-link.mjs");
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(
  stub,
  `import { jsx } from ${JSON.stringify(resolveBare("react/jsx-runtime"))};\n` +
    `export default function Link({ href, children, ...props }) { return jsx("a", { href, ...props, children }); }\n`
);

const sources = [
  "src/components/modules/ExamMonitoringView.tsx",
  "src/components/ui/Badge.tsx",
  "src/components/ui/Button.tsx",
  "src/components/ui/Card.tsx",
  "src/components/ui/EmptyState.tsx",
  "src/components/ui/Input.tsx",
  "src/components/ui/Select.tsx",
  "src/components/ui/Table.tsx",
  "src/utils/cn.ts",
  "src/utils/format.ts",
  "src/lib/exam-monitoring/events.ts",
  "src/lib/student-tests/client-events.ts",
  "src/types/exam-monitoring.ts",
];
for (const rel of sources) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: rel,
  }).outputText;
  const target = path.join(out, rel.replace(/^src\//, "").replace(/\.tsx?$/, ".mjs"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    code.replace(/((?:from\s+|import\(\s*)["'])([^"']+)(["'])/g, (whole, a, spec, b) => {
      if (spec === "next/link") return a + pathToFileURL(stub).href + b;
      if (!spec.startsWith("@/") && !spec.startsWith(".")) return a + resolveBare(spec) + b;
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
  env: {
    ...process.env,
    EXAM_MONITORING_BUILD: pathToFileURL(out).href,
    EXAM_MONITORING_REACT_DOM_SERVER: resolveBare("react-dom/server"),
    EXAM_MONITORING_REACT: resolveBare("react"),
  },
});
fs.rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
