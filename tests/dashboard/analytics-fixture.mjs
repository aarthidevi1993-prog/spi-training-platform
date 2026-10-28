// A dashboard_analytics (0024) response with exactly the migration's fields, for the D2b-2A unit tests.
// Returns a fresh object each call so tests can change it freely.
export function rawAnalytics(overrides = {}) {
  const totals = (o = {}) => ({ test_avg: 78, pass_rate: 90, results: 24, attendance_pct: 81.25, attendance_marked: 16, assignment_avg: 78.57, assignments_scored: 7, ...o });
  return {
    period: { from: "2026-10-01", to: "2026-10-06", prev_from: "2026-09-25", prev_to: "2026-09-30", bucket: "week", days: 6 },
    trend: [
      { bucket_start: "2026-10-01", bucket_end: "2026-10-04", ...totals({ test_avg: 76.5, pass_rate: 88, results: 9, attendance_pct: 80, attendance_marked: 10, assignment_avg: null, assignments_scored: 0 }) },
      { bucket_start: "2026-10-05", bucket_end: "2026-10-06", ...totals({ test_avg: null, pass_rate: null, results: 0, attendance_pct: 83.33, attendance_marked: 6, assignment_avg: 78.57, assignments_scored: 7 }) },
    ],
    totals: { current: totals(), previous: totals({ test_avg: 72, pass_rate: 85, results: 12, attendance_pct: 88, attendance_marked: 20, assignment_avg: null, assignments_scored: 0 }) },
    batches: [
      {
        id: "b1", code: "B-1", name: "Batch One", course_id: "c1", course: "Valves", students: 5,
        attendance_pct: 80, attendance_n: 15, test_avg: 73.75, pass_rate: 90, results_n: 20, assignment_avg: 78.57, assignments_n: 7,
        completion_pct: 20, prev_test_avg: 60, prev_results_n: 5, prev_attendance_pct: null, prev_attendance_n: 2,
      },
    ],
    batches_total: 1,
    courses: [
      { id: "c1", code: "C-1", title: "Valves", test_avg: 74.57, pass_rate: 91.3, results_n: 23, attendance_pct: 80, attendance_n: 15, assignment_avg: 78.57, assignments_n: 7, prev_test_avg: 60, prev_results_n: 5 },
    ],
    courses_total: 1,
    students: {
      top: [{ id: "s2", code: "S-2", name: "Student Two", average: 81.25, results: 4 }],
      improving: [{ id: "s1", code: "S-1", name: "Student One", earlier_avg: 52.5, later_avg: 75, change: 22.5, results: 5 }],
      declining: [{ id: "s2", code: "S-2", name: "Student Two", earlier_avg: 87.5, later_avg: 75, change: -12.5, results: 4 }],
      ranked: 5,
      // 0027: the CURRENT ranking (trailing 366 days, database order) with each student's period trend (pp)
      current: [
        { rank: 1, id: "s2", code: "S-2", name: "Student Two", average: 96, results: 4, period_average: 96, period_results: 2, previous_average: 88, previous_results: 1, trend: 8 },
        { rank: 2, id: "s1", code: "S-1", name: "Student One", average: 92.25, results: 5, period_average: 90, period_results: 1, previous_average: 91, previous_results: 2, trend: -1 },
        { rank: 3, id: "s3", code: "S-3", name: "Student Three", average: 88, results: 3, period_average: null, period_results: 0, previous_average: 80, previous_results: 2, trend: null },
      ],
      current_window: { from: "2025-10-06", to: "2026-10-06" },
    },
    topics: [
      { module_id: "m1", title: "Control Valve Sizing", percent: 33.33, answers: 6, band: "attention" },
      { module_id: "m4", title: "Loop Identification", percent: 70, answers: 5, band: "watch" },
      { module_id: "m2", title: "P&ID Reading", percent: 91.67, answers: 6, band: "healthy" },
    ],
    delivery: [{ course_id: "c1", course: "Valves", planned: 5, delivered: 3, overdue: 1 }],
    delivery_total: 1,
    enrolment: [{ course_id: "c1", course: "Valves", completed: 4, active: 8 }],
    enrolment_total: 1,
    health: {
      attendance_n: 16, attendance_pct: 81.25, results_n: 24, test_avg: 74.17, assignments_n: 7, assignment_avg: 78.57,
      students_assessed: 3, students_below_75: 2, reviews_waiting_over_7d: 2,
    },
    ...overrides,
  };
}
