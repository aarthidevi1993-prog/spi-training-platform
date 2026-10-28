import type { UserRole } from "./user";

/**
 * Lean identity record used by the authentication layer.
 *
 * Deliberately reuses `UserRole` from ./user instead of introducing a
 * second, conflicting role enum — "admin" plays the Super Admin role
 * described in the PART 2 brief. Once a real `profiles` table exists
 * (a later part), this can be widened without touching the auth
 * layer's public API.
 */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  avatarUrl?: string;
  isActive: boolean;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type AuthResult =
  | { success: true; user: AuthUser }
  | { success: false; error: string };

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface LoginFieldErrors {
  email?: string;
  password?: string;
  form?: string;
}
