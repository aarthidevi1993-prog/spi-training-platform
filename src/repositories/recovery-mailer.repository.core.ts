/**
 * Recovery mailer repository core (P5.2) — sends the passwordless sign-in
 * e-mail that lets an already-registered, never-activated invited account
 * prove it controls its mailbox (Supabase Auth signInWithOtp).
 *
 *   auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo } })
 *
 * The client is a SESSION-LESS public client (publishable key, no cookies,
 * no stored session, no auto refresh): never the service-role client and
 * never the Super Admin's own session, so sending cannot sign the admin out
 * or act with elevated rights. shouldCreateUser: false — Auth never creates
 * an account here. It is used by invitations.service only AFTER
 * begin_invitation_recovery authorized the request under the Super Admin's
 * session, and the address passed here is the one that function returned.
 *
 * Results are classified like invitation sends; only a short, safe
 * diagnostic (error name/status/code — never the message, which can contain
 * the address) is returned for the service's single log line. The client
 * factory is injected; recovery-mailer.repository.ts (server-only) wires it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { AuthInviteFailure } from "@/types/user-management";
import { classifyAuthInviteError, isIndeterminateAuthError, type AuthErrorLike } from "@/lib/user-management/invitations";

type PublicClient = SupabaseClient<Database, "public">;

export type RecoveryMailResult = { kind: "sent" } | { kind: "refused"; failure: AuthInviteFailure; diagnostic: string } | { kind: "unknown"; diagnostic: string };

function diagnosticOf(e: unknown): string {
  if (!e || typeof e !== "object") return "no_detail";
  const { name, status, code } = e as AuthErrorLike;
  const parts = [typeof name === "string" ? name : null, typeof status === "number" ? `status=${status}` : null, typeof code === "string" ? `code=${code}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : "no_detail";
}

export function createRecoveryMailerRepository(getPublicClient: () => PublicClient | null) {
  return {
    /** True when a session-less public client can be built (Supabase configured). */
    isConfigured(): boolean {
      try {
        return getPublicClient() !== null;
      } catch {
        return false;
      }
    },

    async sendSignInLink(email: string, redirectTo: string): Promise<RecoveryMailResult> {
      let client: PublicClient | null;
      try {
        client = getPublicClient();
      } catch {
        return { kind: "unknown", diagnostic: "no_client" };
      }
      if (!client) return { kind: "unknown", diagnostic: "no_client" };
      try {
        const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
        if (error) {
          const diagnostic = diagnosticOf(error);
          if (isIndeterminateAuthError(error)) return { kind: "unknown", diagnostic };
          return { kind: "refused", failure: classifyAuthInviteError(error), diagnostic };
        }
        return { kind: "sent" };
      } catch (err) {
        return { kind: "unknown", diagnostic: `threw ${diagnosticOf(err)}` };
      }
    },
  };
}

export type RecoveryMailerRepository = ReturnType<typeof createRecoveryMailerRepository>;
