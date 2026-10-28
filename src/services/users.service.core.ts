/**
 * Users service (Phase 7 P3.2 read-only view, P3.3 lifecycle actions)
 * for Super Admins.
 *
 * Identity always comes from getCurrentUser (the server session), never
 * from a client argument. Only an active Super Admin ("admin") may list
 * users or act on them; everyone else is refused here, in addition to
 * the admin portal's middleware/RoleGuard. RLS still decides every row
 * read, and every change is made by a 0017 database function that
 * re-checks the caller, the target, the transition, self-protection and
 * the last-active-Super-Admin rule, and records the audit row itself.
 * Browser values (ids, statuses, roles, details) are validated against
 * fixed whitelists first; database answers become safe messages — no
 * database detail is ever returned.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; users.service.ts wires the real session.
 */
import type { AuthUser } from "@/types/auth";
import type { UserDetail, UserListPage } from "@/types/user-management";
import { USERS_PAGE_SIZE, buildUserListPage, identityIndex, one, parseUserListFilters, type UserIdentityRecord } from "@/lib/user-management/users";
import type { UserAuditRecord } from "@/lib/user-management/lifecycle";
import {
  DETAILS_REASON_MESSAGE,
  REMOVE_AUDIT_REASON,
  REMOVE_LABEL,
  REMOVE_REASON_MESSAGE,
  ROLE_REASON_MESSAGE,
  STATUS_REASON_MESSAGE,
  trainerAssignmentsMessage,
  type RemovableRole,
  buildDetailsPatch,
  buildRoleDetails,
  errorCodeMessage,
  isUuid,
  mapUserDetail,
  normalizeReason,
  parseTargetRole,
  parseTargetStatus,
  reasonMessage,
} from "@/lib/user-management/lifecycle";
import { UsersFunctionError, type UsersFunctionOutcome, type UsersRepository } from "@/repositories/users.repository.core";

export class UsersAuthorizationError extends Error {
  constructor(message = "Only Super Admins can view users.") {
    super(message);
    this.name = "UsersAuthorizationError";
  }
}

/** A refused or invalid lifecycle action; the message is safe to show. */
export class UsersActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsersActionError";
  }
}

export interface UsersServiceDeps {
  repository: UsersRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** Demo mode has no profiles: the view is empty rather than invented. */
  isDemoMode?: () => boolean;
  pageSize?: number;
  /** The clock used to show a pending invitation past its expiry as expired (tests inject it). */
  now?: () => Date;
  /**
   * P5.2: whether recovery e-mails are switched on (server-only setting, default off). Only decides whether the
   * panel OFFERS "Send sign-in link"; the invitations service still refuses on its own when it is off.
   */
  isRecoveryEnabled?: () => boolean;
}

type SearchParams = Record<string, string | string[] | undefined>;

const ROLE_SUCCESS: Record<string, string> = { super_admin: "Super Admin", trainer: "Trainer", student: "Student" };

