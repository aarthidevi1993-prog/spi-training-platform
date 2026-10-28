// Shared setup for the integration tests (see run.mjs): the real repository/service
// modules, a psql-backed Supabase stand-in per user, and the seed's ids.
import { PgDatabase } from "./pg-client.mjs";

const build = process.env.QI_BUILD;
if (!build) throw new Error("Run through tests/question-import-db/run.mjs");
export const repoCore = await import(`${build}/repositories/question-import.repository.core.mjs`);
export const svcCore = await import(`${build}/services/question-import.service.core.mjs`);
export const core = await import(`${build}/lib/question-import/index.mjs`);
export const xlsx = await import(`${build}/lib/question-import/xlsx.mjs`);
export const csv = await import(`${build}/lib/question-import/csv.mjs`);
export const exporter = await import(`${build}/lib/question-import/export.mjs`);
export const ExcelJS = (await import(process.env.QI_EXCELJS)).default;

export const db = new PgDatabase({ psql: process.env.QI_PSQL, port: Number(process.env.QI_PORT), database: process.env.QI_DB });
export const ids = await db.admin("select json_object_agg(k, v) from t.ids");
export const SHA = "cd".repeat(32);

const user = (key, role) => ({ id: ids[key], email: `${key}@test`, fullName: key, role, isActive: true, createdAt: "2026-01-01" });
export const USERS = { A: user("A", "admin"), A2: user("A2", "admin"), T1: user("T1", "trainer"), T2: user("T2", "trainer"), T3: user("T3", "trainer"), ST1: user("ST1", "student") };

export const clientFor = (u) => db.client(u ? { role: "authenticated", userId: u.id } : { role: "anon" });

/**
 * P5.2 (0029a): bind an invitation to its invited Auth account exactly as a successful send does —
 * begin_invitation_delivery on an active Super Admin's own session, then record_invitation_delivery(sent)
 * as service_role. Only the bound account can accept (accept_user_invitation, 0029a).
 */
export async function bindInvitation(invitationId, authUserId, superAdminId = ids.A) {
  const begun = await db.client({ role: "authenticated", userId: superAdminId }).rpc("begin_invitation_delivery", { p_invitation_id: invitationId });
  if (begun.error || begun.data?.ok !== true) throw new Error(`bindInvitation: begin refused ${JSON.stringify(begun.error ?? begun.data)}`);
  const recorded = await db.client({ role: "service_role" }).rpc("record_invitation_delivery", { p_invitation_id: invitationId, p_sent: true, p_auth_user_id: authUserId });
  if (recorded.error || recorded.data?.ok !== true) throw new Error(`bindInvitation: record refused ${JSON.stringify(recorded.error ?? recorded.data)}`);
}
export const repoFor = (u) => repoCore.createQuestionImportRepository(async () => clientFor(u));

/** Same scope rule as questionsRepository.listManageableCourses, read under the user's RLS. */
export async function manageableCourses(u) {
  const where = u.role === "admin" ? "true" : `c.id in (select b.course_id from public.batches b where b.trainer_id = '${u.id}' and b.status in ('upcoming', 'ongoing'))`;
  const { data, error } = await clientFor(u).sql(`select coalesce(json_agg(json_build_object('id', c.id, 'code', c.course_code, 'title', c.title, 'modules',
      coalesce((select json_agg(json_build_object('id', m.id, 'code', m.module_code, 'title', m.title) order by m.sequence) from public.modules m where m.course_id = c.id), '[]'::json))
      order by c.course_code), '[]'::json) from public.courses c where ${where}`);
  if (error) throw new Error(error.message);
  return data;
}

export function serviceFor(key) {
  const u = key ? USERS[key] : null;
  return svcCore.createQuestionImportService({ repository: repoFor(u), getCurrentUser: async () => u, listManageableCourses: manageableCourses, isDemoMode: () => false });
}

/** Mirrors question-import.actions.ts: {ok,data} | {ok:false,error,retryable}. */
export async function asAction(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof svcCore.QuestionImportRepositoryError) return { ok: false, error: e.message, retryable: e.retryable };
    if (e instanceof svcCore.QuestionImportValidationError || e instanceof svcCore.QuestionImportAuthorizationError) return { ok: false, error: e.message, retryable: false };
    throw e;
  }
}

export const count = (whereSql) => db.admin(`select count(*) from public.questions where ${whereSql}`);
export const question = (id) => db.admin(`select to_json(x) from (select status, revision, question_text, created_by, course_id from public.questions where id = '${id}') x`);

/**
 * The browser flow exactly as QuestionImportView runs it: context → preview
 * (validateImport) → start → chunked import of CREATE/UPDATE rows → finish.
 */
export async function importLikeTheBrowser(key, parsed, { fileName, defaultCourseId = null, defaultModuleId = null, include = [] } = {}) {
  const svc = serviceFor(key);
  const rows = parsed.rows.map((r) => ({ ...r, includeAnyway: include.includes(r.rowNumber) }));
  const context = await svc.getContext({
    source: parsed.source,
    courseCodes: Array.from(new Set(rows.map((r) => (r.courseCode ?? "").trim()).filter(Boolean))),
    questionIds: Array.from(new Set(rows.map((r) => (r.questionId ?? "").trim()).filter(Boolean))),
    defaultCourseId,
  });
  const preview = await core.validateImport(rows, { ...context, defaultCourseId, defaultModuleId });
  const importable = new Set(preview.results.filter((r) => r.status === "CREATE" || r.status === "UPDATE").map((r) => r.rowNumber));
  const toSend = rows.filter((r) => importable.has(r.rowNumber));
  if (toSend.length === 0) return { preview, run: null, outcome: null };
  const run = await svc.startImport({
    source: parsed.source, fileName, fileSha256: SHA,
    plannedCreates: preview.summary.create, plannedUpdates: preview.summary.update,
    plannedExcluded: preview.summary.total - preview.summary.create - preview.summary.update,
  });
  const outcome = await core.runChunks({
    chunks: core.planChunks(toSend),
    send: (chunk) => asAction(() => svc.importChunk(run.id, { source: parsed.source, defaultCourseId, defaultModuleId, rows: chunk })),
    delay: async () => {},
  });
  const finished = await svc.finishImport(run.id);
  return { preview, run: finished, outcome };
}

export async function workbookBytes(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questions");
  rows.forEach((r, i) => {
    ws.getRow(i + 1).values = [undefined, ...r];
  });
  const buf = await wb.xlsx.writeBuffer();
  return buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
export const HEADER = ["Question ID", "Course Code", "Module Code", "Question Text", "Type", "Marks", "Option A", "Option B", "Option C", "Option D", "Option E", "Option F", "Option G", "Option H", "Option I", "Option J", "Correct Answer", "Explanation", "Status", "Revision"];
export const R = (values) => HEADER.map((h) => (h in values ? values[h] : null));
export const bytesToArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
