import "server-only";
import { authService } from "./auth.service";
import { classesService } from "./classes.service";
import { notificationsService } from "./notifications.service";
import { performanceService } from "./performance.service";
import { trainerDashboardRepository } from "@/repositories/trainer-dashboard.repository";
import { createTrainerDashboardService } from "./trainer-dashboard.service.core";

/**
 * The trainer dashboard service bound to the real session (authService),
 * the trainer's own Supabase client (trainer dashboard repository) and the
 * existing services it reuses — Classes (trainer scope resolved on the
 * server, date range filtered in SQL), Performance (topic analysis of the
 * trainer's current batches) and Notifications (the user's own feed). Each
 * checks the caller again on its own.
 */
export const trainerDashboardService = createTrainerDashboardService({
  repository: trainerDashboardRepository,
  getCurrentUser: () => authService.getCurrentUser(),
  listClasses: async (from, to) => {
    const classes = await classesService.listClasses({ dateRange: "custom", dateFrom: from, dateTo: to });
    return classes.map((c) => ({
      id: c.id,
      title: c.title,
      class_date: c.classDate,
      start_time: c.startTime,
      end_time: c.endTime,
      status: c.status,
      class_type: c.classType,
      batch_id: c.batchId,
      batch_name: c.batchName,
      batch_code: "",
      course_title: c.courseTitle,
    }));
  },
  getModulePerformance: async () => {
    const data = await performanceService.getPerformance();
    if (!data || data.role !== "trainer") return null;
    return (data.modules ?? []).map((m) => ({ title: m.title, percent: m.percent, answers: m.answers }));
  },
  getNotifications: (limit) => notificationsService.listNotifications(limit),
});

export { TrainerDashboardAuthorizationError } from "./trainer-dashboard.service.core";
