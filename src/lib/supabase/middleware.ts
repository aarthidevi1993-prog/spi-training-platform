import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchProfileRole } from "@/lib/auth/profile-role";
import type { UserRole } from "@/types/user";
import type { Database } from "./types";

export interface SupabaseSessionResult {
  response: NextResponse;
  user: User | null;
  /**
   * Role from public.profiles — only resolved when requested and a
   * user is present; otherwise null. Never derived from user_metadata.
   */
  role: UserRole | null;
}

/**
 * Refreshes the Supabase session cookie on every request that passes
 * through middleware, per the current @supabase/ssr Next.js pattern.
 * This keeps the access token from silently expiring between
 * requests — without it, a Server Component could see a valid-looking
 * but stale/expired session.
 *
 * Returns the (possibly cookie-updated) response plus the resolved
 * user (and, for protected routes, their profile role), so the caller
 * (middleware.ts) can make routing decisions with the same client.
 */
export async function updateSupabaseSession(
  request: NextRequest,
  options: { resolveRole?: boolean } = {}
): Promise<SupabaseSessionResult> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    return { response, user: null, role: null };
  }

  const supabase = createServerClient<Database, "public">(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const role = user && options.resolveRole ? await fetchProfileRole(supabase, user.id) : null;

    // `response` is read only now, after every call that may have
    // refreshed cookies via setAll above.
    return { response, user, role };
  } catch (err) {
    // Supabase unreachable — fail closed (treat as unauthenticated)
    // rather than throwing inside middleware, which would 500 every
    // request. Route protection below then redirects to /login as
    // it would for any other unauthenticated visitor.
    console.error("[auth] middleware session refresh failed unexpectedly:", err instanceof Error ? err.message : err);
    return { response, user: null, role: null };
  }
}
