import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MyNotificationsRow } from "@/lib/supabase/types";

/**
 * Notifications repository — the only module that talks to the 0012
 * notification database, and only through its four user functions:
 * my_notifications, my_unread_notification_count,
 * mark_notification_read and mark_all_notifications_read.
 *
 * Always the caller's own session (never the service role). The
 * functions take no recipient argument: the database identifies the
 * recipient from auth.uid(), so a user can only ever read or mark their
 * own notifications. The notifications table is never queried or
 * written directly, and nothing here creates notifications — database
 * triggers do.
 */

const GENERIC_DB_ERROR = "We couldn't reach the notification service. Please try again.";

export class NotificationRepositoryError extends Error {
  /** Postgres error code, when the database raised one. */
  readonly code: string;
  constructor(message: string = GENERIC_DB_ERROR, code = "") {
    super(message);
    this.name = "NotificationRepositoryError";
    this.code = code;
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[notifications] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new NotificationRepositoryError();
  return supabase;
}

/** 42501 is raised by the 0012 functions when nobody is signed in. Raw Postgres messages are never passed on. */
function toRepositoryError(error: unknown): NotificationRepositoryError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "42501") return new NotificationRepositoryError("You need to be signed in.", code);
  return new NotificationRepositoryError(GENERIC_DB_ERROR, code);
}

/** One database function call. */
async function rpc<T>(context: string, fn: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  let result: { data: T | null; error: unknown };
  try {
    result = await fn();
  } catch (err) {
    logDbError(context, err);
    throw new NotificationRepositoryError();
  }
  if (result.error) {
    logDbError(context, result.error);
    throw toRepositoryError(result.error);
  }
  if (result.data === null || result.data === undefined) throw new NotificationRepositoryError();
  return result.data;
}

export const notificationsRepository = {
  /** The caller's latest notifications, newest first. The database caps the limit at 50. */
  async listMine(limit: number): Promise<MyNotificationsRow[]> {
    const supabase = await client();
    return rpc("listMine", () => supabase.rpc("my_notifications", { p_limit: limit }));
  },

  async countMyUnread(): Promise<number> {
    const supabase = await client();
    return rpc("countMyUnread", () => supabase.rpc("my_unread_notification_count"));
  },

  /** false when the id is not one of the caller's unread notifications. */
  async markRead(notificationId: string): Promise<boolean> {
    const supabase = await client();
    return rpc("markRead", () => supabase.rpc("mark_notification_read", { p_notification_id: notificationId }));
  },

  /** Number of the caller's notifications that were marked read. */
  async markAllRead(): Promise<number> {
    const supabase = await client();
    return rpc("markAllRead", () => supabase.rpc("mark_all_notifications_read"));
  },
};
