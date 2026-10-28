"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, LogOut, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { siteConfig } from "@/config/site";
import { navigationByRole, portalLabel, type PortalRole } from "@/config/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { Logo } from "./Logo";
import { Avatar } from "@/components/ui/Avatar";

export interface SidebarProps {
  role: PortalRole;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function isActivePath(pathname: string, href: string) {
  if (href === `/${pathname.split("/")[1]}`) {
    // exact portal root, e.g. /admin
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ role, collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const pathname = usePathname();
  const items = navigationByRole[role];
  const { user, logout, isLoggingOut } = useAuth();
  const displayName = user?.fullName ?? "Signed out";

  const content = (
    <div className="flex h-full flex-col bg-panel text-ink-onPanel">
      <div className="flex h-16 items-center justify-between gap-2 border-b border-panel-border px-4">
        <Link href={`/${role}`} className="flex min-w-0 items-center gap-2.5" onClick={onCloseMobile}>
          <Logo variant="icon" plate className="h-8 shrink-0" />
          {!collapsed && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-ink-onPanel">
                {siteConfig.companyShortName}
              </span>
              <span className="truncate text-2xs text-ink-onPanelMuted">{siteConfig.companySuffix}</span>
            </span>
          )}
        </Link>
        <button
          onClick={onCloseMobile}
          aria-label="Close menu"
          className="rounded p-1 text-ink-onPanelMuted hover:bg-panel-soft md:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!collapsed && (
        <div className="border-b border-panel-border px-4 py-3">
          <p className="truncate text-xs font-medium text-ink-onPanel">SPI Training Management</p>
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-onPanelMuted">
            {portalLabel[role]} portal
          </span>
        </div>
      )}

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onCloseMobile}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-brand-gold font-semibold text-panel shadow-sm"
                      : "text-ink-onPanelMuted hover:bg-panel-soft hover:text-white",
                    collapsed && "justify-center px-2"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-panel-border p-2">
        <button
          onClick={onToggleCollapsed}
          className="hidden w-full items-center justify-center gap-2 rounded px-3 py-2 text-xs text-ink-onPanelMuted hover:bg-panel-soft hover:text-white md:flex"
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>

        <div
          className={cn(
            "mt-1 flex items-center gap-2.5 rounded-lg px-2 py-2",
            !collapsed && "hover:bg-panel-soft"
          )}
        >
          <Avatar name={displayName} size="md" tone="gold" />
          {!collapsed && (
            <>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-sm font-medium text-ink-onPanel">{displayName}</span>
                <span className="truncate text-2xs text-ink-onPanelMuted">
                  {user ? ROLE_LABEL[user.role] : ""}
                </span>
              </span>
              <button
                onClick={logout}
                disabled={isLoggingOut}
                aria-label="Log out"
                title="Log out"
                className="shrink-0 rounded p-1.5 text-ink-onPanelMuted hover:bg-panel hover:text-white disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {content}
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none"
        )}
        aria-hidden={!mobileOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-panel/60 transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0"
          )}
          onClick={onCloseMobile}
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-64 transition-transform duration-200",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          {content}
        </div>
      </div>
    </>
  );
}
