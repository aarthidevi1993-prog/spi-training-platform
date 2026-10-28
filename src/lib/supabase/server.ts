import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "./types";

/**
 * Server-side Supabase client (Server Components, Route Handlers,
 * Server Actions). Uses the publishable/anon key plus the caller's
 * cookies so Row Level Security still applies — this is NOT the
 * admin client.
 *
 * Returns `null` until NEXT_PUBLIC_SUPABASE_URL / PUBLISHABLE_KEY
 * are set, which is what allows demo auth mode to run without a
 * Supabase project configured.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient<Database, "public"> | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient<Database, "public">(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component with no request context —
          // safe to ignore when middleware refreshes the session.
        }
      },
    },
  });
}
