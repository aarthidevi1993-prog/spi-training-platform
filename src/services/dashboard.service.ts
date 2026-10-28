import "server-only";
import { authService } from "./auth.service";
import { usersService } from "./users.service";
import { notificationsService } from "./notifications.service";
import { certificatesService } from "./certificates.service";
import { dashboardRepository } from "@/repositories/dashboard.repository";
import { createAdminDashboardService } from "./dashboard.service.core";

/**
 * The Super Admin dashboard service bound to the real session
 * (authService), the caller's own Supabase client (dashboard repository)
 * and the existing services it reuses — each of which checks the caller
 * again on its own.
 */
export const adminDashboardService = createAdminDashboardService({
  repository: dashboardRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  getAccountTotals: async () => {
    const { totals } = await usersService.listUsers(null);
    return { invited: totals.byStatus.invited, suspended: totals.byStatus.suspended, missingRecord: totals.missingRecord };
  },
  getNotifications: (limit) => notificationsService.listNotifications(limit),
  getCompletionBatches: () => certificatesService.listCompletionBatches(),
});

export { DashboardAuthorizationError } from "./dashboard.service.core";
export type { DashboardAnalyticsResult, DashboardLoad } from "./dashboard.service.core";
