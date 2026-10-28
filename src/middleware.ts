import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authConfig } from "@/config/auth";
import { decodeDemoSession } from "@/lib/auth/session";
import { updateSupabaseSession, type SupabaseSessionResult } from "@/lib/supabase/middleware";
import { decidePortalAccess, getPortalForPath } from "@/lib/auth/roles";
import type { UserRole } from "@/types/user";

/**
 * Edge-level route protection — the first (and cheapest) of the two
 * enforcement layers described in the PART 2 brief; RoleGuard in each
 * portal layout is the second, authoritative one. Also refreshes the
 * Supabase session cookie on every request (see
 * lib/supabase/middleware.ts) so tokens don't silently expire between
 * page loads.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requiredPortal = getPortalForPath(pathname);

  // In Supabase mode, always run the refresh so cookies stay valid —
  // even on public pages like /login, which redirects away if a
  // session already exists.
  // The profile role is only looked up for protected portal routes, so
  // public pages cost no extra query.
  const supabaseResult: SupabaseSessionResult =
    authConfig.mode === "supabase"
      ? await updateSupabaseSession(request, { resolveRole: requiredPortal !== null })
      : { response: NextResponse.next({ request }), user: null, role: null };

  if (!requiredPortal) {
    // Public/marketing/auth pages — nothing further to enforce here.
    return supabaseResult.response;
  }

  let role: UserRole | null = null;

  if (authConfig.mode === "demo") {
    // Local development only — separate cookie-based identity.
    const payload = decodeDemoSession(request.cookies.get(authConfig.session.cookieName)?.value);
    role = payload?.role ?? null;
  } else {
    // Production: role from public.profiles only (see
    // lib/auth/profile-role.ts). A signed-in user with no profile, an
    // inactive (invited/suspended) account or an unrecognised role gets
    // null here and is treated as signed out.
    role = supabaseResult.role;
  }

  const decision = decidePortalAccess(requiredPortal, role);
  if (decision === "login") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (decision === "unauthorized") {
    return NextResponse.redirect(new URL("/unauthorized", request.url));
  }

  return supabaseResult.response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
