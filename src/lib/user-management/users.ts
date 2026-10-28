/**
 * Users view (Phase 7 P3.2) — pure logic: URL filter validation, row
 * mapping, search, deterministic sorting and paging. No database, no
 * session, no `server-only`: tested directly by tests/user-management.
 *
 * Authorization is NOT decided here. Every record passed in was already
 * returned by the database under the viewer's own session (RLS), and
 * usersService admits only Super Admins. The filters below can only
 * narrow that set — they never add rows.
 */
import type {
  AccountStatus,
  AccountStatusFilter,
  DomainRecordFilter,
  DomainRecordSummary,
  PersonStatus,
  UserBatchRef,
  UserBatchSummary,
  UserListFilters,
  UserListPage,
  UserRoleFilter,
  UserSummary,
} from "@/types/user-management";
import type { UserRole } from "@/types/user";

export const USERS_PAGE_SIZE = 25;
export const SEARCH_MAX_LENGTH = 100;
const PAGE_MAX = 100_000;

// -------------------------------------------------------------------
// Records as read from the database (one embedded read per page of
// profiles; see users.repository.core.ts). One-to-one embeds may arrive
// as an object or a one-element array, so both are accepted.
// -------------------------------------------------------------------
export type OneOrMany<T> = T | T[] | null | undefined;

export interface UserBatchRecord {
  id: string;
  batch_code: string;
  name: string;
  status: string;
}

export interface UserStudentRecord {
  student_code: string;
  full_name: string;
  status: string;
  student_details: OneOrMany<{ email: string | null }>;
  batch_students: { enrollment_status: string; batches: OneOrMany<UserBatchRecord> }[] | null;
}

export interface UserTrainerRecord {
  trainer_code: string;
  full_name: string;
  status: string;
  trainer_details: OneOrMany<{ email: string | null }>;
  batches: UserBatchRecord[] | null;
}

export interface UserProfileRecord {
  id: string;
  role: string;
  account_status: string;
  account_status_changed_at: string;
  created_at: string;
  updated_at: string;
  students: OneOrMany<UserStudentRecord>;
  trainers: OneOrMany<UserTrainerRecord>;
}

/**
 * The name an account was invited with and when it accepted, from its ACCEPTED invitation (user_invitations,
 * read under the Super Admin's own session — RLS user_invitations_admin_select). The only identity a Super Admin
 * account has: it has no student/trainer record. Never the invitation's address, a token or Auth data, and
 * never a pending, revoked or expired invitation.
 */
export interface UserIdentityRecord {
  id?: string;
  accepted_user_id: string;
  full_name: string | null;
  accepted_at: string | null;
}

/** One identity per account: the most recently accepted invitation (then the larger invitation id, for a stable choice). */
export function identityIndex(records: readonly UserIdentityRecord[] | null | undefined): Map<string, UserIdentityRecord> {
  const index = new Map<string, UserIdentityRecord>();
  for (const r of records ?? []) {
    if (!r || typeof r.accepted_user_id !== "string") continue;
    const kept = index.get(r.accepted_user_id);
    const newer = !kept || (r.accepted_at ?? "") > (kept.accepted_at ?? "") || ((r.accepted_at ?? "") === (kept.accepted_at ?? "") && (r.id ?? "") > (kept.id ?? ""));
    if (newer) index.set(r.accepted_user_id, r);
  }
  return index;
}

const trimmed = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function one<T>(value: OneOrMany<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// -------------------------------------------------------------------
// Labels
// -------------------------------------------------------------------
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
};

export const PERSON_STATUS_LABEL: Record<PersonStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  invited: "Invited",
};

export const RECORD_FILTER_LABEL: Record<DomainRecordFilter, string> = {
  all: "Any record",
  active: "Record active",
  inactive: "Record inactive",
  invited: "Record invited",
  missing: "Record missing",
};

// -------------------------------------------------------------------
// Filters (from URL search params)
// -------------------------------------------------------------------
const ROLE_VALUES: readonly UserRoleFilter[] = ["all", "admin", "trainer", "student"];
const STATUS_VALUES: readonly AccountStatusFilter[] = ["all", "invited", "active", "suspended"];
const RECORD_VALUES: readonly DomainRecordFilter[] = ["all", "active", "inactive", "invited", "missing"];

export const DEFAULT_USER_FILTERS: UserListFilters = { q: "", role: "all", status: "all", record: "all", page: 1 };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `value` when it is one of `allowed`, otherwise "all". */
function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | "all" {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : "all";
}

