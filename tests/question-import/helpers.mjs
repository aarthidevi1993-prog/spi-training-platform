// Shared test helpers: load the transpiled core (see run.mjs) and build contexts/rows.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.QUESTION_IMPORT_CORE) throw new Error("Run through tests/question-import/run.mjs");
export const core = await import(process.env.QUESTION_IMPORT_CORE);
/** Modules kept out of the core barrel (they import exceljs/papaparse; the app loads them on demand). */
export const load = (name) => import(`${process.env.QUESTION_IMPORT_BUILD}/${name}.mjs`);
export const ExcelJS = (await import(process.env.QUESTION_IMPORT_EXCELJS)).default;
export const fixture = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name));
/** A Node Buffer's bytes as a standalone ArrayBuffer (what File.arrayBuffer() gives in the browser). */
export const arrayBufferOf = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const here = path.dirname(fileURLToPath(import.meta.url));
/** Expected values computed by the real 0013 SQL functions on PostgreSQL. */
export const VECTORS = JSON.parse(fs.readFileSync(path.join(here, "fixtures/fingerprint-vectors.json"), "utf8"));

export const C1 = "11111111-1111-4111-8111-111111111111";
export const C2 = "22222222-2222-4222-8222-222222222222";
export const M1 = "aaaaaaaa-0000-4000-8000-000000000001";
export const M2 = "aaaaaaaa-0000-4000-8000-000000000002";
export const MX = "bbbbbbbb-0000-4000-8000-000000000001";
export const Q_DRAFT = "dddddddd-0000-4000-8000-000000000001";
export const Q_DRAFT2 = "dddddddd-0000-4000-8000-000000000002";
export const Q_ACTIVE = "dddddddd-0000-4000-8000-00000000000a";
export const Q_ARCHIVED = "dddddddd-0000-4000-8000-00000000000b";
export const Q_OTHER_COURSE = "dddddddd-0000-4000-8000-00000000000c";

export function context(overrides = {}) {
  return {
    source: "xlsx",
    courses: [
      { id: C1, code: "SPI-101", modules: [{ id: M1, code: "M1" }, { id: M2, code: "M2" }] },
      { id: C2, code: "SPI-201", modules: [{ id: MX, code: "M1" }] },
    ],
    existing: [],
    updateTargets: [
      { id: Q_DRAFT, courseId: C1, status: "draft", revision: 3 },
      { id: Q_DRAFT2, courseId: C1, status: "draft", revision: 1 },
      { id: Q_ACTIVE, courseId: C1, status: "active", revision: 2 },
      { id: Q_ARCHIVED, courseId: C1, status: "archived", revision: 5 },
      { id: Q_OTHER_COURSE, courseId: C2, status: "draft", revision: 1 },
    ],
    ...overrides,
  };
}

/** A valid single-choice row; override any field. */
export function row(rowNumber, overrides = {}) {
  return {
    rowNumber,
    questionId: "",
    courseCode: "SPI-101",
    moduleCode: "",
    questionType: "single_choice",
    questionText: `Question number ${rowNumber}?`,
    options: ["Alpha", "Beta", "Gamma", "Delta"],
    correctAnswer: "A",
    marks: "1",
    explanation: "",
    status: "",
    ...overrides,
  };
}

export const codes = (result) => result.issues.map((i) => i.code);
export const severityOf = (result, code) => result.issues.find((i) => i.code === code)?.severity;

/** Existing-bank entry computed with the core's own fingerprint (parity with SQL is proven separately). */
export async function existing(questionId, courseId, type, text, options, status = "active", revision = 1) {
  return {
    questionId,
    courseId,
    status,
    revision,
    fingerprint: await core.questionFingerprint(courseId, type, text, options),
    textFingerprint: await core.textFingerprint(courseId, text),
  };
}