export function createUsersService(deps: UsersServiceDeps) {
  async function requireSuperAdmin(message?: string): Promise<AuthUser> {
    const user = await deps.getCurrentUser();
    if (!user) throw new UsersAuthorizationError("You need to be signed in.");
    // "admin" is the application name for the super_admin profile role.
    if (user.role !== "admin") throw new UsersAuthorizationError(message);
    return user;
  }

  function requireActions(): void {
    if (deps.isDemoMode?.()) throw new UsersActionError("Account changes aren't available in demo mode.");
  }

  function targetId(userId: unknown): string {
    if (!isUuid(userId)) throw new UsersActionError("That account no longer exists.");
    return userId;
  }

  /** Runs one 0017 function and turns its answer (or raised error) into a safe outcome. */
  async function perform(fn: () => Promise<UsersFunctionOutcome>, reasons: Record<string, string>): Promise<UsersFunctionOutcome> {
    let outcome: UsersFunctionOutcome;
    try {
      outcome = await fn();
    } catch (err) {
      if (err instanceof UsersFunctionError) throw new UsersActionError(errorCodeMessage(err.code));
      throw new UsersActionError("The change could not be made. Please try again.");
    }
    if (!outcome.ok) throw new UsersActionError(reasonMessage(reasons, outcome.reason));
    return outcome;
  }

  /**
   * Accepted-invitation identities (Super Admin view only: every caller has passed requireSuperAdmin). An
   * identity is an improvement, never a requirement: a failed read (already logged by the repository) leaves
   * the names out instead of failing the page.
   */
  async function acceptedIdentities(userIds?: readonly string[]): Promise<UserIdentityRecord[]> {
    if (!deps.repository.listAcceptedIdentities) return [];
    try {
      return await deps.repository.listAcceptedIdentities(userIds);
    } catch {
      return [];
    }
  }

  /** History actors other than the viewer → their name: own student/trainer record first, else accepted invitation. */
  async function actorNames(audit: UserAuditRecord[], viewerId: string): Promise<Map<string, string>> {
    const ids = [...new Set(audit.map((a) => a.actor_id).filter((id): id is string => typeof id === "string" && id !== viewerId))];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    if (deps.repository.listRecordNames) {
      try {
        for (const r of await deps.repository.listRecordNames(ids)) {
          const name = (one(r.students)?.full_name ?? one(r.trainers)?.full_name)?.trim();
          if (name) names.set(r.id, name);
        }
      } catch {
        // Logged by the repository; the history keeps the actor ids.
      }
    }
    for (const [id, identity] of identityIndex(await acceptedIdentities(ids.filter((id) => !names.has(id))))) {
      const name = identity.full_name?.trim();
      if (name) names.set(id, name);
    }
    return names;
  }

  async function loadDetail(viewer: AuthUser, userId: string): Promise<UserDetail | null> {
    const record = await deps.repository.getProfile(userId);
    if (!record) return null;
    // Only an invited account has an invitation to manage (P3.9); its events join the account history.
    const invitation = record.account_status === "invited" ? await deps.repository.getLatestInvitation(userId) : null;
    const audit = await deps.repository.listAuditEvents(userId, invitation?.id ?? null);
    // Only a suspended account needs its latest status change (never-activated hint, 0018).
    const latest = record.account_status === "suspended" ? await deps.repository.latestStatusChange(userId) : null;
    // P5.2: an invited account without a pending bound invitation may have an unbound one it can recover with a
    // sign-in link (the database decides eligibility; this only decides whether the button shows).
    const recovery =
      record.account_status === "invited" && invitation?.status !== "pending" && deps.repository.getRecoveryCandidate
        ? await deps.repository.getRecoveryCandidate(userId)
        : null;
    const identity = identityIndex(await acceptedIdentities([userId])).get(userId) ?? null;
    return mapUserDetail(record, audit, viewer.id, latest, invitation, deps.now?.() ?? new Date(), recovery, deps.isRecoveryEnabled?.() === true, {
      record: identity,
      actorNames: await actorNames(audit, viewer.id),
    });
  }

  /**
   * Remove = deactivate (P3.11-B): active → suspended through admin_set_account_status — never a deletion.
   * The target's role is read from the database (never taken from the browser) and must be the list's role;
   * a trainer with current batches or scheduled/live classes is refused until they are reassigned. The
   * database function re-checks Super Admin, self, the last active Super Admin and the transition.
   */
  async function removeAccount(kind: RemovableRole, userId: unknown): Promise<string> {
    const viewer = await requireSuperAdmin(`Only Super Admins can remove ${REMOVE_LABEL[kind]}s.`);
    requireActions();
    const id = targetId(userId);
    if (id === viewer.id) throw new UsersActionError(REMOVE_REASON_MESSAGE.cannot_change_self ?? "You can't remove your own account.");
    const record = await deps.repository.getProfile(id);
    if (!record) throw new UsersActionError(REMOVE_REASON_MESSAGE.not_found ?? "That account no longer exists.");
    if (record.role !== kind) throw new UsersActionError(`This account is not a ${REMOVE_LABEL[kind]}, so it can't be removed from this list.`);
    if (kind === "trainer") {
      const blocked = trainerAssignmentsMessage(await deps.repository.countTrainerAssignments(id));
      if (blocked) throw new UsersActionError(blocked);
    }
    await perform(() => deps.repository.setAccountStatus(id, "suspended", REMOVE_AUDIT_REASON[kind]), REMOVE_REASON_MESSAGE);
    return kind === "student"
      ? "Student removed. Their account is deactivated and they can no longer sign in; their training records are kept."
      : "Trainer removed. Their account is deactivated and they can no longer sign in; their records and authored content are kept.";
  }

  return {
    /** One page of users for the given URL search params. */
    async listUsers(searchParams: SearchParams | null | undefined): Promise<UserListPage> {
      await requireSuperAdmin();
      const filters = parseUserListFilters(searchParams);
      const records = deps.isDemoMode?.() ? [] : await deps.repository.listProfiles();
      // Super Admin accounts have no student/trainer record: their name (only — never an email) comes from the accepted invitation.
      const identities = records.length > 0 ? await acceptedIdentities() : [];
      return buildUserListPage(records, filters, deps.pageSize ?? USERS_PAGE_SIZE, identities);
    },

    /** One account with its contact details, history and available actions; null if unknown/unreadable. */
    async getUserDetail(userId: unknown): Promise<UserDetail | null> {
      const viewer = await requireSuperAdmin();
      if (deps.isDemoMode?.() || !isUuid(userId)) return null;
      return loadDetail(viewer, userId);
    },

    /** Suspend (active/invited → suspended) or reactivate (suspended → active). */
    async setAccountStatus(userId: unknown, status: unknown, reason: unknown): Promise<string> {
      await requireSuperAdmin("Only Super Admins can change account status.");
      requireActions();
      const id = targetId(userId);
      const target = parseTargetStatus(status);
      if (!target.ok) throw new UsersActionError(target.error);
      const why = normalizeReason(reason);
      if (!why.ok) throw new UsersActionError(why.error);
      await perform(() => deps.repository.setAccountStatus(id, target.value, why.value), STATUS_REASON_MESSAGE);
      return target.value === "suspended" ? "Account suspended. The user can no longer sign in." : "Account reactivated.";
    },

    /** Remove a student from the Students list: deactivate the account; every record is kept. */
    removeStudent(userId: unknown): Promise<string> {
      return removeAccount("student", userId);
    },

    /** Remove a trainer from the Trainers list once no current batch or scheduled/live class is assigned to them. */
    removeTrainer(userId: unknown): Promise<string> {
      return removeAccount("trainer", userId);
    },

    /**
     * Change the role of an active account — or, with its current role,
     * create the record that role is missing. A new record needs a full
     * name and gets a generated code (0020); an existing (inactive) one is
     * reactivated by the database and the old role's record is kept, marked inactive.
     */
    async changeRole(userId: unknown, role: unknown, recordInput: { fullName?: unknown } | null | undefined): Promise<string> {
      const viewer = await requireSuperAdmin("Only Super Admins can change roles.");
      requireActions();
      const id = targetId(userId);
      const target = parseTargetRole(role);
      if (!target.ok) throw new UsersActionError(target.error);
      // Which record the target role needs is read from the database, never taken from the browser.
      const detail = await loadDetail(viewer, id);
      if (!detail) throw new UsersActionError("That account no longer exists.");
      const needsRecord = target.value === "student" ? !detail.hasStudentRecord : target.value === "trainer" ? !detail.hasTrainerRecord : false;
      const details = buildRoleDetails(target.value, needsRecord, recordInput);
      if (!details.ok) throw new UsersActionError(details.error);
      const outcome = await perform(() => deps.repository.setUserRole(id, target.value, details.value), ROLE_REASON_MESSAGE);
      const sameRole = detail.user.role === (target.value === "super_admin" ? "admin" : target.value);
      const base = sameRole ? `${ROLE_SUCCESS[target.value]} record created.` : `Role changed to ${ROLE_SUCCESS[target.value]}.`;
      return outcome.code ? `${base} ${ROLE_SUCCESS[target.value]} code: ${outcome.code}.` : base;
    },

    /** Name and contact details of the account's current student/trainer record (changed fields only). */
    async updateDetails(userId: unknown, input: Record<string, unknown> | null | undefined): Promise<string> {
      const viewer = await requireSuperAdmin("Only Super Admins can edit user details.");
      requireActions();
      const id = targetId(userId);
      const detail = await loadDetail(viewer, id);
      if (!detail) throw new UsersActionError("That account no longer exists.");
      if (!detail.contact) throw new UsersActionError("This account has no student or trainer record to edit.");
      const patch = buildDetailsPatch(detail.contact, input);
      if (!patch.ok) throw new UsersActionError(patch.error);
      if (Object.keys(patch.value).length === 0) throw new UsersActionError("Nothing changed.");
      const contact = detail.contact;
      await perform(
        () => (contact.kind === "student" ? deps.repository.updateStudent(id, patch.value) : deps.repository.updateTrainer(id, patch.value)),
        DETAILS_REASON_MESSAGE
      );
      return "Details saved.";
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
