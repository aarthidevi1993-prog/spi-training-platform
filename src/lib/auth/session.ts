import type { UserRole } from "@/types/user";

/**
 * Demo-mode session codec.
 *
 * IMPORTANT: this is intentionally lightweight — it is NOT a signed
 * or encrypted token, only a base64url-encoded JSON payload stored in
 * an httpOnly cookie. That is acceptable for a local/demo-only auth
 * path (see src/config/auth.ts — demo mode can never activate itself
 * in production), but it must never be treated as a security
 * boundary for real user data. When Supabase Auth is configured,
 * Supabase's own signed session cookies are used instead and this
 * codec isn't involved at all.
 *
 * Uses only Web APIs (atob/btoa) rather than Node's Buffer so the
 * same code runs unmodified in the Edge middleware runtime and in
 * Server Actions / Route Handlers.
 */
export interface DemoSessionPayload {
  userId: string;
  email: string;
  fullName: string;
  role: UserRole;
  issuedAt: number;
  expiresAt: number;
}

function toBase64Url(input: string): string {
  const base64 = btoa(unescape(encodeURIComponent(input)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return decodeURIComponent(escape(atob(base64)));
}

export function encodeDemoSession(payload: DemoSessionPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeDemoSession(token: string | undefined | null): DemoSessionPayload | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(token)) as Partial<DemoSessionPayload>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.fullName !== "string" ||
      typeof parsed.role !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt < Date.now()) return null;
    return parsed as DemoSessionPayload;
  } catch {
    return null;
  }
}
