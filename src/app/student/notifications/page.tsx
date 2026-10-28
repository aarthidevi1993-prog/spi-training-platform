import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { NotificationCenter } from "@/components/modules/NotificationCenter";
import { notificationsService } from "@/services/notifications.service";
import type { NotificationFeed } from "@/types/notification";

export const dynamic = "force-dynamic";

export default async function StudentNotificationsPage() {
  let feed: NotificationFeed | null = null;
  let loadError: string | null = null;

  try {
    // The signed-in user's own notifications only — the database scopes them by session.
    feed = await notificationsService.listNotifications();
  } catch (err) {
    console.error("[student/notifications] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your notifications. Please try again.";
  }

  return (
    <div>
      <PageHeader title="Notifications" description="Stay up to date with your classes, assignments, tests and certificates." />
      {loadError ? (
        <ErrorState title="We couldn't load your notifications" description={loadError} />
      ) : feed ? (
        <NotificationCenter notifications={feed.notifications} unreadCount={feed.unreadCount} />
      ) : (
        <EmptyState title="Notifications unavailable" description="Notifications require Supabase mode." />
      )}
    </div>
  );
}
