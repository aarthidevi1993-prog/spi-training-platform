// Phase 7 P3.10-D — migration 0029: only an active Super Admin may revoke invitations. Trainers (even for an
// invitation they created before 0028, in a batch they still teach), students and suspended Super Admins are
// refused by the database with 42501 before anything is read or written; the Super Admin's revoke is unchanged
// (state change only, audited, pending / expired / not_pending rules, 500-character reason). Own fixtures (irv_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(here, `../../supabase/migrations/${name}`), "utf8").replace(/\r\n/g, "\n");
const M0029 = migration("0029_restrict_invitation_revocation_to_super_admin.sql");
const SIG = "revoke_user_invitation(p_invitation_id uuid, p_reason text default null)";
const FN = "public.revoke_user_invitation(uuid, text)";
const OLD_GUARD = "if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then";
const NEW_GUARD = "if v_uid is null or v_role is distinct from 'super_admin' then  -- 0029: Super Admin only";

let W = {};
const as = (id) => db.client({ role: "authenticated", userId: id });
async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code} ${error.message}`);
  return data;
}
async function err(client, fn, args = {}) {
  return (await client.rpc(fn, args)).error;
}
let n = 0;
const invite = async (o = {}) => {
  const r = await call(as(W.irv_SA), "create_user_invitation", { p: { email: `irv${Date.now().toString(36)}${++n}@irv.test`, role: "student", full_name: "Irv Person", ...o } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.invitation_id;
};
/** A pre-0028 trainer invitation: created by the Super Admin, then attributed to the trainer as the superuser (test-only). */
async function legacyTrainerInvitation(trainerId, batchId) {
  const id = await invite({ batch_id: batchId });
  await db.run(`set session_replication_role = replica; update public.user_invitations set invited_by = '${trainerId}' where id = '${id}';`);
  return id;
}
const row = (id) =>
  db.admin(`select json_build_object('status', status, 'revoked_by', revoked_by, 'reason', revoke_reason, 'revoked', revoked_at is not null)
              from public.user_invitations where id = '${id}'`);
const revokeEvents = (id) => db.admin(`select count(*) from public.user_admin_events where invitation_id = '${id}' and event_type = 'invitation_revoked'`);
function body(sql, signature) {
  const start = sql.indexOf(`function public.${signature}`);
  assert.ok(start >= 0, signature);
  const open = sql.indexOf("as $$", start) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$;", open));
}
const attrs = () =>
  db.admin(`select json_build_object('definer', p.prosecdef, 'config', p.proconfig, 'owner', p.proowner::regrole::text, 'src_md5', md5(p.prosrc),
      'anon', has_function_privilege('anon', p.oid, 'execute'), 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'))
    from pg_proc p where p.oid = to_regprocedure('${FN}')`);

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'irv_' || k, gen_random_uuid() from unnest(array['SA','SA_SUS','T','T2','ST','B','B2']) k;
    insert into auth.users (id, email) select v, lower(k) || '@irv.test' from t.ids where k in ('irv_SA','irv_SA_SUS','irv_T','irv_T2','irv_ST');
    update public.profiles set role = 'super_admin' where id in (t.id('irv_SA'), t.id('irv_SA_SUS'));
    update public.profiles set role = 'trainer' where id in (t.id('irv_T'), t.id('irv_T2'));
    update public.profiles set account_status = 'active' where id in (t.id('irv_SA'), t.id('irv_SA_SUS'), t.id('irv_T'), t.id('irv_T2'), t.id('irv_ST'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('irv_T'), 'IRV-T', 'Irv Trainer'), (t.id('irv_T2'), 'IRV-T2', 'Irv Trainer Two');
    insert into public.students (id, student_code, full_name) values (t.id('irv_ST'), 'IRV-ST', 'Irv Student');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('irv_B'),  'IRV-B',  t.id('C1'), t.id('irv_T'),  'IRV-B',  '2026-01-01', '2027-12-31', 'ongoing', 30),
      (t.id('irv_B2'), 'IRV-B2', t.id('C1'), t.id('irv_T2'), 'IRV-B2', '2026-01-01', '2027-12-31', 'ongoing', 30);
    update public.profiles set account_status = 'suspended' where id = t.id('irv_SA_SUS');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("migration 0029: one CREATE OR REPLACE — the 0017 body with only the guard changed; no other DDL or data change", () => {
  const ddl = M0029.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "");
  assert.equal((ddl.match(/create or replace function public\.revoke_user_invitation\(p_invitation_id uuid, p_reason text default null\)/gi) ?? []).length, 1);
  assert.equal((ddl.match(/create\s/gi) ?? []).length, 1, "the only CREATE");
  assert.doesNotMatch(ddl, /drop\s|grant\s|revoke\s|alter\s|policy|disable|bypassrls|insert\s|delete\s|update\s|truncate/i);
  const before017 = body(migration("0017_user_management_foundation.sql"), SIG);
  assert.equal(before017.split(OLD_GUARD).length, 2, "exactly one old guard in 0017");
  assert.equal(body(M0029, SIG), before017.replace(OLD_GUARD, NEW_GUARD), "identical to 0017 except the guard");
  assert.match(M0029, /Preflight failed: 0028 is not applied/);
  assert.match(M0029, /Preflight failed: public\.revoke_user_invitation\(uuid, text\) differs from the 0017 definition/);
  assert.match(M0029, /Postflight failed: public\.revoke_user_invitation\(uuid, text\) does not have the 0029 guard and attributes/);
});

test("0029 applied: guard first; SECURITY DEFINER, search_path and EXECUTE (authenticated, not anon) unchanged", async () => {
  const a = await attrs();
  assert.deepEqual([a.definer, a.config, a.anon, a.authenticated], [true, ['search_path=""'], false, true]);
  const src = await db.admin(`select prosrc from pg_proc where oid = to_regprocedure('${FN}')`);
  assert.match(src, /\bbegin\s+if v_uid is null or v_role is distinct from 'super_admin' then\s+(--[^\n]*\n\s*)?raise exception 'You don''t have permission to do that\.' using errcode = '42501';/);
});

test("trainers are refused (42501) — even for their own pre-0028 invitation in a batch they still teach; nothing changes", async () => {
  const legacy = await legacyTrainerInvitation(W.irv_T, W.irv_B);
  const adminInBatch = await invite({ batch_id: W.irv_B });
  for (const [client, id, label] of [
    [as(W.irv_T), legacy, "own legacy invitation"],
    [as(W.irv_T), adminInBatch, "Super Admin invitation in the trainer's batch"],
    [as(W.irv_T), randomUUID(), "unknown id"],
    [as(W.irv_T2), legacy, "another trainer"],
  ]) {
    const e = await err(client, "revoke_user_invitation", { p_invitation_id: id, p_reason: "Wrong person" });
    assert.equal(e?.code, "42501", label);
    assert.equal(e.message, "You don't have permission to do that.", `${label}: the generic refusal`);
  }
  // Refused before the reason is even checked.
  assert.equal((await err(as(W.irv_T), "revoke_user_invitation", { p_invitation_id: legacy, p_reason: "x".repeat(501) }))?.code, "42501");
  for (const id of [legacy, adminInBatch]) {
    assert.deepEqual(await row(id), { status: "pending", revoked_by: null, reason: null, revoked: false });
    assert.equal(await revokeEvents(id), 0);
  }
});

test("students, suspended Super Admins, user-less and anonymous sessions are refused (42501)", async () => {
  const id = await invite();
  for (const [label, client] of [["student", as(W.irv_ST)], ["suspended Super Admin", as(W.irv_SA_SUS)], ["no user", db.client({ role: "authenticated" })]]) {
    assert.equal((await err(client, "revoke_user_invitation", { p_invitation_id: id }))?.code, "42501", label);
  }
  const anon = await err(db.client({ role: "anon" }), "revoke_user_invitation", { p_invitation_id: id });
  assert.equal(anon?.code, "42501", "anon: no EXECUTE");
  assert.equal((await row(id)).status, "pending");
});

test("Super Admin revocation unchanged: any pending invitation (incl. a trainer's legacy one), audited; repeat / expired / reason rules", async () => {
  const sa = as(W.irv_SA);
  const legacy = await legacyTrainerInvitation(W.irv_T, W.irv_B);
  assert.deepEqual(await call(sa, "revoke_user_invitation", { p_invitation_id: legacy, p_reason: "  Wrong person  " }), { ok: true });
  assert.deepEqual(await row(legacy), { status: "revoked", revoked_by: W.irv_SA, reason: "Wrong person", revoked: true });
  assert.equal(await revokeEvents(legacy), 1);
  assert.deepEqual(await call(sa, "revoke_user_invitation", { p_invitation_id: legacy }), { ok: false, reason: "not_pending", status: "revoked" });

  const blankReason = await invite();
  assert.deepEqual(await call(sa, "revoke_user_invitation", { p_invitation_id: blankReason, p_reason: "   " }), { ok: true });
  assert.equal((await row(blankReason)).reason, null, "a blank reason is stored as null");

  const expired = await invite();
  await db.exec(`update public.user_invitations set expires_at = created_at + interval '1 millisecond' where id = '${expired}';`);
  assert.deepEqual(await call(sa, "revoke_user_invitation", { p_invitation_id: expired }), { ok: false, reason: "expired" });
  assert.equal((await row(expired)).status, "expired");

  assert.deepEqual(await call(sa, "revoke_user_invitation", { p_invitation_id: randomUUID() }), { ok: false, reason: "not_found" });
  assert.equal((await err(sa, "revoke_user_invitation", { p_invitation_id: randomUUID(), p_reason: "x".repeat(501) }))?.code, "22023");
});

test("re-applying 0029 is refused by its preflight and changes nothing", async () => {
  const before = await attrs();
  const r = await db.run(M0029);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Preflight failed: public\.revoke_user_invitation\(uuid, text\) differs from the 0017 definition/);
  assert.deepEqual(await attrs(), before);
});
