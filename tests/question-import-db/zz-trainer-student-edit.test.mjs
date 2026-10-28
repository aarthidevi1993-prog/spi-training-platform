// Phase 7 P3.10-B — trainer student editing: the real students write repository + edit service exactly as
// /trainer/students uses them, against the local database, each caller through their OWN session client
// (never the service role). trainer_update_student (0017) decides scope; the service sends only typed,
// non-blank values, so private fields the trainer cannot read are never erased. Own fixtures only (te_*).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, ids } from "./harness.mjs";

const build = process.env.QI_BUILD;
const { createStudentsWriteRepository } = await import(`${build}/repositories/students.repository.core.mjs`);
const { createTrainerStudentEditService, StudentEditAuthorizationError } = await import(`${build}/services/students.service.core.mjs`);
const E = await import(`${build}/lib/students/trainer-edit.mjs`);

let U = {};
const svcAs = (key, role) =>
  createTrainerStudentEditService({
    repository: createStudentsWriteRepository(async () => db.client({ role: "authenticated", userId: U[key] ?? ids[key] })),
    getCurrentUser: async () => ({ id: U[key] ?? ids[key], email: `${key}@te.test`, fullName: key, role, isActive: true, createdAt: "2026-01-01" }),
  });
const trainer = () => svcAs("te_TR", "trainer");
const details = (k) =>
  db.admin(`select json_build_object('name', s.full_name, 'phone', d.phone, 'org', d.organization, 'des', d.designation)
              from public.students s left join public.student_details d on d.student_id = s.id where s.id = '${U[k]}'`);
const detailEvents = (k) =>
  db.admin(`select coalesce(json_agg(json_build_object('actor', actor_id, 'detail', detail) order by id), '[]'::json)
              from public.user_admin_events where target_user_id = '${U[k]}' and event_type = 'user_details_changed'`);

before(async () => {
  await db.exec(`
    insert into t.ids (k, v) select 'te_' || k, gen_random_uuid()
      from unnest(array['TR','TR2','C','BO','BU','BC','BX','S1','S2','SC','SW','SX']) k;
    insert into auth.users (id, email) select v, lower(k) || '@te.test' from t.ids
     where k in ('te_TR','te_TR2','te_S1','te_S2','te_SC','te_SW','te_SX');
    update public.profiles set account_status = 'active'
     where id in (select v from t.ids where k in ('te_TR','te_TR2','te_S1','te_S2','te_SC','te_SW','te_SX'));
    update public.profiles set role = 'trainer' where id in (t.id('te_TR'), t.id('te_TR2'));
    insert into public.trainers (id, trainer_code, full_name) values (t.id('te_TR'), 'TE-TR', 'TE Trainer'), (t.id('te_TR2'), 'TE-TR2', 'TE Other Trainer');
    insert into public.students (id, student_code, full_name)
      select v, upper(k), 'TE ' || substr(k, 4) from t.ids where k in ('te_S1','te_S2','te_SC','te_SW','te_SX');
    -- Private details the trainer can never read: they must survive every trainer edit that leaves them empty.
    insert into public.student_details (student_id, email, phone, organization, designation)
      select v, lower(k) || '@te.test', '+91 11111', 'Private Org', 'Private Role' from t.ids where k in ('te_S1','te_S2','te_SC','te_SW','te_SX');
    insert into public.courses (id, course_code, title, level) values (t.id('te_C'), 'TE-101', 'Trainer Edit', 'foundation');
    insert into public.batches (id, batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
      (t.id('te_BO'), 'TE-BO', t.id('te_C'), t.id('te_TR'),  'TE ongoing',   '2026-01-01', '2026-12-31', 'ongoing',   10),
      (t.id('te_BU'), 'TE-BU', t.id('te_C'), t.id('te_TR'),  'TE upcoming',  '2027-01-01', '2027-06-30', 'upcoming',  10),
      (t.id('te_BC'), 'TE-BC', t.id('te_C'), t.id('te_TR'),  'TE completed', '2025-01-01', '2025-06-30', 'completed', 10),
      (t.id('te_BX'), 'TE-BX', t.id('te_C'), t.id('te_TR2'), 'TE other',     '2026-01-01', '2026-12-31', 'ongoing',   10);
    -- S1: ongoing (editable). S2: upcoming (editable). SC: only a completed batch. SW: withdrawn from the ongoing
    -- batch. SX: another trainer's student only.
    insert into public.batch_students (batch_id, student_id) values
      (t.id('te_BO'), t.id('te_S1')), (t.id('te_BU'), t.id('te_S2')), (t.id('te_BC'), t.id('te_SC')),
      (t.id('te_BO'), t.id('te_SW')), (t.id('te_BX'), t.id('te_SX'));
    update public.batch_students set enrollment_status = 'withdrawn' where batch_id = t.id('te_BO') and student_id = t.id('te_SW');`, ids.A);
  U = await db.admin("select json_object_agg(k, v) from t.ids");
});

test("edit: the trainer renames an in-scope student and sets one private field; untouched private fields keep their values; audited", async () => {
  const r = await trainer().updateAsTrainer(U.te_S1, { fullName: "TE Student One (edited)", phone: "+91 22222", organization: "", designation: "   " });
  assert.deepEqual(r, { ok: true, message: E.TRAINER_EDIT_MESSAGE.saved });
  assert.deepEqual(await details("te_S1"), { name: "TE Student One (edited)", phone: "+91 22222", org: "Private Org", des: "Private Role" }, "blank fields did not erase existing values");
  const ev = await detailEvents("te_S1");
  assert.deepEqual(ev.at(-1), { actor: U.te_TR, detail: { fields: ["full_name", "phone"] } }, "the trainer is the actor; field names only");
  assert.ok(!JSON.stringify(ev).includes("22222"), "values never enter the audit");
});

