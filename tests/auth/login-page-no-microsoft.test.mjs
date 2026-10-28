// P5.1 — Microsoft login is out of scope: email/password is the only supported sign-in method.
// Source-level checks that the login page no longer imports or renders the Microsoft placeholder,
// while the email/password form, the password-reset link and Microsoft Teams class links stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("login page: no Microsoft sign-in placeholder is imported or rendered", () => {
  assert.ok(!exists("src/app/login/MicrosoftSignInButton.tsx"), "the placeholder component is removed");
  const page = strip(src("src/app/login/page.tsx"));
  assert.doesNotMatch(page, /MicrosoftSignInButton|Continue with Microsoft/, "not imported or rendered");
  assert.doesNotMatch(page, /microsoft|azure|entra|signInWithOAuth|\bSSO\b/i, "no Microsoft/OAuth sign-in on the login page");
  assert.doesNotMatch(page, />\s*or\s*</, "no divider left over for a second sign-in method");
});

test("login page: the email/password form and its password-reset link remain", () => {
  const page = strip(src("src/app/login/page.tsx"));
  assert.match(page, /<Suspense fallback=\{null\}>\s*<LoginForm \/>\s*<\/Suspense>/);
  assert.match(src("src/components/auth/LoginForm.tsx"), /href="\/forgot-password"/);
  assert.match(src("src/repositories/auth.repository.ts"), /supabase\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.ok(exists("src/app/auth/callback/route.ts"), "the callback used by password reset stays");
});

test("no OAuth sign-in anywhere in the app; Microsoft Teams class links are unrelated and stay", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  };
  walk("src");
  for (const rel of files) assert.doesNotMatch(src(rel), /signInWithOAuth|provider:\s*["']azure["']/, `${rel}: no OAuth sign-in`);
  assert.match(src("src/components/modules/ClassDetailView.tsx"), /Opens Microsoft Teams in a new tab\./);
});
