// Course Management (0030), end to end against the throwaway local database: the real repository + service on
// each caller's OWN session (never the service role). Automatic course / module codes, duplicate titles, editing,
// modules, the history lock, archive vs delete, batch association, permissions, direct-write refusals and the
// append-only audit. Own fixtures only (cm_*); seed data is only read.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createCourseManagementRepository } = await import(`${build}/repositories/course-management.repository.core.mjs`);
const { createCourseManagementService } = await import(`${build}/services/course-management.service.core.mjs`);
const { classifyBatchInsertError } = await import(`${build}/lib/batches/create-batch.mjs`);

let W;
let n = 0;
const uniq = (p) => `${p} ${Date.now().toString(36)}-${++n}`;
const as = (uid) => db.client({ role: "authenticated", userId: uid });
const repoAs = (uid) => createCourseManagementRepository(async () => as(uid));
const svcAs = (uid, role = "admin") =>
  createCourseManagementService({
    repository: repoAs(uid),
    getCurrentUser: async () => ({ id: uid, email: "x@cm.test", fullName: "x", role, isActive: true, createdAt: "2026-01-01" }),
  });
const admin = () => svcAs(ids.A);
const course = (over = {}) => ({ title: uniq("CM course"), description: "Plan.", level: "foundation", durationHours: 40, status: "published", ...over });
const row = (id) =>
  db.admin(`select json_build_object('code', course_code, 'title', title, 'description', description, 'level', level, 'hours', duration_hours,
              'status', status, 'by', created_by) from public.courses where id = '${id}'`);
const modules = (id) =>
  db.admin(`select coalesce(json_agg(json_build_object('code', module_code, 'title', title, 'seq', sequence) order by sequence), '[]') from public.modules where course_id = '${id}'`);
const events = (id) => db.admin(`select coalesce(json_agg(json_build_object('type', event_type, 'actor', actor_id) order by id), '[]') from public.course_events where course_id = '${id}'`);
const create = async (over = {}) => {
  const r = await admin().createCourse(course(over));
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
};
const sqlLit = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
/** A client batch insert exactly as batchesRepository.create makes it (Super Admin session). */
const clientBatch = (courseId, uid = ids.A) =>
  as(uid).execute(`with ins as (insert into public.batches (batch_code, course_id, name, start_date, end_date, status, max_seats)
                    values (${sqlLit(uniq("CMB").replace(/\s/g, "-"))}, '${courseId}', 'CM batch', '2027-01-01', '2027-02-01', 'upcoming', 10) returning id)
                   select json_build_object('id', id)::text from ins`);
