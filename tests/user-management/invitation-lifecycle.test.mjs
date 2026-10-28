// Phase 7 P3.9 — existing invitation lifecycle (resend + revoke from the Users panel): pure tests for the
// invitation summary mapping, the users-service read path, the invitations service's revoke, the revoke
// server action (with a fake service and next/cache), and source boundaries for the new code paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const build = process.env.UM_BUILD;
if (!build) throw new Error("Run through tests/user-management/run.mjs");
const L = await import(`${build}/lib/user-management/lifecycle.mjs`);
const I = await import(`${build}/lib/user-management/invitations.mjs`);
const { createUsersService } = await import(`${build}/services/users.service.core.mjs`);
const { InvitationsFunctionError, InvitationsRepositoryError } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createInvitationsService, InvitationsAuthorizationError, InvitationsInputError } = await import(`${build}/services/invitations.service.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const code = (rel) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const INV = "66666666-6666-4666-8666-666666666666";
const ACC = "77777777-7777-4777-8777-777777777777";
const ADMIN = { id: "55555555-5555-4555-8555-555555555555", email: "a@test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" };
const NOW = new Date("2026-10-08T12:00:00Z");
const pendingRow = (o = {}) => ({ id: INV, status: "pending", expires_at: "2026-10-15T12:00:00Z", last_sent_at: "2026-10-08T11:00:00Z", resend_count: 0, ...o });

// ---------------------------------------------------------------- summary mapping
test("mapInvitation: pending → resend + revoke; first send has no cap; at the cap → revoke only; past expiry → expired, no actions", () => {
  assert.deepEqual(L.mapInvitation(pendingRow(), NOW), {
    id: INV, status: "pending", expiresAt: "2026-10-15T12:00:00Z", lastSentAt: "2026-10-08T11:00:00Z", resendCount: 0, canResend: true, canRevoke: true,
  });
  assert.equal(L.mapInvitation(pendingRow({ last_sent_at: null }), NOW).canResend, true, "never sent: a first send is not a resend");
  assert.equal(L.mapInvitation(pendingRow({ resend_count: 4 }), NOW).canResend, true);
  const capped = L.mapInvitation(pendingRow({ resend_count: L.INVITATION_RESEND_LIMIT }), NOW);
  assert.deepEqual({ canResend: capped.canResend, canRevoke: capped.canRevoke }, { canResend: false, canRevoke: true });
  const lapsed = L.mapInvitation(pendingRow({ expires_at: "2026-10-08T11:59:59Z" }), NOW);
  assert.deepEqual({ status: lapsed.status, canResend: lapsed.canResend, canRevoke: lapsed.canRevoke }, { status: "expired", canResend: false, canRevoke: false });
  assert.equal(L.INVITATION_RESEND_LIMIT, 5, "mirrors 0019's begin_invitation_delivery cap");
});

test("mapInvitation: revoked / accepted / expired offer nothing; unknown statuses, bad ids and missing rows map to null (nothing invented)", () => {
  for (const status of ["revoked", "accepted", "expired"]) {
    const m = L.mapInvitation(pendingRow({ status }), NOW);
    assert.deepEqual({ status: m.status, canResend: m.canResend, canRevoke: m.canRevoke }, { status, canResend: false, canRevoke: false }, status);
  }
  assert.equal(L.mapInvitation(null, NOW), null);
  assert.equal(L.mapInvitation(pendingRow({ status: "sent" }), NOW), null);
  assert.equal(L.mapInvitation(pendingRow({ id: "x" }), NOW), null);
  assert.equal(L.mapInvitation(pendingRow({ resend_count: -3 }), NOW).resendCount, 0);
});

test("mapUserDetail: only an invited account carries an invitation; the summary has no address or token fields", () => {
  const record = (account_status) => ({ id: ACC, role: "student", account_status, account_status_changed_at: "2026-10-01", created_at: "2026-10-01", updated_at: "2026-10-01", students: null, trainers: null });
  const invited = L.mapUserDetail(record("invited"), [], ADMIN.id, null, pendingRow(), NOW);
  assert.equal(invited.invitation.status, "pending");
  assert.deepEqual(Object.keys(invited.invitation).sort(), ["canResend", "canRevoke", "expiresAt", "id", "lastSentAt", "resendCount", "status"]);
  for (const s of ["active", "suspended"]) assert.equal(L.mapUserDetail(record(s), [], ADMIN.id, null, pendingRow(), NOW).invitation, null, s);
  assert.equal(L.mapUserDetail(record("invited"), [], ADMIN.id).invitation, null, "no invitation row → no section");
});

test("history wording: a resend shows its count; revoke uses the existing label", () => {
  assert.equal(L.describeEvent("invitation_resent", { resend_count: 2 }), "Invitation resent (resend 2 of 5)");
  assert.equal(L.describeEvent("invitation_resent", {}), "Invitation resent");
  assert.equal(L.describeEvent("invitation_revoked", {}), "Invitation revoked");
});

// ---------------------------------------------------------------- users service read path
function usersHarness(account_status) {
  const calls = [];
  const repository = {
    getProfile: async (id) => (calls.push(["getProfile", id]), { id, role: "student", account_status, account_status_changed_at: "2026-10-01", created_at: "2026-10-01", updated_at: "2026-10-01", students: null, trainers: null }),
    getLatestInvitation: async (id) => (calls.push(["getLatestInvitation", id]), pendingRow()),
    listAuditEvents: async (id, invitationId) => (calls.push(["listAuditEvents", id, invitationId]), []),
    latestStatusChange: async () => null,
  };
  return { calls, svc: createUsersService({ repository, getCurrentUser: async () => ADMIN, now: () => NOW }) };
}

test("users service: the invitation is read only for invited accounts, and its events join the history read", async () => {
  const invited = usersHarness("invited");
  const d = await invited.svc.getUserDetail(ACC);
  assert.equal(d.invitation.id, INV);
  assert.deepEqual(invited.calls.filter((c) => c[0] !== "getProfile"), [["getLatestInvitation", ACC], ["listAuditEvents", ACC, INV]]);
  const active = usersHarness("active");
  assert.equal((await active.svc.getUserDetail(ACC)).invitation, null);
  assert.deepEqual(active.calls.filter((c) => c[0] !== "getProfile"), [["listAuditEvents", ACC, null]], "no invitation read for an active account");
});

// ---------------------------------------------------------------- invitations service: revoke
function revokeHarness(o = {}) {
  const log = [];
  let opened = 0;
  const invitations = {
    revokeInvitation: async (id, reason) => (log.push(["revoke", id, reason]), o.revoke ? o.revoke(id, reason) : { ok: true }),
    createInvitation: async () => assert.fail("not used"),
    beginDelivery: async () => assert.fail("not used"),
  };
  const svc = createInvitationsService({
    invitations,
    authAdmin: { openDelivery: () => (opened++, null) },
    getCurrentUser: async () => (o.user === undefined ? ADMIN : o.user),
    redirectUrl: () => "https://training.example.com/auth/confirm",
    isDemoMode: () => o.demo ?? false,
  });
  return { svc, log, opened: () => opened };
}

test("revoke service: only active Super Admins; trainers, students and signed-out callers are refused before any call", async () => {
  for (const u of [null, { ...ADMIN, role: "trainer" }, { ...ADMIN, role: "student" }]) {
    const h = revokeHarness({ user: u });
    await assert.rejects(h.svc.revokeInvitation(INV, null), InvitationsAuthorizationError);
    assert.deepEqual(h.log, []);
  }
});

test("revoke service: demo mode, bad ids and over-long reasons stop before the database; the reason is trimmed; no service-role client is ever opened", async () => {
  const demo = revokeHarness({ demo: true });
  await assert.rejects(demo.svc.revokeInvitation(INV, null), InvitationsInputError);
  const h = revokeHarness();
  assert.deepEqual(await h.svc.revokeInvitation("not-a-uuid", null), { ok: false, reason: "not_found" });
  await assert.rejects(h.svc.revokeInvitation(INV, "x".repeat(501)), InvitationsInputError);
  assert.deepEqual(h.log, [], "nothing reached the database");
  assert.deepEqual(await h.svc.revokeInvitation(INV, "  wrong person  "), { ok: true });
  assert.deepEqual(await h.svc.revokeInvitation(INV, "   "), { ok: true });
  assert.deepEqual(h.log, [["revoke", INV, "wrong person"], ["revoke", INV, null]]);
  assert.equal(demo.opened() + h.opened(), 0, "revocation never opens the Auth Admin path");
});

test("revoke service: database answers → known refusals; raised 42501/22023 → permission/invalid; unknown codes and other errors are errors", async () => {
  for (const reason of ["not_found", "expired", "not_pending"]) {
    const h = revokeHarness({ revoke: () => ({ ok: false, reason }) });
    assert.deepEqual(await h.svc.revokeInvitation(INV, null), { ok: false, reason });
  }
  for (const [sqlstate, reason] of [["42501", "permission"], ["22023", "invalid"]]) {
    const h = revokeHarness({ revoke: () => { throw new InvitationsFunctionError(sqlstate); } });
    assert.deepEqual(await h.svc.revokeInvitation(INV, null), { ok: false, reason });
  }
  const saved = console.error;
  console.error = () => {};
  try {
    await assert.rejects(revokeHarness({ revoke: () => ({ ok: false, reason: "something_new" }) }).svc.revokeInvitation(INV, null), InvitationsRepositoryError);
    await assert.rejects(revokeHarness({ revoke: () => { throw new InvitationsRepositoryError(); } }).svc.revokeInvitation(INV, null), InvitationsRepositoryError);
  } finally {
    console.error = saved;
  }
});

test("messages: every revoke refusal and the success have a safe sentence; the resend-limit guidance points to revoke", () => {
  for (const reason of ["not_found", "expired", "not_pending", "permission", "invalid"]) {
    assert.ok(I.REVOKE_REASON_MESSAGE[reason]?.length > 10, reason);
    assert.equal(I.asRevokeRefusal(reason), reason);
  }
  assert.equal(I.asRevokeRefusal("cooldown"), null, "delivery reasons are not revoke reasons");
  assert.match(I.REVOKE_SUCCESS_MESSAGE, /can no longer be accepted/);
  assert.match(I.REVOKE_SUCCESS_MESSAGE, /unchanged/);
  assert.match(I.DELIVER_REASON_MESSAGE.resend_limit, /Revoke it/);
  assert.match(I.invitationOutcomeMessage({ kind: "refused", stage: "deliver", reason: "cooldown", invitationId: INV, retryAfterSeconds: 42 }), /about 42 s/);
});

// ---------------------------------------------------------------- server action (fake service, fake next/cache)
async function loadActions() {
  const { createRequire } = await import("node:module");
  const os = await import("node:os");
  const ts = createRequire(path.join(root, "package.json"))("typescript");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-lifecycle-actions-"));
  fs.writeFileSync(path.join(dir, "next-cache.mjs"), "export const calls = []; export function revalidatePath(p) { calls.push(p); }\n");
  fs.writeFileSync(
    path.join(dir, "fake-service.mjs"),
    [
      "export class InvitationsAuthorizationError extends Error { constructor(m = \"Only Super Admins can send invitations.\") { super(m); this.name = \"InvitationsAuthorizationError\"; } }",
      "export class InvitationsInputError extends Error { constructor(m) { super(m); this.name = \"InvitationsInputError\"; } }",
      "export const received = [];",
      "export const control = { next: null };",
      "const answer = async (call) => { received.push(call); const n = control.next; if (typeof n === \"function\") return n(call); return n; };",
      "export const invitationsService = { revokeInvitation: (id, reason) => answer({ fn: \"revokeInvitation\", id, reason }), resendInvitation: (id) => answer({ fn: \"resendInvitation\", id }) };",
    ].join("\n")
  );
  const out = ts.transpileModule(src("src/services/invitations.actions.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const rewired = out
    .replace(/from\s+["']next\/cache["']/, `from "${pathToFileURL(path.join(dir, "next-cache.mjs")).href}"`)
    .replace(/from\s+["']\.\/invitations\.service["']/, `from "${pathToFileURL(path.join(dir, "fake-service.mjs")).href}"`)
    .replace(/from\s+["']@\/lib\/user-management\/invitations["']/, `from "${build}/lib/user-management/invitations.mjs"`);
  fs.writeFileSync(path.join(dir, "actions.mjs"), rewired);
  const actions = await import(pathToFileURL(path.join(dir, "actions.mjs")).href);
  const service = await import(pathToFileURL(path.join(dir, "fake-service.mjs")).href);
  const cache = await import(pathToFileURL(path.join(dir, "next-cache.mjs")).href);
  return { actions, service, cache, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("revoke action: only the id and reason are forwarded; safe results; user pages revalidated when the state may have changed; logs name only", async () => {
  const { actions, service, cache, cleanup } = await loadActions();
  const saved = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    service.control.next = { ok: true };
    assert.deepEqual(await actions.revokeInvitationAction(INV, "reason"), { ok: true, message: I.REVOKE_SUCCESS_MESSAGE });
    assert.deepEqual(service.received.at(-1), { fn: "revokeInvitation", id: INV, reason: "reason" });
    assert.deepEqual(cache.calls.splice(0), ["/admin/students", "/admin/trainers", "/admin/users"]);

    await actions.revokeInvitationAction(INV);
    assert.equal(service.received.at(-1).reason, null, "a missing reason becomes null");
    cache.calls.splice(0);

    for (const [reason, revalidates] of [["not_pending", true], ["expired", true], ["not_found", false], ["permission", false]]) {
      service.control.next = { ok: false, reason };
      assert.deepEqual(await actions.revokeInvitationAction(INV, null), { ok: false, error: I.REVOKE_REASON_MESSAGE[reason] }, reason);
      assert.equal(cache.calls.splice(0).length > 0, revalidates, `${reason} revalidation`);
    }

    const { InvitationsAuthorizationError: AuthErr } = service;
    service.control.next = async () => { throw new AuthErr(); };
    assert.deepEqual(await actions.revokeInvitationAction(INV, null), { ok: false, error: "Only Super Admins can send invitations." });
    service.control.next = async () => { const e = new Error("relation user_invitations: secret detail (a@b.test)"); e.code = "XX000"; throw e; };
    assert.deepEqual(await actions.revokeInvitationAction(INV, null), { ok: false, error: I.GENERIC_INVITATION_ERROR });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /secret|a@b\.test|user_invitations/, "the log line carries the error name only");
  } finally {
    console.error = saved;
    cleanup();
  }
});

// ---------------------------------------------------------------- sources
test("sources: the panel calls server actions only, confirms before revoking, and guards against duplicate resends; reads never select an address or token", () => {
  const panel = code("src/components/modules/UserDetailPanel.tsx");
  assert.match(src("src/components/modules/UserDetailPanel.tsx"), /^"use client";/);
  // P5.2 adds recoverInvitationAction (the "Send sign-in link" server action) — still server actions only.
  assert.match(panel, /import \{ recoverInvitationAction, resendInvitationAction, revokeInvitationAction \} from "@\/services\/invitations\.actions";/);
  assert.doesNotMatch(panel, /@\/services\/invitations\.service|@\/repositories\/|@\/lib\/supabase\/|auth\.admin|SUPABASE_SERVICE_ROLE_KEY/);
  // Revoke only from the confirmation dialog.
  assert.match(panel, /title="Revoke this invitation\?"/);
  assert.equal((panel.match(/revokeInvitationAction\(/g) ?? []).length, 1, "one call site, inside the dialog");
  assert.match(panel, /onClick=\{\(\) => setRevokeOpen\(true\)\}/, "the panel button only opens the dialog");
  // Duplicate-submission guard for resend.
  assert.match(panel, /if \(sending\.current \|\| isPending\) return;/);
  assert.match(panel, /sending\.current = true;/);
  assert.match(panel, /finally \{\s*sending\.current = false;/);
  // Buttons only where the summary allows them.
  assert.match(panel, /\{inv\.canResend && \(/);
  assert.match(panel, /\{inv\.canRevoke && \(/);
  assert.match(panel, /\{detail\.invitation && <InvitationSection/);

  const usersRepo = code("src/repositories/users.repository.core.ts");
  assert.match(usersRepo, /export const USER_INVITATION_SELECT = "id, status, expires_at, last_sent_at, resend_count";/);
  // The Super Admin identity fallback adds exactly ONE more fixed list: the name an ACCEPTED invitation was made
  // for and when it was accepted — never the address, a token, a code or Auth data.
  assert.match(usersRepo, /export const USER_IDENTITY_SELECT = "id, accepted_user_id, full_name, accepted_at";/);
  assert.doesNotMatch(usersRepo, /\.from\("user_invitations"\)\.select\((?!USER_INVITATION_SELECT\)|USER_IDENTITY_SELECT\))/, "only the two fixed column lists");
  assert.equal((usersRepo.match(/\.from\("user_invitations"\)\.select\(USER_IDENTITY_SELECT\)\.eq\("status", "accepted"\)/g) ?? []).length, 1, "identities come from accepted invitations only");
  for (const [, name, list] of usersRepo.matchAll(/export const (USER_INVITATION_SELECT|USER_IDENTITY_SELECT) = "([^"]*)"/g)) {
    assert.doesNotMatch(list, /\b(email|email_normalized|auth_user_id|token\w*|student_code|trainer_code|phone|organization|designation)\b|auth\./, `${name} reads no address, token, code, contact or Auth data`);
  }
  assert.doesNotMatch(usersRepo, /\.(insert|update|upsert|delete)\(/, "reads only");
  const service = code("src/services/invitations.service.core.ts");
  assert.doesNotMatch(service, /\.rpc\(|\.from\(|lib\/supabase\//, "the service still only sequences repository calls");
  const revokeBody = service.slice(service.indexOf("async revokeInvitation("));
  assert.doesNotMatch(revokeBody.slice(0, revokeBody.indexOf("return { ok: false, reason: refusal };")), /openSending|openDelivery|authAdmin/, "revoke never touches the service-role path");
  assert.doesNotMatch(src("src/services/invitations.actions.ts"), /deleteUser|\.delete\(/);
});
