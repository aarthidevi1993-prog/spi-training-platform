// Course and module planned durations (approved rule, 0031): more than 0 hours, at most 9999.9, at most one decimal
// place — refused otherwise on EVERY path: the application service, a direct RPC call that skips the application, and
// a direct table write. Existing courses / modules that already have 0 hours are not changed and stay editable for
// their other fields; only a duration that is set or changed is checked. Throwaway local database, never Supabase.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDatabase } from "./pg-client.mjs";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createCourseManagementRepository } = await import(`${build}/repositories/course-management.repository.core.mjs`);
const { createCourseManagementService } = await import(`${build}/services/course-management.service.core.mjs`);

let n = 0;
const uniq = (p) => `${p} ${Date.now().toString(36)}-${++n}`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const admin = () =>
  createCourseManagementService({
    repository: createCourseManagementRepository(async () => as(ids.A)),
    getCurrentUser: async () => ({ id: ids.A, email: "a@dv.test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" }),
  });
const rpc = (fn, args) => as(ids.A).rpc(fn, args);
const hoursOf = (id) => db.admin(`select duration_hours::text from public.courses where id = '${id}'`);
const moduleHoursOf = (id) => db.admin(`select duration_hours::text from public.modules where id = '${id}'`);
const countTitled = (title) => db.admin(`select count(*) from public.courses where title = '${title.replace(/'/g, "''")}'`);
const eventCount = (courseId) => db.admin(`select count(*) from public.course_events where course_id = '${courseId}'`);

/** Values that must be refused for any duration (JSON as a client sends it). */
const INVALID = [
  ["zero", 0],
  ["negative", -1],
  ["text", "40"],
  ["two decimals", 1.25],
  ["above the maximum", 10000],
];

test("course creation: zero, negative, text, excess precision, above-maximum and missing hours are refused (service and direct RPC)", async () => {
  for (const [label, value] of INVALID) {
    const title = uniq(`DV create ${label}`);
    const viaService = await admin().createCourse({ title, description: "", level: "foundation", durationHours: value, status: "draft" });
    assert.equal(viaService.ok, false, `${label}: ${JSON.stringify(viaService)}`);
    assert.ok(viaService.errors?.durationHours, `${label}: a field message`);
    const direct = await rpc("admin_create_course", { p: { title, level: "foundation", duration_hours: value } });
    assert.equal(direct.error?.code, "22023", `${label}: ${JSON.stringify(direct)}`);
    assert.equal(await countTitled(title), 0, `${label}: nothing created`);
  }
  assert.match((await admin().createCourse({ title: uniq("DV zero msg"), description: "", level: "foundation", durationHours: 0, status: "draft" })).errors.durationHours, /more than 0 hours/);
  const title = uniq("DV create missing");
  assert.equal((await rpc("admin_create_course", { p: { title, level: "foundation" } })).error?.code, "22023");
  assert.equal((await admin().createCourse({ title, description: "", level: "foundation", status: "draft" })).ok, false);
  assert.equal(await countTitled(title), 0);
  // Valid positive values are saved (smallest step and one decimal place).
  for (const value of [0.5, 12.5, 9999.9]) {
    const ok = await admin().createCourse({ title: uniq(`DV valid ${value}`), description: "", level: "foundation", durationHours: value, status: "draft" });
    assert.equal(ok.ok, true, `${value}: ${JSON.stringify(ok)}`);
    assert.equal(Number(await hoursOf(ok.courseId)), value);
  }
});

