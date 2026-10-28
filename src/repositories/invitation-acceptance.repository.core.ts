/**
 * Invitation acceptance repository (Phase 7 P3.5) — the invitee's OWN
 * session client (publishable key + cookies; never the service role):
 *
 *   auth.verifyOtp({ type: "invite", token_hash })   the Continue step
 *   auth.verifyOtp({ type: "email", token_hash })    P5.2 recovery sign-in link
 *   auth.getUser() / auth.updateUser({ password }) / auth.signOut()
 *   rpc accept_user_invitation()                      0017 (0029a: bound account only)
 *   rpc complete_invitation_recovery()                0029a (P5.2)
 *   profiles role lookup                              fetchProfileRole
 *
 * One client per request (`open()`), so the session established by
 * verifyOtp is the one every later call uses. Results are typed and
 * safe; errors are logged by code/status only — never a token,
 * password, email or raw message. Factory without `server-only` so it
 * can be tested; invitation-acceptance.repository.ts wires the real
 * server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { fetchProfileRole } from "@/lib/auth/profile-role";
import type { UserRole } from "@/types/user";

type Client = SupabaseClient<Database, "public">;

export type VerifyInviteResult = "verified" | "invalid" | "failed";
export type UpdatePasswordResult = { ok: true } | { ok: false; reason: "weak_password" | "failed" };
export type AcceptInvitationResult =
  | {
      ok: true;
      role: string | null;
      enrolled: boolean;
      /** 0030: why the invitation's batch enrolment was skipped (e.g. "course_archived"), or null. */
      enrolmentSkipped: string | null;
    }
  | { ok: false; reason: string };
/** P5.2: complete_invitation_recovery() — bound (or already bound to this account), or a refusal code. */
export type CompleteRecoveryResult = { ok: true } | { ok: false; reason: string };
/** P5.2: whether the recovery-created session was confirmed gone ("ended") or not ("unconfirmed"). */
export type EndSessionResult = "ended" | "unconfirmed";

/** Only a code or status — never a message (it could echo personal data). */
function diagnostic(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as { code?: unknown; status?: unknown; name?: unknown };
  const parts = [e.name, e.code, e.status].filter((p) => typeof p === "string" || typeof p === "number");
  return parts.length ? parts.join(" ") : "unknown";
}

function logAuth(context: string, error: unknown) {
  console.error(`[invite-acceptance] ${context}:`, diagnostic(error));
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: unknown): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);

