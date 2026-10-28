import "server-only";
import { cookies } from "next/headers";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { authConfig, DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/config/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encodeDemoSession, decodeDemoSession } from "@/lib/auth/session";
import { fetchProfileRole, NO_ACCESS_MESSAGE } from "@/lib/auth/profile-role";
import type { AuthResult, AuthSession, AuthUser } from "@/types/auth";
import type { UserRole } from "@/types/user";

/**
 * Authentication repository — the only module allowed to know
 * *how* a session is actually established. Two isolated
 * implementations live behind one interface:
 *
 *  - Demo mode: a lightweight httpOnly cookie, used only when
 *    authConfig.mode === "demo" (see src/config/auth.ts — this can
 *    never silently activate in a production build).
 *  - Supabase mode: real Supabase Auth via @supabase/ssr, the
 *    production path.
 *
 * authService calls this; UI code never should. Every Supabase SDK
 * call below is wrapped in try/catch — Supabase being unreachable
 * (network failure, outage) must degrade to a safe, generic error
 * message, never an unhandled exception/raw 500.
 */

const GENERIC_AUTH_ERROR = "Something went wrong. Please try again in a moment.";

function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** Logs full detail server-side only; callers only ever see GENERIC_AUTH_ERROR. */
function logAuthError(context: string, error: unknown) {
  console.error(`[auth] ${context}:`, error instanceof Error ? error.message : error);
}

/**
 * Builds the AuthUser for a Supabase user. `role` must come from
 * fetchProfileRole() (public.profiles) — never from user_metadata,
 * which the user can edit themselves. user_metadata is read below for
 * display-only fields (name, avatar) and grants nothing.
 */
function mapSupabaseUser(user: SupabaseUser, role: UserRole): AuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    fullName: (user.user_metadata?.full_name as string | undefined) ?? user.email ?? "Unknown user",
    role,
    avatarUrl: user.user_metadata?.avatar_url as string | undefined,
    isActive: true,
    createdAt: user.created_at,
  };
}

async function loginDemo(email: string, password: string, rememberMe?: boolean): Promise<AuthResult> {
  const account = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());

  // Deliberately generic error either way — never reveal whether the
  // email matched a known account.
  if (!account || password !== DEMO_PASSWORD) {
    return { success: false, error: "Invalid email or password." };
  }

  const now = Date.now();
  const maxAgeSeconds = rememberMe ? authConfig.session.rememberMeMaxAgeSeconds : authConfig.session.maxAgeSeconds;

  const user: AuthUser = {
    id: `demo_${account.role}`,
    email: account.email,
    fullName: account.fullName,
    role: account.role,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const token = encodeDemoSession({
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    issuedAt: now,
    expiresAt: now + maxAgeSeconds * 1000,
  });

  const cookieStore = await cookies();
  cookieStore.set(authConfig.session.cookieName, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });

  return { success: true, user };
}

async function loginSupabase(email: string, password: string): Promise<AuthResult> {
  // Note: `rememberMe` isn't threaded through here. Supabase's session
  // cookie lifetime is governed by the project's configured JWT/
  // refresh-token expiry (Auth settings in the Supabase dashboard),
  // not a per-login-call option in the current @supabase/ssr API, and
  // middleware unconditionally refreshes that cookie on every request
  // (see lib/supabase/middleware.ts) — so a session-only cookie set
  // here would just get re-persisted on the very next request anyway.
  // Demo mode's rememberMe (above) works because it owns its cookie
  // end-to-end with no such refresh step.
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { success: false, error: "Authentication isn't configured yet. Contact your administrator." };
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      // Supabase distinguishes invalid-credentials from other errors
      // via error.status/name, but we intentionally collapse anything
      // here to one message — never reveal whether the account exists,
      // whether the password was close, etc.
      return { success: false, error: "Invalid email or password." };
    }

    // Credentials are valid, but access also requires a profile with a
    // recognised role. Without one, fail closed: end the session that
    // signInWithPassword just created so no half-authorized cookie
    // remains.
    const role = await fetchProfileRole(supabase, data.user.id);
    if (!role) {
      await supabase.auth.signOut();
      // Same message for no profile, invited, suspended or unknown role — never reveals which.
      return { success: false, error: NO_ACCESS_MESSAGE };
    }

    return { success: true, user: mapSupabaseUser(data.user, role) };
  } catch (err) {
    logAuthError("signInWithPassword failed unexpectedly", err);
    return { success: false, error: GENERIC_AUTH_ERROR };
  }
}

