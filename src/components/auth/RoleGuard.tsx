import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { authService } from "@/services/auth.service";
import type { UserRole } from "@/types/user";

export interface RoleGuardProps {
  allowedRoles: UserRole[];
  children: ReactNode;
}

/**
 * Server-side role gate — the primary authorization boundary for
 * each portal's route group (see src/app/admin/layout.tsx and
 * siblings). Unauthenticated visitors are sent to /login; signed-in
 * users whose role isn't in `allowedRoles` are sent to /unauthorized.
 *
 * This runs on the server before any protected content renders, so
 * it holds even if a client-side check were bypassed — it is not
 * merely a UI convenience. Middleware provides a second, earlier
 * layer of the same check for defense in depth.
 */
export async function RoleGuard({ allowedRoles, children }: RoleGuardProps) {
  const user = await authService.getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  if (!allowedRoles.includes(user.role)) {
    redirect("/unauthorized");
  }

  return <>{children}</>;
}