/** Trimmed, whitespace-collapsed, control characters removed, at most SEARCH_MAX_LENGTH characters. */
export function normalizeSearch(value: string | undefined): string {
  if (!value) return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, SEARCH_MAX_LENGTH).join("").trim();
}

/** Only whitelisted values survive; anything else falls back to the default. Never throws. */
export function parseUserListFilters(params: SearchParams | null | undefined): UserListFilters {
  const p = params ?? {};
  const rawPage = first(p.page);
  const page = rawPage !== undefined && /^\d{1,6}$/.test(rawPage) ? Math.min(Math.max(Number(rawPage), 1), PAGE_MAX) : 1;
  return {
    q: normalizeSearch(first(p.q)),
    role: pick(first(p.role), ROLE_VALUES),
    status: pick(first(p.status), STATUS_VALUES),
    record: pick(first(p.record), RECORD_VALUES),
    page,
  };
}

/** The page URL for these filters (defaults omitted), so every view is shareable. */
export function usersHref(basePath: string, filters: UserListFilters, changes: Partial<UserListFilters> = {}): string {
  const f = { ...filters, ...changes };
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.role !== "all") params.set("role", f.role);
  if (f.status !== "all") params.set("status", f.status);
  if (f.record !== "all") params.set("record", f.record);
  if (f.page > 1) params.set("page", String(f.page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** The same view with one account's detail panel open (P3.3). */
export function userDetailHref(basePath: string, filters: UserListFilters, userId: string): string {
  const href = usersHref(basePath, filters);
  return `${href}${href.includes("?") ? "&" : "?"}user=${encodeURIComponent(userId)}`;
}

/** `?edit=` value that opens the detail panel with its existing details form already open (P3.11-C). */
export const EDIT_DETAILS_PARAM = "details";

/** The detail panel of one account with its details form open — the same form and save path as the panel's Edit. */
export function userEditDetailsHref(basePath: string, filters: UserListFilters, userId: string): string {
  return `${userDetailHref(basePath, filters, userId)}&edit=${EDIT_DETAILS_PARAM}`;
}

// -------------------------------------------------------------------
// Mapping
// -------------------------------------------------------------------
const DB_ROLE: Record<string, UserRole> = { super_admin: "admin", trainer: "trainer", student: "student" };
const ACCOUNT_STATUSES: readonly string[] = ["invited", "active", "suspended"];
const PERSON_STATUSES: readonly string[] = ["active", "inactive", "invited"];
const BATCH_STATUSES: readonly string[] = ["upcoming", "ongoing", "completed", "cancelled"];

function personStatus(value: string): PersonStatus {
  // The database enum only has these values; anything else is shown as inactive (never as active).
  return PERSON_STATUSES.includes(value) ? (value as PersonStatus) : "inactive";
}

function batchRef(b: UserBatchRecord): UserBatchRef {
  return {
    id: b.id,
    code: b.batch_code,
    name: b.name,
    status: (BATCH_STATUSES.includes(b.status) ? b.status : "cancelled") as UserBatchRef["status"],
  };
}

const byCode = (a: UserBatchRef, b: UserBatchRef) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function studentBatches(s: UserStudentRecord): UserBatchSummary {
  const summary: UserBatchSummary = { current: [], completed: 0, withdrawn: 0 };
  for (const e of s.batch_students ?? []) {
    const batch = one(e.batches);
    if (!batch) continue;
    if (e.enrollment_status === "enrolled" && batch.status !== "cancelled") summary.current.push(batchRef(batch));
    else if (e.enrollment_status === "completed") summary.completed += 1;
    else if (e.enrollment_status === "withdrawn") summary.withdrawn += 1;
  }
  summary.current.sort(byCode);
  return summary;
}

function trainerBatches(t: UserTrainerRecord): UserBatchSummary {
  const summary: UserBatchSummary = { current: [], completed: 0, withdrawn: 0 };
  for (const b of t.batches ?? []) {
    if (b.status === "upcoming" || b.status === "ongoing") summary.current.push(batchRef(b));
    else if (b.status === "completed") summary.completed += 1;
  }
  summary.current.sort(byCode);
  return summary;
}

function studentRecord(s: UserStudentRecord): DomainRecordSummary {
  return { kind: "student", code: s.student_code, status: personStatus(s.status) };
}

function trainerRecord(t: UserTrainerRecord): DomainRecordSummary {
  return { kind: "trainer", code: t.trainer_code, status: personStatus(t.status) };
}

const emailOf = (details: OneOrMany<{ email: string | null }>): string | null => {
  const email = one(details)?.email?.trim();
  return email ? email : null;
};

/**
 * One profile (with whatever domain data the viewer could read) → one Users row. The domain record stays the
 * source of name and email; the accepted invitation (`identity`) only fills a missing NAME — which is how a
 * Super Admin account gets its name. It never provides an email.
 */
export function mapUserRecord(r: UserProfileRecord, identity: UserIdentityRecord | null = null): UserSummary {
  const role = DB_ROLE[r.role] ?? null;
  const student = one(r.students);
  const trainer = one(r.trainers);
  const own = role === "student" ? student : role === "trainer" ? trainer : null;
  const other = role === "student" ? trainer : role === "trainer" ? student : null;

  let record: DomainRecordSummary | null = null;
  let otherRecord: DomainRecordSummary | null = null;
  let batches: UserBatchSummary | null = null;
  if (role === "student" && student) {
    record = studentRecord(student);
    batches = studentBatches(student);
  } else if (role === "trainer" && trainer) {
    record = trainerRecord(trainer);
    batches = trainerBatches(trainer);
  }
  if (role === "student" && trainer) otherRecord = trainerRecord(trainer);
  else if (role === "trainer" && student) otherRecord = studentRecord(student);
  else if (role !== "student" && role !== "trainer") otherRecord = student ? studentRecord(student) : trainer ? trainerRecord(trainer) : null;

  // Name and email: the current role's record first, then any other record of the same person.
  const named = own ?? other ?? student ?? trainer;
  const email =
    (role === "student" && student ? emailOf(student.student_details) : null) ??
    (role === "trainer" && trainer ? emailOf(trainer.trainer_details) : null) ??
    (student ? emailOf(student.student_details) : null) ??
    (trainer ? emailOf(trainer.trainer_details) : null);

  // The accepted invitation fills only a missing name (a Super Admin has no record); never an email.
  const invited = identity && identity.accepted_user_id === r.id ? identity : null;

  return {
    id: r.id,
    name: named?.full_name?.trim() || trimmed(invited?.full_name),
    email,
    role,
    // Unknown values cannot exist (enum); never present one as active.
    accountStatus: (ACCOUNT_STATUSES.includes(r.account_status) ? r.account_status : "suspended") as AccountStatus,
    accountStatusChangedAt: r.account_status_changed_at,
    recordState: role === "student" || role === "trainer" ? (record ? "present" : "missing") : "not_applicable",
    record,
    otherRecord,
    batches,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// -------------------------------------------------------------------
// Search, filter, sort, page
// -------------------------------------------------------------------
export function matchesFilters(u: UserSummary, f: UserListFilters): boolean {
  if (f.role !== "all" && u.role !== f.role) return false;
  if (f.status !== "all" && u.accountStatus !== f.status) return false;
  if (f.record === "missing" && u.recordState !== "missing") return false;
  if (f.record !== "all" && f.record !== "missing" && u.record?.status !== f.record) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const haystack = [u.name, u.email, u.record?.code, u.otherRecord?.code, u.id];
    if (!haystack.some((v) => v && v.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** lower(name) ascending, accounts without a name last, then id — always the same order. */
export function compareUsers(a: UserSummary, b: UserSummary): number {
  const an = a.name?.toLowerCase() ?? null;
  const bn = b.name?.toLowerCase() ?? null;
  if (an !== bn) {
    if (an === null) return 1;
    if (bn === null) return -1;
    return an < bn ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The requested page (clamped to the last page) of the filtered, sorted rows, plus totals. */
export function buildUserListPage(
  records: UserProfileRecord[],
  filters: UserListFilters,
  pageSize: number = USERS_PAGE_SIZE,
  identities: readonly UserIdentityRecord[] = []
): UserListPage {
  const index = identityIndex(identities);
  const all = records.map((r) => mapUserRecord(r, index.get(r.id) ?? null));
  const totals = {
    all: all.length,
    byStatus: { invited: 0, active: 0, suspended: 0 } as Record<AccountStatus, number>,
    missingRecord: 0,
  };
  for (const u of all) {
    totals.byStatus[u.accountStatus] += 1;
    if (u.recordState === "missing") totals.missingRecord += 1;
  }
  const matching = all.filter((u) => matchesFilters(u, filters)).sort(compareUsers);
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(filters.page, pageCount);
  return {
    rows: matching.slice((page - 1) * pageSize, page * pageSize),
    filters: { ...filters, page },
    matching: matching.length,
    page,
    pageCount,
    pageSize,
    totals,
  };
}
