/**
 * Users repository (Phase 7 P3.2 reads, P3.3 lifecycle actions):
 * public.profiles with each account's student/trainer record, contact
 * details (student_details / trainer_details) and batches, the account's
 * audit history (user_admin_events), an invited account's latest
 * invitation (user_invitations, lifecycle columns only — P3.9), the name
 * and acceptance time of ACCEPTED invitations (the only identity a Super
 * Admin account has; never the address — used by the Super Admin Users
 * view only), and the 0017 Super Admin functions.
 *
 * Always the caller's own session (never the service role): RLS decides
 * every row read, and every change goes through a 0017 SECURITY DEFINER
 * function that checks the caller (active Super Admin), the target, the
 * transition, self-protection and the last-active-Super-Admin rule and
 * writes the audit row in the same transaction. Nothing here writes a
 * table directly. auth.users is never read — no sign-in data, no auth
 * email, no tokens.
 *
 * The list is one embedded read per page of profiles (keyset on
 * profiles.id), so the number of requests depends only on the number of
 * accounts / page size, never on records or batches per account (no N+1).
 *
 * Factory without `server-only` so it can be tested against a local
 * database; users.repository.ts wires the real server client.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountStatusColumn, AppRoleColumn, Database, Json } from "@/lib/supabase/types";
import { KEYSET_PAGE_SIZE, readAllByKeyset } from "@/lib/supabase/paging";
import type { OneOrMany, UserIdentityRecord, UserProfileRecord } from "@/lib/user-management/users";
import type { UserAuditRecord, UserDetailRecord, UserInvitationRecord, UserRecoveryCandidateRecord } from "@/lib/user-management/lifecycle";

type Client = SupabaseClient<Database, "public">;

const GENERIC_DB_ERROR = "We couldn't load the users. Please try again.";

export class UsersRepositoryError extends Error {
  constructor(message: string = GENERIC_DB_ERROR) {
    super(message);
    this.name = "UsersRepositoryError";
  }
}

/** A database function raised an error; only its SQLSTATE is kept (to choose a safe message). */
export class UsersFunctionError extends UsersRepositoryError {
  constructor(public readonly code: string | null) {
    super("The change could not be made.");
    this.name = "UsersFunctionError";
  }
}

/**
 * Exactly the columns the Users view shows — nothing secret exists in
 * these tables, and nothing else is selected. The profile → record embeds
 * name their foreign key (students.id / trainers.id → profiles.id) so the
 * read stays unambiguous if other profile ↔ record links are ever added.
 */
export const USER_PROFILE_SELECT = `
  id, role, account_status, account_status_changed_at, created_at, updated_at,
  students!students_id_fkey ( student_code, full_name, status,
    student_details ( email ),
    batch_students ( enrollment_status, batches ( id, batch_code, name, status ) ) ),
  trainers!trainers_id_fkey ( trainer_code, full_name, status,
    trainer_details ( email ),
    batches ( id, batch_code, name, status ) )
`;

/** One account for the detail panel: the list columns plus the editable contact fields. */
export const USER_DETAIL_SELECT = `
  id, role, account_status, account_status_changed_at, created_at, updated_at,
  students!students_id_fkey ( student_code, full_name, status,
    student_details ( email, phone, organization, designation ),
    batch_students ( enrollment_status, batches ( id, batch_code, name, status ) ) ),
  trainers!trainers_id_fkey ( trainer_code, full_name, status,
    trainer_details ( email, phone, organization, designation, specializations, bio ),
    batches ( id, batch_code, name, status ) )
`;

export const AUDIT_HISTORY_LIMIT = 25;

/** The invitation columns the detail panel needs (P3.9) — never the address, a token or Auth data. */
export const USER_INVITATION_SELECT = "id, status, expires_at, last_sent_at, resend_count";

/**
 * The identity of an account from its ACCEPTED invitation: the name a Super Admin account was invited with
 * (it has no student/trainer record) and when it accepted. Read only for the Super Admin Users view — never the
 * invitation's address, a token or Auth data.
 */
export const USER_IDENTITY_SELECT = "id, accepted_user_id, full_name, accepted_at";

/** Names of history actors: their own student/trainer record name (the Super Admin view resolves the rest). */
export const USER_NAME_SELECT = "id, students!students_id_fkey ( full_name ), trainers!trainers_id_fkey ( full_name )";

export interface UserNameRecord {
  id: string;
  students: OneOrMany<{ full_name: string | null }>;
  trainers: OneOrMany<{ full_name: string | null }>;
}

