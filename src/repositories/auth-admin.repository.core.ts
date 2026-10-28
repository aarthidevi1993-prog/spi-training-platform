/**
 * Auth Admin repository core (Phase 7 P3.4) — the ONLY code that uses the
 * service-role Supabase client, and only for two operations:
 *
 *   inviteUserByEmail(email, redirectTo)       Supabase Auth Admin
 *   recordDelivery(invitationId, sent, user)   record_invitation_delivery (0019, service_role only)
 *
 * openDelivery() builds ONE service-role client for one send operation
 * and returns the two operations bound to it (null when not configured),
 * so the client is never rebuilt between "Auth sent" and "record it".
 * Nothing is cached across operations.
 *
 * It is used by invitations.service only AFTER begin_invitation_delivery
 * has authorized the attempt under the caller's own session, and the email
 * passed here is the one that function returned (never browser input).
 * It never creates, activates, deletes or changes users or profiles, never
 * reads or writes tables directly, and never throws or returns raw Auth or
 * database errors — only classified results plus a short, safe diagnostic
 * (error name/status/code only) for the service's single log line.
 *
 * The client factory is injected; auth-admin.repository.ts (server-only)
 * is the single place that imports src/lib/supabase/admin.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import type { AuthInviteFailure } from "@/types/user-management";
import { classifyAuthInviteError, isIndeterminateAuthError, type AuthErrorLike } from "@/lib/user-management/invitations";

type AdminClient = SupabaseClient<Database, "public">;

export type AuthInviteResult =
  | { kind: "sent"; authUserId: string }
  | { kind: "refused"; failure: AuthInviteFailure; diagnostic: string }
  | { kind: "unknown"; diagnostic: string };

export type RecordDeliveryResult = { ok: true } | { ok: false; reason: string };

/** The two operations of one send, bound to one service-role client. */
export interface AuthAdminDelivery {
  inviteUserByEmail(email: string, redirectTo: string): Promise<AuthInviteResult>;
  recordDelivery(invitationId: string, sent: boolean, authUserId: string | null): Promise<RecordDeliveryResult>;
}

/** Error name / status / code only — never the message (it can contain the address) or any response body. */
function diagnosticOf(e: unknown): string {
  if (!e || typeof e !== "object") return "no_detail";
  const { name, status, code } = e as AuthErrorLike;
  const parts = [typeof name === "string" ? name : null, typeof status === "number" ? `status=${status}` : null, typeof code === "string" ? `code=${code}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : "no_detail";
}

export function createAuthAdminRepository(getAdminClient: () => AdminClient | null) {
  return {
    /** One service-role client for one send; null when it is not configured or cannot be created. */
    openDelivery(): AuthAdminDelivery | null {
      let admin: AdminClient | null;
      try {
        admin = getAdminClient();
      } catch {
        return null;
      }
      if (!admin) return null;
      const client = admin;

      return {
        async inviteUserByEmail(email: string, redirectTo: string): Promise<AuthInviteResult> {
          try {
            // No user metadata is sent: roles come only from the database at acceptance.
            const { data, error } = await client.auth.admin.inviteUserByEmail(email, { redirectTo });
            if (error) {
              const diagnostic = diagnosticOf(error);
              if (isIndeterminateAuthError(error)) return { kind: "unknown", diagnostic };
              return { kind: "refused", failure: classifyAuthInviteError(error), diagnostic };
            }
            const id = data?.user?.id;
            if (typeof id !== "string" || id === "") return { kind: "unknown", diagnostic: "no_user_in_response" };
            return { kind: "sent", authUserId: id };
          } catch (err) {
            return { kind: "unknown", diagnostic: `threw ${diagnosticOf(err)}` };
          }
        },

        async recordDelivery(invitationId: string, sent: boolean, authUserId: string | null): Promise<RecordDeliveryResult> {
          try {
            const { data, error } = await client.rpc("record_invitation_delivery", {
              p_invitation_id: invitationId,
              p_sent: sent,
              p_auth_user_id: authUserId,
            });
            if (error) {
              const code = (error as { code?: unknown }).code;
              return { ok: false, reason: typeof code === "string" ? `db_error_${code}` : "db_error" };
            }
            const d = data && typeof data === "object" && !Array.isArray(data) ? (data as { [k: string]: Json | undefined }) : null;
            if (d?.ok === true) return { ok: true };
            return { ok: false, reason: typeof d?.reason === "string" ? d.reason : "unexpected_result" };
          } catch {
            return { ok: false, reason: "threw" };
          }
        },
      };
    },
  };
}

export type AuthAdminRepository = ReturnType<typeof createAuthAdminRepository>;
