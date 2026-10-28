"use client";

import { createContext, useContext, useMemo, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { logoutAction } from "@/services/auth.actions";
import { useToast } from "@/components/ui/Toast";
import type { AuthUser } from "@/types/auth";

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoggingOut: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  /** The current user, resolved server-side (see src/app/layout.tsx). */
  initialUser: AuthUser | null;
  children: ReactNode;
}

/**
 * Makes the current user available to client components (e.g. the
 * Topbar profile menu) without re-deriving auth state in the
 * browser — the real check already happened server-side in the root
 * layout. This is a display/convenience context, not a security
 * boundary: route protection lives in RoleGuard + middleware.
 */
export function AuthProvider({ initialUser, children }: AuthProviderProps) {
  // Read the prop directly rather than copying it into state: the root
  // layout stays mounted across client navigations, so only a fresh
  // prop (delivered by router.refresh() after login/logout) reflects
  // the current session.
  const user = initialUser;
  const [isLoggingOut, startTransition] = useTransition();
  const router = useRouter();
  const { showToast } = useToast();

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      isLoggingOut,
      logout: () => {
        startTransition(async () => {
          await logoutAction();
          showToast({ variant: "success", title: "Logged out successfully." });
          router.push("/login");
          router.refresh();
        });
      },
    }),
    [user, isLoggingOut, router, showToast]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
