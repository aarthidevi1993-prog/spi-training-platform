/**
 * Bulk Question Import types (0013_question_import.sql). Staff-only: rows
 * carry the answer key. Shared by the browser preview and the server's
 * re-validation — the database (0013 + save_question) is the final
 * authority.
 */
import type { QuestionStatus, QuestionType } from "./question";

/** Source file kinds (mirrors public.question_import_source). */
export type ImportSource = "xlsx" | "csv" | "docx" | "pdf" | "pdf_ocr";

/** Questions detected in one file (mirrors 0013 question_import_runs_planned_limit). */
export const IMPORT_QUESTION_LIMITS: Record<ImportSource, number> = {
  xlsx: 5000,
  csv: 10000,
  docx: 1000,
  pdf: 1000,
  pdf_ocr: 1000,
};

/** Largest accepted source file (checked before parsing). */
export const IMPORT_FILE_SIZE_LIMITS: Record<ImportSource, number> = {
  xlsx: 10 * 1024 * 1024,
  csv: 10 * 1024 * 1024,
  docx: 15 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  pdf_ocr: 25 * 1024 * 1024,
};

/** Rows per import_question_chunk call (0013 maximum). */
export const IMPORT_CHUNK_SIZE = 100;

/** Row numbers accepted by 0013. */
export const IMPORT_ROW_NUMBER_MAX = 1_000_000;

/** Option columns A–J (the Question Bank allows up to 10 options). */
export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type OptionLetter = (typeof OPTION_LETTERS)[number];

/** Per-row outcome in the preview. */
export type ImportRowStatus = "CREATE" | "UPDATE" | "DUPLICATE" | "ERROR" | "NEEDS_REVIEW";

export type ImportIssueSeverity = "error" | "needs_review" | "warning";

export type ImportField =
  | "row"
  | "questionId"
  | "courseCode"
  | "moduleCode"
  | "questionType"
  | "questionText"
  | "options"
  | "correctAnswer"
  | "marks"
  | "explanation"
  | "status";

export type ImportIssueCode =
  | "row_number_invalid"
  | "question_id_invalid"
  | "question_id_repeated"
  | "question_not_found"
  | "question_protected"
  | "course_missing"
  | "course_not_found"
  | "course_mismatch"
  | "course_change"
  | "module_not_found"
  | "type_missing"
  | "type_invalid"
  | "text_missing"
  | "text_too_long"
  | "options_too_few"
  | "option_gap"
  | "option_too_long"
  | "option_repeated"
  | "true_false_options"
  | "answer_missing"
  | "answer_invalid"
  | "answer_repeated"
  | "answer_blank_option"
  | "answer_count"
  | "marks_missing"
  | "marks_invalid"
  | "explanation_too_long"
  | "status_ignored"
  | "extraction_incomplete"
  | "ocr_review"
  | "duplicate_in_file"
  | "duplicate_in_bank"
  | "included_anyway"
  | "similar_question"
  | "revision_conflict"
  | "revision_missing"
  | "revision_invalid"
  | "formula_cell"
  | "cell_error"
  | "row_malformed";

export interface ImportIssue {
  code: ImportIssueCode;
  severity: ImportIssueSeverity;
  field?: ImportField;
  message: string;
}

/** Where an extracted item came from (Word/PDF/OCR). */
export interface ImportRowSource {
  page?: number;
  paragraph?: number;
  /** 0–100 (OCR). */
  ocrConfidence?: number;
  /** The extractor was unsure of this item (e.g. low OCR confidence). */
  uncertain?: boolean;
  /** Required information the extractor could not find. */
  missing?: ImportField[];
}

/**
 * One source row or extracted item, exactly as read (raw values).
 * options[0] is Option A … options[9] is Option J.
 */
