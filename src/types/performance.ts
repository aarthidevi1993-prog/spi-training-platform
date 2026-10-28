/**
 * Performance (Phase 1). Separate, factual metrics only — there is
 * deliberately no combined "overall" score.
 *
 *   - Test average:       mean of best released test percentages
 *                         (one per student × closed test).
 *   - Pass rate:          passed / released best results × 100.
 *   - Attendance:         (present + late + excused) / marked records × 100.
 *   - Assignment average: returned submissions with a numeric score,
 *                         each as score / max_score × 100, averaged.
 *
 * Module performance is staff-only (question → module); students get
 * no topic analysis in Phase 1.
 */

export type PerformanceRole = "admin" | "trainer" | "student";

export interface PerformanceMetrics {
  /** null when there is nothing to average. */
  testAverage: number | null;
  releasedResults: number;
  passedResults: number;
  passRate: number | null;
  attendancePercent: number | null;
  attendanceMarked: number;
  attendanceAttended: number;
  assignmentAverage: number | null;
  assignmentsScored: number;
}

/** One released test on the trend line (chronological). */
export interface PerformanceTrendPoint {
  testId: string;
  title: string;
  /** ISO timestamp/date used for ordering and the axis label. */
  date: string | null;
  /** Average best percentage for this test in scope. */
  averagePercent: number;
}

/** Marks earned vs available for one module (staff only). */
export interface ModulePerformance {
  moduleId: string;
  title: string;
  percent: number;
  /** Graded question answers counted. */
  answers: number;
}

/** A released test result shown on the student's own performance page. */
export interface StudentPerformanceResult {
  testId: string;
  title: string;
  percentage: number;
  passed: boolean;
}

export interface PerformanceFilterOption {
  value: string;
  label: string;
}

export interface PerformanceFilters {
  batches: PerformanceFilterOption[];
  /** Students of the selected batch (empty until a batch is chosen). */
  students: PerformanceFilterOption[];
  batchId: string | null;
  studentId: string | null;
}

export interface PerformanceData {
  role: PerformanceRole;
  metrics: PerformanceMetrics;
  trend: PerformanceTrendPoint[];
  /** Staff only; null for students (no topic analysis in Phase 1). */
  modules: ModulePerformance[] | null;
  strongModules: string[];
  weakModules: string[];
  /** Student only: their released results, newest first. */
  studentResults: StudentPerformanceResult[] | null;
  /** Staff only. */
  filters: PerformanceFilters | null;
  /** Short description of what the numbers cover. */
  scopeLabel: string;
}

/** Module thresholds (match the ProgressBar colour bands on the page). */
export const MODULE_STRONG_MIN = 80;
export const MODULE_WEAK_BELOW = 65;
