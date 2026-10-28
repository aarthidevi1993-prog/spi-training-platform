"use client";

import { usePathname } from "next/navigation";
import { Menu, Search, LogOut, ChevronDown, User, Settings as SettingsIcon } from "lucide-react";
import { navigationByRole, type PortalRole } from "@/config/navigation";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { useAuth } from "@/components/auth/AuthProvider";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { Logo } from "./Logo";
import { Avatar } from "@/components/ui/Avatar";
import { NotificationBell } from "./NotificationBell";

export interface TopbarProps {
  role: PortalRole;
  onOpenMobileMenu: () => void;
}

function useCurrentPageTitle(role: PortalRole) {
  const pathname = usePathname();
  const items = navigationByRole[role];

  const match = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return match?.label ?? "Dashboard";
}

export function Topbar({ role, onOpenMobileMenu }: TopbarProps) {
  const title = useCurrentPageTitle(role);
  const { user, logout, isLoggingOut } = useAuth();

  const displayName = user?.fullName ?? "Signed out";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-surface-border bg-surface-raised px-4 sm:px-6">
      <button
        onClick={onOpenMobileMenu}
        aria-label="Open menu"
        className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <Logo variant="icon" className="h-6 shrink-0 md:hidden" />

      {/* The title takes the space left after the right-hand group (as before); it never competes with the search. */}
      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</p>

      {/* min-w-0 lets this group shrink below its content width: when the header is constrained (tablet widths,
          with the sidebar shown from md) the search gives up width instead of pushing the page wider. */}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <div className="relative hidden w-64 min-w-0 sm:block lg:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            placeholder="Search students, courses, or anything…"
            aria-label="Search"
            className="h-10 w-full rounded-lg border border-surface-border bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue"
          />
        </div>

        <NotificationBell role={role} />

        <Dropdown
          trigger={
            <button className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-sunken">
              <Avatar name={displayName} size="md" tone="gold" />
              {/* An unusually long display name is capped and truncated on screen (full text stays in the DOM for the
                  button's accessible name, and in the title) so user data cannot widen the header past the viewport. */}
              <span className="hidden min-w-0 flex-col items-start sm:flex">
                <span className="block max-w-[14rem] truncate text-sm leading-tight text-ink" title={displayName}>
                  {displayName}
                </span>
                {user && (
                  <span className="text-2xs leading-tight text-ink-faint">{ROLE_LABEL[user.role]}</span>
                )}
              </span>
              <ChevronDown className="hidden h-3.5 w-3.5 text-ink-faint sm:inline" />
            </button>
          }
        >
          <DropdownItem disabled title="Coming in a later part">
            <User className="h-3.5 w-3.5" /> My profile
          </DropdownItem>
          <DropdownItem disabled title="Coming in a later part">
            <SettingsIcon className="h-3.5 w-3.5" /> Account settings
          </DropdownItem>
          <div className="my-1 border-t border-surface-border" />
          <DropdownItem onClick={logout} disabled={isLoggingOut} className="text-signal-red">
            <LogOut className="h-3.5 w-3.5" /> {isLoggingOut ? "Logging out…" : "Log out"}
          </DropdownItem>
        </Dropdown>
      </div>
    </header>
  );
}