test("course editing: invalid hours (including 0) are refused on both paths; valid changes are saved and audited", async () => {
  const created = await admin().createCourse({ title: uniq("DV edit"), description: "", level: "foundation", durationHours: 50, status: "draft" });
  assert.equal(created.ok, true, JSON.stringify(created));
  for (const [label, value] of INVALID) {
    assert.equal((await admin().updateCourse(created.courseId, { durationHours: value })).ok, false, label);
    const direct = await rpc("admin_update_course", { p_course_id: created.courseId, p: { duration_hours: value } });
    assert.equal(direct.error?.code, "22023", `${label}: ${JSON.stringify(direct)}`);
    assert.equal(await hoursOf(created.courseId), "50.0", `${label}: unchanged`);
  }
  const before = await eventCount(created.courseId);
  assert.equal((await admin().updateCourse(created.courseId, { durationHours: 42.5 })).ok, true);
  assert.equal(await hoursOf(created.courseId), "42.5");
  assert.equal(await eventCount(created.courseId), before + 1, "the change is audited");
});

test("an existing course with 0 hours stays editable for other fields; only setting a duration is checked", async () => {
  // A course as it can exist today (created before this rule, or edited to 0 under the old rule): 0 hours.
  const created = await admin().createCourse({ title: uniq("DV legacy course"), description: "", level: "foundation", durationHours: 50, status: "draft" });
  await db.exec(`update public.courses set duration_hours = 0 where id = '${created.courseId}'`);   // privileged writer = legacy state
  // Description (and title) edits work; the stored 0 is not touched.
  assert.equal((await admin().updateCourse(created.courseId, { description: "Outline added." })).ok, true);
  assert.equal((await rpc("admin_update_course", { p_course_id: created.courseId, p: { title: uniq("DV legacy renamed") } })).data?.ok, true);
  // Sending the unchanged 0 alongside another change does not block that change at the database …
  assert.equal((await rpc("admin_update_course", { p_course_id: created.courseId, p: { description: "Again.", duration_hours: 0 } })).data?.ok, true);
  assert.equal(await hoursOf(created.courseId), "0.0", "existing data is never silently altered");
  // … while the application never sends an unchanged duration, and refuses an explicit 0.
  assert.equal((await admin().updateCourse(created.courseId, { durationHours: 0 })).ok, false);
  // Correcting the duration to a positive value works.
  assert.equal((await admin().updateCourse(created.courseId, { durationHours: 50 })).ok, true);
  assert.equal(await hoursOf(created.courseId), "50.0");
  // Once positive, changing it back to 0 is refused on both paths.
  assert.equal((await rpc("admin_update_course", { p_course_id: created.courseId, p: { duration_hours: 0 } })).error?.code, "22023");
  assert.equal(await hoursOf(created.courseId), "50.0");
});

