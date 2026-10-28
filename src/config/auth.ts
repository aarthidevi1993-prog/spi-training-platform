import type { UserRole } from "@/types/user";

export type AuthMode = "supabase" | "demo";

export interface DemoAccount {
  email: string;
  fullName: string;
  role: UserRole;
}

function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

/**
 * Resolves once at build/boot time from NEXT_PUBLIC_* env vars, which
 * Next.js inlines statically — so the client and the server always
 * agree on the mode without an extra round trip.
 *
 * Resolution order:
 *  0. Production (NODE_ENV === "production", i.e. `next build` /
 *     `next start` / any deployment): ALWAYS "supabase". Demo mode's
 *     unsigned session cookie and public passwords are a local
 *     development convenience only and must never be reachable in
 *     production — not even via NEXT_PUBLIC_AUTH_MODE=demo. Without
 *     Supabase configured, production fails safely with a clear
 *     "authentication isn't configured" error.
 *  1. Development: NEXT_PUBLIC_AUTH_MODE="supabase" or "demo" wins.
 *  2. Otherwise: use Supabase if it's configured.
 *  3. Otherwise: demo mode.
 */
function resolveAuthMode(): AuthMode {
  const explicit = process.env.NEXT_PUBLIC_AUTH_MODE;

  if (process.env.NODE_ENV === "production") {
    if (explicit === "demo" && typeof window === "undefined") {
      console.warn('[auth] NEXT_PUBLIC_AUTH_MODE="demo" is ignored in production; using Supabase authentication.');
    }
    return "supabase";
  }

  if (explicit === "supabase") return "supabase";
  if (explicit === "demo") return "demo";

  if (isSupabaseConfigured()) return "supabase";

  return "demo";
}

const mode = resolveAuthMode();

/**
 * Demo accounts — public, intentionally non-secret, and only ever
 * usable when authConfig.mode === "demo". See src/repositories/auth.repository.ts
 * for where the password is actually checked.
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: "admin@spi-training.local", fullName: "Demo Super Admin", role: "admin" },
  { email: "trainer@spi-training.local", fullName: "Demo Trainer", role: "trainer" },
  { email: "student@spi-training.local", fullName: "Demo Student", role: "student" },
];

export const DEMO_PASSWORD = "Demo@12345";

export const authConfig = {
  mode,
  isSupabaseConfigured: isSupabaseConfigured(),
  session: {
    cookieName: "spi_auth_session",
    /** 8 hours, in seconds. */
    maxAgeSeconds: 60 * 60 * 8,
    /** 30 days, in seconds — used when "remember me" is checked. */
    rememberMeMaxAgeSeconds: 60 * 60 * 24 * 30,
  },
  passwordRules: {
    minLength: 8,
  },
  availableRoles: ["admin", "trainer", "student"] as UserRole[],
  demo: {
    enabled: mode === "demo",
    accounts: DEMO_ACCOUNTS,
    password: DEMO_PASSWORD,
  },
} as const;
