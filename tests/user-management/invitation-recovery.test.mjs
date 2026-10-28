// P5.2 — invitation recovery, Super Admin side (pure + fake dependencies): the recovery redirect, refusal and outcome
// messages, invitationsService.recoverInvitation sequencing (database first, then the session-less mailer with the
// database-owned address only; never the service-role Auth Admin client), the Users panel read model, and the panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.UM_BUILD;
if (!build) throw new Error("Run through tests/user-management/run.mjs");
const I = await import(`${build}/lib/user-management/invitations.mjs`);
const L = await import(`${build}/lib/user-management/lifecycle.mjs`);
const { InvitationsFunctionError, InvitationsRepositoryError } = await import(`${build}/repositories/invitations.repository.core.mjs`);
const { createInvitationsService, InvitationsAuthorizationError } = await import(`${build}/services/invitations.service.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const ID = "44444444-4444-4444-8444-444444444444";
const ADMIN = { id: "55555555-5555-4555-8555-555555555555", email: "a@x.test", fullName: "A", role: "admin", isActive: true, createdAt: "2026-01-01" };
const TRAINER = { ...ADMIN, role: "trainer" };

test("recovery redirect: the configured app origin + /auth/recover; same safety rules as invitations", () => {
  assert.equal(I.recoveryRedirectUrl("https://training.example.com/some/path"), "https://training.example.com/auth/recover");
  assert.equal(I.recoveryRedirectUrl("http://localhost:3000"), "http://localhost:3000/auth/recover");
  for (const bad of [undefined, null, "", "not a url", "http://training.example.com", "https://user:pw@training.example.com"]) {
    assert.equal(I.recoveryRedirectUrl(bad), null, String(bad));
  }
});

test("messages: every recovery refusal and outcome has a safe sentence; unknown codes never pass through", () => {
  const reasons = ["not_found", "expired", "not_pending", "already_bound", "not_recoverable", "cooldown", "resend_limit", "permission", "invalid"];
  assert.deepEqual(Object.keys(I.RECOVERY_REASON_MESSAGE).sort(), [...reasons].sort());
  for (const r of reasons) assert.equal(I.asRecoveryRefusal(r), r);
  for (const r of ["something_new", "toString", "__proto__"]) assert.equal(I.asRecoveryRefusal(r), null, r);
  const outcomes = [
    { kind: "sent", invitationId: ID },
    ...reasons.map((reason) => ({ kind: "refused", reason, invitationId: ID, retryAfterSeconds: 17 })),
    ...["already_registered", "rate_limited", "address_not_allowed", "invalid_address", "auth_error"].map((reason) => ({ kind: "delivery_failed", invitationId: ID, reason })),
    { kind: "delivery_unknown", invitationId: ID },
    { kind: "unavailable", invitationId: null, reason: "not_configured" },
  ];
  const texts = outcomes.map((o) => I.recoveryOutcomeMessage(o));
  for (const t of texts) assert.ok(typeof t === "string" && t.length > 10, t);
  assert.match(I.recoveryOutcomeMessage({ kind: "refused", reason: "cooldown", invitationId: ID, retryAfterSeconds: 17 }), /17 s/);
  assert.match(I.RECOVERY_REASON_MESSAGE.expired, /new invitation/i);
  // When the e-mail failed or is uncertain, the message says the REQUEST was recorded — not that a link was sent.
  for (const o of [{ kind: "delivery_failed", invitationId: ID, reason: "auth_error" }, { kind: "delivery_failed", invitationId: ID, reason: "rate_limited" }, { kind: "delivery_unknown", invitationId: ID }]) {
    assert.match(I.recoveryOutcomeMessage(o), /^The request was recorded, but/, JSON.stringify(o));
  }
  assert.doesNotMatch(texts.join(" "), /service[_ ]role|SUPABASE|public\.|SQLSTATE|42501|token|begin_invitation|amr|@/i);
  assert.match(I.DELIVERY_FAILURE_MESSAGE.already_registered, /send them a sign-in link/, "the Super Admin is pointed to recovery");
});

/** invitationsService with fakes: the database (beginRecovery), the Auth Admin client (must never be used) and the mailer. */
function harness({ user = ADMIN, begin, mail, mailerConfigured = true, redirect = "https://training.example.com/auth/recover", demo = false, withMailer = true, enabled = true } = {}) {
  const calls = [];
  const deps = {
    invitations: {
      async beginRecovery(id) {
        calls.push(["beginRecovery", id]);
        if (begin instanceof Error) throw begin;
        return begin ?? { ok: true, invitationId: id, email: "db-owned@x.test", expiresAt: "2026-12-31T00:00:00Z", resendCount: 1 };
      },
    },
    authAdmin: { openDelivery() { calls.push(["authAdmin.openDelivery"]); return null; } },
    getCurrentUser: async () => user,
    redirectUrl: () => "https://training.example.com/auth/confirm",
    recoveryRedirectUrl: () => redirect,
    isDemoMode: () => demo,
    // The server-side switch: left out entirely with enabled: "omit" (the production default — off).
    ...(enabled === "omit" ? {} : { recoveryEnabled: () => enabled }),
    ...(withMailer
      ? {
          recoveryMailer: {
            isConfigured: () => mailerConfigured,
            async sendSignInLink(email, redirectTo) {
              calls.push(["sendSignInLink", email, redirectTo]);
              return mail ?? { kind: "sent" };
            },
          },
        }
      : {}),
  };
  return { calls, service: createInvitationsService(deps) };
}
async function captured(fn) {
  const lines = [];
  const saved = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = saved;
  }
}

test("recoverInvitation: Super Admin only; the database decides first; the mailer gets the database-owned address only", async () => {
  let h = harness({ user: TRAINER });
  await assert.rejects(() => h.service.recoverInvitation(ID), InvitationsAuthorizationError);
  assert.deepEqual(h.calls, [], "refused before any call");
  h = harness({ user: null });
  await assert.rejects(() => h.service.recoverInvitation(ID), InvitationsAuthorizationError);

  h = harness();
  assert.deepEqual(await h.service.recoverInvitation("not-a-uuid"), { kind: "refused", reason: "not_found", invitationId: null });
  assert.deepEqual(h.calls, []);

  for (const over of [{ withMailer: false }, { mailerConfigured: false }, { redirect: null }, { demo: true }]) {
    h = harness(over);
    assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "unavailable", invitationId: ID, reason: "not_configured" }, JSON.stringify(over));
    assert.deepEqual(h.calls, [], "nothing attempted");
  }

  h = harness();
  assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "sent", invitationId: ID });
  assert.deepEqual(h.calls, [["beginRecovery", ID], ["sendSignInLink", "db-owned@x.test", "https://training.example.com/auth/recover"]]);
  assert.ok(!h.calls.some((c) => c[0] === "authAdmin.openDelivery"), "never the service-role Auth Admin client");
});

test("recoverInvitation: the server-side switch is OFF by default — refused before the database or the mailer", async () => {
  for (const enabled of ["omit", false, "true"]) {
    const h = harness({ enabled });
    assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "unavailable", invitationId: ID, reason: "disabled" }, String(enabled));
    assert.deepEqual(h.calls, [], "nothing recorded, nothing sent");
  }
  // Still Super Admin first: a trainer is refused before the switch is even looked at.
  await assert.rejects(() => harness({ user: TRAINER, enabled: false }).service.recoverInvitation(ID), InvitationsAuthorizationError);
  assert.match(I.recoveryOutcomeMessage({ kind: "unavailable", invitationId: ID, reason: "disabled" }), /turned off[\s\S]*Nothing was requested or sent/);
  // Wiring: a server-only variable, exactly "true" to enable.
  const wiring = strip(src("src/services/invitations.service.ts"));
  assert.match(wiring, /recoveryEnabled: \(\) => invitationRecoveryEnabled\(process\.env\.INVITATION_RECOVERY_EMAILS_ENABLED\)/);
  // The one helper both services use: only the exact string "true" turns it on.
  assert.equal(I.invitationRecoveryEnabled("true"), true);
  for (const v of [undefined, null, "", "TRUE", "True", " true", "1", "yes", "false"]) assert.equal(I.invitationRecoveryEnabled(v), false, String(v));
  assert.doesNotMatch(wiring, /NEXT_PUBLIC_INVITATION_RECOVERY/);
});

test("recoverInvitation: refusals, raised errors and mailer outcomes", async () => {
  let h = harness({ begin: { ok: false, reason: "cooldown", retryAfterSeconds: 23 } });
  assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "refused", reason: "cooldown", invitationId: ID, retryAfterSeconds: 23 });
  assert.deepEqual(h.calls.map((c) => c[0]), ["beginRecovery"], "nothing sent after a refusal");
  for (const reason of ["not_recoverable", "already_bound", "expired", "not_pending", "resend_limit", "not_found"]) {
    h = harness({ begin: { ok: false, reason } });
    assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "refused", reason, invitationId: ID }, reason);
  }
  h = harness({ begin: { ok: false, reason: "something_new" } });
  const unexpected = await captured(() => h.service.recoverInvitation(ID).then(() => "resolved", (e) => e));
  assert.ok(unexpected.result instanceof InvitationsRepositoryError, "an unknown refusal code is an error, never passed on");
  h = harness({ begin: new InvitationsFunctionError("42501") });
  assert.deepEqual(await h.service.recoverInvitation(ID), { kind: "refused", reason: "permission", invitationId: ID });

  h = harness({ mail: { kind: "refused", failure: "rate_limited", diagnostic: "AuthApiError status=429" } });
  let q = await captured(() => h.service.recoverInvitation(ID));
  assert.deepEqual(q.result, { kind: "delivery_failed", invitationId: ID, reason: "rate_limited" });
  assert.deepEqual(q.lines, [`[invitations] delivery recovery_failed: invitation=${ID} reason=rate_limited auth=AuthApiError status=429`]);
  h = harness({ mail: { kind: "unknown", diagnostic: "AuthRetryableFetchError" } });
  q = await captured(() => h.service.recoverInvitation(ID));
  assert.deepEqual(q.result, { kind: "delivery_unknown", invitationId: ID });
  assert.doesNotMatch(q.lines.join(" "), /db-owned@x\.test/, "the address is never logged");
});

test("Users panel read model: the recovery key appears only for an invited account with a valid candidate", () => {
  // The same profile record shape as invitation-lifecycle.test.mjs.
  const record = (account_status) => ({ id: ADMIN.id, role: "student", account_status, account_status_changed_at: "2026-10-01", created_at: "2026-10-01", updated_at: "2026-10-01", students: null, trainers: null });
  const candidate = { invitation_id: ID, expires_at: "2026-12-31T00:00:00Z", last_sent_at: "2026-06-01T00:00:00Z", resend_count: 2, recovery_requested_at: null };
  const invited = L.mapUserDetail(record("invited"), [], "other", null, null, new Date("2026-06-02T00:00:00Z"), candidate);
  assert.deepEqual(invited.recovery, { invitationId: ID, expiresAt: candidate.expires_at, lastSentAt: candidate.last_sent_at, resendCount: 2, recoveryRequestedAt: null, available: false }, "switch off by default → not offered");
  const switchedOn = L.mapUserDetail(record("invited"), [], "other", null, null, new Date("2026-06-02T00:00:00Z"), candidate, true);
  assert.equal(switchedOn.recovery.available, true);
  assert.equal(L.mapRecoveryCandidate(candidate, "true").available, false, "only the boolean true counts");
  assert.equal("recovery" in L.mapUserDetail(record("invited"), [], "other"), false, "absent without a candidate (existing shape unchanged)");
  assert.equal("recovery" in L.mapUserDetail(record("active"), [], "other", null, null, new Date(), candidate), false, "never for an active account");
  assert.equal(L.mapRecoveryCandidate({ ...candidate, invitation_id: "nope" }), null);
  // The request is recorded before the e-mail is attempted, so the history says "requested", never "sent".
  assert.equal(L.describeEvent("invitation_recovery_requested", {}), "Sign-in link requested for the existing account");
  assert.doesNotMatch(L.describeEvent("invitation_recovery_requested", {}), /\bsent\b/i);
  assert.equal(L.describeEvent("invitation_recovered", {}), "Invitation linked after sign-in from the email link");
});

test("source: the panel offers recovery only with a candidate and sends only the invitation id; the action is Super Admin-checked in the service", () => {
  const panel = strip(src("src/components/modules/UserDetailPanel.tsx"));
  assert.match(panel, /\{detail\.recovery && <RecoverySection key=\{detail\.recovery\.invitationId\} detail=\{detail\} \/>\}/);
  assert.match(panel, /recoverInvitationAction\(rec\.invitationId\)/);
  // Request times are shown as requests, not deliveries.
  assert.match(panel, /`Last sign-in link requested \$\{formatDateTime\(rec\.recoveryRequestedAt\)\}` : "No sign-in link requested yet"/);
  assert.doesNotMatch(panel, /Last sign-in link sent|No sign-in link sent yet/);
  // The action is offered only when the server-side switch is on; otherwise the section explains and has no button.
  assert.match(panel, /\{rec\.available \? \(\s*<div className="flex flex-wrap gap-2">\s*<Button [\s\S]*?onClick=\{send\}>/);
  assert.match(panel, /Sign-in links are turned off on this server until their email setup has been confirmed, so this can&apos;t be sent yet\./);
  assert.equal((panel.match(/onClick=\{send\}/g) ?? []).length, 1, "the only trigger is inside the available branch");
  const usersWiring = strip(src("src/services/users.service.ts"));
  assert.match(usersWiring, /isRecoveryEnabled: \(\) => invitationRecoveryEnabled\(process\.env\.INVITATION_RECOVERY_EMAILS_ENABLED\)/);
  // The switch reaches mapUserDetail as a strict `=== true` (now followed by the identity argument).
  assert.match(strip(src("src/services/users.service.core.ts")), /deps\.isRecoveryEnabled\?\.\(\) === true, \{/);
  assert.doesNotMatch(strip(src("src/services/users.service.core.ts")), /deps\.isRecoveryEnabled\?\.\(\)(?! === true)/, "never passed or used loosely");
  // A failure toast never claims that no e-mail was sent (an uncertain result may have sent one).
  assert.match(panel, /title: "Sign-in link not confirmed as sent", description: result\.error/);
  assert.doesNotMatch(panel, /No sign-in link was sent/);
  const actions = strip(src("src/services/invitations.actions.ts"));
  assert.match(actions, /export async function recoverInvitationAction\(invitationId: string\): Promise<UserActionResult>/);
  assert.match(actions, /invitationsService\.recoverInvitation\(invitationId\)/);
  const service = strip(src("src/services/invitations.service.ts"));
  assert.match(service, /recoveryMailer: recoveryMailerRepository/);
  assert.match(service, /recoveryRedirectUrl: \(\) => recoveryRedirectUrl\(process\.env\.NEXT_PUBLIC_APP_URL\)/);
  const usersService = strip(src("src/services/users.service.core.ts"));
  assert.match(usersService, /record\.account_status === "invited" && invitation\?\.status !== "pending"/);
});