export const authRepository = {
  /** `rememberMe` only affects session length in demo mode — see the note in loginSupabase(). */
  async login(email: string, password: string, rememberMe?: boolean): Promise<AuthResult> {
    return authConfig.mode === "demo" ? loginDemo(email, password, rememberMe) : loginSupabase(email, password);
  },

  async logout(): Promise<void> {
    if (authConfig.mode === "demo") {
      const cookieStore = await cookies();
      cookieStore.delete(authConfig.session.cookieName);
      return;
    }

    try {
      const supabase = await createSupabaseServerClient();
      await supabase?.auth.signOut();
    } catch (err) {
      // Logout must never throw — worst case, the session cookie
      // simply expires on its own. Log and move on.
      logAuthError("signOut failed unexpectedly", err);
    }
  },

  async getSession(): Promise<AuthSession | null> {
    if (authConfig.mode === "demo") {
      const cookieStore = await cookies();
      const payload = decodeDemoSession(cookieStore.get(authConfig.session.cookieName)?.value);
      if (!payload) return null;

      return {
        user: {
          id: payload.userId,
          email: payload.email,
          fullName: payload.fullName,
          role: payload.role,
          isActive: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        expiresAt: payload.expiresAt,
      };
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) return null;

    try {
      // getUser() revalidates the token against Supabase directly and
      // is the recommended call for server-side trust decisions —
      // getSession() alone only reads the (possibly stale) local
      // cookie and must never be used as the sole authorization check.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;

      // No profile / unrecognised role -> treated exactly like "not
      // signed in" (fail closed); fetchProfileRole logs the reason.
      const role = await fetchProfileRole(supabase, user.id);
      if (!role) return null;

      const {
        data: { session },
      } = await supabase.auth.getSession();

      return {
        user: mapSupabaseUser(user, role),
        expiresAt: session?.expires_at ? session.expires_at * 1000 : Date.now() + authConfig.session.maxAgeSeconds * 1000,
      };
    } catch (err) {
      // Supabase unreachable / expired-and-unrefreshable session —
      // treat as "not authenticated" (fail closed) rather than
      // throwing and breaking the page.
      logAuthError("getSession failed unexpectedly", err);
      return null;
    }
  },

  async requestPasswordReset(email: string): Promise<void> {
    if (authConfig.mode === "demo") {
      // Simulated — demo mode has no real mailbox to send to.
      return;
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) return;

    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${appUrl}/auth/callback?next=/reset-password`,
      });
    } catch (err) {
      // Never let this surface to the caller — the UI always shows a
      // generic "check your email" message regardless (see
      // requestPasswordResetAction), so a delivery-side failure here
      // is logged only, not exposed.
      logAuthError("resetPasswordForEmail failed unexpectedly", err);
    }
  },

  async updatePassword(newPassword: string): Promise<{ error?: string }> {
    if (authConfig.mode === "demo") {
      return { error: "Password updates aren't available in demo mode." };
    }

    const supabase = await createSupabaseServerClient();
    if (!supabase) return { error: "Authentication isn't configured yet." };

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      return error ? { error: "We couldn't update your password. The reset link may have expired." } : {};
    } catch (err) {
      logAuthError("updateUser (password) failed unexpectedly", err);
      return { error: GENERIC_AUTH_ERROR };
    }
  },
};
