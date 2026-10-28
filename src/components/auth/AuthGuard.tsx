import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { authService } from "@/services/auth.service";

export interface AuthGuardProps {
  children: ReactNode;
  /** Where to send unauthenticated visitors. Defaults to /login. */
  redirectTo?: string;
}

/**
 * Server-side "must be signed in" gate. Renders children only when a
 * valid session exists; otherwise redirects before anything renders.
 * This — not the client-side useAuth() hook — is the real security
 * boundary. Use RoleGuard instead when a specific role is required.
 */
export async function AuthGuard({ children, redirectTo = "/login" }: AuthGuardProps) {
  const user = await authService.getCurrentUser();

  if (!user) {
    redirect(redirectTo);
  }

  return <>{children}</>;
}
