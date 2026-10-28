// Course Management — pure tests for src/lib/courses/course-management.ts and the service core
// (fake repository), plus source-level wiring checks. Database behaviour: tests/question-import-db.
//   node tests/courses/run.mjs
// Transpiles with the project's own `typescript` into a temp folder and runs
// Node's built-in test runner (no extra packages, no package.json scripts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "courses-tests-"));
for (const rel of [
  "src/types/course.ts",
  "src/types/auth.ts",
  "src/types/user.ts",
  "src/lib/courses/course-management.ts",
  "src/lib/courses/course-availability.ts",
  "src/repositories/course-management.repository.core.ts",
  "src/services/course-management.service.core.ts",
]) {
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

// Rendering: the course Classes tab (TSX) rendered with react-dom/server, as tests/exam-monitoring does
// (next/link replaced by a plain <a>; packages resolved from the project's own node_modules).
const requireFromRoot = createRequire(path.join(root, "package.json"));
function resolveBare(spec) {
  if (spec === "lucide-react") {
    const pkgDir = path.dirname(requireFromRoot.resolve("lucide-react/package.json"));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    return pathToFileURL(path.join(pkgDir, pkg.module)).href;
  }
  return pathToFileURL(requireFromRoot.resolve(spec)).href;
}
const linkStub = path.join(out, "stubs/next-link.mjs");
fs.mkdirSync(path.dirname(linkStub), { recursive: true });
fs.writeFileSync(
  linkStub,
  `import { jsx } from ${JSON.stringify(resolveBare("react/jsx-runtime"))};\n` +
    `export default function Link({ href, children, ...props }) { return jsx("a", { href, ...props, children }); }\n`
);
for (const rel of [
  "src/components/modules/CourseClassesList.tsx",
  "src/components/ui/Badge.tsx",
  "src/components/ui/Card.tsx",
  "src/components/ui/EmptyState.tsx",
  "src/components/ui/StatusBadge.tsx",
  "src/utils/cn.ts",
  "src/utils/format.ts",
  "src/types/class.ts",
]) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: rel,
  }).outputText;
  const target = path.join(out, rel.replace(/^src\//, "").replace(/\.tsx?$/, ".mjs"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    code.replace(/((?:from\s+|import\(\s*)["'])([^"']+)(["'])/g, (whole, a, spec, b) => {
      if (spec === "next/link") return a + pathToFileURL(linkStub).href + b;
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
    COURSES_CORE: pathToFileURL(path.join(out, "lib/courses/course-management.mjs")).href,
    COURSES_BUILD: pathToFileURL(out).href,
    COURSES_REACT_DOM_SERVER: resolveBare("react-dom/server"),
    COURSES_REACT: resolveBare("react"),
  },
});
fs.rmSync(out, { recursive: true, force: true });
process.exit(result.status ?? 1);
