// supabase/rollback/0031_rollback.sql (manual, never a migration) on a populated 0031 database (a separate throwaway
// database in the local test cluster — never Supabase): refused unless all four functions are exactly the 0031
// versions (on a 0030 database, and after drift — nothing replaced); a real rollback restores the exact 0030
// definitions with the same owner, SECURITY DEFINER, search_path and grants, changes no course, module or audit row,
// and 0 hours are accepted again while authorization and audit stay; a second rollback is refused; 0031 re-applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { db } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0031 = path.join(MIGRATIONS, "0031_positive_course_module_durations.sql");
const RB0031 = path.resolve(here, "../../supabase/rollback/0031_rollback.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const ROLLBACK_DB = "qi_dv_rollback";

const FP_0030 = {
  "public.admin_create_course(jsonb)": "620460b943f6e2e8b7cbc5da78f2a1d0",
  "public.admin_update_course(uuid, jsonb)": "91ee8f6a9843e45904ff2aeb8ef74966",
  "public.admin_create_module(uuid, jsonb)": "a8c18b39b659eafbebe9c167d9b1a0cf",
  "public.admin_update_module(uuid, jsonb)": "77162d7b0e422a0aa89ede5e4018221b",
};
const FP_0031 = {
  "public.admin_create_course(jsonb)": "9bc1a7322603269f0b452ac23ea4fa2a",
  "public.admin_update_course(uuid, jsonb)": "6cbf926a4e84ea6a400b17038e18efd8",
  "public.admin_create_module(uuid, jsonb)": "81b8a6995ff2cf06658e93ba682fc92c",
  "public.admin_update_module(uuid, jsonb)": "6606099e4bf723e8aff28a5cb944b4fe",
};

test("0031 rollback: refused on 0030 or drift (nothing replaced); restores 0030 exactly with attributes and grants; no data change; re-run refused; 0031 re-applies", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: ROLLBACK_DB });
  let r = await db.run(`drop database if exists ${ROLLBACK_DB} with (force);\ncreate database ${ROLLBACK_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [
    path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2\d|30)[a-z]?_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)),
    path.join(here, "fixtures/seed.sql"),
  ]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }

  const fingerprints = async () => {
    const out = {};
    for (const sig of Object.keys(FP_0030)) {
      out[sig] = await up.admin(`select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('${sig}')`);
    }
    return out;
  };
  const sigs = Object.keys(FP_0030).map((s) => `to_regprocedure('${s}')`).join(", ");
  const attributes = () => up.admin(`select json_agg(json_build_object('f', p.oid::regprocedure::text, 'secdef', p.prosecdef, 'cfg', p.proconfig,
      'owner', p.proowner::regrole::text, 'acl', p.proacl::text) order by p.oid::regprocedure::text)
      from pg_proc p where p.oid = any (array[${sigs}])`);

  // On a 0030 database (0031 not applied): refused, nothing replaced.
  assert.deepEqual(await fingerprints(), FP_0030);
  const attributes0030 = await attributes();
  r = await up.run(read(RB0031));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Rollback preflight failed: public\.admin_create_course\(jsonb\) is not exactly the 0031 version/);
  assert.deepEqual(await fingerprints(), FP_0030, "nothing was replaced");

  // A legacy 0-hour course and module (allowed before 0031), then 0031 and rows created under it.
  await up.exec(`
    insert into t.ids (k, v) select 'rb_' || k, gen_random_uuid() from unnest(array['C0','M0']) k;
    insert into public.courses (id, course_code, title, level, status, duration_hours) values (t.id('rb_C0'), 'LEGACY-ZERO', 'Legacy zero course', 'foundation', 'draft', 0);
    insert into public.modules (id, course_id, module_code, title, sequence, duration_hours) values (t.id('rb_M0'), t.id('rb_C0'), 'M01', 'Legacy zero module', 1, 0);`);
  r = await up.run(read(M0031));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await fingerprints(), FP_0031);
  const sa = up.client({ role: "authenticated", userId: await up.admin("select t.id('A')") });
  const c = await sa.rpc("admin_create_course", { p: { title: "Under 0031", level: "foundation", duration_hours: 5 } });
  assert.equal(c.data?.ok, true, JSON.stringify(c));
  assert.equal((await sa.rpc("admin_create_module", { p_course_id: c.data.course_id, p: { title: "Module", duration_hours: 2 } })).data?.ok, true);

  // Drift: one function differs from its 0031 version → refused, nothing replaced (not even the matching ones).
  const drift = (from, to) => up.exec(`do $d$ begin
      execute replace(pg_get_functiondef('public.admin_update_module(uuid, jsonb)'::regprocedure), $q$${from}$q$, $q$${to}$q$);
    end $d$;`);
  await drift("perform public.user_mgmt_require_super_admin();", "perform public.user_mgmt_require_super_admin(); /* drift */");
  r = await up.run(read(RB0031));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Rollback preflight failed: public\.admin_update_module\(uuid, jsonb\) is not exactly the 0031 version/);
  assert.equal((await fingerprints())["public.admin_create_course(jsonb)"], FP_0031["public.admin_create_course(jsonb)"], "nothing was replaced");
  await drift("perform public.user_mgmt_require_super_admin(); /* drift */", "perform public.user_mgmt_require_super_admin();");
  assert.deepEqual(await fingerprints(), FP_0031, "drift removed");

  const snapshot = () => up.admin(`select json_build_object(
      'courses', (select md5(string_agg(id::text || course_code || title || description || level::text || duration_hours::text || status::text || updated_at::text, ',' order by id)) from public.courses),
      'modules', (select md5(string_agg(id::text || module_code || title || coalesce(description, '<null>') || sequence::text || duration_hours::text || updated_at::text, ',' order by id)) from public.modules),
      'events', (select count(*) from public.course_events))`);
  const before = await snapshot();

  // The rollback: the exact 0030 definitions, attributes and grants; no data changed.
  r = await up.run(read(RB0031));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await fingerprints(), FP_0030);
  assert.deepEqual(await attributes(), attributes0030, "owner, SECURITY DEFINER, search_path and grants as under 0030");
  assert.deepEqual(await snapshot(), before, "no course, module or audit row changed");
  assert.equal(await up.admin("select duration_hours::text from public.courses where id = t.id('rb_C0')"), "0.0", "legacy zero row unchanged");

  // 0030 behaviour is back (0 accepted); authorization and audit logging are part of the restored bodies.
  const zero = await sa.rpc("admin_create_course", { p: { title: "Zero after rollback", level: "foundation", duration_hours: 0 } });
  assert.equal(zero.data?.ok, true, JSON.stringify(zero));
  assert.equal(await up.admin(`select count(*) from public.course_events where event_type = 'course_created' and course_id = '${zero.data.course_id}'`), 1);
  const trainer = up.client({ role: "authenticated", userId: await up.admin("select t.id('T1')") });
  assert.equal((await trainer.rpc("admin_create_course", { p: { title: "Trainer", level: "foundation", duration_hours: 1 } })).error?.code, "42501");
  assert.equal(await up.admin("select has_function_privilege('anon', 'public.admin_create_course(jsonb)'::regprocedure, 'execute')"), false);

  // A second rollback is refused; 0031 applies again cleanly.
  r = await up.run(read(RB0031));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Rollback preflight failed/);
  r = await up.run(read(M0031));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await fingerprints(), FP_0031);

  r = await db.run(`drop database if exists ${ROLLBACK_DB} with (force);`);
  assert.equal(r.code, 0, r.stderr);
});