/** A batch row as delivered history (privileged writer, like the seed). */
const historyBatch = (courseId, status) =>
  db.exec(`insert into public.batches (batch_code, course_id, name, start_date, end_date, status, max_seats)
           values (${sqlLit(uniq("CMH").replace(/\s/g, "-"))}, '${courseId}', 'CM history', '2026-01-01', '2026-06-30', '${status}', 10);`);

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'cm_' || k, gen_random_uuid() from unnest(array['T','S','SA_SUS']) k;
    insert into auth.users (id, email) select v, lower(k) || '@cm.test' from t.ids where k in ('cm_T','cm_S','cm_SA_SUS');
    update public.profiles set role = 'trainer', account_status = 'active' where id = t.id('cm_T');
    update public.profiles set role = 'student', account_status = 'active' where id = t.id('cm_S');
    update public.profiles set role = 'super_admin', account_status = 'suspended' where id = t.id('cm_SA_SUS');
    insert into public.trainers (id, trainer_code, full_name) values (t.id('cm_T'), 'CM-T', 'CM Trainer');
    insert into public.students (id, student_code, full_name) values (t.id('cm_S'), 'CM-S', 'CM Student');`);
  W = await db.admin("select json_object_agg(k, v) from t.ids");
});

// ---- creation and automatic codes ----
test("create: the database assigns unique CRS- codes; values stored as sent; creator and audit recorded", async () => {
  const a = await create({ status: "draft", durationHours: 12.5, level: "advanced" });
  const b = await create();
  assert.match(a.courseCode, /^CRS-\d{5,}$/);
  assert.match(b.courseCode, /^CRS-\d{5,}$/);
  assert.ok(Number(b.courseCode.slice(4)) > Number(a.courseCode.slice(4)), "codes increase");
  const stored = await row(a.courseId);
  assert.deepEqual({ ...stored, title: undefined }, { code: a.courseCode, title: undefined, description: "Plan.", level: "advanced", hours: 12.5, status: "draft", by: ids.A });
  assert.deepEqual(await events(a.courseId), [{ type: "course_created", actor: ids.A }]);
  assert.match(a.message, new RegExp(`Course ${a.courseCode} created\\.`));
});

test("codes: simultaneous creations get distinct codes; a supplied code is refused; codes never change", async () => {
  const results = await Promise.all([1, 2, 3, 4].map(() => admin().createCourse(course())));
  const codes = results.map((r) => r.courseCode);
  assert.equal(new Set(codes).size, 4, codes.join(", "));
  // Calling the function directly with a code is refused (unknown field), nothing created.
  const before = await db.admin("select count(*) from public.courses");
  const smuggled = await as(ids.A).rpc("admin_create_course", { p: { title: uniq("Smuggle"), level: "foundation", duration_hours: 1, course_code: "HACK-1" } });
  assert.equal(smuggled.error?.code, "22023");
  assert.equal(await db.admin("select count(*) from public.courses"), before);
  // Immutable for every writer, even the SQL Editor.
  await assert.rejects(db.exec(`update public.courses set course_code = 'CHANGED-1' where id = '${results[0].courseId}'`), /Course codes cannot be changed/);
  // A privileged insert without a code gets one generated (seed / SQL Editor path).
  await db.exec(`insert into public.courses (title, level) values (${sqlLit(uniq("Privileged"))}, 'foundation')`);
  assert.match(await db.admin("select course_code from public.courses order by created_at desc limit 1"), /^CRS-\d{5,}$/);
});

test("direct client writes to courses and modules are refused — even for a Super Admin (functions only)", async () => {
  const c = await create();
  for (const sql of [
    `insert into public.courses (course_code, title, level) values ('DIRECT-1', 'Direct', 'foundation')`,
    `update public.courses set title = 'Direct edit' where id = '${c.courseId}'`,
    `delete from public.courses where id = '${c.courseId}'`,
    `insert into public.modules (course_id, module_code, title, sequence) values ('${c.courseId}', 'MX', 'Direct', 1)`,
  ]) {
    const r = await as(ids.A).execute(sql);
    assert.equal(r.error?.code, "42501", sql);
  }
  assert.equal((await row(c.courseId)).title, (await row(c.courseId)).title);
  assert.deepEqual(await modules(c.courseId), []);
});

// ---- duplicates ----
test("duplicates: a non-archived course with the same title (any case/spacing) is reused, not re-created", async () => {
  const title = uniq("Process Safety");
  const first = await create({ title });
  const dup = await admin().createCourse(course({ title: `  ${title.toUpperCase().replace(" ", "   ")} ` }));
  assert.equal(dup.ok, false);
  assert.match(dup.error, new RegExp(`already exists \\(${first.courseCode}\\)`));
  assert.equal(dup.errors.title, dup.error);
  // Archived courses don't block a new version with the same title …
  assert.equal((await admin().setCourseStatus(first.courseId, "archived")).ok, true);
  const second = await create({ title });
  // … but the archived one can't come back while the new one is active.
  const back = await admin().setCourseStatus(first.courseId, "published");
  assert.equal(back.ok, false);
  assert.match(back.error, new RegExp(second.courseCode));
  // Renaming onto another active course's title is refused too.
  const other = await create();
  const rename = await admin().updateCourse(other.courseId, { title, description: "", level: "foundation", durationHours: 40 });
  assert.equal(rename.ok, false);
  assert.match(rename.error, /already exists/);
});

// ---- editing ----
test("edit: details saved and audited with the previous values; the code is untouched; no-op refused", async () => {
  const c = await create({ status: "draft" });
  const title = uniq("Renamed");
  const r = await admin().updateCourse(c.courseId, { title, description: "New plan.", level: "intermediate", durationHours: 48 });
  assert.deepEqual(r, { ok: true, message: "Course details saved." });
  const stored = await row(c.courseId);
  assert.deepEqual([stored.code, stored.title, stored.description, stored.level, stored.hours], [c.courseCode, title, "New plan.", "intermediate", 48]);
  const ev = await db.admin(`select detail from public.course_events where course_id = '${c.courseId}' and event_type = 'course_updated'`);
  assert.deepEqual(ev.fields.sort(), ["description", "duration_hours", "level", "title"]);
  assert.deepEqual(ev.before.level, "foundation");
  assert.equal("description" in ev.before, false, "description text is not copied into the log");
  assert.equal((await admin().updateCourse(c.courseId, { title, description: "New plan.", level: "intermediate", durationHours: 48 })).error, "Nothing changed.");
});

// ---- modules ----
test("modules: generated codes and positions, edit, reorder, delete with renumbering; all audited", async () => {
  const c = await create();
  const svc = admin();
  for (const t of ["Basics", "Loops", "Tuning"]) assert.equal((await svc.createModule(c.courseId, { title: t, description: "", durationHours: 4 })).ok, true);
  assert.deepEqual(await modules(c.courseId), [
    { code: "M01", title: "Basics", seq: 1 },
    { code: "M02", title: "Loops", seq: 2 },
    { code: "M03", title: "Tuning", seq: 3 },
  ]);
  const id = (code) => db.admin(`select id from public.modules where course_id = '${c.courseId}' and module_code = '${code}'`);
  assert.equal((await svc.updateModule(await id("M02"), { title: "Control loops", description: "PID", durationHours: 6 })).ok, true);
  assert.equal((await svc.moveModule(await id("M03"), "up")).ok, true);
  assert.equal((await svc.moveModule(await id("M01"), "up")).error, "Nothing changed.", "already first");
  assert.deepEqual((await modules(c.courseId)).map((m) => `${m.seq}:${m.code}`), ["1:M01", "2:M03", "3:M02"]);
  assert.equal((await svc.deleteModule(await id("M01"))).ok, true);
  assert.deepEqual((await modules(c.courseId)).map((m) => `${m.seq}:${m.code}`), ["1:M03", "2:M02"], "later modules move up");
  assert.equal((await svc.createModule(c.courseId, { title: "Extra", description: "", durationHours: 1 })).message, "Module M04 added.", "codes are never reused");
  assert.deepEqual((await events(c.courseId)).map((e) => e.type), [
    "course_created", "module_created", "module_created", "module_created", "module_updated", "module_moved", "module_deleted", "module_created",
  ]);
  // The seed course's legacy codes (M1, M2) are respected: the next one is M03.
  const seedNext = await db.admin(`select public.course_mgmt_next_module_code('${ids.C1}')`);
  assert.equal(seedNext, "M03");
});

test("a module used by a class or a question is never deleted (classes would otherwise lose it silently)", async () => {
  const c = await create();
  await admin().createModule(c.courseId, { title: "Used", description: "", durationHours: 1 });
  const mid = await db.admin(`select id from public.modules where course_id = '${c.courseId}'`);
  const bid = await db.admin(`select gen_random_uuid()`);
  // Fixture rows only (as the other suites do): replica role skips unrelated scheduling triggers; FKs still apply.
  await db.exec(`set session_replication_role = replica;
                 insert into public.batches (id, batch_code, course_id, name, start_date, end_date, status, max_seats)
                   values ('${bid}', ${sqlLit(uniq("CMU").replace(/\s/g, "-"))}, '${c.courseId}', 'x', '2027-01-01', '2027-02-01', 'upcoming', 5);
                 insert into public.classes (course_id, batch_id, module_id, trainer_id, title, class_date, start_time, end_time, status)
                   values ('${c.courseId}', '${bid}', '${mid}', '${W.cm_T}', 'Planned', '2027-01-10', '09:00', '10:00', 'scheduled');
                 set session_replication_role = origin;`);
  const r = await admin().deleteModule(mid);
  assert.equal(r.ok, false);
  assert.match(r.error, /used by classes or questions/);
  assert.equal(await db.admin(`select count(*) from public.modules where id = '${mid}'`), 1);
});

// ---- historical protection ----
test("history lock: once a batch is ongoing/completed, title / level / duration and modules are locked; description and status stay editable", async () => {
  for (const status of ["ongoing", "completed"]) {
    const c = await create();
    await admin().createModule(c.courseId, { title: "Fixed", description: "", durationHours: 2 });
    const mid = await db.admin(`select id from public.modules where course_id = '${c.courseId}'`);
    await historyBatch(c.courseId, status);
    const svc = admin();
    const before = await row(c.courseId);
    for (const change of [{ title: uniq("Changed") }, { level: "advanced" }, { durationHours: 99 }]) {
      const r = await svc.updateCourse(c.courseId, { title: before.title, description: before.description, level: before.level, durationHours: before.hours, ...change });
      assert.equal(r.ok, false, `${status} ${JSON.stringify(change)}`);
      assert.match(r.error, /locked to protect batch history/);
    }
    assert.deepEqual(await row(c.courseId), before, "nothing changed");
    for (const r of [
      await svc.createModule(c.courseId, { title: "New", description: "", durationHours: 1 }),
      await svc.updateModule(mid, { title: "Renamed", description: "", durationHours: 2 }),
      await svc.moveModule(mid, "down"),
      await svc.deleteModule(mid),
    ]) {
      if (r.error !== "Nothing changed.") assert.match(r.error, /locked/, JSON.stringify(r));
    }
    assert.deepEqual((await modules(c.courseId)).map((m) => m.title), ["Fixed"]);
    // Still allowed (audited): the description, and archiving.
    assert.equal((await svc.updateCourse(c.courseId, { title: before.title, description: "Clarified.", level: before.level, durationHours: before.hours })).ok, true);
    assert.equal((await svc.setCourseStatus(c.courseId, "archived")).ok, true);
  }
  // An upcoming batch is not history yet: planning changes are allowed.
  const planned = await create();
  await historyBatch(planned.courseId, "upcoming");
  assert.equal((await admin().updateCourse(planned.courseId, { title: uniq("Replanned"), description: "", level: "foundation", durationHours: 30 })).ok, true);
  assert.equal((await admin().createModule(planned.courseId, { title: "Added", description: "", durationHours: 1 })).ok, true);
});

// ---- archive / delete / batches ----
test("archive vs delete: a used course is archived (never deleted); an unused one can be deleted with its audit kept", async () => {
  const used = await create();
  const b = await clientBatch(used.courseId);
  assert.equal(b.error, null, JSON.stringify(b.error));
  const del = await admin().deleteCourse(used.courseId);
  assert.equal(del.ok, false);
  assert.match(del.error, /Only a draft course can be deleted. Active and inactive courses are kept permanently/);
  assert.match((await admin().setCourseStatus(used.courseId, "draft")).error, /can't go back to Draft/);
  assert.equal((await admin().setCourseStatus(used.courseId, "archived")).ok, true);
  assert.equal(await db.admin(`select count(*) from public.batches where course_id = '${used.courseId}'`), 1, "the batch is untouched");

  const unused = await create({ status: "draft" });
  await admin().createModule(unused.courseId, { title: "Gone", description: "", durationHours: 1 });
  const usage = await repoAs(ids.A).getUsage(unused.courseId);
  assert.deepEqual([usage.canDelete, usage.hasHistory, usage.batchCount], [true, false, 0]);
  assert.equal((await admin().deleteCourse(unused.courseId)).ok, true);
  assert.equal(await db.admin(`select count(*) from public.courses where id = '${unused.courseId}'`), 0);
  assert.equal(await db.admin(`select count(*) from public.modules where course_id = '${unused.courseId}'`), 0);
  assert.deepEqual((await events(unused.courseId)).map((e) => e.type), ["course_created", "module_created", "course_deleted"], "history survives");
});

test("batches select an existing PUBLISHED course; archived / draft courses can't get new batches; a batch's course never changes", async () => {
  const c = await create({ status: "draft" });
  for (const status of ["draft", "archived"]) {
    if (status === "archived") await admin().setCourseStatus(c.courseId, "archived");
    const r = await clientBatch(c.courseId);
    assert.equal(r.error?.code, "23514", status);
    assert.equal(classifyBatchInsertError(r.error), "rejected", "the stand-in client carries no hint; the app maps hint course_not_published (unit-tested)");
    const raw = await db.run(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${ids.A}"}', false);
      insert into public.batches (batch_code, course_id, name, start_date, end_date, max_seats) values ('${uniq("H").replace(/\s/g, "-")}', '${c.courseId}', 'x', '2027-01-01', '2027-01-02', 1);`);
    assert.match(raw.stderr, /HINT:\s+course_not_published/, "the refusal carries the hint the app maps");
  }
  assert.equal((await admin().setCourseStatus(c.courseId, "published")).ok, true);
  const ok = await clientBatch(c.courseId);
  assert.equal(ok.error, null);
  // Two batches of the same course: each owns its own dates and trainer; the course is shared, not copied.
  const ok2 = await clientBatch(c.courseId);
  assert.equal(ok2.error, null);
  assert.equal(await db.admin(`select count(*) from public.courses where title = (select title from public.courses where id = '${c.courseId}')`), 1);
  const usage = await repoAs(ids.A).getUsage(c.courseId);
  assert.equal(usage.batchCount, 2);
  assert.deepEqual(usage.batches.map((b) => b.id).sort(), [ok.data.id, ok2.data.id].sort());
  // Moving a batch to another course is refused for every writer (its records belong to this course).
  const other = await create();
  assert.equal((await as(ids.A).execute(`update public.batches set course_id = '${other.courseId}' where id = '${ok.data.id}'`)).error?.code, "23514");
  await assert.rejects(db.exec(`update public.batches set course_id = '${other.courseId}' where id = '${ok.data.id}'`), /course cannot be changed/);
  // Archiving later leaves the existing batches alone.
  assert.equal((await admin().setCourseStatus(c.courseId, "archived")).ok, true);
  assert.equal(await db.admin(`select count(*) from public.batches where course_id = '${c.courseId}'`), 2);
});

