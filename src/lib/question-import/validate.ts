/**
 * Bulk import — row validation, duplicate detection and the import plan.
 * Pure (browser preview and server re-check run the same code); the
 * database (0013 + save_question) re-checks everything at import time.
 *
 * Row status (most serious wins): ERROR > NEEDS_REVIEW > DUPLICATE >
 * CREATE / UPDATE. Only CREATE and UPDATE rows are ever sent to the
 * database. New questions are always drafts and no row can set a status.
 */
import { QUESTION_LIMITS } from "@/types/question";
import {
  IMPORT_CHUNK_SIZE,
  IMPORT_QUESTION_LIMITS,
  IMPORT_ROW_NUMBER_MAX,
  type DuplicateRef,
  type ImportChunkItem,
  type ImportContext,
  type ImportCourse,
  type ImportField,
  type ImportIssue,
  type ImportPreviewSummary,
  type ImportRowResult,
  type ImportSource,
  type RawImportRow,
  type UpdateTarget,
} from "@/types/question-import";
import { parseCorrectAnswer, parseOptions } from "./answers";
import { questionFingerprint, textFingerprint } from "./fingerprint";
import { cleanText, normalizeCode, parseMarks, parseQuestionType, parseStatus, parseUuid } from "./normalize";

const EXTRACTED: ReadonlySet<ImportSource> = new Set(["docx", "pdf", "pdf_ocr"]);

const FIELD_LABEL: Record<ImportField, string> = {
  row: "row",
  questionId: "Question ID",
  courseCode: "course",
  moduleCode: "module",
  questionType: "question type",
  questionText: "question text",
  options: "options",
  correctAnswer: "correct answer",
  marks: "marks",
  explanation: "explanation",
  status: "status",
};

const err = (code: ImportIssue["code"], field: ImportField, message: string): ImportIssue => ({ code, severity: "error", field, message });
const review = (code: ImportIssue["code"], field: ImportField, message: string): ImportIssue => ({ code, severity: "needs_review", field, message });
const warn = (code: ImportIssue["code"], field: ImportField, message: string): ImportIssue => ({ code, severity: "warning", field, message });

/** Structured files report missing data as errors; extracted Word/PDF items as "needs review" (marks: always an error). */
function missingIssue(extracted: boolean, code: ImportIssue["code"], field: ImportField, message: string): ImportIssue {
  return extracted ? review(code, field, message) : err(code, field, message);
}

function statusFor(issues: ImportIssue[], action: "create" | "update" | null): ImportRowResult["status"] {
  if (issues.some((i) => i.severity === "error")) return "ERROR";
  if (issues.some((i) => i.severity === "needs_review")) return "NEEDS_REVIEW";
  return action === "update" ? "UPDATE" : "CREATE";
}

function findCourse(courses: ImportCourse[], id: string | null | undefined): ImportCourse | undefined {
  return id ? courses.find((c) => c.id.toLowerCase() === id.toLowerCase()) : undefined;
}

