// Phase 7 P3.10-D — migration 0028: only an active Super Admin may create invitations or begin their delivery.
// The behaviour itself is tested where it lives (zz-user-management, zz-invitation-delivery); this file checks
// the migration: its shape, that re-applying it is refused and changes nothing, and that the two functions keep
// their attributes and grants while record_invitation_delivery stays service_role only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(here, `../../supabase/migrations/${name}`), "utf8").replace(/\r\n/g, "\n");
const M0028 = migration("0028_restrict_invitation_creation_to_super_admin.sql");
const FUNCS = ["public.create_user_invitation(jsonb)", "public.begin_invitation_delivery(uuid)", "public.record_invitation_delivery(uuid, boolean, uuid)"];
const OLD_GUARD = "if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then";
const NEW_GUARD = "if v_uid is null or v_role is distinct from 'super_admin' then  -- 0028: Super Admin only";

/** The dollar-quoted body of `function public.<signature>` in a migration (exactly what lands in prosrc). */
function body(sql, signature) {
  const start = sql.indexOf(`function public.${signature}`);
  assert.ok(start >= 0, signature);
  const open = sql.indexOf("as $$", start) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$;", open));
}

const attrs = () =>
  db.admin(`select json_object_agg(f, json_build_object(
      'definer', p.prosecdef, 'config', p.proconfig, 'owner', p.proowner::regrole::text, 'src_md5', md5(p.prosrc),
      'anon', has_function_privilege('anon', p.oid, 'execute'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
      'service_role', has_function_privilege('service_role', p.oid, 'execute')))
    from unnest(array['${FUNCS.join("','")}']) f join pg_proc p on p.oid = to_regprocedure(f)`);

test("migration 0028: two CREATE OR REPLACE, each the previous body with only the guard changed; no other DDL or data change", () => {
  // Outside every $$ body (function bodies and DO blocks) only the two CREATE OR REPLACE statements remain.
  const ddl = M0028.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "");
  assert.equal((ddl.match(/create or replace function public\.create_user_invitation\(p jsonb\)/gi) ?? []).length, 1);
  assert.equal((ddl.match(/create or replace function public\.begin_invitation_delivery\(p_invitation_id uuid\)/gi) ?? []).length, 1);
  assert.equal((ddl.match(/create\s/gi) ?? []).length, 2, "the only CREATEs");
  assert.doesNotMatch(ddl, /drop\s|grant\s|revoke\s|alter\s|policy|disable|bypassrls|insert\s|delete\s|update\s|truncate/i);

  for (const [prev, sig] of [["0020_automatic_user_codes.sql", "create_user_invitation(p jsonb)"], ["0019_invitation_delivery.sql", "begin_invitation_delivery(p_invitation_id uuid)"]]) {
    const before = body(migration(prev), sig);
    assert.equal(before.split(OLD_GUARD).length, 2, `${sig}: exactly one old guard in ${prev}`);
    assert.equal(body(M0028, sig), before.replace(OLD_GUARD, NEW_GUARD), `${sig}: identical to ${prev} except the guard`);
  }
  assert.match(M0028, /Preflight failed: public\.create_user_invitation\(jsonb\) differs from the 0020 definition/);
  assert.match(M0028, /Preflight failed: public\.begin_invitation_delivery\(uuid\) differs from the 0019 definition/);
  assert.match(M0028, /Postflight failed: record_invitation_delivery must stay service_role only/);
});

test("0028 applied: guard first, SECURITY DEFINER + search_path kept, EXECUTE unchanged; record stays service_role only", async () => {
  const a = await attrs();
  for (const f of FUNCS) {
    assert.equal(a[f].definer, true, f);
    assert.deepEqual(a[f].config, ['search_path=""'], f);
    assert.equal(a[f].anon, false, `${f}: anon`);
  }
  assert.equal(a[FUNCS[0]].authenticated, true, "create: the Super Admin calls it through their own session");
  assert.equal(a[FUNCS[1]].authenticated, true, "begin: the Super Admin calls it through their own session");
  assert.deepEqual([a[FUNCS[2]].authenticated, a[FUNCS[2]].service_role], [false, true], "record_invitation_delivery: service_role only");

  for (const f of FUNCS.slice(0, 2)) {
    const src = await db.admin(`select prosrc from pg_proc where oid = to_regprocedure('${f}')`);
    assert.match(src, /\bbegin\s+if v_uid is null or v_role is distinct from 'super_admin' then\s+(--[^\n]*\n\s*)?raise exception 'You don''t have permission to do that\.' using errcode = '42501';/, `${f}: the guard is the first statement`);
  }
});

test("re-applying 0028 is refused by its preflight and changes nothing", async () => {
  const before = await attrs();
  const r = await db.run(M0028);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Preflight failed: public\.create_user_invitation\(jsonb\) differs from the 0020 definition/);
  assert.deepEqual(await attrs(), before);
});
