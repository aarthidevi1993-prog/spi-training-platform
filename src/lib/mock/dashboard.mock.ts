/**
 * PART 3 placeholder data for the dashboard UI/UX pass.
 *
 * This is presentation-only mock data (no repository/service behind
 * it) so the dashboard can show the intended visual design — KPI
 * cards, charts, activity feed — before the real students/courses/
 * attendance/tests modules exist. Swap each section for a real
 * service call (e.g. studentsService.listStudents().length) as each
 * module is built in a later part; the page components already read
 * from typed shapes below so that swap is additive.
 */

export interface KpiDatum {
  label: string;
  value: string;
  trend: number;
  trendLabel: string;
}

export const adminKpisPrimary: KpiDatum[] = [
  { label: "Total Students", value: "124", trend: 12, trendLabel: "vs last month" },
  { label: "Active Trainers", value: "8", trend: 2, trendLabel: "vs last month" },
  { label: "Active Courses", value: "6", trend: 0, trendLabel: "vs last month" },
  { label: "Active Batches", value: "4", trend: 1, trendLabel: "vs last month" },
];

export const adminKpisSecondary: KpiDatum[] = [
  { label: "Today's Attendance", value: "92%", trend: 3, trendLabel: "vs yesterday" },
  { label: "Tests Completed", value: "48", trend: 15, trendLabel: "vs last month" },
  { label: "Average Performance", value: "78%", trend: 5, trendLabel: "vs last month" },
  { label: "Certificates Issued", value: "32", trend: 8, trendLabel: "vs last month" },
];

export const trainerKpis: KpiDatum[] = [
  { label: "Assigned Batches", value: "3", trend: 0, trendLabel: "vs last month" },
  { label: "Assigned Students", value: "42", trend: 6, trendLabel: "vs last month" },
  { label: "Classes This Week", value: "9", trend: 2, trendLabel: "vs last week" },
  { label: "Avg. Student Score", value: "81%", trend: 4, trendLabel: "vs last month" },
];

export const studentKpis: KpiDatum[] = [
  { label: "Attendance", value: "94%", trend: 2, trendLabel: "vs last month" },
  { label: "Tests Completed", value: "7", trend: 1, trendLabel: "this course" },
  { label: "Average Score", value: "85%", trend: 6, trendLabel: "vs last test" },
  { label: "Course Progress", value: "68%", trend: 10, trendLabel: "vs last month" },
];

export const performanceTrend = [
  { label: "1", value: 25 },
  { label: "2", value: 32 },
  { label: "3", value: 30 },
  { label: "4", value: 45 },
  { label: "5", value: 50 },
  { label: "6", value: 58 },
  { label: "7", value: 65 },
  { label: "8", value: 72 },
];

export const attendanceTrend = [
  { label: "Mon", present: 92, absent: 8 },
  { label: "Tue", present: 88, absent: 12 },
  { label: "Wed", present: 95, absent: 5 },
  { label: "Thu", present: 80, absent: 20 },
  { label: "Fri", present: 90, absent: 10 },
  { label: "Sat", present: 85, absent: 15 },
  { label: "Sun", present: 0, absent: 0 },
];

export const courseProgressSegments = [
  { label: "Completed", value: 68, color: "#0E6B3E" },
  { label: "In Progress", value: 22, color: "#F2B705" },
  { label: "Not Started", value: 10, color: "#DFE4E8" },
];

export interface UpcomingClassRow {
  date: string;
  time: string;
  className: string;
  batch: string;
  mode: "classroom" | "lab" | "online";
}

export const upcomingClasses: UpcomingClassRow[] = [
  { date: "26 May 2025", time: "10:00 – 11:00", className: "Instrumentation Basics", batch: "Batch A", mode: "classroom" },
  { date: "26 May 2025", time: "14:00 – 15:00", className: "Control Systems", batch: "Batch B", mode: "lab" },
  { date: "27 May 2025", time: "10:00 – 11:00", className: "Process Safety", batch: "Batch A", mode: "classroom" },
];

export interface RecentTestResultRow {
  student: string;
  test: string;
  score: number;
  date: string;
}

export const recentTestResults: RecentTestResultRow[] = [
  { student: "Rahul Sharma", test: "Instrumentation Basics", score: 85, date: "26 May 2025" },
  { student: "Priya Nair", test: "Control Systems", score: 78, date: "25 May 2025" },
  { student: "Arjun Kumar", test: "Process Safety", score: 92, date: "24 May 2025" },
  { student: "Sneha Iyer", test: "Instrumentation Basics", score: 76, date: "23 May 2025" },
];

export type ActivityType = "enrollment" | "test" | "attendance" | "certificate";

export interface RecentActivityRow {
  type: ActivityType;
  title: string;
  subtitle: string;
  timeAgo: string;
}

export const recentActivity: RecentActivityRow[] = [
  { type: "enrollment", title: "New student registered", subtitle: "Alex Johnson", timeAgo: "2 hours ago" },
  { type: "test", title: "Test completed", subtitle: "Batch A · Instrumentation Basics", timeAgo: "3 hours ago" },
  { type: "attendance", title: "Attendance marked", subtitle: "Batch B · Control Systems", timeAgo: "4 hours ago" },
  { type: "certificate", title: "New certificate issued", subtitle: "Priya Nair", timeAgo: "5 hours ago" },
];

export function getResultsForStudent(studentName: string): RecentTestResultRow[] {
  return recentTestResults.filter((r) => r.student === studentName);
}
