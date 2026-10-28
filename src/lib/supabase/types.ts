/**
 * Supabase database types.
 *
 * This file will eventually be replaced wholesale by the generated
 * output of:
 *
 *   npx supabase gen types typescript --project-id <id> > src/lib/supabase/types.ts
 *
 * Until then it is maintained by hand, matching the EXACT shape that
 * generator emits (a `type` alias — not an `interface` — with
 * `Database["public"]["Tables"][T]["Row" | "Insert" | "Update"]`,
 * `{ [_ in never]: never }` for empty sections, and `Relationships`
 * as a plain array). Matching the generated shape precisely matters:
 * @supabase/supabase-js's `.from()` overloads resolve through a
 * chain of default generic parameters (SchemaName, then Schema)
 * that are sensitive to this exact structure — see the note above
 * ClassesRow below for what broke when it didn't match.
 *
 * Each table here must stay in sync with its migration under
 * `supabase/migrations/`. Tables that have no migration yet are
 * deliberately absent rather than guessed at.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Mirrors the CHECK constraints on public.classes (0001_classes.sql). */
export type ClassStatusColumn = "scheduled" | "live" | "completed" | "cancelled";
export type ClassTypeColumn = "online" | "offline" | "hybrid";

/**
 * Columns of public.classes exactly as stored.
 * Nullable columns are `| null`, matching the migration.
 */
