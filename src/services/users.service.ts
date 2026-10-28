import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { usersRepository } from "@/repositories/users.repository";
import { createUsersService } from "./users.service.core";
import { invitationRecoveryEnabled } from "@/lib/user-management/invitations";

/**
 * The Users service bound to the real session (authService) and the
 * caller's own Supabase client (RLS applies; changes go through the
 * 0017 database functions). P5.2: the recovery switch is read on the
 * server only and passed on as a plain yes/no for the panel.
 */
export const usersService = createUsersService({
  repository: usersRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  isDemoMode: () => authConfig.mode === "demo",
  isRecoveryEnabled: () => invitationRecoveryEnabled(process.env.INVITATION_RECOVERY_EMAILS_ENABLED),
});

export { UsersActionError, UsersAuthorizationError } from "./users.service.core";
export { UsersRepositoryError } from "@/repositories/users.repository";
