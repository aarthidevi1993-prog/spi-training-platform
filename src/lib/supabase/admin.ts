import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Privileged Supabase client using the service role key.
 *
 * SERVER-ONLY. Bypasses Row Level Security, so it must never be
 * imported into a client component or a file that ships to the
 * browser — the `server-only` import above enforces that at build
 * time. Use this exclusively from trusted repository/service code
 * (e.g. admin batch operations, scheduled jobs).
 */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return null;
  }

  return createClient<Database, "public">(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
