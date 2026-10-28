"use client";

import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Award,
  BadgeCheck,
  BellOff,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Check,
  CheckCheck,
  CircleX,
  ClipboardCheck,
  ClipboardList,
  FileCheck,
  FileQuestion,
  FileText,
  GraduationCap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/utils/cn";
import { formatDateTime } from "@/utils/format";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/services/notifications.actions";
import type { AppNotification, NotificationType } from "@/types/notification";

/** Fired on window after a read-state change so the top-bar badge and any open list stay in step. */
export const NOTIFICATIONS_CHANGED_EVENT = "arsene:notifications-changed";
export interface NotificationsChangedDetail {
  unreadCount?: number;
}

function announceChange(unreadCount?: number) {
  window.dispatchEvent(new CustomEvent<NotificationsChangedDetail>(NOTIFICATIONS_CHANGED_EVENT, { detail: { unreadCount } }));
}

type Tone = "green" | "gold" | "red" | "blue";

const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-primary-50 text-primary-600",
  gold: "bg-signal-amberSoft text-signal-amber",
  red: "bg-signal-redSoft text-signal-red",
  blue: "bg-signal-blueSoft text-signal-blue",
};

const TYPE_STYLE: Record<NotificationType, { icon: LucideIcon; tone: Tone }> = {
  class_scheduled: { icon: CalendarPlus, tone: "green" },
  class_updated: { icon: CalendarClock, tone: "gold" },
  class_cancelled: { icon: CalendarX, tone: "red" },
  assignment_published: { icon: ClipboardList, tone: "blue" },
  submission_received: { icon: FileText, tone: "blue" },
  submission_updated: { icon: FileText, tone: "gold" },
  submission_returned: { icon: FileCheck, tone: "green" },
  test_published: { icon: FileQuestion, tone: "blue" },
  test_closed: { icon: ClipboardCheck, tone: "blue" },
  completion_recommended: { icon: GraduationCap, tone: "gold" },
  completion_approved: { icon: BadgeCheck, tone: "green" },
  completion_rejected: { icon: CircleX, tone: "red" },
  certificate_issued: { icon: Award, tone: "green" },
  certificate_revoked: { icon: Award, tone: "red" },
};

export interface NotificationCenterProps {
  /** The signed-in user's notifications, newest first (already scoped by the database). */
  notifications: AppNotification[];
  unreadCount: number;
  /** "page": the full notifications page. "panel": the compact top-bar popover. */
  variant?: "page" | "panel";
  /** Panel footer link to the full page. */
  viewAllHref?: string;
  /** Called before following a notification link (the panel closes itself). */
  onNavigate?: () => void;
}

/**
 * The signed-in user's notification list with unread state, mark-one
 * and mark-all. Read state changes only through the notification server
 * actions (the database decides which rows the caller may mark). Links
 * arrive already restricted to safe paths in the caller's own portal.
 */