export type ClassesRow = {
  id: string;
  course_id: string;
  module_id: string | null;
  batch_id: string;
  trainer_id: string;
  title: string;
  description: string | null;
  class_date: string;
  start_time: string;
  end_time: string;
  teams_meeting_url: string | null;
  status: ClassStatusColumn;
  class_type: ClassTypeColumn;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Insert shape: columns with a DB default (id, created_at,
 * updated_at, status, class_type) are optional; nullable columns
 * accept null; everything else is required.
 */
export type ClassesInsert = {
  id?: string;
  course_id: string;
  module_id?: string | null;
  batch_id: string;
  trainer_id: string;
  title: string;
  description?: string | null;
  class_date: string;
  start_time: string;
  end_time: string;
  teams_meeting_url?: string | null;
  status?: ClassStatusColumn;
  class_type?: ClassTypeColumn;
  notes?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** Update shape: every column optional (partial patch). */
export type ClassesUpdate = Partial<ClassesInsert>;

/** Mirrors the public.app_role enum (0002_profiles_roles.sql). */
export type AppRoleColumn = "super_admin" | "trainer" | "student";

/** Account access lifecycle (0016_user_lifecycle.sql). Only "active" has a usable role. */
export type AccountStatusColumn = "invited" | "active" | "suspended";

/**
 * Columns of public.profiles exactly as stored. `role` is the ONLY
 * production source of an application role — see
 * src/lib/auth/profile-role.ts.
 */
export type ProfilesRow = {
  id: string;
  role: AppRoleColumn;
  created_at: string;
  updated_at: string;
  /** 0016 — the role applies only while this is "active". */
  account_status: AccountStatusColumn;
  account_status_changed_at: string;
  account_status_changed_by: string | null;
};

/**
 * End users have no INSERT/UPDATE privilege on profiles (RLS + grants
 * in 0002); these shapes exist for type completeness and for trusted
 * service-role code only.
 */
export type ProfilesInsert = {
  id: string;
  role?: AppRoleColumn;
  created_at?: string;
  updated_at?: string;
  account_status?: AccountStatusColumn;
};

export type ProfilesUpdate = Partial<ProfilesInsert>;

// -------------------------------------------------------------------
// Core training model (0003_core_training_model.sql)
// -------------------------------------------------------------------

/** Mirrors the enums created in 0003_core_training_model.sql. */
export type PersonStatusColumn = "active" | "inactive" | "invited";
export type CourseLevelColumn = "foundation" | "intermediate" | "advanced";
export type CourseStatusColumn = "draft" | "published" | "archived";
export type BatchStatusColumn = "upcoming" | "ongoing" | "completed" | "cancelled";
export type EnrollmentStatusColumn = "enrolled" | "withdrawn" | "completed";

/**
 * public.trainers — id is the trainer's profiles.id (auth user id).
 * Only what other roles may see; contact data is in trainer_details.
 */
export type TrainersRow = {
  id: string;
  trainer_code: string;
  full_name: string;
  status: PersonStatusColumn;
  created_at: string;
  updated_at: string;
};

export type TrainersInsert = {
  id: string;
  trainer_code: string;
  full_name: string;
  status?: PersonStatusColumn;
  created_at?: string;
  updated_at?: string;
};

export type TrainersUpdate = Partial<TrainersInsert>;

/** public.trainer_details — readable only by super_admin and the trainer. */
export type TrainerDetailsRow = {
  trainer_id: string;
  email: string;
  phone: string | null;
  /** 0022 */
  organization: string | null;
  /** 0022 */
  designation: string | null;
  specializations: string[];
  bio: string | null;
  created_at: string;
  updated_at: string;
};

export type TrainerDetailsInsert = {
  trainer_id: string;
  email: string;
  phone?: string | null;
  organization?: string | null;
  designation?: string | null;
  specializations?: string[];
  bio?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type TrainerDetailsUpdate = Partial<TrainerDetailsInsert>;

/**
 * public.students — id is the student's profiles.id (auth user id).
 * Only what other roles may see; personal data is in student_details.
 */
export type StudentsRow = {
  id: string;
  student_code: string;
  full_name: string;
  status: PersonStatusColumn;
  created_at: string;
  updated_at: string;
};

export type StudentsInsert = {
  id: string;
  student_code: string;
  full_name: string;
  status?: PersonStatusColumn;
  created_at?: string;
  updated_at?: string;
};

export type StudentsUpdate = Partial<StudentsInsert>;

/** public.student_details — readable only by super_admin and the student. */
export type StudentDetailsRow = {
  student_id: string;
  email: string;
  phone: string | null;
  organization: string | null;
  designation: string | null;
  created_at: string;
  updated_at: string;
};

export type StudentDetailsInsert = {
  student_id: string;
  email: string;
  phone?: string | null;
  organization?: string | null;
  designation?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type StudentDetailsUpdate = Partial<StudentDetailsInsert>;

export type CoursesRow = {
  id: string;
  course_code: string;
  title: string;
  description: string;
  level: CourseLevelColumn;
  duration_hours: number;
  status: CourseStatusColumn;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CoursesInsert = {
  id?: string;
  course_code: string;
  title: string;
  description?: string;
  level: CourseLevelColumn;
  duration_hours?: number;
  status?: CourseStatusColumn;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type CoursesUpdate = Partial<CoursesInsert>;

export type ModulesRow = {
  id: string;
  course_id: string;
  module_code: string;
  title: string;
  description: string | null;
  sequence: number;
  duration_hours: number;
  created_at: string;
  updated_at: string;
};

export type ModulesInsert = {
  id?: string;
  course_id: string;
  module_code: string;
  title: string;
  description?: string | null;
  sequence: number;
  duration_hours?: number;
  created_at?: string;
  updated_at?: string;
};

export type ModulesUpdate = Partial<ModulesInsert>;

export type BatchesRow = {
  id: string;
  batch_code: string;
  course_id: string;
  trainer_id: string | null;
  name: string;
  start_date: string;
  end_date: string;
  status: BatchStatusColumn;
  max_seats: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BatchesInsert = {
  id?: string;
  batch_code: string;
  course_id: string;
  trainer_id?: string | null;
  name: string;
  start_date: string;
  end_date: string;
  status?: BatchStatusColumn;
  max_seats: number;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type BatchesUpdate = Partial<BatchesInsert>;

export type BatchStudentsRow = {
  batch_id: string;
  student_id: string;
  enrollment_status: EnrollmentStatusColumn;
  enrolled_at: string;
  completed_at: string | null;
  enrolled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BatchStudentsInsert = {
  batch_id: string;
  student_id: string;
  enrollment_status?: EnrollmentStatusColumn;
  enrolled_at?: string;
  completed_at?: string | null;
  enrolled_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type BatchStudentsUpdate = Partial<BatchStudentsInsert>;

// -------------------------------------------------------------------
// Class attendance (0005_class_attendance.sql)
// -------------------------------------------------------------------

/** Mirrors the public.attendance_status enum. */
export type AttendanceStatusColumn = "present" | "absent" | "late" | "excused";

/** public.class_attendance — one student's attendance for one class. */
export type ClassAttendanceRow = {
  class_id: string;
  student_id: string;
  batch_id: string;
  status: AttendanceStatusColumn;
  remarks: string | null;
  marked_by: string;
  marked_at: string;
  created_at: string;
  updated_at: string;
};

/**
 * marked_by / marked_at are always set by the database
 * (class_attendance_stamp) and are deliberately not insertable from the
 * client; created_at / updated_at are database-managed too.
 */
export type ClassAttendanceInsert = {
  class_id: string;
  student_id: string;
  batch_id: string;
  status: AttendanceStatusColumn;
  remarks?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ClassAttendanceUpdate = Partial<ClassAttendanceInsert>;

// -------------------------------------------------------------------
// Assignments (0006_assignments.sql)
// -------------------------------------------------------------------

/** Mirrors the public.assignment_status / submission_status enums. */
export type AssignmentStatusColumn = "draft" | "published" | "closed";
export type SubmissionStatusColumn = "submitted" | "returned";

export type ClassAssignmentsRow = {
  id: string;
  class_id: string;
  batch_id: string;
  title: string;
  instructions: string | null;
  resource_url: string | null;
  due_at: string | null;
  max_score: number | null;
  status: AssignmentStatusColumn;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

/**
 * created_by / updated_by / created_at / updated_at are stamped by the
 * database (class_assignments_stamp) and are deliberately not
 * insertable from the client.
 */
export type ClassAssignmentsInsert = {
  id?: string;
  class_id: string;
  batch_id: string;
  title: string;
  instructions?: string | null;
  resource_url?: string | null;
  due_at?: string | null;
  max_score?: number | null;
  status?: AssignmentStatusColumn;
};

export type ClassAssignmentsUpdate = Partial<ClassAssignmentsInsert>;

export type AssignmentSubmissionsRow = {
  assignment_id: string;
  student_id: string;
  batch_id: string;
  submission_url: string;
  note: string | null;
  status: SubmissionStatusColumn;
  submitted_at: string;
  score: number | null;
  feedback: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * submitted_at / reviewed_by / reviewed_at / created_at / updated_at are
 * stamped by the database (assignment_submissions_guard) and are
 * deliberately not insertable from the client. status/score/feedback
 * are review fields: the guard forces them on insert and only honours
 * them from trainers/admins on update.
 */
export type AssignmentSubmissionsInsert = {
  assignment_id: string;
  student_id: string;
  batch_id: string;
  submission_url: string;
  note?: string | null;
  status?: SubmissionStatusColumn;
  score?: number | null;
  feedback?: string | null;
};

export type AssignmentSubmissionsUpdate = Partial<AssignmentSubmissionsInsert>;

// -------------------------------------------------------------------
// Question bank (0007_question_bank.sql)
// -------------------------------------------------------------------

/** Mirrors the public.question_type / question_status enums. */
export type QuestionTypeColumn = "single_choice" | "multiple_choice" | "true_false";
export type QuestionStatusColumn = "draft" | "active" | "archived";

export type QuestionsRow = {
  id: string;
  course_id: string;
  module_id: string | null;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  status: QuestionStatusColumn;
  explanation: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

/**
 * Authenticated users have NO insert/update privilege on questions or
 * question_options: every write goes through the save_question /
 * set_question_status database functions (see Functions below), and
 * created_by / updated_by / revision / timestamps are stamped by the
 * database. These shapes exist only to satisfy the Database type.
 */
export type QuestionsInsert = {
  id?: string;
  course_id: string;
  module_id?: string | null;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  status?: QuestionStatusColumn;
  explanation?: string | null;
};

export type QuestionsUpdate = Partial<QuestionsInsert>;

/** is_correct is the answer key — staff-only (no student RLS policy). */
export type QuestionOptionsRow = {
  id: string;
  question_id: string;
  option_text: string;
  display_order: number;
  is_correct: boolean;
};

export type QuestionOptionsInsert = {
  id?: string;
  question_id: string;
  option_text: string;
  display_order: number;
  is_correct: boolean;
};

export type QuestionOptionsUpdate = Partial<QuestionOptionsInsert>;

// -------------------------------------------------------------------
// Class tests (0008_tests.sql)
// -------------------------------------------------------------------

/** Mirrors the public.test_type / test_status enums. */
export type TestTypeColumn = "quiz" | "module_test" | "final_exam" | "practical";
export type TestStatusColumn = "draft" | "scheduled" | "active" | "closed";

export type TestsRow = {
  id: string;
  class_id: string;
  batch_id: string;
  test_type: TestTypeColumn;
  title: string;
  instructions: string | null;
  status: TestStatusColumn;
  pass_mark_percent: number | null;
  time_limit_minutes: number | null;
  attempt_limit: number;
  available_from: string | null;
  available_until: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

/**
 * created_by / updated_by / created_at / updated_at are stamped by the
 * database (tests_stamp) and are deliberately not insertable from the
 * client. status is validated and normalised by tests_validate.
 */
export type TestsInsert = {
  id?: string;
  class_id: string;
  batch_id: string;
  test_type: TestTypeColumn;
  title: string;
  instructions?: string | null;
  status?: TestStatusColumn;
  pass_mark_percent?: number | null;
  time_limit_minutes?: number | null;
  attempt_limit?: number;
  available_from?: string | null;
  available_until?: string | null;
};

export type TestsUpdate = Partial<TestsInsert>;

/**
 * Frozen question copy. Authenticated users have SELECT only (staff,
 * via RLS); rows are written only by add_test_questions /
 * remove_test_question. The Insert shapes exist only to satisfy the
 * Database type.
 */
export type TestQuestionsRow = {
  id: string;
  test_id: string;
  position: number;
  source_question_id: string;
  source_revision: number;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  explanation: string | null;
  added_by: string;
  added_at: string;
};

export type TestQuestionsInsert = {
  id?: string;
  test_id: string;
  position: number;
  source_question_id: string;
  source_revision: number;
  question_text: string;
  question_type: QuestionTypeColumn;
  marks: number;
  explanation?: string | null;
};

export type TestQuestionsUpdate = Partial<TestQuestionsInsert>;

/** is_correct is the frozen answer key — staff-only (no student RLS policy). */
export type TestQuestionOptionsRow = {
  id: string;
  test_question_id: string;
  option_text: string;
  display_order: number;
  is_correct: boolean;
};

export type TestQuestionOptionsInsert = {
  id?: string;
  test_question_id: string;
  option_text: string;
  display_order: number;
  is_correct: boolean;
};

export type TestQuestionOptionsUpdate = Partial<TestQuestionOptionsInsert>;

// -------------------------------------------------------------------
// Test attempts (0009_test_attempts.sql) — staff read-only
// -------------------------------------------------------------------

/** Mirrors the public.test_attempt_status / test_attempt_finalize_reason enums. */
export type TestAttemptStatusColumn = "in_progress" | "submitted" | "finalized";
export type TestAttemptFinalizeReasonColumn =
  | "student_submit"
  | "deadline"
  | "test_closed"
  | "class_cancelled"
  | "batch_cancelled"
  | "withdrawn"
  | "enrollment_ended";

/** Mirrors the public.test_security_event_type enum. */
export type TestSecurityEventTypeColumn =
  | "attempt_started"
  | "repeated_start"
  | "blocked_start"
  | "answer_saved"
  | "blocked_answer_save"
  | "submit"
  | "auto_submit"
  | "blocked_submission"
  | "deadline_reached"
  | "test_closed_finalization"
  | "cancellation_finalization"
  | "withdrawal_finalization"
  | "invalid_attempt_access"
  | "suspicious_repeated_access"
  // 0015 (exam integrity foundation)
  | "concurrent_session"
  | "client_hidden"
  | "client_offline"
  | "client_online"
  | "client_copy"
  | "client_paste"
  | "client_print"
  | "client_multiple_tabs"
  | "client_fullscreen_exit";

/**
 * public.test_attempts. SELECT only, for super admins and the batch's
 * CURRENT trainer (RLS); students have no table access (they use the
 * 0009 functions). Result columns are written once by the database at
 * finalization — no client can insert or update, so the Insert/Update
 * shapes are deliberately empty.
 */
export type TestAttemptsRow = {
  id: string;
  test_id: string;
  batch_id: string;
  student_id: string;
  attempt_number: number;
  status: TestAttemptStatusColumn;
  started_at: string;
  deadline_at: string;
  question_count: number;
  max_score: number;
  finalized_at: string | null;
  finalize_reason: TestAttemptFinalizeReasonColumn | null;
  score: number | null;
  percentage: number | null;
  passed: boolean | null;
  graded_at: string | null;
};

/** public.test_attempt_answers — graded fields are filled at finalization. Staff SELECT only. */
export type TestAttemptAnswersRow = {
  attempt_id: string;
  test_question_id: string;
  client_seq: number;
  save_count: number;
  saved_at: string | null;
  is_correct: boolean | null;
  marks_awarded: number | null;
};

/** public.test_security_events — append-only, server-written. Staff SELECT only. */
export type TestSecurityEventsRow = {
  id: number;
  occurred_at: string;
  event_type: TestSecurityEventTypeColumn;
  actor_id: string;
  attempt_id: string | null;
  test_id: string | null;
  batch_id: string | null;
  student_id: string | null;
  detail: Json;
};

/** public.test_best_results (security_invoker view): best finished attempt per test × student. */
export type TestBestResultsRow = {
  test_id: string;
  batch_id: string;
  student_id: string;
  best_attempt_id: string;
  score: number;
  max_score: number;
  percentage: number;
  passed: boolean;
  finalized_at: string;
  finished_attempts: number;
};

/** No client writes exist for 0009 tables (no INSERT/UPDATE privilege). */
type NoClientWrites = { [_ in never]: never };

// -------------------------------------------------------------------
// Completion management and certificates (0011_certificates_completion.sql)
// Staff SELECT only (RLS: super admin, or the batch's assigned trainer).
// Every write goes through the 0011 database functions; students and
// anonymous users read only through functions.
// -------------------------------------------------------------------

/** Mirrors the public.completion_status / certificate_status / completion_event_type enums. */
export type CompletionStatusColumn = "recommended" | "approved" | "rejected" | "withdrawn";
export type CertificateStatusColumn = "issued" | "revoked";
export type CompletionEventTypeColumn =
  | "final_assessment_set"
  | "final_assessment_cleared"
  | "required_assignment_added"
  | "required_assignment_removed"
  | "recommended"
  | "recommendation_withdrawn"
  | "approved"
  | "rejected"
  | "certificate_issued"
  | "certificate_revoked";

/** public.batch_final_assessments — the one required final assessment of a batch. */
export type BatchFinalAssessmentsRow = {
  batch_id: string;
  test_id: string;
  designated_by: string;
  designated_at: string;
};

/** public.batch_required_assignments — required assignments of a batch. */
export type BatchRequiredAssignmentsRow = {
  batch_id: string;
  assignment_id: string;
  added_by: string;
  added_at: string;
};

/** public.completion_records — one completion decision per student per batch. */
export type CompletionRecordsRow = {
  id: string;
  batch_id: string;
  student_id: string;
  status: CompletionStatusColumn;
  recommended_by: string;
  recommended_at: string;
  recommendation_note: string | null;
  eligibility_at_recommendation: Json;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  eligibility_at_decision: Json | null;
  completion_date: string | null;
  created_at: string;
  updated_at: string;
};

/** public.certificates — an immutable issued snapshot (revocable once). */
export type CertificatesRow = {
  id: string;
  certificate_number: string;
  verification_code: string;
  completion_id: string;
  batch_id: string;
  student_id: string;
  status: CertificateStatusColumn;
  replaces_certificate_id: string | null;
  student_name: string;
  course_code: string;
  course_title: string;
  batch_code: string;
  batch_name: string;
  batch_start_date: string;
  batch_end_date: string;
  completion_date: string;
  trainer_name: string | null;
  issuer_name: string;
  template_version: string;
  signatories: Json;
  snapshot_sha256: string;
  issued_by: string;
  issued_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
};

/** public.completion_events — append-only audit log. */
export type CompletionEventsRow = {
  id: number;
  occurred_at: string;
  event_type: CompletionEventTypeColumn;
  actor_id: string;
  batch_id: string;
  student_id: string | null;
  completion_id: string | null;
  certificate_id: string | null;
  detail: Json;
};

// -------------------------------------------------------------------
// In-app notifications (0012_notifications.sql)
// Read and marked read ONLY through the four 0012 user functions
// (identity from auth.uid(); no recipient argument). Rows are created
// by database triggers, never by the application.
// -------------------------------------------------------------------

/** Mirrors the public.notification_type / notification_entity enums. */
export type NotificationTypeColumn =
  | "class_scheduled"
  | "class_updated"
  | "class_cancelled"
  | "assignment_published"
  | "submission_received"
  | "submission_updated"
  | "submission_returned"
  | "test_published"
  | "test_closed"
  | "completion_recommended"
  | "completion_approved"
  | "completion_rejected"
  | "certificate_issued"
  | "certificate_revoked";
export type NotificationEntityColumn = "class" | "assignment" | "submission" | "test" | "completion" | "certificate";

// -------------------------------------------------------------------
// Bulk question import (0013_question_import.sql)
// History: SELECT for its creator or a super admin; no client writes.
// Every write goes through the 0013 functions (questions only through
// save_question). question_fingerprint_cache has no client access.
// -------------------------------------------------------------------

/** Mirrors the public.question_import_source / _status / _action enums. */
export type QuestionImportSourceColumn = "xlsx" | "csv" | "docx" | "pdf" | "pdf_ocr";
export type QuestionImportStatusColumn = "in_progress" | "completed" | "discarded";
export type QuestionImportActionColumn = "create" | "update";

/** public.question_import_runs */
export type QuestionImportRunsRow = {
  id: string;
  created_by: string;
  source: QuestionImportSourceColumn;
  file_name: string;
  file_sha256: string;
  planned_creates: number;
  planned_updates: number;
  planned_excluded: number;
  status: QuestionImportStatusColumn;
  created_count: number;
  updated_count: number;
  discarded_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  discarded_at: string | null;
};

/** public.question_import_items — one question written by an import. */
export type QuestionImportItemsRow = {
  run_id: string;
  row_number: number;
  action: QuestionImportActionColumn;
  question_id: string;
  previous_revision: number | null;
  new_revision: number;
  fingerprint: string;
  created_at: string;
};

/** One row of public.question_import_fingerprints(p_course_ids). */
export type QuestionImportFingerprintsRow = {
  question_id: string;
  course_id: string;
  status: QuestionStatusColumn;
  revision: number;
  fingerprint: string;
  text_fingerprint: string;
};

// -------------------------------------------------------------------
// User management (0017_user_management_foundation.sql)
// -------------------------------------------------------------------

/** Mirrors public.user_admin_event_type. */
export type UserAdminEventTypeColumn =
  | "invitation_created"
  | "invitation_withheld"
  | "invitation_resent"
  | "invitation_revoked"
  | "invitation_expired"
  | "invitation_accepted"
  | "account_status_changed"
  | "role_changed"
  | "enrollment_changed"
  | "trainer_assignment_changed"
  | "user_details_changed"
  // 0029a (P5.2): invitation recovery for a never-activated placeholder account.
  | "invitation_recovery_requested"
  | "invitation_recovered";

/**
 * public.user_admin_events — append-only audit of user-management
 * actions. Written only by the 0017 functions (actor and time stamped by
 * the database); clients may only SELECT (Super Admin: all rows).
 */
export type UserAdminEventsRow = {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  event_type: UserAdminEventTypeColumn;
  target_user_id: string | null;
  invitation_id: string | null;
  batch_id: string | null;
  detail: Json;
};

/** Mirrors public.user_invitation_status (0017). */
export type UserInvitationStatusColumn = "pending" | "accepted" | "revoked" | "expired";

/**
 * public.user_invitations (0017, 0019) — the lifecycle columns the Users
 * view reads (P3.9). Written only by the invitation functions; clients may
 * only SELECT (Super Admin: all rows; trainer: own / current-batch). The
 * table holds no token or secret (Supabase Auth owns those).
 */
export type UserInvitationsRow = {
  id: string;
  status: UserInvitationStatusColumn;
  expires_at: string;
  last_sent_at: string | null;
  resend_count: number;
  auth_user_id: string | null;
  created_at: string;
};

/**
 * public.enrollment_events — append-only enrolment history (0017). Written
 * only by the batch_students trigger (source admin / trainer / invitation /
 * direct / baseline); clients may only SELECT (Super Admin: all rows;
 * trainer: batches they currently teach).
 */
export type EnrollmentEventsRow = {
  id: number;
  occurred_at: string;
  batch_id: string;
  student_id: string;
  previous_status: EnrollmentStatusColumn | null;
  new_status: EnrollmentStatusColumn;
  actor_id: string | null;
  source: "admin" | "trainer" | "invitation" | "direct" | "baseline";
  reason: string | null;
};

export type CourseEventTypeColumn =
  | "course_created"
  | "course_updated"
  | "course_status_changed"
  | "course_deleted"
  | "module_created"
  | "module_updated"
  | "module_moved"
  | "module_deleted";

/**
 * public.course_events — append-only Course Management audit (0030). Written
 * only by the admin_* course functions; Super Admin SELECT only. course_id /
 * module_id are not foreign keys (the history outlives a deleted course).
 */
export type CourseEventsRow = {
  id: number;
  occurred_at: string;
  actor_id: string | null;
  event_type: CourseEventTypeColumn;
  course_id: string;
  module_id: string | null;
  detail: Json;
};

/** One row returned by public.my_notifications(p_limit). */
export type MyNotificationsRow = {
  id: string;
  type: NotificationTypeColumn;
  title: string;
  body: string;
  link: string | null;
  related_entity_type: NotificationEntityColumn | null;
  created_at: string;
  read_at: string | null;
};

export type Database = {
  public: {
    Tables: {
      classes: {
        Row: ClassesRow;
        Insert: ClassesInsert;
        Update: ClassesUpdate;
        Relationships: [
          {
            foreignKeyName: "classes_course_fk";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "classes_batch_fk";
            columns: ["batch_id", "course_id"];
            isOneToOne: false;
            referencedRelation: "batches";
            referencedColumns: ["id", "course_id"];
          },
          {
            foreignKeyName: "classes_module_fk";
            columns: ["module_id", "course_id"];
            isOneToOne: false;
            referencedRelation: "modules";
            referencedColumns: ["id", "course_id"];
          },
          {
            foreignKeyName: "classes_trainer_fk";
            columns: ["trainer_id"];
            isOneToOne: false;
            referencedRelation: "trainers";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: ProfilesRow;
        Insert: ProfilesInsert;
        Update: ProfilesUpdate;
        Relationships: [];
      };
      trainers: {
        Row: TrainersRow;
        Insert: TrainersInsert;
        Update: TrainersUpdate;
        Relationships: [
          {
            foreignKeyName: "trainers_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      trainer_details: {
        Row: TrainerDetailsRow;
        Insert: TrainerDetailsInsert;
        Update: TrainerDetailsUpdate;
        Relationships: [
          {
            foreignKeyName: "trainer_details_trainer_id_fkey";
            columns: ["trainer_id"];
            isOneToOne: true;
            referencedRelation: "trainers";
            referencedColumns: ["id"];
          },
        ];
      };
      students: {
        Row: StudentsRow;
        Insert: StudentsInsert;
        Update: StudentsUpdate;
        Relationships: [
          {
            foreignKeyName: "students_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      student_details: {
        Row: StudentDetailsRow;
        Insert: StudentDetailsInsert;
        Update: StudentDetailsUpdate;
        Relationships: [
          {
            foreignKeyName: "student_details_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: true;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
      courses: {
        Row: CoursesRow;
        Insert: CoursesInsert;
        Update: CoursesUpdate;
        Relationships: [
          {
            foreignKeyName: "courses_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      modules: {
        Row: ModulesRow;
        Insert: ModulesInsert;
        Update: ModulesUpdate;
        Relationships: [
          {
            foreignKeyName: "modules_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      batches: {
        Row: BatchesRow;
        Insert: BatchesInsert;
        Update: BatchesUpdate;
        Relationships: [
          {
            foreignKeyName: "batches_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "batches_trainer_id_fkey";
            columns: ["trainer_id"];
            isOneToOne: false;
            referencedRelation: "trainers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "batches_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      batch_students: {
        Row: BatchStudentsRow;
        Insert: BatchStudentsInsert;
        Update: BatchStudentsUpdate;
        Relationships: [
          {
            foreignKeyName: "batch_students_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "batch_students_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "batch_students_enrolled_by_fkey";
            columns: ["enrolled_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      class_attendance: {
        Row: ClassAttendanceRow;
        Insert: ClassAttendanceInsert;
        Update: ClassAttendanceUpdate;
        Relationships: [
          {
            foreignKeyName: "class_attendance_class_batch_fk";
            columns: ["class_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id", "batch_id"];
          },
          {
            foreignKeyName: "class_attendance_enrolment_fk";
            columns: ["batch_id", "student_id"];
            isOneToOne: false;
            referencedRelation: "batch_students";
            referencedColumns: ["batch_id", "student_id"];
          },
          {
            foreignKeyName: "class_attendance_student_fk";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "class_attendance_marked_by_fkey";
            columns: ["marked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      class_assignments: {
        Row: ClassAssignmentsRow;
        Insert: ClassAssignmentsInsert;
        Update: ClassAssignmentsUpdate;
        Relationships: [
          {
            foreignKeyName: "class_assignments_class_batch_fk";
            columns: ["class_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id", "batch_id"];
          },
          {
            foreignKeyName: "class_assignments_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "class_assignments_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      assignment_submissions: {
        Row: AssignmentSubmissionsRow;
        Insert: AssignmentSubmissionsInsert;
        Update: AssignmentSubmissionsUpdate;
        Relationships: [
          {
            foreignKeyName: "assignment_submissions_assignment_batch_fk";
            columns: ["assignment_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "class_assignments";
            referencedColumns: ["id", "batch_id"];
          },
          {
            foreignKeyName: "assignment_submissions_enrolment_fk";
            columns: ["batch_id", "student_id"];
            isOneToOne: false;
            referencedRelation: "batch_students";
            referencedColumns: ["batch_id", "student_id"];
          },
          {
            foreignKeyName: "assignment_submissions_student_fk";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_submissions_reviewed_by_fkey";
            columns: ["reviewed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      questions: {
        Row: QuestionsRow;
        Insert: QuestionsInsert;
        Update: QuestionsUpdate;
        Relationships: [
          {
            foreignKeyName: "questions_course_fk";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "questions_module_course_fk";
            columns: ["module_id", "course_id"];
            isOneToOne: false;
            referencedRelation: "modules";
            referencedColumns: ["id", "course_id"];
          },
          {
            foreignKeyName: "questions_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "questions_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      question_options: {
        Row: QuestionOptionsRow;
        Insert: QuestionOptionsInsert;
        Update: QuestionOptionsUpdate;
        Relationships: [
          {
            foreignKeyName: "question_options_question_fk";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
        ];
      };
      tests: {
        Row: TestsRow;
        Insert: TestsInsert;
        Update: TestsUpdate;
        Relationships: [
          {
            foreignKeyName: "tests_class_batch_fk";
            columns: ["class_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "classes";
            referencedColumns: ["id", "batch_id"];
          },
          {
            foreignKeyName: "tests_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tests_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      test_questions: {
        Row: TestQuestionsRow;
        Insert: TestQuestionsInsert;
        Update: TestQuestionsUpdate;
        Relationships: [
          {
            foreignKeyName: "test_questions_test_fk";
            columns: ["test_id"];
            isOneToOne: false;
            referencedRelation: "tests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "test_questions_source_fk";
            columns: ["source_question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "test_questions_added_by_fkey";
            columns: ["added_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      test_question_options: {
        Row: TestQuestionOptionsRow;
        Insert: TestQuestionOptionsInsert;
        Update: TestQuestionOptionsUpdate;
        Relationships: [
          {
            foreignKeyName: "test_question_options_question_fk";
            columns: ["test_question_id"];
            isOneToOne: false;
            referencedRelation: "test_questions";
            referencedColumns: ["id"];
          },
        ];
      };
      test_attempts: {
        Row: TestAttemptsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [
          {
            foreignKeyName: "test_attempts_test_batch_fk";
            columns: ["test_id", "batch_id"];
            isOneToOne: false;
            referencedRelation: "tests";
            referencedColumns: ["id", "batch_id"];
          },
          {
            foreignKeyName: "test_attempts_enrolment_fk";
            columns: ["batch_id", "student_id"];
            isOneToOne: false;
            referencedRelation: "batch_students";
            referencedColumns: ["batch_id", "student_id"];
          },
          {
            foreignKeyName: "test_attempts_student_fk";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "students";
            referencedColumns: ["id"];
          },
        ];
      };
      test_attempt_answers: {
        Row: TestAttemptAnswersRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      test_security_events: {
        Row: TestSecurityEventsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      batch_final_assessments: {
        Row: BatchFinalAssessmentsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      batch_required_assignments: {
        Row: BatchRequiredAssignmentsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      completion_records: {
        Row: CompletionRecordsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      certificates: {
        Row: CertificatesRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      completion_events: {
        Row: CompletionEventsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      question_import_runs: {
        Row: QuestionImportRunsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      question_import_items: {
        Row: QuestionImportItemsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      user_admin_events: {
        Row: UserAdminEventsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      user_invitations: {
        Row: UserInvitationsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      enrollment_events: {
        Row: EnrollmentEventsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
      course_events: {
        Row: CourseEventsRow;
        Insert: NoClientWrites;
        Update: NoClientWrites;
        Relationships: [];
      };
    };
    Views: {
      test_best_results: {
        Row: TestBestResultsRow;
        Relationships: [];
      };
    };
    Functions: {
      /**
       * Caller's role from public.profiles, or NULL (no user / no
       * profile). Defined in 0001, replaced in 0002_profiles_roles.sql.
       */
      current_app_role: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      /** RLS helpers (0003). Each answers a question about the caller only. */
      is_super_admin: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      is_batch_trainer: {
        Args: { p_batch_id: string };
        Returns: boolean;
      };
      is_enrolled_in_batch: {
        Args: { p_batch_id: string };
        Returns: boolean;
      };
      is_class_trainer_in_batch: {
        Args: { p_batch_id: string };
        Returns: boolean;
      };
      can_read_course: {
        Args: { p_course_id: string };
        Returns: boolean;
      };
      student_can_read_trainer: {
        Args: { p_trainer_id: string };
        Returns: boolean;
      };
      trainer_can_read_student: {
        Args: { p_student_id: string };
        Returns: boolean;
      };
      /** RLS helpers (0005). Each answers a question about the caller only. */
      is_class_trainer: {
        Args: { p_class_id: string };
        Returns: boolean;
      };
      owns_student_record: {
        Args: { p_student_id: string };
        Returns: boolean;
      };
      /** Question bank (0007). Caller is a CURRENT trainer (upcoming/ongoing batch) of the course. */
      is_course_trainer: {
        Args: { p_course_id: string };
        Returns: boolean;
      };
      /** Atomic create/update of a question + all its options; returns the question id. */
      save_question: {
        Args: { payload: Json };
        Returns: string;
      };
      set_question_status: {
        Args: { p_question_id: string; p_status: QuestionStatusColumn };
        Returns: undefined;
      };
      /** Class tests (0008). Caller is the CURRENT trainer (upcoming/ongoing) of the batch. */
      is_current_batch_trainer: {
        Args: { p_batch_id: string };
        Returns: boolean;
      };
      test_effective_status: {
        Args: { p_status: TestStatusColumn; p_available_from: string | null; p_available_until: string | null };
        Returns: TestStatusColumn;
      };
      /** Copies active bank questions (server-side) into a draft test; returns how many were added. */
      add_test_questions: {
        Args: { p_test_id: string; p_question_ids: string[] };
        Returns: number;
      };
      remove_test_question: {
        Args: { p_test_question_id: string };
        Returns: undefined;
      };
      /**
       * Secure student test engine (0009/0010). Every student operation
       * goes through these functions (identity from auth.uid(); blocked
       * cases return {ok:false, reason}); students have no table access.
       */
      student_available_tests: {
        Args: Record<string, never>;
        Returns: Json;
      };
      start_test_attempt: {
        Args: { p_test_id: string };
        Returns: Json;
      };
      get_attempt_paper: {
        Args: { p_attempt_id: string };
        Returns: Json;
      };
      save_test_answer: {
        Args: { p_attempt_id: string; p_test_question_id: string; p_option_ids: string[]; p_client_seq: number };
        Returns: Json;
      };
      submit_test_attempt: {
        Args: { p_attempt_id: string };
        Returns: Json;
      };
      get_attempt_result: {
        Args: { p_attempt_id: string };
        Returns: Json;
      };
      /** Student-reported browser signal for the caller's own in-progress attempt (0015). */
      record_attempt_client_event: {
        Args: { p_attempt_id: string; p_kind: string; p_detail?: Json };
        Returns: Json;
      };
      staff_finalize_due_attempts: {
        Args: { p_test_id: string };
        Returns: Json;
      };
      /**
       * Completion management and certificates (0011). Identity from
       * auth.uid(); business outcomes return {ok:false, reason}. The
       * database generates numbers, codes, snapshots and all stamps.
       */
      set_final_assessment: {
        Args: { p_batch_id: string; p_test_id: string };
        Returns: Json;
      };
      clear_final_assessment: {
        Args: { p_batch_id: string };
        Returns: Json;
      };
      add_required_assignment: {
        Args: { p_batch_id: string; p_assignment_id: string };
        Returns: Json;
      };
      remove_required_assignment: {
        Args: { p_batch_id: string; p_assignment_id: string };
        Returns: Json;
      };
      recommend_completion: {
        Args: { p_batch_id: string; p_student_id: string; p_note?: string | null };
        Returns: Json;
      };
      withdraw_recommendation: {
        Args: { p_completion_id: string };
        Returns: Json;
      };
      decide_completion: {
        Args: { p_completion_id: string; p_approve: boolean; p_note?: string | null };
        Returns: Json;
      };
      issue_certificate: {
        Args: { p_completion_id: string };
        Returns: Json;
      };
      revoke_certificate: {
        Args: { p_certificate_id: string; p_reason: string };
        Returns: Json;
      };
      staff_batch_completion: {
        Args: { p_batch_id: string };
        Returns: Json;
      };
      student_completion_status: {
        Args: Record<string, never>;
        Returns: Json;
      };
      student_certificates: {
        Args: Record<string, never>;
        Returns: Json;
      };
      /** Public (anon): BOTH the number and the verification code must match. */
      verify_certificate: {
        Args: { p_number: string; p_code: string };
        Returns: Json;
      };
      // --- 0012 in-app notifications (the caller's own rows only) ---
      /** Latest notifications of the signed-in user, newest first (the database caps it at 50). */
      my_notifications: {
        Args: { p_limit?: number };
        Returns: MyNotificationsRow[];
      };
      my_unread_notification_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** false for another user's id, an unknown id or an already-read notification. */
      mark_notification_read: {
        Args: { p_notification_id: string };
        Returns: boolean;
      };
      /** Number of the caller's notifications that were marked read. */
      mark_all_notifications_read: {
        Args: Record<string, never>;
        Returns: number;
      };
      // --- 0013 bulk question import (caller's own runs; authenticated only) ---
      /** Existing-question fingerprints of 1–50 manageable courses (order by question_id to page). */
      question_import_fingerprints: {
        Args: { p_course_ids: string[] };
        Returns: QuestionImportFingerprintsRow[];
      };
      /** Returns the new run id. */
      start_question_import: {
        Args: {
          p_source: QuestionImportSourceColumn;
          p_file_name: string;
          p_file_sha256: string;
          p_planned_creates: number;
          p_planned_updates: number;
          p_planned_excluded: number;
        };
        Returns: string;
      };
      /** Up to 100 rows in one transaction; {ok, run_id, created, updated, results[]}. */
      import_question_chunk: {
        Args: { p_run_id: string; p_items: Json };
        Returns: Json;
      };
      finish_question_import: {
        Args: { p_run_id: string };
        Returns: Json;
      };
      discard_question_import: {
        Args: { p_run_id: string };
        Returns: Json;
      };
      // --- 0017 user management (Super Admin; each function checks the caller, scope and protections) ---
      /** active → suspended; suspended → active only if active before (0018). Returns { ok, reason?, previous?, status? }. */
      admin_set_account_status: {
        Args: { p_user_id: string; p_status: AccountStatusColumn; p_reason?: string | null };
        Returns: Json;
      };
      /** Role change of an active account (or completing its missing domain record). Returns { ok, reason?, previous?, role? }. */
      admin_set_user_role: {
        Args: { p_user_id: string; p_role: AppRoleColumn; p_details?: Json };
        Returns: Json;
      };
      /** Name + contact details of a student. Returns { ok, reason?, fields? }. */
      admin_update_student: {
        Args: { p_student_id: string; p: Json };
        Returns: Json;
      };
      /** 0017, caller's session: an active trainer edits an in-scope student (full_name, phone, organization, designation). Returns { ok, fields?, reason? }. */
      trainer_update_student: {
        Args: { p_student_id: string; p: Json };
        Returns: Json;
      };
      /** Name + contact details of a trainer. Returns { ok, reason?, fields? }. */
      admin_update_trainer: {
        Args: { p_trainer_id: string; p: Json };
        Returns: Json;
      };
      /** 0030 Course Management, Super Admin only (42501 otherwise). Each returns { ok, reason?, … }. */
      admin_create_course: {
        Args: { p: Json };
        Returns: Json;
      };
      admin_update_course: {
        Args: { p_course_id: string; p: Json };
        Returns: Json;
      };
      admin_set_course_status: {
        Args: { p_course_id: string; p_status: string };
        Returns: Json;
      };
      admin_delete_course: {
        Args: { p_course_id: string };
        Returns: Json;
      };
      admin_create_module: {
        Args: { p_course_id: string; p: Json };
        Returns: Json;
      };
      admin_update_module: {
        Args: { p_module_id: string; p: Json };
        Returns: Json;
      };
      admin_move_module: {
        Args: { p_module_id: string; p_direction: string };
        Returns: Json;
      };
      admin_delete_module: {
        Args: { p_module_id: string };
        Returns: Json;
      };
      admin_course_usage: {
        Args: { p_course_id: string };
        Returns: Json;
      };
      /** Assign/change a current batch's trainer (row lock, audited; 0021 refuses direct writes). Returns { ok, reason?, previous?, trainer_id? }. */
      admin_assign_batch_trainer: {
        Args: { p_batch_id: string; p_trainer_id: string };
        Returns: Json;
      };
      /** 0017/0023, Super Admin: enrol / withdraw / re-enrol / complete. Returns { ok, reason?, previous?, status? }. */
      admin_set_enrollment: {
        Args: { p_batch_id: string; p_student_id: string; p_status: EnrollmentStatusColumn; p_reason?: string | null };
        Returns: Json;
      };
      /** 0017/0023, trainer: enrol an in-scope student into a batch they currently teach. Returns { ok, reason?, status? }. */
      trainer_enroll_student: {
        Args: { p_batch_id: string; p_student_id: string };
        Returns: Json;
      };
      /**
       * 0024, Super Admin (SECURITY INVOKER, the caller's RLS): grouped dashboard analytics for India dates
       * [p_from, p_to] and the same number of days before. Returns one JSON object (validated by
       * src/lib/dashboard/analytics.ts before use).
       */
      dashboard_analytics: {
        Args: { p_from: string; p_to: string; p_limit?: number };
        Returns: Json;
      };
      /** 0017 (address rule widened by 0019 D1). Returns { ok, invitation_id? , reason? }. */
      create_user_invitation: {
        Args: { p: Json };
        Returns: Json;
      };
      /** 0017, caller's session: revoke a pending invitation (state only; nothing deleted). Returns { ok, reason?, status? }. */
      revoke_user_invitation: {
        Args: { p_invitation_id: string; p_reason?: string | null };
        Returns: Json;
      };
      /** 0019, caller's session: authorize one delivery attempt. Returns { ok, email?, expires_at?, attempt?, resend_count?, reason?, retry_after_seconds? }. */
      begin_invitation_delivery: {
        Args: { p_invitation_id: string };
        Returns: Json;
      };
      /** 0019, service_role ONLY: record the outcome of an authorized attempt. Returns { ok, delivery_status?, reason? }. */
      record_invitation_delivery: {
        Args: { p_invitation_id: string; p_sent: boolean; p_auth_user_id?: string | null };
        Returns: Json;
      };
      /** 0017 (0029a: bound account only), the invitee's own session: activate the invited account. Returns { ok, role?, enrolled?, reason? }. */
      accept_user_invitation: {
        Args: Record<string, never>;
        Returns: Json;
      };
      /** 0029a, Super Admin's session: request recovery for a never-activated placeholder. Returns { ok, email?, expires_at?, resend_count?, reason?, retry_after_seconds? }. */
      begin_invitation_recovery: {
        Args: { p_invitation_id: string };
        Returns: Json;
      };
      /** 0029a, the invitee's own session after an e-mail sign-in link: bind the requested invitation. Returns { ok, bound?, reason? }. */
      complete_invitation_recovery: {
        Args: Record<string, never>;
        Returns: Json;
      };
      /** 0029a, Super Admin read: the invitation a placeholder account could recover. Returns { ok, invitation_id?, expires_at?, last_sent_at?, resend_count?, recovery_requested_at? }. */
      invitation_recovery_candidate: {
        Args: { p_user_id: string };
        Returns: Json;
      };
    };
    Enums: {
      app_role: AppRoleColumn;
      person_status: PersonStatusColumn;
      course_level: CourseLevelColumn;
      course_status: CourseStatusColumn;
      batch_status: BatchStatusColumn;
      enrollment_status: EnrollmentStatusColumn;
      attendance_status: AttendanceStatusColumn;
      assignment_status: AssignmentStatusColumn;
      submission_status: SubmissionStatusColumn;
      question_type: QuestionTypeColumn;
      question_status: QuestionStatusColumn;
      test_type: TestTypeColumn;
      test_status: TestStatusColumn;
      test_attempt_status: TestAttemptStatusColumn;
      test_attempt_finalize_reason: TestAttemptFinalizeReasonColumn;
      test_security_event_type: TestSecurityEventTypeColumn;
      completion_status: CompletionStatusColumn;
      certificate_status: CertificateStatusColumn;
      completion_event_type: CompletionEventTypeColumn;
      notification_type: NotificationTypeColumn;
      notification_entity: NotificationEntityColumn;
      question_import_source: QuestionImportSourceColumn;
      question_import_status: QuestionImportStatusColumn;
      question_import_action: QuestionImportActionColumn;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
