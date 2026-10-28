import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRoleColumn, Database } from "@/lib/supabase/types";
import type { UserRole } from "@/types/user";

/**
 * Production (Supabase) role resolution — the ONLY place the app
 * derives a role for a Supabase user.
 *
 * The role comes exclusively from public.profiles.role (see
 * supabase/migrations/0002_profiles_roles.sql), read through the
 * caller's own RLS-scoped client. `user_metadata` is user-writable
 * (supabase.auth.updateUser / signUp) and is never consulted here.
 *
 * Account status (0016): only an ACTIVE account has a usable role.
 * Invited and suspended accounts get `null`, exactly like a user with
 * no profile — the database enforces the same (current_app_role() and
 * RLS), and with 0016 an inactive account cannot even read its own
 * profile row. Callers show one generic message (NO_ACCESS_MESSAGE)
 * whatever the reason, so the status is never revealed.
 *
 * Fails closed: any error, missing profile, inactive account or
 * unrecognised value yields `null`, which every caller treats as
 * "not authorized". There is no default role.
 *
 * Kept free of `server-only` / `next/headers` so the same logic runs
 * in the Edge middleware and in server components/actions.
 *
 * Demo mode never calls this — it has its own, separate cookie-based
 * identity (src/lib/auth/session.ts).
 */

/**
 * Database role -> application role. The database uses the explicit
 * name `super_admin`; the application has always called that role
 * `admin` (routes under /admin, labelled "Super Admin" in the UI via
 * ROLE_LABEL). Mapping here, at the boundary, keeps every existing
 * route, guard and permission unchanged.
 */
const DB_ROLE_TO_USER_ROLE: Record<AppRoleColumn, UserRole> = {
  super_admin: "admin",
  trainer: "trainer",
  student: "student",
};

function isAppRole(value: unknown): value is AppRoleColumn {
  return value === "super_admin" || value === "trainer" || value === "student";
}

export function mapProfileRole(value: unknown): UserRole | null {
  return isAppRole(value) ? DB_ROLE_TO_USER_ROLE[value] : null;
}

/** Shown for every signed-in account without access (no profile, invited, suspended, unknown role). */
export const NO_ACCESS_MESSAGE = "Your account isn't set up for access yet. Contact your administrator.";

/** Application role for a profile row: only an active account with a known role has one. */
export function resolveProfileRole(row: { role?: unknown; account_status?: unknown } | null | undefined): UserRole | null {
  if (!row || row.account_status !== "active") return null;
  return mapProfileRole(row.role);
}

export async function fetchProfileRole(
  supabase: SupabaseClient<Database, "public">,
  userId: string
): Promise<UserRole | null> {
  try {
    const { data, error } = await supabase.from("profiles").select("role, account_status").eq("id", userId).maybeSingle();

    if (error) {
      console.error("[auth] profile role lookup failed:", error.message);
      return null;
    }

    if (!data) {
      // Also what an invited/suspended account sees once 0016 is applied (RLS hides its own row).
      console.warn(`[auth] Supabase user ${userId} has no readable profile; access denied.`);
      return null;
    }

    if (data.account_status !== "active") {
      console.warn(`[auth] Supabase user ${userId} does not have an active account; access denied.`);
      return null;
    }

    const role = resolveProfileRole(data);
    if (!role) {
      console.warn(`[auth] Supabase user ${userId} has an unrecognised profile role; access denied.`);
    }
    return role;
  } catch (err) {
    console.error("[auth] profile role lookup failed unexpectedly:", err instanceof Error ? err.message : err);
    return null;
  }
}
