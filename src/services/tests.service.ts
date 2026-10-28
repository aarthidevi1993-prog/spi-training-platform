import "server-only";
import { authConfig } from "@/config/auth";
import { authService } from "./auth.service";
import {
  testsRepository,
  TestRepositoryError,
  type ClassOptionRecord,
  type TestRecord,
  type TestScope,
  type TestSettingsFields,
} from "@/repositories/tests.repository";
import type { AuthUser } from "@/types/auth";
import {
  TEST_LIMITS,
  type TestClassOption,
  type TestDetail,
  type TestInput,
  type TestManagementData,
  type TestStatus,
  type TestSummary,
  type TestType,
} from "@/types/test";

/**
 * Tests service — resolves the caller's identity server-side via
 * authService (never from a client-supplied argument), limits test
 * management to super admins and the batch's CURRENT trainer, and
 * validates settings (mirroring 0008) so users get clear messages. The
 * database (0008 RLS + tests_validate / tests_stamp + the question-set
 * functions) remains the final authority for scope and lifecycle.
 */

export class TestAuthorizationError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "TestAuthorizationError";
  }
}

export class TestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestValidationError";
  }
}

const TEST_TYPES: TestType[] = ["quiz", "module_test", "final_exam", "practical"];
const NOT_FOUND = "Test not found, or you don't have permission to change it.";
const INDIA_TIME_ZONE = "Asia/Kolkata";
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -------------------------------------------------------------------
// Identity and scope
// -------------------------------------------------------------------

async function requireManager(): Promise<AuthUser> {
  if (authConfig.mode === "demo") {
    throw new TestValidationError("Test management requires Supabase mode.");
  }
  const user = await authService.getCurrentUser();
  if (!user) throw new TestAuthorizationError("You need to be signed in.");
  if (user.role !== "admin" && user.role !== "trainer") {
    throw new TestAuthorizationError("You don't have permission to manage tests.");
  }
  return user;
}

function scopeFor(user: AuthUser): TestScope {
  return user.role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id };
}

/** Mirrors is_current_batch_trainer (0008); the database re-checks every write. */
function canManage(user: AuthUser, record: TestRecord): boolean {
  if (user.role === "admin") return true;
  const batch = record.classes?.batches;
  return Boolean(batch && batch.trainer_id === user.id && (batch.status === "upcoming" || batch.status === "ongoing"));
}

/** The batch's assigned trainer (any status) may read the frozen question set (0008 RLS). */
function canReadQuestions(user: AuthUser, record: TestRecord): boolean {
  return user.role === "admin" || record.classes?.batches?.trainer_id === user.id;
}

// -------------------------------------------------------------------
// India-time helpers (opening/closing times are entered and shown in Asia/Kolkata)
// -------------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" in India time → ISO timestamp. */
function indiaLocalToIso(local: string, label: string): string {
  if (!LOCAL_DATETIME.test(local)) throw new TestValidationError(`Enter a valid ${label}.`);
  const date = new Date(`${local}:00+05:30`);
  if (Number.isNaN(date.getTime())) throw new TestValidationError(`Enter a valid ${label}.`);
  return date.toISOString();
}

/** ISO timestamp → "YYYY-MM-DDTHH:mm" in India time (for the editor). */
function isoToIndiaLocal(iso: string | null): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Display mirror of test_effective_status (0008): scheduled/active move
 * on with time. The database function is authoritative for enforcement.
 */
function effectiveStatus(record: Pick<TestRecord, "status" | "available_from" | "available_until">): TestStatus {
  if (record.status === "draft" || record.status === "closed") return record.status;
  const now = Date.now();
  if (record.available_until && now >= new Date(record.available_until).getTime()) return "closed";
  if (record.available_from && now >= new Date(record.available_from).getTime()) return "active";
  return "scheduled";
}

// -------------------------------------------------------------------
// Mapping
// -------------------------------------------------------------------

