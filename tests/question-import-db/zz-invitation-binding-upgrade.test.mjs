// P5.2 — migration order and rollback for 0029a (a separate throwaway database in the local test cluster — never
// Supabase). Live has 0001–0029 today. 0029a applies on its own (no course management); 0030 refuses to run without
// it (so 0030 can never re-open unbound acceptance) and, once applied after it, keeps the binding rule; a re-run of
// 0029a is refused; supabase/rollback/0029a_rollback.sql restores exactly the 0022 function and removes the recovery
// objects (only before 0030), and 0029a can be re-applied afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { db } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const M0029A = read(path.join(MIGRATIONS, "0029a_invitation_binding_and_recovery.sql"));
const M0030 = read(path.join(MIGRATIONS, "0030_course_management.sql"));
const ROLLBACK = read(path.resolve(here, "../../supabase/rollback/0029a_rollback.sql"));
const UPGRADE_DB = "qi_ib_upgrade";
// Whitespace-insensitive fingerprints of accept_user_invitation(): live today (0022), after 0029a, after the amended 0030.
const MD5 = { v0022: "073654ed182b8762f4a902106ab554cd", v0029a: "96dd1023a79442f8db66e2e5ef5510f1", v0030: "554389411d82541a0d931fdbff1dd1cc" };
const RECOVERY_FUNCTIONS = ["begin_invitation_recovery", "complete_invitation_recovery", "invitation_recovery_candidate", "user_mgmt_recoverable_placeholder"];

test("0029a order and rollback: alone on 0029; 0030 refused without it; re-run refused; rollback restores 0022; re-apply; 0030 keeps the rule", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  try {
    for (const f of [
      path.join(here, "fixtures/bootstrap.sql"),
      ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2\d)_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)),
      path.join(here, "fixtures/seed.sql"),
    ]) {
      r = await up.run(read(f));
      assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
    }
    const accept = () => up.admin(`select json_build_object('md5', md5(regexp_replace(p.prosrc, '\\s+', ' ', 'g')), 'definer', p.prosecdef, 'config', p.proconfig,
        'anon', has_function_privilege('anon', p.oid, 'execute'), 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'))
      from pg_proc p where p.oid = 'public.accept_user_invitation()'::regprocedure`);
    const attrs = { definer: true, config: ['search_path=""'], anon: false, authenticated: true };
    const recoveryObjects = () => up.admin(`select json_build_object(
        'functions', (select coalesce(json_agg(p.proname order by p.proname), '[]') from pg_proc p where p.pronamespace = 'public'::regnamespace
                       and p.proname in (${RECOVERY_FUNCTIONS.map((f) => `'${f}'`).join(", ")})),
        'columns', (select coalesce(json_agg(column_name order by column_name), '[]') from information_schema.columns
                     where table_schema = 'public' and table_name = 'user_invitations' and column_name like 'recovery\\_%'),
        'course_mgmt', to_regclass('public.course_code_seq') is not null)`);
    const none = { functions: [], columns: [], course_mgmt: false };
    const all = { functions: [...RECOVERY_FUNCTIONS].sort(), columns: ["recovery_requested_at", "recovery_requested_by", "recovery_user_id"], course_mgmt: false };

    // Live today (0001–0029): the 0022 definition. 0030 is refused without 0029a and changes nothing.
    assert.deepEqual(await accept(), { md5: MD5.v0022, ...attrs });
    r = await up.run(M0030);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /accept_user_invitation \(0029a\) must be the current versions/);
    assert.deepEqual(await accept(), { md5: MD5.v0022, ...attrs }, "a refused 0030 changes nothing");
    assert.deepEqual(await recoveryObjects(), none);

    // 0029a alone (no course management).
    r = await up.run(M0029A);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await accept(), { md5: MD5.v0029a, ...attrs });
    assert.deepEqual(await recoveryObjects(), all);
    r = await up.run(M0029A);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Preflight failed: 0029a is already applied/);
    assert.deepEqual(await accept(), { md5: MD5.v0029a, ...attrs }, "a refused re-run changes nothing");

    // Behaviour: an unbound super_admin invitation is refused for the matching-address account.
    const A = await up.admin("select v from t.ids where k = 'A'");
    const created = await up.client({ role: "authenticated", userId: A }).rpc("create_user_invitation", { p: { email: "up.unbound@ib.test", role: "super_admin", full_name: "Up Unbound" } });
    assert.equal(created.error, null, JSON.stringify(created.error));
    await up.exec(`insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'up.unbound@ib.test');`);
    const claimant = up.client({ role: "authenticated", userId: "11111111-1111-4111-8111-111111111111" });
    assert.deepEqual((await claimant.rpc("accept_user_invitation")).data, { ok: false, reason: "resend_required" });

    // Rollback (before 0030): exactly the 0022 definition, recovery objects gone; a second rollback is refused.
    r = await up.run(ROLLBACK);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await accept(), { md5: MD5.v0022, ...attrs });
    assert.deepEqual(await recoveryObjects(), none);
    r = await up.run(ROLLBACK);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Rollback preflight failed: public\.accept_user_invitation\(\) is not the 0029a definition/);

    // Re-apply 0029a (the enum values it added survive the rollback), then 0030 on top: the rule is kept.
    r = await up.run(M0029A);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await accept(), { md5: MD5.v0029a, ...attrs });
    r = await up.run(M0030);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await accept(), { md5: MD5.v0030, ...attrs });
    assert.deepEqual(await recoveryObjects(), { ...all, course_mgmt: true });
    assert.deepEqual((await claimant.rpc("accept_user_invitation")).data, { ok: false, reason: "resend_required" }, "0030 keeps the binding rule");

    // After 0030 the 0029a rollback is refused (0030 requires 0029a) and changes nothing.
    r = await up.run(ROLLBACK);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Rollback preflight failed: 0030 is applied/);
    assert.deepEqual(await accept(), { md5: MD5.v0030, ...attrs });
  } finally {
    r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
    assert.equal(r.code, 0, r.stderr);
  }
});
