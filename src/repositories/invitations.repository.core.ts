/**
 * Invitations repository (Phase 7 P3.4) — the caller's OWN session
 * (never the service role) calling the database functions that decide
 * whether an invitation may be created or sent:
 *
 *   create_user_invitation(p)            0017 (0019 D1 address rule)
 *   begin_invitation_delivery(id)        0019: scope, pending/unexpired,
 *                                        row lock, cooldown, resend cap;
 *                                        returns the database-owned address
 *   revoke_user_invitation(id, reason)   0017: scope, pending/unexpired, row
 *                                        lock; state change + audit only (P3.9)
 *   begin_invitation_recovery(id)        0029a: Super Admin; never-activated
 *                                        placeholder; shared cooldown/cap;
 *                                        returns the database-owned address (P5.2)
 *
 * Nothing here writes a table directly or decides any rule. Factory
 * without `server-only` so it can be tested against a local database;
 * invitations.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";

type Client = SupabaseClient<Database, "public">;

export class InvitationsRepositoryError extends Error {
  constructor(message = "The invitation could not be processed.") {
    super(message);
    this.name = "InvitationsRepositoryError";
  }
}

/** A database function raised an error; only its SQLSTATE is kept. */
export class InvitationsFunctionError extends InvitationsRepositoryError {
  constructor(public readonly code: string | null) {
    super();
    this.name = "InvitationsFunctionError";
  }
}

/** `code`: the generated student/trainer code (0020); null for a Super Admin invitation. */
export type CreateInvitationResult = { ok: true; invitationId: string; code: string | null } | { ok: false; reason: string };

export type RevokeInvitationResult = { ok: true } | { ok: false; reason: string };

export type BeginDeliveryResult =
  | { ok: true; invitationId: string; email: string; expiresAt: string; attempt: "initial" | "resend"; resendCount: number }
  | { ok: false; reason: string; retryAfterSeconds?: number };

/** P5.2: begin_invitation_recovery's answer — the address to send a sign-in link to, or a refusal code. */
export type BeginRecoveryResult =
  | { ok: true; invitationId: string; email: string; expiresAt: string; resendCount: number }
  | { ok: false; reason: string; retryAfterSeconds?: number };

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[invitations] ${context}:`, detail);
}

type JsonObject = { [key: string]: Json | undefined };
const asObject = (v: Json | null): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null);

export function createInvitationsRepository(getClient: () => Promise<Client | null>) {
  async function call(context: string, fn: (s: Client) => PromiseLike<{ data: Json | null; error: unknown }>): Promise<JsonObject> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new InvitationsRepositoryError();
    }
    if (!supabase) throw new InvitationsRepositoryError();
    let result: { data: Json | null; error: unknown };
    try {
      result = await fn(supabase);
    } catch (err) {
      logDbError(context, err);
      throw new InvitationsRepositoryError();
    }
    if (result.error) {
      logDbError(context, result.error);
      const code = (result.error as { code?: unknown }).code;
      throw new InvitationsFunctionError(typeof code === "string" ? code : null);
    }
    const data = asObject(result.data);
    if (!data || typeof data.ok !== "boolean") {
      logDbError(context, "unexpected function result");
      throw new InvitationsRepositoryError();
    }
    return data;
  }

  return {
    async createInvitation(p: Record<string, Json>): Promise<CreateInvitationResult> {
      const d = await call("createInvitation", (s) => s.rpc("create_user_invitation", { p }));
      if (d.ok === true && typeof d.invitation_id === "string") {
        return { ok: true, invitationId: d.invitation_id, code: typeof d.code === "string" ? d.code : null };
      }
      return { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
    },

    async beginDelivery(invitationId: string): Promise<BeginDeliveryResult> {
      const d = await call("beginDelivery", (s) => s.rpc("begin_invitation_delivery", { p_invitation_id: invitationId }));
      if (d.ok === true) {
        if (typeof d.email !== "string" || typeof d.expires_at !== "string" || (d.attempt !== "initial" && d.attempt !== "resend")) {
          logDbError("beginDelivery", "incomplete authorization result");
          throw new InvitationsRepositoryError();
        }
        return { ok: true, invitationId, email: d.email, expiresAt: d.expires_at, attempt: d.attempt, resendCount: typeof d.resend_count === "number" ? d.resend_count : 0 };
      }
      return {
        ok: false,
        reason: typeof d.reason === "string" ? d.reason : "unknown",
        ...(typeof d.retry_after_seconds === "number" ? { retryAfterSeconds: d.retry_after_seconds } : {}),
      };
    },

    /**
     * P5.2: begin_invitation_recovery (0029a) — Super Admin only; records a recovery REQUEST for the address's
     * never-activated placeholder account (not a binding) and returns the database-owned address to e-mail.
     */
    async beginRecovery(invitationId: string): Promise<BeginRecoveryResult> {
      const d = await call("beginRecovery", (s) => s.rpc("begin_invitation_recovery", { p_invitation_id: invitationId }));
      if (d.ok === true) {
        if (typeof d.email !== "string" || typeof d.expires_at !== "string") {
          logDbError("beginRecovery", "incomplete authorization result");
          throw new InvitationsRepositoryError();
        }
        return { ok: true, invitationId, email: d.email, expiresAt: d.expires_at, resendCount: typeof d.resend_count === "number" ? d.resend_count : 0 };
      }
      return {
        ok: false,
        reason: typeof d.reason === "string" ? d.reason : "unknown",
        ...(typeof d.retry_after_seconds === "number" ? { retryAfterSeconds: d.retry_after_seconds } : {}),
      };
    },

    /** P3.9: revoke_user_invitation (0017) — a state change only; the database decides scope and state. */
    async revokeInvitation(invitationId: string, reason: string | null): Promise<RevokeInvitationResult> {
      const d = await call("revokeInvitation", (s) => s.rpc("revoke_user_invitation", { p_invitation_id: invitationId, p_reason: reason }));
      return d.ok === true ? { ok: true } : { ok: false, reason: typeof d.reason === "string" ? d.reason : "unknown" };
    },
  };
}

export type InvitationsRepository = ReturnType<typeof createInvitationsRepository>;