function toSummary(user: AuthUser, record: TestRecord, stats: { count: number; marks: number } | undefined): TestSummary {
  const readable = canReadQuestions(user, record);
  return {
    id: record.id,
    classId: record.class_id,
    classTitle: record.classes?.title ?? "Unknown class",
    classDate: record.classes?.class_date ?? null,
    batchId: record.batch_id,
    batchCode: record.classes?.batches?.batch_code ?? "",
    batchName: record.classes?.batches?.name ?? "Unknown batch",
    courseId: record.classes?.course_id ?? null,
    courseCode: record.classes?.courses?.course_code ?? "",
    courseTitle: record.classes?.courses?.title ?? "Unknown course",
    testType: record.test_type,
    title: record.title,
    instructions: record.instructions,
    status: record.status,
    effectiveStatus: effectiveStatus(record),
    passMarkPercent: record.pass_mark_percent === null ? null : Number(record.pass_mark_percent),
    timeLimitMinutes: record.time_limit_minutes,
    attemptLimit: record.attempt_limit,
    availableFrom: record.available_from,
    availableUntil: record.available_until,
    availableFromLocal: isoToIndiaLocal(record.available_from),
    availableUntilLocal: isoToIndiaLocal(record.available_until),
    questionCount: readable ? (stats?.count ?? 0) : null,
    totalMarks: readable ? Math.round((stats?.marks ?? 0) * 100) / 100 : null,
    canManage: canManage(user, record),
  };
}

function toClassOption(row: ClassOptionRecord): TestClassOption {
  return {
    id: row.id,
    title: row.title,
    classDate: row.class_date,
    batchId: row.batch_id,
    batchCode: row.batches?.batch_code ?? "",
    courseCode: row.courses?.course_code ?? "",
  };
}

// -------------------------------------------------------------------
// Validation (mirrors the 0008 constraints; the database re-checks)
// -------------------------------------------------------------------

function isId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function hasTwoDecimalsAtMost(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) <= 1e-6;
}

function buildSettings(input: TestInput): Required<Pick<TestSettingsFields, "test_type" | "title">> & TestSettingsFields {
  if (!input || typeof input !== "object") throw new TestValidationError("Invalid test details.");
  if (!TEST_TYPES.includes(input.testType)) throw new TestValidationError("Choose a test type.");

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new TestValidationError("Title is required.");
  if (title.length > TEST_LIMITS.titleMax) throw new TestValidationError(`Title must be ${TEST_LIMITS.titleMax} characters or fewer.`);

  const instructions = typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : null;
  if (instructions && instructions.length > TEST_LIMITS.instructionsMax) {
    throw new TestValidationError(`Instructions must be ${TEST_LIMITS.instructionsMax} characters or fewer.`);
  }

  const pass = input.passMarkPercent;
  if (pass !== null) {
    if (typeof pass !== "number" || !Number.isFinite(pass) || pass < TEST_LIMITS.passMarkMin || pass > TEST_LIMITS.passMarkMax || !hasTwoDecimalsAtMost(pass)) {
      throw new TestValidationError("Pass mark must be between 0 and 100%, with up to 2 decimal places.");
    }
  }

  const time = input.timeLimitMinutes;
  if (time !== null) {
    if (typeof time !== "number" || !Number.isInteger(time) || time < TEST_LIMITS.timeLimitMin || time > TEST_LIMITS.timeLimitMax) {
      throw new TestValidationError(`Time limit must be a whole number of minutes between ${TEST_LIMITS.timeLimitMin} and ${TEST_LIMITS.timeLimitMax}.`);
    }
  }

  const attempts = input.attemptLimit;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < TEST_LIMITS.attemptLimitMin || attempts > TEST_LIMITS.attemptLimitMax) {
    throw new TestValidationError(`Attempt limit must be a whole number between ${TEST_LIMITS.attemptLimitMin} and ${TEST_LIMITS.attemptLimitMax}.`);
  }

  const from = input.availableFromLocal ? indiaLocalToIso(input.availableFromLocal, "opening time") : null;
  const until = input.availableUntilLocal ? indiaLocalToIso(input.availableUntilLocal, "closing time") : null;
  if (from && until && new Date(until).getTime() <= new Date(from).getTime()) {
    throw new TestValidationError("The closing time must be after the opening time.");
  }

  return {
    test_type: input.testType,
    title,
    instructions,
    pass_mark_percent: pass === null ? null : Math.round(pass * 100) / 100,
    time_limit_minutes: time,
    attempt_limit: attempts,
    available_from: from,
    available_until: until,
  };
}

