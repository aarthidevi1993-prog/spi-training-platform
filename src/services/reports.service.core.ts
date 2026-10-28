/**
 * Reports service — Super Admins and trainers only.
 *
 * Identity and scope always come from getCurrentUser (the server session),
 * never from the URL: a Super Admin reports on every batch; a trainer only
 * on their CURRENT (upcoming/ongoing) batches — the same scope as the
 * Performance pages. Students and signed-out callers are refused before
 * any read. URL filters (course, batch, student, dates) can only narrow
 * that scope: a value outside it is ignored and reported, never trusted.
 * RLS still decides every row (the repository uses the caller's session).
 *
 * Factory without `server-only` so it can be tested against a local
 * database; reports.service.ts wires the real session.
 */
import type { AuthUser } from "@/types/auth";
import {
  REPORT_TYPES,
  buildReport,
  parseReportFilters,
  type IgnoredFilter,
  type ReportFilters,
  type ReportSource,
  type ReportSummaryItem,
  type ReportTable,
  type ReportType,
} from "@/lib/reports/reports";
import type { ReportsRepository } from "@/repositories/reports.repository.core";

export class ReportsAuthorizationError extends Error {
  constructor(message = "Only Super Admins and trainers can view reports.") {
    super(message);
    this.name = "ReportsAuthorizationError";
  }
}

export interface ReportOption {
  value: string;
  label: string;
}

export interface ReportResult {
  role: "admin" | "trainer";
  type: ReportType;
  typeLabel: string;
  /** The filters actually applied (values outside the caller's scope removed). */
  filters: ReportFilters;
  options: { courses: ReportOption[]; batches: ReportOption[]; students: ReportOption[] };
  /** Filters that were ignored, with the reason (malformed, or outside the caller's scope). */
  ignored: IgnoredFilter[];
  scopeLabel: string;
  summary: ReportSummaryItem[];
  table: ReportTable;
  generatedAt: string;
}

export interface ReportsServiceDeps {
  repository: ReportsRepository;
  getCurrentUser: () => Promise<AuthUser | null>;
  /** Demo mode has no database: the page explains instead of inventing a report. */
  isDemoMode?: () => boolean;
  /** The clock (release status of tests); tests inject it. */
  now?: () => Date;
}

type SearchParams = Record<string, string | string[] | undefined>;

const byLabel = (a: ReportOption, b: ReportOption) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value);

