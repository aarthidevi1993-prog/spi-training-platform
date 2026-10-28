"use server";

/**
 * Server Actions — the RPC boundary the notification UI calls. Each
 * action delegates to notificationsService, which requires the signed-in
 * user; the 0012 database functions identify the recipient from the
 * session. Only a notification id is ever accepted from the browser —
 * never a recipient or user id. Internal error details are logged,
 * never returned.
 */

import { revalidatePath } from "next/cache";
import {
  notificationsService,
  NotificationAuthorizationError,
  NotificationRepositoryError,
  NotificationValidationError,
} from "./notifications.service";
import { authConfig } from "@/config/auth";
import { NOTIFICATION_LIMITS, type NotificationActionResult, type NotificationSummaryResult } from "@/types/notification";

function revalidateNotificationPages() {
  revalidatePath("/admin/notifications");
  revalidatePath("/trainer/notifications");
  revalidatePath("/student/notifications");
}

function userFacingError(context: string, err: unknown): string {
  if (
    err instanceof NotificationValidationError ||
    err instanceof NotificationAuthorizationError ||
    err instanceof NotificationRepositoryError
  ) {
    // These carry messages written to be shown to users.
    return err.message;
  }
  console.error(`[notifications.actions] ${context}:`, err instanceof Error ? err.message : err);
  return "Something went wrong. Please try again.";
}

/** The unread count after a change, or undefined if it couldn't be read (the change itself still succeeded). */
async function unreadCountAfterChange(): Promise<number | undefined> {
  try {
    return await notificationsService.getUnreadNotificationCount();
  } catch {
    return undefined;
  }
}

/** Top-bar panel: the signed-in user's latest few notifications and unread count. */
export async function getNotificationSummaryAction(): Promise<NotificationSummaryResult> {
  if (authConfig.mode === "demo") return { ok: true, available: false };
  try {
    const feed = await notificationsService.listNotifications(NOTIFICATION_LIMITS.panel);
    return feed ? { ok: true, available: true, feed } : { ok: true, available: false };
  } catch (err) {
    return { ok: false, error: userFacingError("getNotificationSummary", err) };
  }
}

export async function markNotificationReadAction(notificationId: string): Promise<NotificationActionResult> {
  try {
    await notificationsService.markNotificationRead(notificationId);
    revalidateNotificationPages();
    return { ok: true, unreadCount: await unreadCountAfterChange() };
  } catch (err) {
    return { ok: false, error: userFacingError("markNotificationRead", err) };
  }
}

export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  try {
    await notificationsService.markAllNotificationsRead();
    revalidateNotificationPages();
    return { ok: true, unreadCount: await unreadCountAfterChange() };
  } catch (err) {
    return { ok: false, error: userFacingError("markAllNotificationsRead", err) };
  }
}