async function requireTest(user: AuthUser, testId: unknown): Promise<TestRecord> {
  if (!isId(testId)) throw new TestAuthorizationError(NOT_FOUND);
  const record = await testsRepository.getTest(testId);
  if (!record) throw new TestAuthorizationError(NOT_FOUND);
  return record;
}

async function requireManagedTest(testId: unknown): Promise<TestRecord> {
  const user = await requireManager();
  const record = await requireTest(user, testId);
  if (!canManage(user, record)) {
    throw new TestAuthorizationError("Only the batch's current trainer or a Super Admin can change this test.");
  }
  return record;
}

/** Apply a status change; the database validates the transition and has the final say. */
async function setStatus(testId: string, status: TestStatus): Promise<void> {
  const changed = await testsRepository.updateTest(testId, { status });
  if (!changed) throw new TestAuthorizationError(NOT_FOUND);
}

export const testsService = {
  /** List page data: tests the caller may see and the classes they may create tests for. */
  async getManagementData(): Promise<TestManagementData> {
    if (authConfig.mode === "demo") return { enabled: false, classes: [], tests: [] };
    const user = await requireManager();
    const [records, classes] = await Promise.all([
      testsRepository.listTests(),
      testsRepository.listManageableClasses(scopeFor(user)),
    ]);
    const stats = await testsRepository.listQuestionStats(records.map((r) => r.id));
    return {
      enabled: true,
      classes: classes.map(toClassOption),
      tests: records.map((r) => toSummary(user, r, stats.get(r.id))),
    };
  },

  /** Detail page data; null when the test doesn't exist or isn't visible (→ notFound). */
  async getTestDetail(testId: string): Promise<TestDetail | null> {
    if (authConfig.mode === "demo") return null;
    const user = await requireManager();
    if (!isId(testId) || !UUID_PATTERN.test(testId)) return null;
    const record = await testsRepository.getTest(testId);
    if (!record) return null;

    const readable = canReadQuestions(user, record);
    const questionRecords = readable ? await testsRepository.listTestQuestions(record.id) : [];
    const stats = { count: questionRecords.length, marks: questionRecords.reduce((sum, q) => sum + Number(q.marks), 0) };
    const summary = toSummary(user, record, stats);

    const questions = readable
      ? questionRecords.map((q) => ({
          id: q.id,
          position: q.position,
          questionType: q.question_type,
          questionText: q.question_text,
          marks: Number(q.marks),
          sourceQuestionId: q.source_question_id,
          sourceRevision: q.source_revision,
          options: [...q.test_question_options]
            .sort((a, b) => a.display_order - b.display_order)
            .map((o) => ({ text: o.option_text, isCorrect: o.is_correct })),
        }))
      : null;

    let candidates: TestDetail["candidates"] = [];
    if (summary.canManage && record.status === "draft" && summary.courseId) {
      const used = new Set(questionRecords.map((q) => q.source_question_id));
      candidates = (await testsRepository.listCandidateQuestions(summary.courseId))
        .filter((q) => !used.has(q.id))
        .map((q) => ({
          id: q.id,
          text: q.question_text,
          questionType: q.question_type,
          marks: Number(q.marks),
          moduleTitle: q.modules?.title ?? null,
        }));
    }

    return { ...summary, questions, candidates };
  },

  /** Create a draft test for a class the caller may manage. Returns its id. */
  async createTest(input: TestInput): Promise<string> {
    const user = await requireManager();
    if (!isId(input?.classId)) throw new TestValidationError("Choose a class.");
    const classes = await testsRepository.listManageableClasses(scopeFor(user));
    const target = classes.find((c) => c.id === input.classId);
    if (!target) {
      throw new TestAuthorizationError(
        user.role === "admin"
          ? "That class isn't available for tests (it may be cancelled)."
          : "You can only create tests for classes in batches you currently teach."
      );
    }
    return testsRepository.insertTest(target.id, target.batch_id, buildSettings(input));
  },

  /**
   * Update settings. Drafts: everything but the class. Published tests:
   * only title, instructions and extending the closing time (the
   * database locks the rest and refuses shortening).
   */
  async updateTest(testId: string, input: TestInput): Promise<string> {
    const record = await requireManagedTest(testId);
    if (input?.classId !== record.class_id) throw new TestValidationError("A test's class cannot be changed.");
    const settings = buildSettings(input);

    if (record.status === "draft") {
      const changed = await testsRepository.updateTest(record.id, settings);
      if (!changed) throw new TestAuthorizationError(NOT_FOUND);
      return record.id;
    }

    const locked: [boolean, string][] = [
      [settings.test_type !== record.test_type, "The test type is locked after publishing."],
      [settings.pass_mark_percent !== (record.pass_mark_percent === null ? null : Number(record.pass_mark_percent)), "The pass mark is locked after publishing."],
      [settings.time_limit_minutes !== record.time_limit_minutes, "The time limit is locked after publishing."],
      [settings.attempt_limit !== record.attempt_limit, "The attempt limit is locked after publishing."],
      [!sameInstant(settings.available_from ?? null, record.available_from), "The opening time is locked after publishing."],
    ];
    const hit = locked.find(([changedField]) => changedField);
    if (hit) throw new TestValidationError(hit[1]);

    const fields: TestSettingsFields = { title: settings.title, instructions: settings.instructions };
    if (!sameInstant(settings.available_until ?? null, record.available_until)) {
      fields.available_until = settings.available_until ?? null;
    }
    const changed = await testsRepository.updateTest(record.id, fields);
    if (!changed) throw new TestAuthorizationError(NOT_FOUND);
    return record.id;
  },

  async publishTest(testId: string): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "draft") throw new TestValidationError("Only draft tests can be published.");
    await setStatus(record.id, "scheduled"); // the database stores scheduled or active
    return record.id;
  },

  async closeTest(testId: string): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "scheduled" && record.status !== "active") {
      throw new TestValidationError("Only published tests can be closed.");
    }
    await setStatus(record.id, "closed");
    return record.id;
  },

  async reopenTest(testId: string): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "closed") throw new TestValidationError("Only closed tests can be reopened.");
    await setStatus(record.id, "scheduled"); // the database stores scheduled or active
    return record.id;
  },

  async deleteDraftTest(testId: string): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "draft") throw new TestValidationError("Only draft tests can be deleted. Close this test instead.");
    const deleted = await testsRepository.deleteDraftTest(record.id);
    if (!deleted) throw new TestValidationError("Only draft tests can be deleted. Close this test instead.");
    return record.id;
  },

  async addQuestions(testId: string, questionIds: string[]): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "draft") throw new TestValidationError("The question set is locked after the test is published.");
    if (!Array.isArray(questionIds) || questionIds.length === 0 || !questionIds.every(isId)) {
      throw new TestValidationError("Choose at least one question to add.");
    }
    const ids = Array.from(new Set(questionIds));
    if (ids.length > TEST_LIMITS.questionsPerAdd) {
      throw new TestValidationError(`Add at most ${TEST_LIMITS.questionsPerAdd} questions at a time.`);
    }
    await testsRepository.addQuestions(record.id, ids);
    return record.id;
  },

  async removeQuestion(testId: string, testQuestionId: string): Promise<string> {
    const record = await requireManagedTest(testId);
    if (record.status !== "draft") throw new TestValidationError("The question set is locked after the test is published.");
    if (!isId(testQuestionId)) throw new TestValidationError("Choose a question to remove.");
    await testsRepository.removeQuestion(testQuestionId);
    return record.id;
  },
};

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

export { TestRepositoryError };