/** What a 0017 function answered: { ok: true, ... } or { ok: false, reason }. */
export interface UsersFunctionOutcome {
  ok: boolean;
  reason: string | null;
  /** A generated student/trainer code — present only when the function created a record (0020). */
  code?: string;
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[users] ${context}:`, detail);
}

export function createUsersRepository(getClient: () => Promise<Client | null>, options: { pageSize?: number } = {}) {
  const pageSize = options.pageSize ?? KEYSET_PAGE_SIZE;

  async function client(context: string): Promise<Client> {
    let supabase: Client | null;
    try {
      supabase = await getClient();
    } catch (err) {
      logDbError(`${context} (client)`, err);
      throw new UsersRepositoryError();
    }
    if (!supabase) throw new UsersRepositoryError();
    return supabase;
  }

  async function read<T>(context: string, fn: (supabase: Client) => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
    const supabase = await client(context);
    try {
      const { data, error } = await fn(supabase);
      if (error) throw error;
      return data;
    } catch (err) {
      logDbError(context, err);
      throw new UsersRepositoryError();
    }
  }

  async function call(context: string, fn: (supabase: Client) => PromiseLike<{ data: Json | null; error: unknown }>): Promise<UsersFunctionOutcome> {
    const supabase = await client(context);
    let result: { data: Json | null; error: unknown };
    try {
      result = await fn(supabase);
    } catch (err) {
      logDbError(context, err);
      throw new UsersRepositoryError("The change could not be made.");
    }
    if (result.error) {
      logDbError(context, result.error);
      const code = (result.error as { code?: unknown }).code;
      throw new UsersFunctionError(typeof code === "string" ? code : null);
    }
    const data = result.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.ok !== "boolean") {
      logDbError(context, "unexpected function result");
      throw new UsersRepositoryError("The change could not be made.");
    }
    return { ok: data.ok, reason: typeof data.reason === "string" ? data.reason : null, ...(typeof data.code === "string" ? { code: data.code } : {}) };
  }

  return {
    /** Every profile the session may read, with its domain data (RLS-scoped). */
    async listProfiles(): Promise<UserProfileRecord[]> {
      const supabase = await client("listProfiles");
      try {
        return await readAllByKeyset<UserProfileRecord>((afterId, limit) => {
          let q = supabase.from("profiles").select(USER_PROFILE_SELECT);
          if (afterId) q = q.gt("id", afterId);
          return q.order("id").limit(limit);
        }, pageSize);
      } catch (err) {
        logDbError("listProfiles", err);
        throw new UsersRepositoryError();
      }
    },

    /** One profile with its contact details, or null when the session may not read it (RLS). */
    async getProfile(userId: string): Promise<UserDetailRecord | null> {
      return read<UserDetailRecord>("getProfile", (s) =>
        s.from("profiles").select(USER_DETAIL_SELECT).eq("id", userId).maybeSingle() as unknown as PromiseLike<{ data: UserDetailRecord | null; error: unknown }>
      );
    },

    /**
     * The account's most recent user-management audit rows, newest first (Super Admin RLS) — plus,
     * when given, the rows of its invitation (P3.9: invitation events carry the invitation id, not the account).
     */
    async listAuditEvents(userId: string, invitationId: string | null = null): Promise<UserAuditRecord[]> {
      const recent = (column: "target_user_id" | "invitation_id", id: string) =>
        read<UserAuditRecord[]>("listAuditEvents", (s) =>
          s.from("user_admin_events").select("id, occurred_at, event_type, actor_id, detail").eq(column, id).order("id", { ascending: false }).limit(AUDIT_HISTORY_LIMIT)
        );
      const own = (await recent("target_user_id", userId)) ?? [];
      if (!invitationId) return own;
      // Two plain reads merged by event id (an event can match both) — newest first, same limit.
      const byId = new Map<number, UserAuditRecord>();
      for (const r of [...own, ...((await recent("invitation_id", invitationId)) ?? [])]) byId.set(r.id, r);
      return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, AUDIT_HISTORY_LIMIT);
    },

    /**
     * Name and acceptance time of ACCEPTED invitations (never the address) — the identity of accounts without a
     * student/trainer record (Super Admins). Caller's own session: RLS (user_invitations_admin_select) returns
     * every row only to a Super Admin; a trainer sees at most their own invitations, a student none. Every
     * accepted invitation when `userIds` is omitted (the Users list), else those of the given accounts.
     */
    async listAcceptedIdentities(userIds?: readonly string[]): Promise<UserIdentityRecord[]> {
      if (userIds && userIds.length === 0) return [];
      const supabase = await client("listAcceptedIdentities");
      try {
        return await readAllByKeyset<UserIdentityRecord & { id: string }>((afterId, limit) => {
          // status = 'accepted' ⇔ accepted_user_id and accepted_at are set (constraint user_invitations_accepted_ok, 0017).
          let q = supabase.from("user_invitations").select(USER_IDENTITY_SELECT).eq("status", "accepted");
          if (userIds) q = q.in("accepted_user_id", [...userIds]);
          if (afterId) q = q.gt("id", afterId);
          return q.order("id").limit(limit) as unknown as PromiseLike<{ data: (UserIdentityRecord & { id: string })[] | null; error: unknown }>;
        }, pageSize);
      } catch (err) {
        logDbError("listAcceptedIdentities", err);
        throw new UsersRepositoryError();
      }
    },

    /** The given accounts' own student/trainer record names (history actors), RLS-scoped; [] for no ids. */
    async listRecordNames(userIds: readonly string[]): Promise<UserNameRecord[]> {
      if (userIds.length === 0) return [];
      return (
        (await read<UserNameRecord[]>("listRecordNames", (s) =>
          s.from("profiles").select(USER_NAME_SELECT).in("id", [...userIds]) as unknown as PromiseLike<{ data: UserNameRecord[] | null; error: unknown }>
        )) ?? []
      );
    },

    /**
     * The latest invitation bound to this account (P3.9), lifecycle columns only — no address, token or
     * Auth data. Super Admin RLS; null when there is none.
     */
    async getLatestInvitation(userId: string): Promise<UserInvitationRecord | null> {
      const rows = await read<UserInvitationRecord[]>("getLatestInvitation", (s) =>
        s.from("user_invitations").select(USER_INVITATION_SELECT).eq("auth_user_id", userId).order("created_at", { ascending: false }).limit(1)
      );
      return rows?.[0] ?? null;
    },

    /**
     * P5.2 (0029a): the pending, unexpired, UNBOUND invitation this never-activated placeholder account could
     * recover with a sign-in link — lifecycle facts only, never the address. invitation_recovery_candidate is
     * Super Admin only; null when there is none (or anything goes wrong — it only decides whether a button shows).
     */
    async getRecoveryCandidate(userId: string): Promise<UserRecoveryCandidateRecord | null> {
      let supabase: Client | null;
      try {
        supabase = await getClient();
      } catch (err) {
        logDbError("getRecoveryCandidate (client)", err);
        return null;
      }
      if (!supabase) return null;
      try {
        const { data, error } = await supabase.rpc("invitation_recovery_candidate", { p_user_id: userId });
        if (error) {
          logDbError("getRecoveryCandidate", error);
          return null;
        }
        const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
        if (d?.ok !== true || typeof d.invitation_id !== "string" || typeof d.expires_at !== "string") return null;
        return {
          invitation_id: d.invitation_id,
          expires_at: d.expires_at,
          last_sent_at: typeof d.last_sent_at === "string" ? d.last_sent_at : null,
          resend_count: typeof d.resend_count === "number" ? d.resend_count : 0,
          recovery_requested_at: typeof d.recovery_requested_at === "string" ? d.recovery_requested_at : null,
        };
      } catch (err) {
        logDbError("getRecoveryCandidate", err);
        return null;
      }
    },

    /**
     * The account's most recent account-status audit row (or null) — the
     * same fact 0018 checks before a reactivation, read here only to avoid
     * offering an action the database will refuse.
     */
    async latestStatusChange(userId: string): Promise<{ detail: Json } | null> {
      const rows = await read<{ detail: Json }[]>("latestStatusChange", (s) =>
        s.from("user_admin_events").select("detail").eq("target_user_id", userId).eq("event_type", "account_status_changed").order("id", { ascending: false }).limit(1)
      );
      return rows?.[0] ?? null;
    },

    /**
     * The trainer's CURRENT work (Remove trainer): batches they run that are still upcoming or ongoing — the
     * only batches a Super Admin can reassign to another trainer — and their scheduled or live classes. Completed
     * and cancelled batches and classes are history and never block. Exact database counts (no rows sent).
     */
    async countTrainerAssignments(trainerId: string): Promise<{ batches: number; classes: number }> {
      const supabase = await client("countTrainerAssignments");
      try {
        const [batches, classes] = await Promise.all([
          supabase.from("batches").select("id", { count: "exact", head: true }).eq("trainer_id", trainerId).in("status", ["upcoming", "ongoing"]),
          supabase.from("classes").select("id", { count: "exact", head: true }).eq("trainer_id", trainerId).in("status", ["scheduled", "live"]),
        ]);
        for (const r of [batches, classes]) {
          if (r.error) throw r.error;
          if (typeof r.count !== "number") throw new Error("no count");
        }
        return { batches: batches.count as number, classes: classes.count as number };
      } catch (err) {
        logDbError("countTrainerAssignments", err);
        throw new UsersRepositoryError();
      }
    },

    setAccountStatus(userId: string, status: AccountStatusColumn, reason: string | null): Promise<UsersFunctionOutcome> {
      return call("setAccountStatus", (s) => s.rpc("admin_set_account_status", { p_user_id: userId, p_status: status, p_reason: reason }));
    },

    setUserRole(userId: string, role: AppRoleColumn, details: Record<string, string>): Promise<UsersFunctionOutcome> {
      return call("setUserRole", (s) => s.rpc("admin_set_user_role", { p_user_id: userId, p_role: role, p_details: details }));
    },

    updateStudent(userId: string, patch: Record<string, Json>): Promise<UsersFunctionOutcome> {
      return call("updateStudent", (s) => s.rpc("admin_update_student", { p_student_id: userId, p: patch }));
    },

    updateTrainer(userId: string, patch: Record<string, Json>): Promise<UsersFunctionOutcome> {
      return call("updateTrainer", (s) => s.rpc("admin_update_trainer", { p_trainer_id: userId, p: patch }));
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