export function createReportsService(deps: ReportsServiceDeps) {
  async function requireStaff(): Promise<AuthUser & { role: "admin" | "trainer" }> {
    const user = await deps.getCurrentUser();
    if (!user) throw new ReportsAuthorizationError("You need to be signed in.");
    if (user.role !== "admin" && user.role !== "trainer") throw new ReportsAuthorizationError();
    return user as AuthUser & { role: "admin" | "trainer" };
  }

  return {
    /** One report for the URL search params, within the caller's scope; null in demo mode. */
    async getReport(searchParams: SearchParams | null | undefined): Promise<ReportResult | null> {
      const user = await requireStaff();
      if (deps.isDemoMode?.()) return null;
      const now = deps.now?.() ?? new Date();
      const { filters: parsed, ignored } = parseReportFilters(searchParams);

      const scope = await deps.repository.listScopeBatches(user.role === "admin" ? { kind: "all" } : { kind: "trainer", trainerId: user.id });

      // Course: one of the courses of the scope's batches.
      const courseOptions = Array.from(
        new Map(scope.map((b) => [b.course_id, { value: b.course_id, label: b.courses ? `${b.courses.course_code} — ${b.courses.title}` : "Course" }])).values()
      ).sort(byLabel);
      let courseId = parsed.courseId;
      if (courseId && !courseOptions.some((c) => c.value === courseId)) {
        ignored.push({ param: "course", reason: "That course isn't in your reporting scope, so the filter was ignored." });
        courseId = null;
      }
      const inCourse = courseId ? scope.filter((b) => b.course_id === courseId) : scope;

      // Batch: one of the (course-narrowed) scope batches.
      const batchOptions = inCourse
        .map((b) => ({ value: b.id, label: b.batch_code ? `${b.batch_code} — ${b.name}` : b.name }))
        .sort(byLabel);
      let batchId = parsed.batchId;
      if (batchId && !inCourse.some((b) => b.id === batchId)) {
        ignored.push({ param: "batch", reason: "That batch isn't in your reporting scope (or the chosen course), so the filter was ignored." });
        batchId = null;
      }
      const batches = batchId ? inCourse.filter((b) => b.id === batchId) : inCourse;
      const batchIds = batches.map((b) => b.id);

      // Student: only within a chosen batch, and only someone enrolled in it (any enrolment status).
      const batchEnrolments = batchId ? await deps.repository.listEnrolments([batchId]) : [];
      const studentOptions = Array.from(
        new Map(
          batchEnrolments.map((e) => [
            e.student_id,
            { value: e.student_id, label: e.students ? `${e.students.full_name}${e.students.student_code ? ` (${e.students.student_code})` : ""}` : "Unknown student" },
          ])
        ).values()
      ).sort(byLabel);
      let studentId = parsed.studentId;
      if (studentId && !studentOptions.some((s) => s.value === studentId)) {
        ignored.push({
          param: "student",
          reason: batchId ? "That student isn't enrolled in the chosen batch, so the filter was ignored." : "Choose a batch before filtering by student.",
        });
        studentId = null;
      }

      // Only the records this report needs, for exactly these batches (and student).
      const type = parsed.type;
      const needsAttendance = type === "attendance" || type === "performance";
      const needsTests = type === "test_results" || type === "performance";
      const needsAssignments = type === "assignments" || type === "performance";
      const dated = Boolean(parsed.from || parsed.to);
      const [enrolments, classes, attendance, bestResults, assignments, submissions] = await Promise.all([
        batchId && !studentId ? Promise.resolve(batchEnrolments) : deps.repository.listEnrolments(batchIds, studentId),
        needsAttendance && dated ? deps.repository.listClasses(batchIds) : Promise.resolve([]),
        needsAttendance ? deps.repository.listAttendance(batchIds, studentId) : Promise.resolve([]),
        needsTests ? deps.repository.listBestResults(batchIds, studentId) : Promise.resolve([]),
        needsAssignments ? deps.repository.listAssignments(batchIds) : Promise.resolve([]),
        needsAssignments ? deps.repository.listSubmissions(batchIds, studentId) : Promise.resolve([]),
      ]);
      const tests = needsTests ? await deps.repository.listTests(Array.from(new Set(bestResults.map((r) => r.test_id)))) : [];

      const source: ReportSource = { batches, enrolments, classes, attendance, bestResults, tests, assignments, submissions };
      const filters: ReportFilters = { type, courseId, batchId, studentId, from: parsed.from, to: parsed.to };
      const built = buildReport(type, source, filters, now.getTime());

      const batch = batchId ? batches[0] : null;
      const student = studentId ? studentOptions.find((s) => s.value === studentId) : null;
      const course = courseId ? courseOptions.find((c) => c.value === courseId) : null;
      const scopeLabel = [
        batch ? (batch.batch_code ? `${batch.batch_code} — ${batch.name}` : batch.name) : course ? course.label : user.role === "admin" ? "All batches" : "Your current batches (upcoming and ongoing)",
        student?.label,
        parsed.from || parsed.to ? `${parsed.from ?? "…"} to ${parsed.to ?? "…"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        role: user.role,
        type,
        typeLabel: REPORT_TYPES.find((t) => t.value === type)?.label ?? type,
        filters,
        options: { courses: courseOptions, batches: batchOptions, students: studentOptions },
        ignored,
        scopeLabel,
        summary: built.summary,
        table: built.table,
        generatedAt: now.toISOString(),
      };
    },
  };
}