test("modules: zero, negative, text, excess precision, above-maximum and missing hours are refused on create and edit", async () => {
  const created = await admin().createCourse({ title: uniq("DV modules"), description: "", level: "foundation", durationHours: 20, status: "draft" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal((await admin().createModule(created.courseId, { title: "Valid", description: "", durationHours: 3 })).ok, true);
  const mid = await db.admin(`select id from public.modules where course_id = '${created.courseId}'`);
  for (const [label, value] of INVALID) {
    assert.equal((await admin().createModule(created.courseId, { title: `M ${label}`, description: "", durationHours: value })).ok, false, label);
    assert.equal((await rpc("admin_create_module", { p_course_id: created.courseId, p: { title: `M ${label}`, duration_hours: value } })).error?.code, "22023", label);
    assert.equal((await admin().updateModule(mid, { title: "Valid", description: "", durationHours: value })).ok, false, label);
    assert.equal((await rpc("admin_update_module", { p_module_id: mid, p: { duration_hours: value } })).error?.code, "22023", label);
  }
  // Missing hours on create are refused (never silently stored as 0).
  assert.equal((await admin().createModule(created.courseId, { title: "No hours", description: "" })).ok, false);
  assert.equal((await rpc("admin_create_module", { p_course_id: created.courseId, p: { title: "No hours" } })).error?.code, "22023");
  assert.equal(await db.admin(`select count(*) from public.modules where course_id = '${created.courseId}'`), 1, "no invalid module created");
  assert.equal(await moduleHoursOf(mid), "3.0", "the module's hours are unchanged");
  // Valid changes: positive hours saved; editing without hours leaves them as they are.
  assert.equal((await admin().updateModule(mid, { title: "Valid", description: "", durationHours: 2.5 })).ok, true);
  assert.equal(await moduleHoursOf(mid), "2.5");
  assert.equal((await admin().updateModule(mid, { title: "Renamed", description: "" })).ok, true);
  assert.equal(await moduleHoursOf(mid), "2.5");
});

test("an existing module with 0 hours stays editable for its title and description; setting 0 elsewhere is refused", async () => {
  const created = await admin().createCourse({ title: uniq("DV legacy module"), description: "", level: "foundation", durationHours: 10, status: "draft" });
  const legacy = await db.admin("select gen_random_uuid()");
  await db.exec(`insert into public.modules (id, course_id, title, sequence) values ('${legacy}', '${created.courseId}', 'Legacy zero', 1)`);   // default 0 hours
  assert.equal(await moduleHoursOf(legacy), "0.0");
  assert.equal((await admin().updateModule(legacy, { title: "Legacy renamed", description: "Described." })).ok, true);
  assert.equal(await moduleHoursOf(legacy), "0.0", "existing data is never silently altered");
  assert.equal((await admin().updateModule(legacy, { title: "Legacy renamed", description: "Described.", durationHours: 4 })).ok, true);
  assert.equal(await moduleHoursOf(legacy), "4.0");
  assert.equal((await rpc("admin_update_module", { p_module_id: legacy, p: { duration_hours: 0 } })).error?.code, "22023", "back to 0 is refused");
});

test("direct table writes cannot bypass validation: refused for clients (guard); negative refused for any writer (check)", async () => {
  const created = await admin().createCourse({ title: uniq("DV table"), description: "", level: "foundation", durationHours: 10, status: "draft" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const client = await as(ids.A).execute(`update public.courses set duration_hours = 0 where id = '${created.courseId}'`);
  assert.equal(client.error?.code, "42501", JSON.stringify(client.error));
  await assert.rejects(db.exec(`update public.courses set duration_hours = -1 where id = '${created.courseId}'`), /courses_duration_non_negative/);
  assert.equal(await hoursOf(created.courseId), "10.0");
});

test("trainers, students and signed-out callers still cannot use the duration functions (authorization unchanged)", async () => {
  const created = await admin().createCourse({ title: uniq("DV auth"), description: "", level: "foundation", durationHours: 10, status: "draft" });
  const trainer = await db.admin("select t.id('T1')");
  for (const [fn, args] of [
    ["admin_create_course", { p: { title: uniq("DV x"), level: "foundation", duration_hours: 5 } }],
    ["admin_update_course", { p_course_id: created.courseId, p: { duration_hours: 5 } }],
    ["admin_create_module", { p_course_id: created.courseId, p: { title: "X", duration_hours: 5 } }],
  ]) {
    assert.equal((await as(trainer).rpc(fn, args)).error?.code, "42501", fn);
    assert.ok((await db.client({ role: "anon" }).rpc(fn, args)).error, `${fn} anonymous`);
  }
  assert.equal(await hoursOf(created.courseId), "10.0");
});

// ---- 0031 on a populated 0030 database ----
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../supabase/migrations");
const M0031 = path.join(MIGRATIONS, "0031_positive_course_module_durations.sql");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const UPGRADE_DB = "qi_dv_upgrade";

test("0031 on a populated 0030 database: no data changed, legacy zero rows kept and editable, drift refused, re-run refused", async () => {
  const up = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: UPGRADE_DB });
  let r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);\ncreate database ${UPGRADE_DB};`);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [
    path.join(here, "fixtures/bootstrap.sql"),
    ...fs.readdirSync(MIGRATIONS).filter((x) => /^00(0\d|1\d|2\d|30)[a-z]?_.*\.sql$/.test(x)).sort().map((x) => path.join(MIGRATIONS, x)),
    path.join(here, "fixtures/seed.sql"),
  ]) {
    r = await up.run(read(f));
    assert.equal(r.code, 0, `${path.basename(f)}: ${r.stderr}`);
  }
  // Legacy rows with 0 hours (allowed before 0031).
  await up.exec(`
    insert into t.ids (k, v) select 'dv_' || k, gen_random_uuid() from unnest(array['C0','M0']) k;
    insert into public.courses (id, course_code, title, level, status, duration_hours) values (t.id('dv_C0'), 'LEGACY-ZERO', 'Legacy zero course', 'foundation', 'draft', 0);
    insert into public.modules (id, course_id, module_code, title, sequence, duration_hours) values (t.id('dv_M0'), t.id('dv_C0'), 'M01', 'Legacy zero module', 1, 0);`);
  const snapshot = () => up.admin(`select json_build_object(
      'courses', (select md5(string_agg(id::text || course_code || title || duration_hours::text || status::text || updated_at::text, ',' order by id)) from public.courses),
      'modules', (select md5(string_agg(id::text || module_code || title || duration_hours::text || updated_at::text, ',' order by id)) from public.modules))`);
  const before = await snapshot();
  const fpOf = (sig) => up.admin(`select md5(regexp_replace(prosrc, '\\s+', ' ', 'g')) from pg_proc where oid = to_regprocedure('${sig}')`);

  // Drift: a replaced function that differs from its 0030 version is never overwritten — 0031 stops, nothing changes.
  const drift = (from, to) => up.exec(`do $d$ begin
      execute replace(pg_get_functiondef('public.admin_create_course(jsonb)'::regprocedure), $q$${from}$q$, $q$${to}$q$);
    end $d$;`);
  await drift("perform public.user_mgmt_require_super_admin();", "perform public.user_mgmt_require_super_admin(); /* drift */");
  r = await up.run(read(M0031));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /admin_create_course\(jsonb\) is not exactly the 0030 version/);
  assert.equal(await fpOf("public.admin_update_course(uuid, jsonb)"), "91ee8f6a9843e45904ff2aeb8ef74966", "nothing was replaced");
  await drift("perform public.user_mgmt_require_super_admin(); /* drift */", "perform public.user_mgmt_require_super_admin();");
  assert.equal(await fpOf("public.admin_create_course(jsonb)"), "620460b943f6e2e8b7cbc5da78f2a1d0", "restored to 0030");

  // The real upgrade: data unchanged; the four functions are the 0031 versions with grants kept.
  r = await up.run(read(M0031));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await snapshot(), before, "0031 changes no course or module");
  assert.equal(await fpOf("public.admin_create_module(uuid, jsonb)"), "81b8a6995ff2cf06658e93ba682fc92c");
  assert.equal(await up.admin("select has_function_privilege('anon', 'public.admin_update_module(uuid, jsonb)'::regprocedure, 'execute')"), false);

  // Legacy zero rows stay editable for other fields; setting 0 on a new course is refused.
  const sa = up.client({ role: "authenticated", userId: await up.admin("select t.id('A')") });
  const C0 = await up.admin("select t.id('dv_C0')");
  const M0 = await up.admin("select t.id('dv_M0')");
  assert.equal((await sa.rpc("admin_update_course", { p_course_id: C0, p: { description: "Now described." } })).data?.ok, true);
  assert.equal((await sa.rpc("admin_update_module", { p_module_id: M0, p: { title: "Legacy renamed" } })).data?.ok, true);
  assert.equal(await up.admin("select duration_hours::text from public.courses where id = t.id('dv_C0')"), "0.0");
  assert.equal((await sa.rpc("admin_create_course", { p: { title: "After 0031", level: "foundation", duration_hours: 0 } })).error?.code, "22023");

  // A second run is refused.
  r = await up.run(read(M0031));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0031 already applied/);

  r = await db.run(`drop database if exists ${UPGRADE_DB} with (force);`);
  assert.equal(r.code, 0, r.stderr);
});
