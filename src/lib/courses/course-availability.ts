/**
 * Which courses may be chosen where (Option A for archived courses):
 *
 *   New batches        only a PUBLISHED course. Archiving a course retires
 *                      it from the catalogue (the 0030 database guard
 *                      refuses a client batch insert for any other status).
 *   Class scheduling   a PUBLISHED course, or an ARCHIVED course that still
 *                      has an upcoming or ongoing batch — that batch's
 *                      training continues normally after archiving (the
 *                      batch itself must still be upcoming/ongoing, which
 *                      the class form and service check separately).
 *
 * Enrolment: an archived course's ONGOING batches still take students; its
 * UPCOMING batches take no new ones (enforced in the database: 0030 section 7,
 * admin_set_enrollment / trainer_enroll_student / invitations). Attendance,
 * tests, assignments and completion never depend on the course status.
 * Pure functions: the class options loader and the Add Batch options use them.
 */

export type CourseStatusLike = string | null | undefined;

/** A batch status that still has training ahead (classes may be scheduled for it). */
export const isCurrentBatchStatus = (status: CourseStatusLike) => status === "upcoming" || status === "ongoing";

/** May a NEW batch use this course? */
export function isCourseOpenForNewBatches(status: CourseStatusLike): boolean {
  return status === "published";
}

/** May classes be scheduled for this course (given whether it still has an upcoming/ongoing batch)? */
export function isCourseOpenForScheduling(status: CourseStatusLike, hasCurrentBatch: boolean): boolean {
  return status === "published" || (status === "archived" && hasCurrentBatch);
}
