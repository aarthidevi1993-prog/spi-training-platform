// Phase 7 P3.11-B — Remove student / trainer (pure + fake-repository tests).
// Remove = deactivate through admin_set_account_status (active → suspended); nothing is deleted. The target's
// role is read from the database and must match the list; a trainer with current work is refused before any
// change; only the account id comes from the browser; refusals become fixed sentences.
import { test } from "node:test";
import assert from "node:assert/strict";

const build = process.env.UM_BUILD;
if (!build) throw new Error("Run through tests/user-management/run.mjs");
const L = await import(`${build}/lib/user-management/lifecycle.mjs`);
const { createUsersService, UsersAuthorizationError, UsersActionError } = await import(`${build}/services/users.service.core.mjs`);
const { UsersFunctionError } = await import(`${build}/repositories/users.repository.core.mjs`);

const ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN = { id: ADMIN_ID, email: "a@test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" };
const profile = (role, account_status = "active") => ({
  id: ID, role, account_status, account_status_changed_at: "2026-09-01", created_at: "2026-08-01", updated_at: "2026-09-01", students: null, trainers: null,
});

function service({ user = ADMIN, role = "student", status = "active", counts = { batches: 0, classes: 0 }, setAccountStatus, demo = false } = {}) {
  const calls = [];
  const repository = {
    getProfile: async (id) => (calls.push(["getProfile", id]), role === null ? null : profile(role, status)),
    countTrainerAssignments: async (id) => (calls.push(["countTrainerAssignments", id]), counts),
    setAccountStatus: async (...a) => (calls.push(["setAccountStatus", ...a]), setAccountStatus ? setAccountStatus(...a) : { ok: true, reason: null }),
  };
  return { calls, svc: createUsersService({ repository, getCurrentUser: async () => user, isDemoMode: () => demo }) };
}

test("only an active Super Admin may remove; refused before any request", async () => {
  for (const user of [null, { ...ADMIN, role: "trainer" }, { ...ADMIN, role: "student" }]) {
    const { svc, calls } = service({ user });
    await assert.rejects(svc.removeStudent(ID), UsersAuthorizationError);
    await assert.rejects(svc.removeTrainer(ID), UsersAuthorizationError);
    assert.deepEqual(calls, [], `${user?.role ?? "signed out"}: nothing reached the repository`);
  }
});

test("bad ids, your own account and demo mode are refused before any request", async () => {
  for (const id of ["not-a-uuid", "", null, 42]) {
    const { svc, calls } = service();
    await assert.rejects(svc.removeStudent(id), UsersActionError);
    assert.deepEqual(calls, []);
  }
  const self = service();
  await assert.rejects(svc_(self).removeTrainer(ADMIN_ID), /You can't remove your own account\./);
  assert.deepEqual(self.calls, []);
  const demo = service({ demo: true });
  await assert.rejects(demo.svc.removeStudent(ID), /demo mode/);
  assert.deepEqual(demo.calls, []);
});
const svc_ = (s) => s.svc;

test("the target's role comes from the database and must match the list; unknown accounts are refused", async () => {
  const asTrainer = service({ role: "trainer" });
  await assert.rejects(asTrainer.svc.removeStudent(ID), /This account is not a student, so it can't be removed from this list\./);
  const asAdmin = service({ role: "super_admin" });
  await assert.rejects(asAdmin.svc.removeTrainer(ID), /This account is not a trainer/);
  const asStudent = service({ role: "student" });
  await assert.rejects(asStudent.svc.removeTrainer(ID), /This account is not a trainer/);
  const gone = service({ role: null });
  await assert.rejects(gone.svc.removeStudent(ID), /That account no longer exists\./);
  for (const s of [asTrainer, asAdmin, asStudent, gone]) assert.ok(!s.calls.some((c) => c[0] === "setAccountStatus"), "no change attempted");
});

test("student: deactivates through admin_set_account_status (suspended) with the audit reason; never a deletion", async () => {
  const { svc, calls } = service({ role: "student" });
  const message = await svc.removeStudent(ID);
  assert.match(message, /Student removed\. Their account is deactivated and they can no longer sign in; their training records are kept\./);
  assert.deepEqual(calls, [["getProfile", ID], ["setAccountStatus", ID, "suspended", "Removed from the Students list"]]);
});

test("trainer: current batches or scheduled/live classes block the removal before any change", async () => {
  for (const [counts, expect] of [
    [{ batches: 2, classes: 0 }, /2 current batches \(upcoming or ongoing\)/],
    [{ batches: 0, classes: 1 }, /1 scheduled or live class\b/],
    [{ batches: 1, classes: 3 }, /1 current batch \(upcoming or ongoing\) and 3 scheduled or live classes/],
  ]) {
    const { svc, calls } = service({ role: "trainer", counts });
    await assert.rejects(svc.removeTrainer(ID), (err) => err instanceof UsersActionError && expect.test(err.message) && /Reassign each current batch/.test(err.message));
    assert.deepEqual(calls, [["getProfile", ID], ["countTrainerAssignments", ID]], "no status change");
  }
  const clear = service({ role: "trainer" });
  assert.match(await clear.svc.removeTrainer(ID), /Trainer removed\./);
  assert.deepEqual(clear.calls.at(-1), ["setAccountStatus", ID, "suspended", "Removed from the Trainers list"]);
});

test("database refusals become fixed sentences; raised errors map by SQLSTATE only", async () => {
  for (const [reason, expect] of [
    ["unchanged", /already been removed/],
    ["transition_not_allowed", /hasn't accepted its invitation yet/],
    ["cannot_change_self", /You can't remove your own account\./],
    ["last_super_admin", /last active Super Admin/],
    ["not_found", /no longer exists/],
    ["something_new", /could not be made|try again/i],
  ]) {
    const { svc } = service({ setAccountStatus: async () => ({ ok: false, reason }) });
    await assert.rejects(svc.removeStudent(ID), (err) => err instanceof UsersActionError && expect.test(err.message), reason);
  }
  const raised = service({ setAccountStatus: async () => { throw new UsersFunctionError("42501"); } });
  await assert.rejects(raised.svc.removeStudent(ID), (err) => err instanceof UsersActionError && !/42501|permission denied for/.test(err.message));
});

test("trainer assignment message: null when nothing is current; singular / plural wording", () => {
  assert.equal(L.trainerAssignmentsMessage({ batches: 0, classes: 0 }), null);
  assert.match(L.trainerAssignmentsMessage({ batches: 1, classes: 0 }), /1 current batch \(/);
  assert.match(L.trainerAssignmentsMessage({ batches: 0, classes: 2 }), /2 scheduled or live classes/);
  assert.deepEqual(L.REMOVE_AUDIT_REASON, { student: "Removed from the Students list", trainer: "Removed from the Trainers list" });
});
