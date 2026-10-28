import "server-only";
import { cache } from "react";
import { authRepository } from "@/repositories/auth.repository";
import { hasPermission as checkPermission, type Permission } from "@/lib/auth/permissions";
import type { AuthResult, AuthSession, AuthUser } from "@/types/auth";
import type { UserRole } from "@/types/user";

/**
 * Authentication service — business rules on top of authRepository.
 * Server Components, Server Actions and Route Handlers should call
 * this (not the repository directly).
 *
 * getSession/getCurrentUser are wrapped in React's cache() so calling
 * them from multiple places in the same request (root layout, a
 * RoleGuard, a page) only reads the cookie/hits Supabase once.
 */

const getSessionCached = cache(async (): Promise<AuthSession | null> => authRepository.getSession());

export const authService = {
  async login(email: string, password: string, rememberMe?: boolean): Promise<AuthResult> {
    return authRepository.login(email, password, rememberMe);
  },

  async logout(): Promise<void> {
    return authRepository.logout();
  },

  async getCurrentSession(): Promise<AuthSession | null> {
    return getSessionCached();
  },

  async getCurrentUser(): Promise<AuthUser | null> {
    const session = await getSessionCached();
    return session?.user ?? null;
  },

  async isAuthenticated(): Promise<boolean> {
    return (await this.getCurrentUser()) !== null;
  },

  async getUserRole(): Promise<UserRole | null> {
    const user = await this.getCurrentUser();
    return user?.role ?? null;
  },

  async hasRole(allowedRoles: UserRole[]): Promise<boolean> {
    const role = await this.getUserRole();
    return role !== null && allowedRoles.includes(role);
  },

  async hasPermission(permission: Permission): Promise<boolean> {
    const role = await this.getUserRole();
    return checkPermission(role, permission);
  },

  async requestPasswordReset(email: string): Promise<void> {
    return authRepository.requestPasswordReset(email);
  },

  async updatePassword(newPassword: string): Promise<{ error?: string }> {
    return authRepository.updatePassword(newPassword);
  },
};