function sessionFor(client: Client) {
  return {
    /** Consumes the one-time invite token and stores the invitee's session (cookies). */
    async verifyInvite(tokenHash: string): Promise<VerifyInviteResult> {
      try {
        const { error } = await client.auth.verifyOtp({ type: "invite", token_hash: tokenHash });
        if (error) {
          logAuth("verifyOtp refused", error);
          return "invalid";
        }
        return "verified";
      } catch (err) {
        logAuth("verifyOtp threw", err);
        return "failed";
      }
    },

    /**
     * P5.2: consumes the one-time passwordless sign-in link (type "email") a Super Admin had sent for invitation
     * recovery, and stores the person's session (cookies). Same result shape as verifyInvite.
     */
    async verifyEmailLink(tokenHash: string): Promise<VerifyInviteResult> {
      try {
        const { error } = await client.auth.verifyOtp({ type: "email", token_hash: tokenHash });
        if (error) {
          logAuth("verifyOtp (email) refused", error);
          return "invalid";
        }
        return "verified";
      } catch (err) {
        logAuth("verifyOtp (email) threw", err);
        return "failed";
      }
    },

    /** P5.2: complete_invitation_recovery() (0029a) on this fresh sign-in — the database decides everything. */
    async completeRecovery(): Promise<CompleteRecoveryResult> {
      try {
        const { data, error } = await client.rpc("complete_invitation_recovery");
        if (error) {
          logAuth("complete_invitation_recovery failed", error);
          return { ok: false, reason: "error" };
        }
        const d = asObject(data);
        if (d?.ok === true) return { ok: true };
        if (d?.ok === false) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
        logAuth("complete_invitation_recovery", "unexpected result");
        return { ok: false, reason: "unknown" };
      } catch (err) {
        logAuth("complete_invitation_recovery threw", err);
        return { ok: false, reason: "error" };
      }
    },

    /** The signed-in user, revalidated with Supabase; null when there is none. */
    async getUser(): Promise<{ id: string; email: string | null } | null> {
      try {
        const { data, error } = await client.auth.getUser();
        if (error || !data?.user) return null;
        return { id: data.user.id, email: data.user.email ?? null };
      } catch (err) {
        logAuth("getUser threw", err);
        return null;
      }
    },

    /** Role of an ACTIVE account (public.profiles); null for invited/suspended/unknown. */
    fetchRole(userId: string): Promise<UserRole | null> {
      return fetchProfileRole(client, userId);
    },

    async updatePassword(password: string): Promise<UpdatePasswordResult> {
      try {
        const { error } = await client.auth.updateUser({ password });
        if (error) {
          logAuth("updateUser (password) refused", error);
          return { ok: false, reason: (error as { code?: unknown }).code === "weak_password" ? "weak_password" : "failed" };
        }
        return { ok: true };
      } catch (err) {
        logAuth("updateUser (password) threw", err);
        return { ok: false, reason: "failed" };
      }
    },

    /** The database decides everything (0017); the caller supplies nothing. */
    async acceptInvitation(): Promise<AcceptInvitationResult> {
      try {
        const { data, error } = await client.rpc("accept_user_invitation");
        if (error) {
          logAuth("accept_user_invitation failed", error);
          return { ok: false, reason: "error" };
        }
        const d = asObject(data);
        if (d?.ok === true) {
          return {
            ok: true,
            role: typeof d.role === "string" ? d.role : null,
            enrolled: d.enrolled === true,
            enrolmentSkipped: typeof d.enrolment_skipped === "string" ? d.enrolment_skipped : null,
          };
        }
        if (d?.ok === false) return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
        logAuth("accept_user_invitation", "unexpected result");
        return { ok: false, reason: "unknown" };
      } catch (err) {
        logAuth("accept_user_invitation threw", err);
        return { ok: false, reason: "error" };
      }
    },

    /**
     * P5.2: end the session the recovery flow created, and CONFIRM it is gone from this request's cookies.
     * `scope: "local"` ends only this session (never the person's other devices). @supabase/auth-js (2.117)
     * removes the local session through the SSR cookie adapter even when the server call fails and then reports
     * the error, so the error is logged but not trusted either way: the confirmation is a fresh getSession() read.
     * Limitation: with @supabase/ssr that read answers from the client's in-memory record of the removal, not from
     * the browser cookies (written later through the project's setAll) — "ended" does not prove cookie deletion.
     * "unconfirmed" when that read still finds a session, cannot be made, or anything throws — the caller then
     * uses the safe page that never redirects to a portal. Never throws; never logs a token or message.
     */
    async endSession(): Promise<EndSessionResult> {
      try {
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) logAuth("signOut (local) reported an error", error);
        const { data, error: readError } = await client.auth.getSession();
        if (readError) {
          logAuth("getSession after signOut failed", readError);
          return "unconfirmed";
        }
        return data?.session ? "unconfirmed" : "ended";
      } catch (err) {
        logAuth("signOut (local) threw", err);
        return "unconfirmed";
      }
    },

    /** Never throws: at worst the session simply expires. */
    async signOut(): Promise<void> {
      try {
        await client.auth.signOut();
      } catch (err) {
        logAuth("signOut threw", err);
      }
    },
  };
}

export type InvitationAcceptanceSession = ReturnType<typeof sessionFor>;

export function createInvitationAcceptanceRepository(getClient: () => Promise<Client | null>) {
  return {
    /** A session handle for this request, or null when Supabase Auth isn't available. */
    async open(): Promise<InvitationAcceptanceSession | null> {
      let client: Client | null;
      try {
        client = await getClient();
      } catch (err) {
        logAuth("client", err);
        return null;
      }
      return client ? sessionFor(client) : null;
    },
  };
}

export type InvitationAcceptanceRepository = ReturnType<typeof createInvitationAcceptanceRepository>;
