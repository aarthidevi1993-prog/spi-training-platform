"use server";

/**
 * Server Actions — the RPC boundary client components call into.
 * Each action validates input, delegates to authService, and returns
 * a plain result object; the calling client component decides how to
 * navigate (see components/auth/*). Actions never redirect()
 * themselves so the same functions behave predictably whether called
 * from a <form action> or a plain onClick handler.
 */

import { authService } from "./auth.service";
import { authConfig } from "@/config/auth";
import { getHomeRouteForRole } from "@/lib/auth/roles";
import type { LoginFieldErrors } from "@/types/auth";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LoginActionResult {
  ok: boolean;
  errors?: LoginFieldErrors;
  redirectTo?: string;
}

export async function loginAction(
  email: string,
  password: string,
  rememberMe: boolean,
  next?: string | null
): Promise<LoginActionResult> {
  const errors: LoginFieldErrors = {};
  const trimmedEmail = email.trim();

  if (!trimmedEmail) {
    errors.email = "Email address is required.";
  } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
    errors.email = "Please enter a valid email address.";
  }

  if (!password) {
    errors.password = "Password is required.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const result = await authService.login(trimmedEmail, password, rememberMe);

  if (!result.success) {
    return { ok: false, errors: { form: result.error } };
  }

  const homeRoute = getHomeRouteForRole(result.user.role);
  // Only honour `next` if it's a same-origin path inside the signed-in
  // user's own portal — otherwise a student who followed a link into
  // /admin/* would get bounced right back into /admin/* post-login.
  const isSafeNext =
    next && next.startsWith("/") && !next.startsWith("//") && next.startsWith(homeRoute);

  return { ok: true, redirectTo: isSafeNext ? next : homeRoute };
}

export async function logoutAction(): Promise<{ ok: true }> {
  await authService.logout();
  return { ok: true };
}

export interface ForgotPasswordActionResult {
  ok: boolean;
  error?: string;
}

export async function requestPasswordResetAction(email: string): Promise<ForgotPasswordActionResult> {
  const trimmedEmail = email.trim();

  if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  await authService.requestPasswordReset(trimmedEmail);
  // Always a generic success message — never reveal whether the
  // email matched an account.
  return { ok: true };
}

export interface ResetPasswordActionResult {
  ok: boolean;
  error?: string;
}

export async function updatePasswordAction(
  newPassword: string,
  confirmPassword: string
): Promise<ResetPasswordActionResult> {
  if (newPassword.length < authConfig.passwordRules.minLength) {
    return { ok: false, error: `Password must be at least ${authConfig.passwordRules.minLength} characters.` };
  }

  if (newPassword !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const { error } = await authService.updatePassword(newPassword);
  if (error) {
    return { ok: false, error };
  }

  return { ok: true };
}
