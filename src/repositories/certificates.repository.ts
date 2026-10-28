import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { BatchStatusColumn, CertificateStatusColumn, CertificatesRow, CompletionStatusColumn, Json } from "@/lib/supabase/types";
import { readAllPages } from "./results.repository";

/**
 * Certificates repository — the only module that talks to the 0011
 * completion/certificate database (completion_records, certificates,
 * batch requirements and their functions).
 *
 * Always the caller's own session (never the service role): the 0011
 * functions prove identity from auth.uid(), check the role and batch
 * scope, calculate eligibility and generate certificate numbers,
 * verification codes, snapshots and stamps. This layer only passes
 * ids, notes and reasons — never eligibility, status, numbers, codes,
 * reviewer identities or timestamps.
 *
 * The staff SELECT reads below are RLS-scoped (super admin: all; the
 * batch's assigned trainer). Students and anonymous users never read
 * tables here — they use the student/verification functions.
 */

const GENERIC_DB_ERROR = "We couldn't reach the certificate service. Please try again.";

export class CertificateRepositoryError extends Error {
  /** Postgres error code, when the database raised one. */
  readonly code: string;
  constructor(message: string = GENERIC_DB_ERROR, code = "") {
    super(message);
    this.name = "CertificateRepositoryError";
    this.code = code;
  }
}

function logDbError(context: string, error: unknown) {
  const detail =
    error && typeof error === "object" && "message" in error
      ? `${(error as { code?: string }).code ?? ""} ${(error as { message: string }).message}`.trim()
      : error;
  console.error(`[certificates] ${context}:`, detail);
}

async function client() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) throw new CertificateRepositoryError();
  return supabase;
}

/**
 * Raised database errors: 42501 (permission — the 0011 messages are
 * written for users), 22023 (invalid input) and 23514 (a guard refused
 * the change). Raw Postgres messages are replaced with a safe fallback.
 */
const USER_FACING_FALLBACK: Record<string, string> = {
  "42501": "You don't have permission to do that.",
  "22023": "That request wasn't valid. Please reload the page and try again.",
  "23514": "That change isn't allowed right now.",
  "23505": "That change conflicts with an existing record.",
};
const RAW_POSTGRES_MESSAGE = /violates|permission denied for|relation "|constraint "|column "|syntax|function .*does not exist/i;

function toRepositoryError(error: unknown): CertificateRepositoryError {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  const fallback = USER_FACING_FALLBACK[code];
  if (fallback) {
    return new CertificateRepositoryError(message && !RAW_POSTGRES_MESSAGE.test(message) ? message : fallback, code);
  }
  return new CertificateRepositoryError(GENERIC_DB_ERROR, code);
}

/** One database function call returning JSON. */
async function rpc(context: string, fn: () => PromiseLike<{ data: Json | null; error: unknown }>): Promise<Json> {
  let result: { data: Json | null; error: unknown };
  try {
    result = await fn();
  } catch (err) {
    logDbError(context, err);
    throw new CertificateRepositoryError();
  }
  if (result.error) {
    logDbError(context, result.error);
    throw toRepositoryError(result.error);
  }
  if (result.data === null || result.data === undefined) throw new CertificateRepositoryError();
  return result.data;
}

/** One RLS-scoped read. */
async function read<T>(context: string, fn: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  let result: { data: T | null; error: unknown };
  try {
    result = await fn();
  } catch (err) {
    logDbError(context, err);
    throw new CertificateRepositoryError();
  }
  if (result.error) {
    logDbError(context, result.error);
    throw toRepositoryError(result.error);
  }
  return result.data;
}

export interface CompletionBatchRecord {
  id: string;
  batch_code: string;
  name: string;
  status: BatchStatusColumn;
  start_date: string;
  end_date: string;
  trainer_id: string | null;
  courses: { course_code: string; title: string } | null;
  trainers: { full_name: string } | null;
}

export type CertificateSummaryRecord = Pick<
  CertificatesRow,
  | "id"
  | "certificate_number"
  | "status"
  | "batch_id"
  | "student_name"
  | "course_code"
  | "course_title"
  | "batch_code"
  | "batch_name"
  | "completion_date"
  | "issued_at"
  | "revoked_at"
  | "replaces_certificate_id"
