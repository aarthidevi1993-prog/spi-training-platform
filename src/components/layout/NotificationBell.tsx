"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell, Loader2, RotateCw } from "lucide-react";
import type { PortalRole } from "@/config/navigation";
import {
  NotificationCenter,
  NOTIFICATIONS_CHANGED_EVENT,
  type NotificationsChangedDetail,
} from "@/components/modules/NotificationCenter";
import { getNotificationSummaryAction } from "@/services/notifications.actions";
import type { NotificationFeed } from "@/types/notification";

type Status = "idle" | "loading" | "ready" | "error" | "unavailable";

/**
 * Top-bar bell: the signed-in user's unread count and a compact panel
 * of their latest notifications. Data comes only from the notification
 * server action (the session decides whose notifications they are);
 * it refreshes on navigation and whenever the panel opens — no polling.
 */
export function NotificationBell({ role }: { role: PortalRole }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setStatus((prev) => (prev === "ready" ? prev : "loading"));
    const result = await getNotificationSummaryAction();
    if (request !== requestRef.current) return; // a newer load superseded this one
    if (!result.ok) {
      setError(result.error ?? "We couldn't load your notifications.");
      setStatus("error");
      return;
    }
    if (!result.available || !result.feed) {
      setFeed(null);
      setUnreadCount(0);
      setStatus("unavailable");
      return;
    }
    setError(null);
    setFeed(result.feed);
    setUnreadCount(result.feed.unreadCount);
    setStatus("ready");
  }, []);

  // On first render and after each navigation.
  useEffect(() => {
    void load();
  }, [pathname, load]);

  // Read-state changes made elsewhere (the notifications page, or this panel).
  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<NotificationsChangedDetail>).detail;
      if (typeof detail?.unreadCount === "number") setUnreadCount(detail.unreadCount);
      void load();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
  }, [load]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open) void load();
    setOpen(!open);
  }

  const badge = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative rounded-lg p-2.5 text-ink-muted hover:bg-surface-sunken"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal-red px-1 font-mono text-[10px] font-semibold leading-none text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-surface-border bg-surface-raised shadow-overlay"
        >
          {status === "ready" && feed ? (
            <NotificationCenter
              variant="panel"
              notifications={feed.notifications}
              unreadCount={unreadCount}
              viewAllHref={`/${role}/notifications`}
              onNavigate={() => setOpen(false)}
            />
          ) : status === "error" ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <p className="text-sm font-medium text-ink">We couldn&apos;t load your notifications</p>
              <p className="text-xs text-ink-muted">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-1 inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-primary-600 hover:bg-surface-sunken"
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again
              </button>
            </div>
          ) : status === "unavailable" ? (
            <div className="px-4 py-10 text-center text-sm text-ink-muted">Notifications require Supabase mode.</div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading notifications…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