/** Validate one row's content (no duplicate check). */
export function validateRow(raw: RawImportRow, context: ImportContext): ImportRowResult {
  const extracted = EXTRACTED.has(context.source);
  const issues: ImportIssue[] = [...(raw.sourceIssues ?? [])];

  if (!Number.isInteger(raw.rowNumber) || raw.rowNumber < 1 || raw.rowNumber > IMPORT_ROW_NUMBER_MAX) {
    issues.push(err("row_number_invalid", "row", `Row numbers must be whole numbers from 1 to ${IMPORT_ROW_NUMBER_MAX}.`));
  }

  // Question ID: blank = new question; otherwise an existing DRAFT the caller manages.
  const idText = cleanText(raw.questionId);
  let questionId: string | null = null;
  let target: UpdateTarget | undefined;
  if (idText) {
    questionId = parseUuid(idText);
    if (!questionId) {
      issues.push(err("question_id_invalid", "questionId", "Question ID must be the ID exported from the Question Bank (leave it blank for a new question)."));
    } else {
      target = context.updateTargets.find((t) => t.id.toLowerCase() === questionId);
      if (!target) {
        issues.push(err("question_not_found", "questionId", "Question not found, or you don't have permission to change it."));
      } else if (target.status !== "draft") {
        issues.push(err("question_protected", "questionId", "Only draft questions can be updated by import. Active and archived questions are protected — edit them individually in the Question Bank."));
      } else if (raw.expectedRevision !== undefined && raw.expectedRevision !== null && raw.expectedRevision !== target.revision) {
        issues.push(
          err("revision_conflict", "questionId", `This question changed after the preview (revision ${raw.expectedRevision} → ${target.revision}). Reload the preview and try again.`)
        );
      }
    }
  }
  const action: "create" | "update" = questionId ? "update" : "create";

  // Course: the row's code, else the course chosen in the UI, else (updates) the question's own course.
  // Word/PDF: the chosen course is the import's course — a different code in the document is an error.
  // Excel/CSV: the chosen course only fills rows that have no Course Code.
  const codeText = cleanText(raw.courseCode);
  let course: ImportCourse | undefined;
  let usedDefaultCourse = false;
  if (codeText) {
    course = context.courses.find((c) => normalizeCode(c.code) === normalizeCode(codeText));
    if (!course) {
      issues.push(err("course_not_found", "courseCode", `Course code "${codeText}" was not found, or it isn't a course you can manage.`));
    } else if (extracted && context.defaultCourseId && course.id.toLowerCase() !== context.defaultCourseId.toLowerCase()) {
      issues.push(err("course_mismatch", "courseCode", `Course code "${codeText}" does not match the course chosen for this import.`));
      course = undefined; // don't validate the module against the wrong course
    }
  } else if (context.defaultCourseId && !target) {
    course = findCourse(context.courses, context.defaultCourseId);
    usedDefaultCourse = true;
    if (!course) issues.push(err("course_not_found", "courseCode", "The course chosen for this import isn't a course you can manage."));
  } else if (target) {
    course = findCourse(context.courses, target.courseId);
    if (!course) issues.push(err("question_not_found", "questionId", "Question not found, or you don't have permission to change it."));
  } else if (!questionId) {
    issues.push(err("course_missing", "courseCode", "Course code is required."));
  }
  if (target && course && course.id.toLowerCase() !== target.courseId.toLowerCase()) {
    issues.push(err("course_change", "courseCode", "A question's course cannot be changed."));
  }

  // Module (optional): must belong to the row's course.
  const moduleText = cleanText(raw.moduleCode);
  let moduleId: string | null = null;
  if (moduleText) {
    if (course) {
      const found = course.modules.find((m) => normalizeCode(m.code) === normalizeCode(moduleText));
      if (found) moduleId = found.id;
      else issues.push(err("module_not_found", "moduleCode", `Module code "${moduleText}" does not belong to course ${course.code}.`));
    }
  } else if (context.defaultModuleId && course && (usedDefaultCourse || extracted)) {
    const found = course.modules.find((m) => m.id.toLowerCase() === context.defaultModuleId!.toLowerCase());
    if (found) moduleId = found.id;
    else issues.push(err("module_not_found", "moduleCode", "The module chosen for this import does not belong to the course."));
  }

  // Type.
  const typeParse = parseQuestionType(raw.questionType);
  if (!typeParse.ok) {
    issues.push(
      typeParse.reason === "missing"
        ? missingIssue(extracted, "type_missing", "questionType", "Question type is required (single_choice, multiple_choice or true_false).")
        : err("type_invalid", "questionType", `Question type "${cleanText(raw.questionType)}" is not supported. Use single_choice, multiple_choice or true_false.`)
    );
  }

  // Text.
  const text = cleanText(raw.questionText);
  if (!text) issues.push(missingIssue(extracted, "text_missing", "questionText", "Question text is required."));
  else if (text.length > QUESTION_LIMITS.textMax) {
    issues.push(err("text_too_long", "questionText", `Question text must be ${QUESTION_LIMITS.textMax} characters or fewer.`));
  }

  // Options + correct answer (need a known type).
  let options: { text: string; isCorrect: boolean }[] = [];
  if (typeParse.ok) {
    const opts = parseOptions(raw.options, typeParse.type);
    for (const i of opts.issues) {
      issues.push(extracted && i.code === "options_too_few" ? { ...i, severity: "needs_review" } : i);
    }
    const answer = parseCorrectAnswer(raw.correctAnswer, typeParse.type, opts.texts.length);
    for (const i of answer.issues) {
      issues.push(answer.missing ? missingIssue(extracted, i.code, "correctAnswer", i.message) : i);
    }
    options = opts.texts.map((t, i) => ({ text: t, isCorrect: answer.correct.includes(i) }));
  }

  // Marks: missing or invalid is always an error (never defaulted).
  const marksParse = parseMarks(raw.marks);
  if (!marksParse.ok) issues.push(err(marksParse.reason === "missing" ? "marks_missing" : "marks_invalid", "marks", marksParse.message));

  // Explanation (optional).
  const explanation = cleanText(raw.explanation) || null;
  if (explanation && explanation.length > QUESTION_LIMITS.explanationMax) {
    issues.push(err("explanation_too_long", "explanation", `Explanation must be ${QUESTION_LIMITS.explanationMax} characters or fewer.`));
  }

  // Status column: never applied; warn when it asked for something else.
  const status = parseStatus(raw.status);
  if (!status.recognised) {
    issues.push(warn("status_ignored", "status", `Status "${status.raw}" is not recognised and is ignored.`));
  } else if (status.requested && status.requested !== "draft") {
    issues.push(
      warn(
        "status_ignored",
        "status",
        action === "create"
          ? `Status "${status.raw}" is ignored: imported questions are always created as drafts.`
          : `Status "${status.raw}" is ignored: an import never changes a question's status.`
      )
    );
  }

  // Word/PDF extraction gaps, and OCR uncertainty.
  for (const field of raw.source?.missing ?? []) {
    issues.push(review("extraction_incomplete", field, `The ${FIELD_LABEL[field]} could not be read from the source document. Check it before importing.`));
  }
  if ((context.source === "pdf_ocr" || raw.source?.uncertain) && !raw.reviewConfirmed) {
    const where = [
      raw.source?.page ? `page ${raw.source.page}` : null,
      typeof raw.source?.ocrConfidence === "number" ? `OCR confidence ${Math.round(raw.source.ocrConfidence)}%` : null,
    ].filter(Boolean);
    issues.push(review("ocr_review", "questionText", `Scanned text must be checked against the source${where.length ? ` (${where.join(", ")})` : ""} before importing.`));
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  const question =
    !hasErrors && typeParse.ok && course && marksParse.ok && text
      ? { courseId: course.id.toLowerCase(), moduleId: moduleId?.toLowerCase() ?? null, type: typeParse.type, text, marks: marksParse.marks, explanation, options }
      : null;

  return {
    rowNumber: raw.rowNumber,
    status: statusFor(issues, action),
    action: hasErrors ? null : action,
    questionId,
    expectedRevision: target && !hasErrors ? target.revision : null,
    question,
    fingerprint: null,
    textFingerprint: null,
    duplicateOf: null,
    similarTo: [],
    includeAnyway: false,
    issues,
    source: raw.source,
  };
}

/** A file-level problem that stops the whole import, or null. */
export function checkQuestionCount(source: ImportSource, detected: number): string | null {
  const limit = IMPORT_QUESTION_LIMITS[source];
  return detected > limit ? `This file has ${detected} questions; the limit for this file type is ${limit}. Split it into smaller files.` : null;
}

export function summarize(results: ImportRowResult[]): ImportPreviewSummary {
  const count = (s: ImportRowResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    create: count("CREATE"),
    update: count("UPDATE"),
    duplicate: count("DUPLICATE"),
    error: count("ERROR"),
    needsReview: count("NEEDS_REVIEW"),
  };
}

/**
 * Validate every row, then detect duplicates in row order (the order the
 * database imports them): within the file (first occurrence wins) and
 * against the bank (a question never duplicates itself). A duplicate is
 * excluded unless the row says to include it anyway; a question with the
 * same text but different options only gets a warning.
 */
export async function validateImport(rows: RawImportRow[], context: ImportContext): Promise<{ results: ImportRowResult[]; summary: ImportPreviewSummary }> {
  const ordered = [...rows].sort((a, b) => a.rowNumber - b.rowNumber);
  const results = ordered.map((row) => validateRow(row, context));
  const rawByIndex = ordered;

  // Repeated row numbers / repeated Question IDs: later rows are errors.
  const seenRows = new Set<number>();
  const seenIds = new Set<string>();
  results.forEach((r) => {
    if (seenRows.has(r.rowNumber)) addError(r, err("row_number_invalid", "row", `Row number ${r.rowNumber} appears more than once.`));
    seenRows.add(r.rowNumber);
    if (r.questionId) {
      if (seenIds.has(r.questionId)) addError(r, err("question_id_repeated", "questionId", "This Question ID is already updated by an earlier row."));
      seenIds.add(r.questionId);
    }
  });

  // Fingerprints for every row that has a complete question.
  await Promise.all(
    results.map(async (r) => {
      if (!r.question) return;
      const q = r.question;
      r.fingerprint = await questionFingerprint(q.courseId, q.type, q.text, q.options.map((o) => o.text));
      r.textFingerprint = await textFingerprint(q.courseId, q.text);
    })
  );

  // Live index of the bank (updates move a question to its new fingerprint, as the database will).
  const bankByFp = new Map<string, Set<string>>();
  const bankByText = new Map<string, Set<string>>();
  const fpOfQuestion = new Map<string, string>();
  for (const e of context.existing) {
    const id = e.questionId.toLowerCase();
    addTo(bankByFp, e.fingerprint, id);
    addTo(bankByText, e.textFingerprint, id);
    fpOfQuestion.set(id, e.fingerprint);
  }
  const fileByFp = new Map<string, number>();
  const fileByText = new Map<string, { rowNumber: number; fingerprint: string }[]>();

  results.forEach((r, index) => {
    if ((r.status !== "CREATE" && r.status !== "UPDATE") || !r.fingerprint || !r.textFingerprint) return;
    const self = r.questionId;
    const bankHit = firstOther(bankByFp.get(r.fingerprint), self);
    const fileHit = fileByFp.get(r.fingerprint);
    const dup: DuplicateRef | null = bankHit ? { kind: "bank", questionId: bankHit } : fileHit !== undefined ? { kind: "file", rowNumber: fileHit } : null;

    if (dup) {
      const where = dup.kind === "bank" ? "an existing question in this course" : `row ${dup.rowNumber}`;
      if (rawByIndex[index]?.includeAnyway) {
        r.includeAnyway = true;
        r.duplicateOf = dup;
        r.issues.push(warn("included_anyway", "questionText", `Identical to ${where}; included anyway.`));
      } else {
        r.status = "DUPLICATE";
        r.duplicateOf = dup;
        r.issues.push(warn(dup.kind === "bank" ? "duplicate_in_bank" : "duplicate_in_file", "questionText", `Identical to ${where}. Excluded unless you include it anyway.`));
        return;
      }
    } else {
      // Same text, different type/options: a warning only.
      const similar: DuplicateRef[] = [];
      for (const id of bankByText.get(r.textFingerprint) ?? []) {
        if (id !== self && fpOfQuestion.get(id) !== r.fingerprint) similar.push({ kind: "bank", questionId: id });
      }
      for (const f of fileByText.get(r.textFingerprint) ?? []) {
        if (f.fingerprint !== r.fingerprint) similar.push({ kind: "file", rowNumber: f.rowNumber });
      }
      if (similar.length > 0) {
        r.similarTo = similar;
        r.issues.push(warn("similar_question", "questionText", "A question with the same text but different options or type already exists. Check it is not a duplicate."));
      }
    }

    // This row will be written: later rows see it.
    if (r.action === "update" && self) {
      const old = fpOfQuestion.get(self);
      if (old) bankByFp.get(old)?.delete(self);
      addTo(bankByFp, r.fingerprint, self);
      fpOfQuestion.set(self, r.fingerprint);
    } else if (!fileByFp.has(r.fingerprint)) {
      fileByFp.set(r.fingerprint, r.rowNumber);
    }
    const list = fileByText.get(r.textFingerprint) ?? [];
    list.push({ rowNumber: r.rowNumber, fingerprint: r.fingerprint });
    fileByText.set(r.textFingerprint, list);
  });

  return { results, summary: summarize(results) };
}

function addError(r: ImportRowResult, issue: ImportIssue) {
  r.issues.push(issue);
  r.status = "ERROR";
  r.action = null;
  r.question = null;
  r.expectedRevision = null;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function firstOther(set: Set<string> | undefined, self: string | null): string | null {
  for (const id of set ?? []) if (id !== self) return id;
  return null;
}

/**
 * Re-check UPDATE rows against the questions as they are now (before
 * importing): a question that changed since the preview (revision), left
 * draft, or can no longer be seen becomes an ERROR — never overwritten.
 */
export function detectRevisionConflicts(results: ImportRowResult[], current: UpdateTarget[]): ImportRowResult[] {
  return results.map((r) => {
    if (r.status !== "UPDATE" || !r.questionId) return r;
    const now = current.find((t) => t.id.toLowerCase() === r.questionId);
    const copy: ImportRowResult = { ...r, issues: [...r.issues] };
    if (!now) addError(copy, err("question_not_found", "questionId", "Question not found, or you don't have permission to change it."));
    else if (now.status !== "draft") addError(copy, err("question_protected", "questionId", "This question is no longer a draft, so it is protected from import."));
    else if (now.revision !== r.expectedRevision) {
      addError(copy, err("revision_conflict", "questionId", `This question changed after the preview (revision ${r.expectedRevision} → ${now.revision}). Reload the preview and try again.`));
    }
    return copy;
  });
}

/** The rows the database will write (CREATE/UPDATE only), as 0013 chunk items. Never includes a status. */
export function toChunkItems(results: ImportRowResult[]): ImportChunkItem[] {
  return results
    .filter((r) => (r.status === "CREATE" || r.status === "UPDATE") && r.question)
    .map((r) => {
      const q = r.question!;
      return {
        row_number: r.rowNumber,
        ...(r.status === "UPDATE" && r.questionId ? { question_id: r.questionId, expected_revision: r.expectedRevision ?? undefined } : {}),
        course_id: q.courseId,
        module_id: q.moduleId,
        question_type: q.type,
        question_text: q.text,
        marks: q.marks,
        explanation: q.explanation,
        options: q.options.map((o) => ({ option_text: o.text, is_correct: o.isCorrect })),
        allow_duplicate: r.includeAnyway,
      };
    });
}

/** Split into import_question_chunk calls (at most 100 rows each). */
export function toChunks<T>(items: T[], size: number = IMPORT_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