test("issued certificates keep their own course code/title copy (0011) — unaffected by later course edits", async () => {
  const cert = await db.admin(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'certificates' and column_name in ('course_code', 'course_title')`);
  assert.equal(cert, 2);
});

// ---- permissions and audit ----
test("trainers, students and suspended Super Admins are refused by every function; the service refuses them first", async () => {
  const c = await create();
  const mid = (await admin().createModule(c.courseId, { title: "P", description: "", durationHours: 1 })) && (await db.admin(`select id from public.modules where course_id = '${c.courseId}'`));
  const calls = [
    ["admin_create_course", { p: { title: uniq("X"), level: "foundation", duration_hours: 1 } }],
    ["admin_update_course", { p_course_id: c.courseId, p: { title: "X" } }],
    ["admin_set_course_status", { p_course_id: c.courseId, p_status: "archived" }],
    ["admin_delete_course", { p_course_id: c.courseId }],
    ["admin_create_module", { p_course_id: c.courseId, p: { title: "X" } }],
    ["admin_update_module", { p_module_id: mid, p: { title: "X" } }],
    ["admin_move_module", { p_module_id: mid, p_direction: "up" }],
    ["admin_delete_module", { p_module_id: mid }],
    ["admin_course_usage", { p_course_id: c.courseId }],
  ];
  const before = await row(c.courseId);
  for (const uid of [W.cm_T, W.cm_S, W.cm_SA_SUS]) {
    for (const [fn, args] of calls) assert.equal((await as(uid).rpc(fn, args)).error?.code, "42501", `${uid} ${fn}`);
    assert.equal((await as(uid).from("course_events").select("id").eq("course_id", c.courseId)).data?.length ?? 0, 0, "audit is Super Admin only");
  }
  const anon = await db.client({ role: "anon" }).rpc("admin_create_course", { p: { title: "X", level: "foundation", duration_hours: 1 } });
  assert.ok(anon.error, "anonymous callers cannot execute");
  for (const [uid, role] of [[W.cm_T, "trainer"], [W.cm_S, "student"]]) {
    const r = await svcAs(uid, role).updateCourse(c.courseId, { title: "Hacked", description: "", level: "foundation", durationHours: 1 });
    assert.deepEqual(r, { ok: false, error: "Only a Super Admin can manage courses." });
  }
  // A suspended Super Admin whose session were still believed active is refused by the database.
  const stale = await svcAs(W.cm_SA_SUS).updateCourse(c.courseId, { title: "Hacked", description: "", level: "foundation", durationHours: 1 });
  assert.deepEqual(stale, { ok: false, error: "Only a Super Admin can manage courses." });
  assert.deepEqual(await row(c.courseId), before);
});

test("course_events is append-only and stamped by the database", async () => {
  const c = await create();
  const id = await db.admin(`select id from public.course_events where course_id = '${c.courseId}' limit 1`);
  await assert.rejects(db.exec(`update public.course_events set event_type = 'course_deleted' where id = ${id}`), /append-only/);
  await assert.rejects(db.exec(`delete from public.course_events where id = ${id}`), /append-only/);
  const direct = await as(ids.A).execute(`insert into public.course_events (event_type, course_id) values ('course_created', '${c.courseId}')`);
  assert.equal(direct.error?.code, "42501", "clients cannot write audit rows");
  const m = await admin().getManagement(c.courseId);
  assert.deepEqual(m.history.map((h) => [h.actor, h.summary]), [["you", `Course created as published (${c.courseCode}).`]]);
});

// ---- review fixes (history sources, legacy data, question-referenced modules) ----

/** A fresh published course with modules and an UPCOMING batch (the status the app never changes). */
async function courseWithUpcomingBatch(moduleTitles = ["Taught", "Spare"]) {
  const c = await create();
  for (const t of moduleTitles) await admin().createModule(c.courseId, { title: t, description: "", durationHours: 1 });
  const mids = await db.admin(`select coalesce(json_agg(id order by sequence), '[]') from public.modules where course_id = '${c.courseId}'`);
  const bid = await db.admin("select gen_random_uuid()");
  // Fixture rows (replica role skips unrelated triggers, as the other suites do).
  await db.exec(`set session_replication_role = replica;
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats)
      values ('${bid}', ${sqlLit(uniq("CMR").replace(/\s/g, "-"))}, '${c.courseId}', '${W.cm_T}', 'held', '2026-01-01', '2027-12-31', 'upcoming', 5);
    insert into public.batch_students (batch_id, student_id) values ('${bid}', '${W.cm_S}');
    set session_replication_role = origin;`);
  return { ...c, mids, bid };
}
const addClass = async (c, { date, status, module = null }) => {
  const id = await db.admin("select gen_random_uuid()");
  await db.exec(`set session_replication_role = replica;
    insert into public.classes (id, course_id, batch_id, module_id, trainer_id, title, class_date, start_time, end_time, status)
      values ('${id}', '${c.courseId}', '${c.bid}', ${module ? `'${module}'` : "null"}, '${W.cm_T}', 'class', '${date}', '09:00', '10:00', '${status}');
    set session_replication_role = origin;`);
  return id;
};
const locked = async (c) => (await repoAs(ids.A).getUsage(c.courseId)).hasHistory;

test("REGRESSION (review bug 1): upcoming batch + scheduled class + recorded attendance locks title, level, duration and modules", async () => {
  const c = await courseWithUpcomingBatch();
  // A FUTURE scheduled class, so only the attendance row is history.
  const cls = await addClass(c, { date: "2027-06-01", status: "scheduled", module: c.mids[0] });
  assert.equal(await locked(c), false, "no history before attendance");
  await db.exec(`set session_replication_role = replica;
    insert into public.class_attendance (class_id, student_id, batch_id, status, marked_by) values ('${cls}', '${W.cm_S}', '${c.bid}', 'present', '${W.cm_T}');
    set session_replication_role = origin;`);
  assert.equal(await locked(c), true, "attendance is delivered training");

  const svc = admin();
  const before = await row(c.courseId);
  const modsBefore = await modules(c.courseId);
  for (const change of [{ title: uniq("Rewritten") }, { level: "advanced" }, { durationHours: 999 }]) {
    const r = await svc.updateCourse(c.courseId, change);
    assert.equal(r.ok, false, JSON.stringify(change));
    assert.match(r.error, /locked to protect batch history/);
  }
  for (const r of [
    await svc.createModule(c.courseId, { title: "Added after teaching", description: "", durationHours: 1 }),
    await svc.updateModule(c.mids[0], { title: "Renamed", description: "", durationHours: 1 }),
    await svc.moveModule(c.mids[1], "up"),
    await svc.deleteModule(c.mids[1]),
  ]) {
    assert.equal(r.ok, false);
    assert.match(r.error, /locked/);
  }
  assert.deepEqual(await row(c.courseId), before, "course unchanged");
  assert.deepEqual(await modules(c.courseId), modsBefore, "modules unchanged");
  // Still allowed: the description (audited).
  assert.equal((await svc.updateCourse(c.courseId, { description: "Clarified after delivery." })).ok, true);
});

test("history sources: a past non-cancelled class, a test attempt and a completion record each lock; a cancelled past class doesn't", async () => {
  const past = await courseWithUpcomingBatch(["One"]);
  await addClass(past, { date: "2025-01-10", status: "cancelled" });
  assert.equal(await locked(past), false, "a cancelled class is not history");
  await addClass(past, { date: "2025-01-11", status: "scheduled" });
  assert.equal(await locked(past), true, "a past class left 'scheduled' is history");

  const attempt = await courseWithUpcomingBatch(["One"]);
  const cls = await addClass(attempt, { date: "2027-06-01", status: "scheduled" });
  const tid = await db.admin("select gen_random_uuid()");
  await db.exec(`set session_replication_role = replica;
    insert into public.tests (id, class_id, batch_id, test_type, title, created_by, updated_by) values ('${tid}', '${cls}', '${attempt.bid}', 'quiz', 'Quiz', '${ids.A}', '${ids.A}');
    set session_replication_role = origin;`);
  assert.equal(await locked(attempt), false, "a test alone is planning, not history");
  await db.exec(`set session_replication_role = replica;
    insert into public.test_attempts (test_id, batch_id, student_id, attempt_number, deadline_at) values ('${tid}', '${attempt.bid}', '${W.cm_S}', 1, now() + interval '1 hour');
    set session_replication_role = origin;`);
  assert.equal(await locked(attempt), true, "a test attempt is history");

  const done = await courseWithUpcomingBatch(["One"]);
  await db.exec(`set session_replication_role = replica;
    insert into public.completion_records (batch_id, student_id, recommended_by, eligibility_at_recommendation) values ('${done.bid}', '${W.cm_S}', '${ids.A}', '{}');
    set session_replication_role = origin;`);
  assert.equal(await locked(done), true, "a completion record is history");

  // Assignment submissions and certificates (heavily constrained rows) are checked in the function definition.
  const def = await db.admin("select pg_get_functiondef('public.course_mgmt_has_history(uuid)'::regprocedure)");
  for (const table of ["class_attendance", "test_attempts", "assignment_submissions", "completion_records", "certificates"]) {
    assert.match(def, new RegExp(`public\\.${table} x where x\\.batch_id = b\\.id`), table);
  }
});

test("legacy title longer than 150 characters: other fields stay editable; a new over-long title is refused", async () => {
  const id = await db.admin("select gen_random_uuid()");
  const legacy = "L".repeat(160);
  await db.exec(`insert into public.courses (id, title, level, status) values ('${id}', '${legacy}', 'foundation', 'published');`);
  // The form sends only what changed: the description alone.
  assert.deepEqual(await admin().updateCourse(id, { description: "Only the description." }), { ok: true, message: "Course details saved." });
  assert.equal((await row(id)).title, legacy, "the legacy title is kept");
  // A caller that re-sends the unchanged title is not blocked either (the database compares and keeps it).
  const same = await as(ids.A).rpc("admin_update_course", { p_course_id: id, p: { title: legacy, duration_hours: 12 } });
  assert.deepEqual(same.data, { ok: true, fields: ["duration_hours"] });
  // A NEW title still gets the full checks, in the service and in the database.
  const longer = "N".repeat(151);
  const r = await admin().updateCourse(id, { title: longer });
  assert.equal(r.ok, false);
  assert.match(r.errors.title, /150 characters or fewer/);
  assert.equal((await as(ids.A).rpc("admin_update_course", { p_course_id: id, p: { title: longer } })).error?.code, "22023");
  assert.equal((await row(id)).title, legacy);
});

test("module descriptions: empty and missing are the same, so no false change and no false audit event", async () => {
  const c = await create();
  const legacyMid = await db.admin("select gen_random_uuid()");
  await db.exec(`insert into public.modules (id, course_id, title, description, sequence) values ('${legacyMid}', '${c.courseId}', 'Legacy', '', 1);`);
  await admin().createModule(c.courseId, { title: "New", description: "", durationHours: 1 });
  const newMid = await db.admin(`select id from public.modules where course_id = '${c.courseId}' and title = 'New'`);
  assert.equal(await db.admin(`select description from public.modules where id = '${newMid}'`), null, "stored as missing");
  const eventsBefore = await db.admin(`select count(*) from public.course_events where course_id = '${c.courseId}' and event_type = 'module_updated'`);
  for (const [mid, title] of [[legacyMid, "Legacy"], [newMid, "New"]]) {
    assert.equal((await admin().updateModule(mid, { title, description: "" })).error, "Nothing changed.", title);
    assert.equal((await admin().updateModule(mid, { title, description: "   " })).error, "Nothing changed.", `${title} (blank)`);
  }
  assert.equal(await db.admin(`select count(*) from public.course_events where course_id = '${c.courseId}' and event_type = 'module_updated'`), eventsBefore);
  assert.equal(await db.admin(`select description from public.modules where id = '${legacyMid}'`), "", "legacy row not rewritten");
  // A real change is still saved and audited — even though the legacy module has 0 hours (unchanged hours are not
  // sent, so not re-validated).
  assert.equal((await admin().updateModule(legacyMid, { title: "Legacy", description: "Now described." })).ok, true);
});

test("a module referenced by a question cannot be deleted (the question bank keeps its module)", async () => {
  const c = await create();
  await admin().createModule(c.courseId, { title: "Asked", description: "", durationHours: 1 });
  const mid = await db.admin(`select id from public.modules where course_id = '${c.courseId}'`);
  await db.exec(`select t.as_('A');
    select public.save_question(t.p('${c.courseId}', 'single_choice', 1, t.opts('Yes*', 'No'), 'Is this module asked about?') || jsonb_build_object('module_id', '${mid}'));`);
  assert.equal(await db.admin(`select count(*) from public.questions where module_id = '${mid}'`), 1, "fixture: the question uses the module");
  const r = await admin().deleteModule(mid);
  assert.equal(r.ok, false);
  assert.match(r.error, /used by classes or questions/);
  assert.equal(await db.admin(`select count(*) from public.modules where id = '${mid}'`), 1);
  assert.equal((await repoAs(ids.A).getUsage(c.courseId)).canDelete, false, "the course itself cannot be deleted either");
});

test("approved lifecycle: only a never-published, unused DRAFT can be deleted; Active, Inactive and once-published courses are kept", async () => {
  const svc = admin();
  const usage = (id) => repoAs(ids.A).getUsage(id);
  const exists = (id) => db.admin(`select count(*) from public.courses where id = '${id}'`);

  // Active (published), unused → refused, not offered.
  const active = await create({ status: "published" });
  assert.equal((await usage(active.courseId)).canDelete, false);
  const a = await svc.deleteCourse(active.courseId);
  assert.equal(a.ok, false);
  assert.match(a.error, /Only a draft course can be deleted\. Active and inactive courses are kept permanently/);
  assert.equal(await exists(active.courseId), 1);

  // Inactive (archived), unused → refused.
  assert.equal((await svc.setCourseStatus(active.courseId, "archived")).ok, true);
  assert.match((await svc.deleteCourse(active.courseId)).error, /Only a draft course can be deleted/);
  // Reactivation says so.
  assert.equal((await svc.setCourseStatus(active.courseId, "published")).message, "Course reactivated. It is active again and can be used for new batches.");

  // Created as Active, moved back to Draft (no batches) → still kept: it was published before.
  assert.equal((await svc.setCourseStatus(active.courseId, "draft")).ok, true);
  assert.equal((await usage(active.courseId)).canDelete, false);
  assert.match((await svc.deleteCourse(active.courseId)).error, /has been published before, so it is kept permanently/);
  // Created as Draft, published, then back to Draft → kept as well.
  const once = await create({ status: "draft" });
  await svc.setCourseStatus(once.courseId, "published");
  await svc.setCourseStatus(once.courseId, "draft");
  assert.match((await svc.deleteCourse(once.courseId)).error, /has been published before/);
  assert.equal(await exists(once.courseId), 1);

  // Never-published, unused Draft → offered and deleted (audited).
  const fresh = await create({ status: "draft" });
  assert.equal((await usage(fresh.courseId)).canDelete, true);
  assert.equal((await svc.deleteCourse(fresh.courseId)).ok, true);
  assert.equal(await exists(fresh.courseId), 0);
  assert.deepEqual((await events(fresh.courseId)).map((e) => e.type), ["course_created", "course_deleted"]);

  // The rule is in the database: a direct call gets the same refusal codes.
  assert.deepEqual((await as(ids.A).rpc("admin_delete_course", { p_course_id: once.courseId })).data, { ok: false, reason: "was_published" });
  const act2 = await create({ status: "published" });
  assert.deepEqual((await as(ids.A).rpc("admin_delete_course", { p_course_id: act2.courseId })).data, { ok: false, reason: "not_draft" });
});
