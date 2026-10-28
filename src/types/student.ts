import type { UserStatus } from "./user";

/**
 * A student as the app presents it: public.students (code, name,
 * status) plus public.student_details (email, phone, organization,
 * designation — readable only by super_admin and the student
 * themselves). `id` is the student's profiles.id — the same id as
 * their auth user.
 */
export interface Student {
  id: string;
  /**
   * @deprecated Equal to `id` in the database (students.id =
   * profiles.id). Kept only for the mock student records
   * (src/lib/mock/students.mock.ts); remove when that module is wired.
   */
  userId: string;
  studentCode: string;
  fullName: string;
  email: string;
  phone?: string;
  organization?: string;
  designation?: string;
  /**
   * @deprecated Not stored — derived from batch_students in the
   * database. Kept only for the mock student records; remove when the
   * students module is wired.
   */
  enrolledBatchIds: string[];
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * A student as shown in the Students table (admin and trainer). Built
 * from public.students + student_details + current enrolments
 * (Supabase mode), or from the demo data (demo mode).
 */
export interface StudentSummary {
  id: string;
  name: string;
  /** student_details.email; empty when unavailable (e.g. trainers can't read it). */
  email: string;
  /** Current batches (enrolled, non-cancelled), joined — or "—" when none. */
  batch: string;
  /** Courses of those current batches, joined — or "—" when none. */
  course: string;
  /** No data source yet in Supabase mode (needs Attendance) — undefined shows "—". */
  attendance?: number;
  /** No data source yet in Supabase mode (needs Tests) — undefined shows "—". */
  performance?: number;
  status: UserStatus;
  /**
   * The account's status (profiles.account_status) when the caller may read the profile (Super Admin);
   * "suspended" = removed / deactivated (P3.11-B). Undefined when unreadable (e.g. the trainer view) or in demo mode.
   */
  accountStatus?: "active" | "invited" | "suspended";
  /**
   * The account's current role (profiles.role) when readable (Super Admin), P3.11-D. A row whose role is no
   * longer "student" is a stale student record (role changed): it is not offered the Super Admin "Edit".
   */
  accountRole?: "super_admin" | "trainer" | "student";
  /**
   * Trainer list only (P3.10-B), computed server-side: the trainer may edit this student
   * (enrolled in an upcoming/ongoing batch they run). A UI hint — the database decides.
   */
  editable?: boolean;
}
