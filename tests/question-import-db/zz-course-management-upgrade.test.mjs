// 0030 on a populated 0029 (+0029a, P5.2 — 0030 requires it) database (a separate throwaway database in the local test cluster — never Supabase):
// existing courses / modules / batches / codes are not changed; the course-code sequence starts above every
// existing CRS- number (any case); module codes continue after legacy M<n> codes; codes become immutable; the
// preflight refuses case-insensitive code collisions without changing anything; a re-run is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { db } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0030 = path.join(MIGRATIONS, "0030_course_management.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const UPGRADE_DB = "qi_cm_upgrade";

test("0030 on a populated 0029 database: data unchanged, codes continue, collisions refused, re-run refused", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [
    path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2\d)[a-z]?_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)),
    path.join(here, "fixtures/seed.sql"),
  ]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }

  // Existing data as a live 0029 database could hold it: earlier CRS- codes (mixed case), a legacy code, a
  // legacy title longer than today's limit, legacy module codes and an empty module description, and a
  // DRAFT course that already has a batch (allowed before 0030).
  await up.exec(`
    insert into t.ids (k, v) select 'up_' || k, gen_random_uuid() from unnest(array['C7','C9','CL','CD','CN','B']) k;
    insert into public.courses (id, course_code, title, level, status) values
      (t.id('up_C7'), 'CRS-00007', 'Upgrade seven', 'foundation', 'published'),
      (t.id('up_C9'), 'crs-00009', 'Upgrade nine', 'intermediate', 'archived'),
      (t.id('up_CL'), 'LEGACY-1', repeat('T', 160), 'advanced', 'published'),
      (t.id('up_CD'), 'DRAFT-1', 'Draft with batch', 'foundation', 'draft'),
      (t.id('up_CN'), 'DRAFT-2', 'Legacy unused draft', 'foundation', 'draft');
    insert into public.modules (course_id, module_code, title, description, sequence) values
      (t.id('up_C7'), 'M1', 'Legacy one', null, 1), (t.id('up_C7'), 'M05', 'Legacy five', '', 2);
    insert into public.batches (id, batch_code, course_id, name, start_date, end_date, status, max_seats)
      values (t.id('up_B'), 'UP-B', t.id('up_CD'), 'Upgrade batch', '2027-01-01', '2027-02-01', 'upcoming', 10);`);

  const snapshot = () => up.admin(`select json_build_object(
      'courses', (select md5(string_agg(id::text || course_code || title || description || level::text || duration_hours::text || status::text || updated_at::text, ',' order by id)) from public.courses),
      'modules', (select md5(string_agg(id::text || module_code || title || coalesce(description, '<null>') || sequence::text || updated_at::text, ',' order by id)) from public.modules),
      'batches', (select md5(string_agg(id::text || course_id::text || status::text || updated_at::text, ',' order by id)) from public.batches))`);
  const before = await snapshot();
  const notApplied = async () => assert.equal(await up.admin("select to_regclass('public.course_code_seq') is null and to_regclass('public.course_events') is null"), true);

  // Preflight: a case-insensitive course-code collision is refused; nothing is created or changed.
  await up.exec(`insert into public.courses (id, course_code, title, level) values (gen_random_uuid(), 'crs-00007', 'Clash', 'foundation');`);
  r = await up.run(read(M0030));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /course codes collide case-insensitively \(crs-00007\)/);
  await notApplied();
  await up.exec(`delete from public.courses where title = 'Clash';`);

  // Preflight: a case-insensitive module-code collision within one course is refused too.
  await up.exec(`insert into public.modules (course_id, module_code, title, sequence) values (t.id('up_C7'), 'm1', 'Clash', 3);`);
  r = await up.run(read(M0030));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /module codes collide case-insensitively/);
  await notApplied();
  await up.exec(`delete from public.modules where title = 'Clash';`);
  assert.deepEqual(await snapshot(), before, "refused runs left the data as it was");

  // Preflight: a replaced function that still carries its marker but differs elsewhere is never overwritten —
  // the whole body is fingerprinted, so 0030 stops and changes nothing.
  const drift = (from, to) => up.exec(`do $d$ begin
      execute replace(pg_get_functiondef('public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure), $q$${from}$q$, $q$${to}$q$);
    end $d$;`);
  await drift("return jsonb_build_object('ok', true, 'previous'", "/* drift */ return jsonb_build_object('ok', true, 'previous'");
  assert.equal(await up.admin(`select prosrc like '%0023: only an available student may be enrolled or re-enrolled.%' from pg_proc
                               where oid = 'public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure`), true, "the marker alone still matches");
  r = await up.run(read(M0030));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /must be the current versions \(exact definitions/);
  await notApplied();
  await drift("/* drift */ return jsonb_build_object('ok', true, 'previous'", "return jsonb_build_object('ok', true, 'previous'");
  assert.equal(await up.admin(`select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc
                               where oid = 'public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure`), "ab35b62993ccd6464b940540bd443e24", "restored to 0023");

  // The real upgrade.
  r = await up.run(read(M0030));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await snapshot(), before, "0030 changes no existing course, module or batch");
  assert.equal(await up.admin("select count(*) from public.course_events"), 0, "no audit rows invented");

  // Codes continue above every existing CRS- number (case-insensitive: crs-00009 → next is CRS-00010).
  const A = await up.admin("select t.id('A')");
  const sa = up.client({ role: "authenticated", userId: A });
  const created = await sa.rpc("admin_create_course", { p: { title: "After upgrade", level: "foundation", duration_hours: 8 } });
  assert.equal(created.data?.course_code, "CRS-00010", JSON.stringify(created));
  // Module codes continue after legacy M<n> codes on that course: M1, M05 → M06.
  const C7 = await up.admin("select t.id('up_C7')");
  assert.equal((await sa.rpc("admin_create_module", { p_course_id: C7, p: { title: "Added", duration_hours: 1 } })).data?.module_code, "M06");

  // A legacy course's publication history is unknown (no course_created event), so even an unused legacy DRAFT
  // is never deleted; a draft created through Course Management, whose history proves it, still can be.
  const CN = await up.admin("select t.id('up_CN')");
  assert.equal((await sa.rpc("admin_course_usage", { p_course_id: CN })).data?.can_delete, false);
  assert.deepEqual((await sa.rpc("admin_delete_course", { p_course_id: CN })).data, { ok: false, reason: "was_published" });
  assert.equal(await up.admin("select count(*) from public.courses where id = t.id('up_CN')"), 1, "the legacy draft is kept");
  assert.equal((await sa.rpc("admin_course_usage", { p_course_id: created.data.course_id })).data?.can_delete, true);
  assert.equal((await sa.rpc("admin_delete_course", { p_course_id: created.data.course_id })).data?.ok, true);

  // Existing codes are now immutable; the legacy long title remains editable for other fields.
  r = await up.run(`update public.courses set course_code = 'CHANGED' where id = t.id('up_C7');`);
  assert.match(r.stderr, /Course codes cannot be changed/);
  const CL = await up.admin("select t.id('up_CL')");
  assert.deepEqual((await sa.rpc("admin_update_course", { p_course_id: CL, p: { description: "Kept title" } })).data, { ok: true, fields: ["description"] });
  // The legacy empty module description is not reported as a change.
  const M05 = await up.admin("select id from public.modules where module_code = 'M05'");
  assert.deepEqual((await sa.rpc("admin_update_module", { p_module_id: M05, p: { title: "Legacy five", description: "" } })).data, { ok: false, reason: "unchanged" });
  // The draft course's existing batch is untouched; a NEW client batch needs a published course.
  assert.equal(await up.admin("select count(*) from public.batches where batch_code = 'UP-B'"), 1);

  // A second run is refused.
  r = await up.run(read(M0030));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0030 already applied/);

  r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
  assert.equal(r.code, 0, r.stderr);
});