export interface RawImportRow {
  rowNumber: number;
  questionId?: string | null;
  courseCode?: string | null;
  moduleCode?: string | null;
  questionType?: string | null;
  questionText?: string | null;
  options?: Array<string | number | boolean | null | undefined>;
  correctAnswer?: string | number | boolean | null;
  marks?: string | number | null;
  explanation?: string | null;
  status?: string | null;
  source?: ImportRowSource;
  /** Preview decision: import even though it is a duplicate. */
  includeAnyway?: boolean;
  /** Preview decision: the reviewer checked an OCR item against its page. */
  reviewConfirmed?: boolean;
  /**
   * Update rows: the revision the preview showed. When given, a question
   * that changed since then is a revision conflict (never overwritten).
   */
  expectedRevision?: number | null;
  /** Problems the file parser found in this row (e.g. a formula cell); always reported. */
  sourceIssues?: ImportIssue[];
}

/** A parsed Excel/CSV file (browser side; nothing is uploaded). */
export interface ParsedImportFile {
  source: ImportSource;
  rows: RawImportRow[];
  /** Blocking problems (bad headers, malformed file, too many rows): nothing can be imported. */
  fileErrors: string[];
  /** Non-blocking notes (ignored columns, skipped blank rows). */
  warnings: string[];
  blankRowsSkipped: number;
  /** Worksheet read (Excel). */
  sheetName?: string;
  /** Whether the file has a Course Code column with a value on every row. */
  everyRowHasCourse: boolean;
}

/** One Question Bank question as exported for staff (includes the answer key). */
export interface ExportQuestion {
  id: string;
  courseCode: string;
  moduleCode: string | null;
  text: string;
  type: QuestionType;
  marks: number;
  options: { text: string; isCorrect: boolean }[];
  explanation: string | null;
  status: QuestionStatus;
  revision: number;
}

/** "bank": every question in scope; "update": draft questions only, ready to edit and re-import. */
export type ExportMode = "bank" | "update";

export interface QuestionExport {
  mode: ExportMode;
  generatedAt: string;
  questions: ExportQuestion[];
}

/** A spreadsheet-shaped table (header row + data rows). */
export interface SheetTable {
  headers: string[];
  rows: Array<Array<string | number>>;
}

/** A course the caller may manage (the import scope). */
export interface ImportCourse {
  id: string;
  code: string;
  /** For the course picker (not used by validation). */
  title?: string;
  modules: { id: string; code: string; title?: string }[];
}

/** An existing bank question, as returned by question_import_fingerprints (0013). */
export interface ExistingQuestionFingerprint {
  questionId: string;
  courseId: string;
  status: QuestionStatus;
  revision: number;
  fingerprint: string;
  textFingerprint: string;
}

/** A question a row asks to update (read under the caller's RLS scope). */
export interface UpdateTarget {
  id: string;
  courseId: string;
  status: QuestionStatus;
  revision: number;
}

export interface ImportContext {
  source: ImportSource;
  /** Courses the caller may manage (super admin: all; trainer: current courses). */
  courses: ImportCourse[];
  /** Existing questions of the courses the file touches. */
  existing: ExistingQuestionFingerprint[];
  /** Questions named by Question ID that the caller can see. */
  updateTargets: UpdateTarget[];
  /** Course (and module) chosen in the UI for Word/PDF files without codes. */
  defaultCourseId?: string | null;
  defaultModuleId?: string | null;
}

/** A validated, save_question-ready question (always saved as draft). */
export interface NormalizedImportQuestion {
  courseId: string;
  moduleId: string | null;
  type: QuestionType;
  text: string;
  marks: number;
  explanation: string | null;
  options: { text: string; isCorrect: boolean }[];
}

export type DuplicateRef = { kind: "file"; rowNumber: number } | { kind: "bank"; questionId: string };

export interface ImportRowResult {
  rowNumber: number;
  status: ImportRowStatus;
  action: "create" | "update" | null;
  questionId: string | null;
  /** Revision seen in the preview (updates); the database refuses a changed question. */
  expectedRevision: number | null;
  question: NormalizedImportQuestion | null;
  fingerprint: string | null;
  textFingerprint: string | null;
  duplicateOf: DuplicateRef | null;
  similarTo: DuplicateRef[];
  includeAnyway: boolean;
  issues: ImportIssue[];
  source?: ImportRowSource;
}