test("upcoming batch: also editable; organization/designation replaced only when typed", async () => {
  const r = await trainer().updateAsTrainer(U.te_S2, { fullName: "TE S2", organization: "New Org" });
  assert.deepEqual(r, { ok: true, message: E.TRAINER_EDIT_MESSAGE.saved });
  assert.deepEqual(await details("te_S2"), { name: "TE S2", phone: "+91 11111", org: "New Org", des: "Private Role" });
});

test("nothing changed: same name and empty private fields → answered before the database; no audit row", async () => {
  const before = (await detailEvents("te_S2")).length;
  assert.deepEqual(await trainer().updateAsTrainer(U.te_S2, { fullName: "TE S2", phone: "", organization: "", designation: "" }), { ok: false, error: E.NOTHING_CHANGED });
  assert.equal((await detailEvents("te_S2")).length, before);
  assert.equal((await trainer().updateAsTrainer(U.te_S2, { fullName: "   " })).ok, false, "a blank name is refused");
  assert.equal((await details("te_S2")).name, "TE S2");
});

test("scope: completed-batch-only, withdrawn-only and another trainer's students are refused by the database; nothing changes", async () => {
  // Completed-batch-only: readable (trainer_can_read_student includes completed batches) but not editable —
  // the database refuses (42501 → the scope sentence).
  assert.deepEqual(await trainer().updateAsTrainer(U.te_SC, { fullName: "HACKED" }), { ok: false, error: E.TRAINER_EDIT_MESSAGE.scope });
  // Withdrawn-only: not even readable (RLS covers enrolled / completed only) → "not found" before any update.
  assert.deepEqual(await trainer().updateAsTrainer(U.te_SW, { fullName: "HACKED" }), { ok: false, error: E.TRAINER_EDIT_MESSAGE.notFound });
  // And the database itself refuses a withdrawn-only student when called directly.
  const directW = await db.client({ role: "authenticated", userId: U.te_TR }).rpc("trainer_update_student", { p_student_id: U.te_SW, p: { full_name: "HACKED" } });
  assert.equal(directW.error?.code, "42501");
  for (const k of ["te_SC", "te_SW"]) assert.equal((await details(k)).name, `TE ${k.slice(3)}`, `${k} unchanged`);
  // Another trainer's student is not even readable → "not found" before any update.
  const other = await trainer().updateAsTrainer(U.te_SX, { fullName: "HACKED" });
  assert.deepEqual(other, { ok: false, error: E.TRAINER_EDIT_MESSAGE.notFound });
  // The other trainer cannot edit this trainer's student either (readable? no — refused).
  const cross = await svcAs("te_TR2", "trainer").updateAsTrainer(U.te_S1, { fullName: "HACKED" });
  assert.equal(cross.ok, false);
  assert.equal((await details("te_S1")).name, "TE Student One (edited)");
  assert.equal(await trainer().updateAsTrainer(randomUUID(), { fullName: "X" }).then((r) => r.ok), false, "unknown id");
});

test("callers: students and Super Admins are refused by the service; a student calling the function directly gets 42501", async () => {
  await assert.rejects(svcAs("te_S1", "student").updateAsTrainer(U.te_S1, { fullName: "X" }), StudentEditAuthorizationError);
  await assert.rejects(svcAs("A", "admin").updateAsTrainer(U.te_S1, { fullName: "X" }), StudentEditAuthorizationError);
  const direct = await db.client({ role: "authenticated", userId: U.te_S1 }).rpc("trainer_update_student", { p_student_id: U.te_S1, p: { full_name: "X" } });
  assert.equal(direct.error?.code, "42501");
  // Forbidden keys never reach the database through the service; directly, the database refuses them.
  const forged = await db.client({ role: "authenticated", userId: U.te_TR }).rpc("trainer_update_student", { p_student_id: U.te_S1, p: { email: "x@y.z" } });
  assert.equal(forged.error?.code, "22023");
  // No direct writes: the trainer cannot update the tables themselves.
  const write = await db.client({ role: "authenticated", userId: U.te_TR }).execute(`update public.student_details set phone = 'x' where student_id = '${U.te_S1}'`);
  assert.ok(write.error || (await details("te_S1")).phone === "+91 22222", "direct update has no effect");
  assert.equal((await details("te_S1")).phone, "+91 22222");
});

test("privacy unchanged: the trainer still cannot read the private fields they can write", async () => {
  const own = db.client({ role: "authenticated", userId: U.te_TR });
  const rows = await own.from("student_details").select("student_id, phone").eq("student_id", U.te_S1);
  assert.deepEqual(rows.data, [], "student_details stays Super Admin / self only");
  const name = await own.from("students").select("full_name").eq("id", U.te_S1);
  assert.deepEqual(name.data, [{ full_name: "TE Student One (edited)" }], "the name stays readable");
});

test("Super Admin regression: admin_update_student still works on the same student (Users panel path)", async () => {
  const sa = db.client({ role: "authenticated", userId: ids.A });
  const r = await sa.rpc("admin_update_student", { p_student_id: U.te_S1, p: { designation: "Admin Set" } });
  assert.deepEqual(r.data, { ok: true, fields: ["designation"] });
  assert.equal((await details("te_S1")).des, "Admin Set");
});
