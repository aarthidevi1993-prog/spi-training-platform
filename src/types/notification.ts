/**
 * In-app notifications (0012). Exactly what public.my_notifications()
 * returns — the recipient, actor, event key and related entity id are
 * deliberately not exposed by the database function, so they are not
 * modelled here either. The recipient is always the signed-in user.
 */

export type NotificationType =
  | "class_scheduled"
  | "class_updated"
  | "class_cancelled"
  | "assignment_published"
  | "submission_received"
  | "submission_updated"
  | "submission_returned"
  | "test_published"
  | "test_closed"
  | "completion_recommended"
  | "completion_approved"
  | "completion_rejected"
  | "certificate_issued"
  | "certificate_revoked";

export type NotificationEntityType = "class" | "assignment" | "submission" | "test" | "completion" | "certificate";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * Internal route for the signed-in user's own portal, or null. Links
   * that are not a safe path inside the caller's portal are dropped
   * server-side before they reach the browser.
   */
  link: string | null;
  entityType: NotificationEntityType | null;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp, or null while unread. */
  readAt: string | null;
}

/** The signed-in user's latest notifications plus their total unread count. */
export interface NotificationFeed {
  notifications: AppNotification[];
  unreadCount: number;
}

export const NOTIFICATION_LIMITS = {
  /** The database caps my_notifications() at 50. */
  list: 50,
  /** Rows shown in the top-bar panel. */
  panel: 8,
} as const;

export interface NotificationActionResult {
  ok: boolean;
  error?: string;
  /** The caller's unread count after the action, when it could be read. */
  unreadCount?: number;
}

export interface NotificationSummaryResult {
  ok: boolean;
  error?: string;
  /** false in demo auth mode (no notification database). */
  available?: boolean;
  feed?: NotificationFeed;
}