export interface ImportPreviewSummary {
  total: number;
  create: number;
  update: number;
  duplicate: number;
  error: number;
  needsReview: number;
}

// ---------------------------------------------------------------------------
// Server engine (Phase D): runs, chunks, outcomes
// ---------------------------------------------------------------------------

/** What the browser declares when an import starts (the server re-checks every chunk). */
export interface ImportPlan {
  source: ImportSource;
  fileName: string;
  /** SHA-256 of the source file (lowercase hex) — identifies the file for resume. */
  fileSha256: string;
  plannedCreates: number;
  plannedUpdates: number;
  plannedExcluded: number;
}

/** Ask the server for the preview context of a file. */
export interface ImportContextRequest {
  source: ImportSource;
  /** Course codes that appear in the file. */
  courseCodes: string[];
  /** Question IDs that appear in the file (updates). */
  questionIds: string[];
  defaultCourseId?: string | null;
  defaultModuleId?: string | null;
}

/** One chunk of raw rows (≤ 100). The server re-validates every row. */
export interface ImportChunkRequest {
  source: ImportSource;
  defaultCourseId?: string | null;
  defaultModuleId?: string | null;
  rows: RawImportRow[];
}

export type ImportRunStatus = "in_progress" | "completed" | "discarded";

export interface ImportRunProgress {
  id: string;
  status: ImportRunStatus;
  source: ImportSource;
  fileName: string;
  fileSha256: string;
  plannedCreates: number;
  plannedUpdates: number;
  plannedExcluded: number;
  createdCount: number;
  updatedCount: number;
  discardedCount: number;
  createdAt: string;
  completedAt: string | null;
  discardedAt: string | null;
}

/** Why the database refused a row (0013 reasons). */
export type ImportRejectReason = "duplicate" | "protected" | "conflict" | "not_found" | "no_permission" | "invalid" | "limit";

/**
 * What happened to one row:
 *  created / updated — written by this chunk; unchanged — update with identical content;
 *  already_done — written earlier in this run (resume/retry); skipped — not sent (the
 *  server's validation said ERROR / NEEDS_REVIEW / DUPLICATE); rejected — refused by the database.
 */
export type ImportRowOutcomeKind = "created" | "updated" | "unchanged" | "already_done" | "skipped" | "rejected";

export interface ImportRowOutcome {
  rowNumber: number;
  outcome: ImportRowOutcomeKind;
  questionId: string | null;
  /** skipped: the server-side status. */
  status?: ImportRowStatus;
  /** rejected: the database's reason. */
  reason?: ImportRejectReason;
  message?: string;
  issues?: ImportIssue[];
  duplicateOf?: string | null;
}

export interface ImportChunkOutcome {
  runId: string;
  rows: ImportRowOutcome[];
  created: number;
  updated: number;
  run: ImportRunProgress;
}

export interface ImportResumeState {
  run: ImportRunProgress;
  /** Row numbers already written in this run (skip them when resuming). */
  doneRowNumbers: number[];
}

export interface ImportDiscardOutcome {
  run: ImportRunProgress;
  /** Drafts this run created that were deleted (unchanged, unused). */
  deleted: number;
  /** Created questions kept (edited or activated since, or used in a test). Updates are never reverted. */
  kept: number;
}

/** Server action result. `retryable` is true only for transient failures (network, timeout, busy database). */
export type ImportActionResult<T> = { ok: true; data: T } | { ok: false; error: string; retryable: boolean };

/** One row object for import_question_chunk (0013 keys). Never carries a status. */
export interface ImportChunkItem {
  row_number: number;
  question_id?: string;
  expected_revision?: number;
  course_id: string;
  module_id: string | null;
  question_type: QuestionType;
  question_text: string;
  marks: number;
  explanation: string | null;
  options: { option_text: string; is_correct: boolean }[];
  allow_duplicate: boolean;
}