export function NotificationCenter({
  notifications,
  unreadCount,
  variant = "page",
  viewAllHref,
  onNavigate,
}: NotificationCenterProps) {
  const router = useRouter();
  const [items, setItems] = useState(notifications);
  const [unread, setUnread] = useState(unreadCount);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh server data (after revalidation or a panel reload) replaces local state.
  useEffect(() => setItems(notifications), [notifications]);
  useEffect(() => setUnread(unreadCount), [unreadCount]);

  const isPanel = variant === "panel";

  function setPending(id: string, pending: boolean) {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function markRead(notification: AppNotification): Promise<void> {
    if (notification.readAt || pendingIds.has(notification.id)) return;
    setError(null);
    setPending(notification.id, true);
    const result = await markNotificationReadAction(notification.id);
    setPending(notification.id, false);
    if (!result.ok) {
      setError(result.error ?? "We couldn't update that notification.");
      return;
    }
    const readAt = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === notification.id ? { ...n, readAt: n.readAt ?? readAt } : n)));
    const nextUnread = result.unreadCount ?? Math.max(0, unread - 1);
    setUnread(nextUnread);
    announceChange(nextUnread);
  }

  async function markAllRead() {
    if (markingAll || unread === 0) return;
    setError(null);
    setMarkingAll(true);
    const result = await markAllNotificationsReadAction();
    setMarkingAll(false);
    if (!result.ok) {
      setError(result.error ?? "We couldn't update your notifications.");
      return;
    }
    const readAt = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt })));
    const nextUnread = result.unreadCount ?? 0;
    setUnread(nextUnread);
    announceChange(nextUnread);
  }

  /** Unread + plain click: mark it read first, then navigate. Modified clicks open normally. */
  async function openLink(event: MouseEvent<HTMLAnchorElement>, notification: AppNotification) {
    if (!notification.link) return;
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    if (notification.readAt) {
      if (!modified) onNavigate?.();
      return;
    }
    if (modified) {
      void markRead(notification);
      return;
    }
    event.preventDefault();
    await markRead(notification);
    onNavigate?.();
    router.push(notification.link);
  }

  const toolbar = (
    <div className={cn("flex items-center justify-between gap-3", isPanel ? "border-b border-surface-border px-4 py-3" : "mb-3")}>
      {isPanel ? (
        <p className="text-sm font-semibold text-ink">
          Notifications
          {unread > 0 && <span className="ml-2 text-xs font-medium text-ink-muted">{unread} unread</span>}
        </p>
      ) : (
        <p className="text-sm text-ink-muted" aria-live="polite">
          <span className="font-semibold text-ink">{unread}</span> unread notification{unread === 1 ? "" : "s"}
        </p>
      )}
      <Button
        variant={isPanel ? "ghost" : "secondary"}
        size="sm"
        onClick={markAllRead}
        isLoading={markingAll}
        disabled={unread === 0}
        className={cn(isPanel && "h-7 px-2 text-xs")}
      >
        {!markingAll && <CheckCheck className="h-3.5 w-3.5" aria-hidden />}
        Mark all as read
      </Button>
    </div>
  );

  const errorBanner = error && (
    <p
      role="alert"
      className={cn(
        "rounded-sm border border-signal-red/30 bg-signal-redSoft px-3 py-2 text-xs text-signal-red",
        isPanel ? "mx-4 mt-3" : "mb-3"
      )}
    >
      {error}
    </p>
  );

  const empty = isPanel ? (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <BellOff className="h-6 w-6 text-ink-faint" aria-hidden />
      <p className="text-sm font-medium text-ink">No notifications yet</p>
      <p className="text-xs text-ink-muted">You&apos;re all caught up.</p>
    </div>
  ) : (
    <EmptyState
      icon={BellOff}
      title="No notifications yet"
      description="Updates about your classes, assignments, tests, completions and certificates will appear here."
    />
  );

  const list = (
    <ul className={cn("divide-y divide-surface-border", isPanel && "max-h-[26rem] overflow-y-auto")}>
      {items.map((n) => {
        const { icon: Icon, tone } = TYPE_STYLE[n.type];
        const isUnread = !n.readAt;
        const isPending = pendingIds.has(n.id);
        const content = (
          <>
            <p className={cn("text-sm leading-snug text-ink", isUnread ? "font-semibold" : "font-medium")}>{n.title}</p>
            <p className={cn("mt-0.5 text-ink-muted", isPanel ? "line-clamp-2 text-xs" : "line-clamp-3 text-sm")}>{n.body}</p>
            <p className="mt-1 flex items-center gap-1.5 text-2xs text-ink-faint">
              <time dateTime={n.createdAt}>{formatDateTime(n.createdAt)}</time>
              {n.link && (
                <span className="inline-flex items-center gap-0.5 font-medium text-primary-600">
                  <span aria-hidden>·</span> Open <ArrowRight className="h-3 w-3" aria-hidden />
                </span>
              )}
            </p>
          </>
        );

        return (
          <li
            key={n.id}
            className={cn(
              "relative flex items-start gap-3",
              isPanel ? "px-4 py-3" : "px-5 py-4",
              isUnread ? "bg-primary-50/50" : "bg-surface-raised"
            )}
          >
            {isUnread && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-brand-gold" />}
            <span
              aria-hidden
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full",
                isPanel ? "h-8 w-8" : "h-9 w-9",
                TONE_CLASSES[tone]
              )}
            >
              <Icon className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
              {n.link ? (
                <Link
                  href={n.link}
                  onClick={(e) => openLink(e, n)}
                  className="block rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                >
                  {content}
                </Link>
              ) : (
                content
              )}
              <span className="sr-only">{isUnread ? "Unread" : "Read"}</span>
            </div>

            {isUnread && (
              <button
                type="button"
                onClick={() => markRead(n)}
                disabled={isPending}
                aria-label={`Mark "${n.title}" as read`}
                title="Mark as read"
                className="shrink-0 rounded p-1.5 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-primary-600 disabled:opacity-50"
              >
                <Check className="h-4 w-4" aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  if (isPanel) {
    return (
      <div className="flex flex-col">
        {toolbar}
        {errorBanner}
        {items.length === 0 ? empty : list}
        {viewAllHref && (
          <Link
            href={viewAllHref}
            onClick={() => onNavigate?.()}
            className="flex items-center justify-center gap-1 border-t border-surface-border px-4 py-2.5 text-xs font-medium text-primary-600 hover:bg-surface-sunken"
          >
            View all notifications <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    );
  }

  return (
    <div>
      {toolbar}
      {errorBanner}
      {items.length === 0 ? (
        empty
      ) : (
        <>
          <Card className="overflow-hidden">{list}</Card>
          <p className="mt-3 text-2xs text-ink-faint">Showing your latest {items.length} notification{items.length === 1 ? "" : "s"} (up to 50).</p>
        </>
      )}
    </div>
  );
}
