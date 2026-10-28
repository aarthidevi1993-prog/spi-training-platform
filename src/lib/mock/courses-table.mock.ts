/**
 * PART 3 UI-only mock rows for the Courses grid page. See the note in
 * students-table.mock.ts — this is presentation data only, kept
 * separate from the future courses repository.
 */
import type { CourseSummary } from "@/types/course";

/** Demo-mode course card shape — the same view model Supabase mode returns. */
export type CourseCardData = CourseSummary;

export const courseCards: CourseCardData[] = [
  {
    id: "crs_001",
    title: "Instrumentation Basics",
    description: "Fundamentals of process instrumentation including sensors, transmitters and control loops.",
    modules: 6,
    topics: 24,
    durationHours: 40,
    trainer: "Rajesh Kumar",
    progress: 68,
    status: "published",
  },
  {
    id: "crs_002",
    title: "Control Systems",
    description: "PLC and DCS fundamentals for process control, covering loop tuning and system architecture.",
    modules: 8,
    topics: 30,
    durationHours: 48,
    trainer: "Anita Desai",
    progress: 35,
    status: "published",
  },
  {
    id: "crs_003",
    title: "Process Safety",
    description: "Hazard identification, SIL rating and safety instrumented systems for process plants.",
    modules: 5,
    topics: 18,
    durationHours: 32,
    trainer: "Karthik Raman",
    progress: 12,
    status: "published",
  },
  {
    id: "crs_004",
    title: "P&ID Fundamentals",
    description: "Reading and developing Piping & Instrumentation Diagrams for engineering teams.",
    modules: 4,
    topics: 16,
    durationHours: 24,
    trainer: "Rajesh Kumar",
    progress: 0,
    status: "draft",
  },
  {
    id: "crs_005",
    title: "SPI Tag Configuration",
    description: "Hands-on instrument tag numbering and loop configuration inside Smart Plant Instrumentation.",
    modules: 7,
    topics: 26,
    durationHours: 36,
    trainer: "Anita Desai",
    progress: 0,
    status: "draft",
  },
  {
    id: "crs_006",
    title: "Advanced Process Control",
    description: "Advanced regulatory and supervisory control strategies for continuous processes.",
    modules: 9,
    topics: 34,
    durationHours: 52,
    trainer: "Karthik Raman",
    progress: 0,
    status: "archived",
  },
];

export function getCoursesForTrainer(trainerName: string): CourseCardData[] {
  return courseCards.filter((c) => c.trainer === trainerName);
}

export function getEnrolledCourses(): CourseCardData[] {
  return courseCards.filter((c) => (c.progress ?? 0) > 0);
}
