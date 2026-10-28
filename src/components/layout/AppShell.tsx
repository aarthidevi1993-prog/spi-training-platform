"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Footer } from "./Footer";
import { useDisclosure } from "@/hooks/useDisclosure";
import type { PortalRole } from "@/config/navigation";

export interface AppShellProps {
  role: PortalRole;
  children: ReactNode;
}

/**
 * The application shell used by every /admin, /trainer and /student
 * route group. Owns the desktop collapsed/expanded sidebar state and
 * the mobile drawer state, and renders Sidebar + Topbar around the
 * page content.
 */
export function AppShell({ role, children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const mobileMenu = useDisclosure(false);

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar
        role={role}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((prev) => !prev)}
        mobileOpen={mobileMenu.isOpen}
        onCloseMobile={mobileMenu.close}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar role={role} onOpenMobileMenu={mobileMenu.open} />
        <main className="flex-1 px-4 py-5 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
        <Footer variant="light" className="border-t border-surface-border" />
      </div>
    </div>
  );
}