>;

export type CertificateDocumentRecord = Pick<
  CertificatesRow,
  | "certificate_number"
  | "verification_code"
  | "status"
  | "student_name"
  | "course_code"
  | "course_title"
  | "batch_code"
  | "batch_name"
  | "batch_start_date"
  | "batch_end_date"
  | "completion_date"
  | "trainer_name"
  | "issuer_name"
  | "template_version"
  | "signatories"
  | "snapshot_sha256"
  | "issued_at"
  | "revoked_at"
>;

export interface RequirementOptionRecord {
  id: string;
  title: string;
  classes: { title: string; class_date: string; status: string } | null;
}

const BATCH_SELECT =
  "id, batch_code, name, status, start_date, end_date, trainer_id, courses ( course_code, title ), trainers ( full_name )";
const CERTIFICATE_SUMMARY_SELECT =
  "id, certificate_number, status, batch_id, student_name, course_code, course_title, batch_code, batch_name, completion_date, issued_at, revoked_at, replaces_certificate_id";
const CERTIFICATE_DOCUMENT_SELECT =
  "certificate_number, verification_code, status, student_name, course_code, course_title, batch_code, batch_name, batch_start_date, batch_end_date, completion_date, trainer_name, issuer_name, template_version, signatories, snapshot_sha256, issued_at, revoked_at";

