import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase Auth callback — completes the PKCE/email-link flow by
 * exchanging the one-time `code` for a session (writing the session
 * cookies via the server client's `setAll`), then redirects on:
 *   - email confirmation / magic link  -> `next` (defaults to "/")
 *   - password reset link              -> "/reset-password"
 *   - anything invalid/expired/missing -> "/login" with an error flag
 *
 * Only relevant when authConfig.mode === "supabase" — demo mode never
 * issues links that point here.
 */

const FALLBACK_REDIRECT_PATH = "/";

/**
 * Returns `next` only if it is an internal path on this origin,
 * otherwise FALLBACK_REDIRECT_PATH. Prevents the callback from being
 * used as an open redirect (e.g. `next=//evil.com`, `next=https://…`,
 * or `next=@evil.com`, which would turn `${origin}${next}` into a
 * different host).
 */
function getSafeRedirectPath(next: string | null, origin: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return FALLBACK_REDIRECT_PATH;
  }

  // Browsers treat "\" like "/" and silently drop tab/newline
  // characters, so "/\evil.com" or "/<tab>/evil.com" can become
  // "//evil.com". Reject backslashes and all control characters.
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (next[i] === "\\" || code < 0x20 || code === 0x7f) {
      return FALLBACK_REDIRECT_PATH;
    }
  }

  // Final check: resolved against our origin, it must stay on it.
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return FALLBACK_REDIRECT_PATH;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return FALLBACK_REDIRECT_PATH;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = getSafeRedirectPath(searchParams.get("next"), origin);

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=invalid_callback`);
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/login?error=auth_not_configured`);
  }

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return NextResponse.redirect(`${origin}/login?error=expired_callback`);
    }

    return NextResponse.redirect(`${origin}${next}`);
  } catch (err) {
    console.error("[auth] callback exchangeCodeForSession failed unexpectedly:", err instanceof Error ? err.message : err);
    return NextResponse.redirect(`${origin}/login?error=expired_callback`);
  }
}
