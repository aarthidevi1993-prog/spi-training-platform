"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Browser-side Supabase client, for use inside client components.
 * Reads only the public (safe-to-expose) env vars. Returns `null`
 * when those vars aren't configured yet — in that state the app runs
 * in demo auth mode (see src/config/auth.ts) instead of talking to a
 * live Supabase project.
 *
 * Supabase's newer projects issue a "publishable" key
 * (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY); older projects call the
 * same kind of key the "anon" key. Both are accepted here so this
 * works with either generation of project settings.
 */
export function createSupabaseBrowserClient(): SupabaseClient<Database, "public"> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    return null;
  }

  return createBrowserClient<Database, "public">(url, publishableKey);
}
