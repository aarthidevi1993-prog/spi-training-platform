import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import { notificationsRepository, NotificationRepositoryError } from "@/repositories/notifications.repository";
import type { MyNotificationsRow } from "@/lib/supabase/types";
import type { UserRole } from "@/types/user";
import {
  NOTIFICATION_LIMITS,
  type AppNotification,
  type NotificationEntityType,
  type NotificationFeed,
  type NotificationType,
} from "@/types/notification";

/**
 * Notifications service — the signed-in user's own in-app
 * notifications, on top of the four 0012 database functions.
 *
 * The recipient is never an argument: the database identifies it from
 * the session (auth.uid()) and is the only authority on which rows a
 * user may read or mark read. This layer requires a signed-in user,
 * validates ids, maps rows into typed shapes and drops any link that is
 * not a safe internal path inside the caller's own portal. It never
 * creates notifications — database triggers do.
 */

export { NotificationRepositoryError };

export class NotificationAuthorizationError extends Error {
  constructor(message = "You need to be signed in.") {
    super(message);
    this.name = "NotificationAuthorizationError";
  }
}

export class NotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationValidationError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

const NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "class_scheduled",
  "class_updated",
  "class_cancelled",
  "assignment_published",
  "submission_received",
  "submission_updated",
  "submission_returned",
  "test_published",
  "test_closed",
  "completion_recommended",
  "completion_approved",
  "completion_rejected",
  "certificate_issued",
  "certificate_revoked",
]);

const ENTITY_TYPES: ReadonlySet<NotificationEntityType> = new Set<NotificationEntityType>([
  "class",
  "assignment",
  "submission",
  "test",
  "completion",
  "certificate",
]);

/** The URL prefix of each role's portal. */
const PORTAL_BY_ROLE: Record<UserRole, "admin" | "trainer" | "student"> = {
  admin: "admin",
  trainer: "trainer",
  student: "student",
};

/** Same shape as the 0012 notifications_link_ok constraint. */
const LINK_PATTERN = /^\/(admin|trainer|student)\/[A-Za-z0-9/_.-]{0,180}$/;

/**
 * A notification link is followed only when it is an internal path in
 * the caller's own portal with no empty, "." or ".." segments — so a
 * stored value can never become an external or cross-portal redirect.
 */
function safeLink(link: string | null, role: UserRole): string | null {
  if (typeof link !== "string" || !LINK_PATTERN.test(link)) return null;
  const portal = PORTAL_BY_ROLE[role];
  if (!link.startsWith(`/${portal}/`)) return null;
  const segments = link.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return link;
}

function toNotification(row: MyNotificationsRow, role: UserRole): AppNotification | null {
  // A value outside the approved set (e.g. a newer enum label) is skipped rather than shown untyped.
  if (!isUuid(row.id) || !NOTIFICATION_TYPES.has(row.type)) return null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: safeLink(row.link, role),
    entityType: row.related_entity_type && ENTITY_TYPES.has(row.related_entity_type) ? row.related_entity_type : null,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

// -------------------------------------------------------------------
// Identity
// -------------------------------------------------------------------

function requireSupabaseMode(): void {
  if (authConfig.mode === "demo") {
    throw new NotificationValidationError("Notifications require Supabase mode.");
  }
}

async function requireUser() {
  const user = await authService.getCurrentUser();
  if (!user) throw new NotificationAuthorizationError();
  return user;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return NOTIFICATION_LIMITS.list;
  return Math.min(Math.max(Math.trunc(limit), 1), NOTIFICATION_LIMITS.list);
}

export const notificationsService = {
  /** The signed-in user's latest notifications (at most 50) and unread count. null in demo mode. */
  async listNotifications(limit: number = NOTIFICATION_LIMITS.list): Promise<NotificationFeed | null> {
    if (authConfig.mode === "demo") return null;
    const user = await requireUser();
    const [rows, unreadCount] = await Promise.all([
      notificationsRepository.listMine(clampLimit(limit)),
      notificationsRepository.countMyUnread(),
    ]);
    const notifications = rows
      .map((row) => toNotification(row, user.role))
      .filter((n): n is AppNotification => n !== null);
    return { notifications, unreadCount: Math.max(0, unreadCount) };
  },

  /** The signed-in user's unread count. 0 in demo mode. */
  async getUnreadNotificationCount(): Promise<number> {
    if (authConfig.mode === "demo") return 0;
    await requireUser();
    return Math.max(0, await notificationsRepository.countMyUnread());
  },

  /**
   * Marks one of the signed-in user's notifications as read. Returns
   * false when it is not theirs, does not exist or was already read —
   * the database decides; nothing is changed in those cases.
   */
  async markNotificationRead(notificationId: string): Promise<boolean> {
    requireSupabaseMode();
    if (!isUuid(notificationId)) throw new NotificationValidationError("That notification wasn't found.");
    await requireUser();
    return notificationsRepository.markRead(notificationId);
  },

  /** Marks all of the signed-in user's unread notifications as read; returns how many changed. */
  async markAllNotificationsRead(): Promise<number> {
    requireSupabaseMode();
    await requireUser();
    return notificationsRepository.markAllRead();
  },
};
