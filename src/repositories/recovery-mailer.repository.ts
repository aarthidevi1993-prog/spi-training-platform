import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { createRecoveryMailerRepository } from "./recovery-mailer.repository.core";

/**
 * The recovery sign-in e-mail sender (P5.2) bound to a SESSION-LESS public
 * client: the publishable/anon key only, no cookies, no stored or refreshed
 * session. Deliberately NOT src/lib/supabase/admin.ts (service role) and NOT
 * the caller's cookie client (the Super Admin's session).
 */
function createSessionlessPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !publishableKey) return null;
  return createClient<Database, "public">(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export const recoveryMailerRepository = createRecoveryMailerRepository(createSessionlessPublicClient);

export type { RecoveryMailerRepository } from "./recovery-mailer.repository.core";