export const certificatesRepository = {
  // -----------------------------------------------------------------
  // Staff reads (RLS)
  // -----------------------------------------------------------------

  /** Batches the caller may see; trainers are narrowed to their assigned batches (any status). */
  async listBatches(scope: { kind: "all" } | { kind: "trainer"; trainerId: string }): Promise<CompletionBatchRecord[]> {
    const supabase = await client();
    const data = await read("listBatches", () => {
      let query = supabase
        .from("batches")
        .select(BATCH_SELECT)
        .order("end_date", { ascending: false });
      if (scope.kind === "trainer") query = query.eq("trainer_id", scope.trainerId);
      return query;
    });
    return data ?? [];
  },

  /** One batch (RLS), or null when missing or not visible. */
  async getBatch(batchId: string): Promise<CompletionBatchRecord | null> {
    const supabase = await client();
    return read("getBatch", () => supabase.from("batches").select(BATCH_SELECT).eq("id", batchId).maybeSingle());
  },

  /** Completion and certificate statuses per batch (RLS) — for the batch list counts. */
  async listStatusRows(): Promise<{
    completions: { batch_id: string; status: CompletionStatusColumn }[];
    certificates: { batch_id: string; status: CertificateStatusColumn }[];
  }> {
    const supabase = await client();
    try {
      const [completions, certificates] = await Promise.all([
        readAllPages((from, to) => supabase.from("completion_records").select("batch_id, status").order("id").range(from, to)),
        readAllPages((from, to) => supabase.from("certificates").select("batch_id, status").order("id").range(from, to)),
      ]);
      return { completions, certificates };
    } catch (err) {
      if (err instanceof CertificateRepositoryError) throw err;
      logDbError("listStatusRows", err);
      throw toRepositoryError(err);
    }
  },

  /** Certificates the caller may see (newest first), optionally for one batch. */
  async listCertificates(batchId?: string): Promise<CertificateSummaryRecord[]> {
    const supabase = await client();
    const data = await read("listCertificates", () => {
      let query = supabase.from("certificates").select(CERTIFICATE_SUMMARY_SELECT).order("issued_at", { ascending: false }).limit(500);
      if (batchId) query = query.eq("batch_id", batchId);
      return query;
    });
    return data ?? [];
  },

  /** One certificate snapshot by number (staff RLS), or null. */
  async getCertificateDocument(certificateNumber: string): Promise<CertificateDocumentRecord | null> {
    const supabase = await client();
    return read("getCertificateDocument", () =>
      supabase.from("certificates").select(CERTIFICATE_DOCUMENT_SELECT).eq("certificate_number", certificateNumber).maybeSingle()
    );
  },

  /** Published final-exam tests of a batch (choices for the final assessment). */
  async listFinalExamOptions(batchId: string): Promise<RequirementOptionRecord[]> {
    const supabase = await client();
    const data = await read("listFinalExamOptions", () =>
      supabase
        .from("tests")
        .select("id, title, classes ( title, class_date, status )")
        .eq("batch_id", batchId)
        .eq("test_type", "final_exam")
        .neq("status", "draft")
        .order("title")
    );
    return data ?? [];
  },

  /** Published/closed assignments of a batch (choices for required assignments). */
  async listAssignmentOptions(batchId: string): Promise<RequirementOptionRecord[]> {
    const supabase = await client();
    const data = await read("listAssignmentOptions", () =>
      supabase
        .from("class_assignments")
        .select("id, title, classes ( title, class_date, status )")
        .eq("batch_id", batchId)
        .in("status", ["published", "closed"])
        .order("title")
    );
    return data ?? [];
  },

  // -----------------------------------------------------------------
  // 0011 functions
  // -----------------------------------------------------------------

  async staffBatchCompletion(batchId: string): Promise<Json> {
    const supabase = await client();
    return rpc("staffBatchCompletion", () => supabase.rpc("staff_batch_completion", { p_batch_id: batchId }));
  },

  async setFinalAssessment(batchId: string, testId: string): Promise<Json> {
    const supabase = await client();
    return rpc("setFinalAssessment", () => supabase.rpc("set_final_assessment", { p_batch_id: batchId, p_test_id: testId }));
  },

  async clearFinalAssessment(batchId: string): Promise<Json> {
    const supabase = await client();
    return rpc("clearFinalAssessment", () => supabase.rpc("clear_final_assessment", { p_batch_id: batchId }));
  },

  async addRequiredAssignment(batchId: string, assignmentId: string): Promise<Json> {
    const supabase = await client();
    return rpc("addRequiredAssignment", () =>
      supabase.rpc("add_required_assignment", { p_batch_id: batchId, p_assignment_id: assignmentId })
    );
  },

  async removeRequiredAssignment(batchId: string, assignmentId: string): Promise<Json> {
    const supabase = await client();
    return rpc("removeRequiredAssignment", () =>
      supabase.rpc("remove_required_assignment", { p_batch_id: batchId, p_assignment_id: assignmentId })
    );
  },

  async recommendCompletion(batchId: string, studentId: string, note: string | null): Promise<Json> {
    const supabase = await client();
    return rpc("recommendCompletion", () =>
      supabase.rpc("recommend_completion", { p_batch_id: batchId, p_student_id: studentId, p_note: note })
    );
  },

  async withdrawRecommendation(completionId: string): Promise<Json> {
    const supabase = await client();
    return rpc("withdrawRecommendation", () => supabase.rpc("withdraw_recommendation", { p_completion_id: completionId }));
  },

  async decideCompletion(completionId: string, approve: boolean, note: string | null): Promise<Json> {
    const supabase = await client();
    return rpc("decideCompletion", () =>
      supabase.rpc("decide_completion", { p_completion_id: completionId, p_approve: approve, p_note: note })
    );
  },

  async issueCertificate(completionId: string): Promise<Json> {
    const supabase = await client();
    return rpc("issueCertificate", () => supabase.rpc("issue_certificate", { p_completion_id: completionId }));
  },

  async revokeCertificate(certificateId: string, reason: string): Promise<Json> {
    const supabase = await client();
    return rpc("revokeCertificate", () => supabase.rpc("revoke_certificate", { p_certificate_id: certificateId, p_reason: reason }));
  },

  async studentCompletionStatus(): Promise<Json> {
    const supabase = await client();
    return rpc("studentCompletionStatus", () => supabase.rpc("student_completion_status"));
  },

  async studentCertificates(): Promise<Json> {
    const supabase = await client();
    return rpc("studentCertificates", () => supabase.rpc("student_certificates"));
  },

  /** Public: works without a session (anon may execute only this function). */
  async verifyCertificate(certificateNumber: string, verificationCode: string): Promise<Json> {
    const supabase = await client();
    return rpc("verifyCertificate", () =>
      supabase.rpc("verify_certificate", { p_number: certificateNumber, p_code: verificationCode })
    );
  },
};
