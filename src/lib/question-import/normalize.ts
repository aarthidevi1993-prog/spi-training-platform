/**
 * Bulk import — text normalization and scalar parsing (pure; runs in
 * the browser and on the server). Nothing here guesses: a value that is
 * not clearly valid is reported, never repaired into something else.
 */
import { QUESTION_LIMITS } from "@/types/question";
import type { QuestionStatus, QuestionType } from "@/types/question";

/**
 * Text as it will be stored: Unicode NFC, line breaks as "\n", tabs and
 * other control characters (except "\n") as spaces, ends trimmed.
 * Numbers are written as text; null/undefined become "".
 */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
    .trim();
}

/**
 * The 0013 duplicate-check normalization, reproduced exactly
 * (public.question_import_normalize): Unicode NFKC, ASCII A–Z lower-cased
 * only, every run of U+0001–U+0020 / U+007F collapsed to one space, and
 * leading/trailing spaces removed.
 */
export function fingerprintNormalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[\u0001- \u007F]+/g, " ")
    .replace(/^ +| +$/g, "");
}

/** Compare by Unicode code point (= UTF-8 byte order = PostgreSQL COLLATE "C"). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done || nb.done) return na.done === nb.done ? 0 : na.done ? -1 : 1;
    const diff = (na.value.codePointAt(0) ?? 0) - (nb.value.codePointAt(0) ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID in canonical lowercase form, or null. */
export function parseUuid(value: unknown): string | null {
  const text = cleanText(value);
  return UUID_PATTERN.test(text) ? text.toLowerCase() : null;
}

/** Codes are matched without case or surrounding spaces. */
export function normalizeCode(value: unknown): string {
  return cleanText(value).toUpperCase();
}

const QUESTION_TYPES: readonly QuestionType[] = ["single_choice", "multiple_choice", "true_false"];

export type TypeParse = { ok: true; type: QuestionType } | { ok: false; reason: "missing" | "invalid" };

/**
 * One of the three types, written with any case and with spaces,
 * hyphens, underscores or a slash between words ("Single choice",
 * "multiple-choice", "True/False"). Nothing else is accepted.
 */
export function parseQuestionType(value: unknown): TypeParse {
  const text = cleanText(value);
  if (!text) return { ok: false, reason: "missing" };
  const key = text.toLowerCase().replace(/[\s\-_/]+/g, "_");
  return (QUESTION_TYPES as readonly string[]).includes(key) ? { ok: true, type: key as QuestionType } : { ok: false, reason: "invalid" };
}

export type MarksParse = { ok: true; marks: number } | { ok: false; reason: "missing" | "invalid"; message: string };

/**
 * Marks: a plain decimal number greater than 0, at most 9999.99, with up
 * to 2 decimal places ("2", "1.5", 0.25). Missing marks are an error —
 * never defaulted. Commas, signs, units and exponents are refused.
 */
export function parseMarks(value: unknown): MarksParse {
  if (value === null || value === undefined) return { ok: false, reason: "missing", message: "Marks are required." };
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "invalid", message: "Marks must be a number." };
    text = String(value);
  } else {
    text = cleanText(value);
  }
  if (!text) return { ok: false, reason: "missing", message: "Marks are required." };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, reason: "invalid", message: `Marks must be a number like 1 or 1.5 (got "${text}").` };
  }
  const [, fraction = ""] = text.split(".");
  if (fraction.replace(/0+$/, "").length > 2) {
    return { ok: false, reason: "invalid", message: "Marks can have at most 2 decimal places." };
  }
  const marks = Number(text);
  if (!(marks > 0)) return { ok: false, reason: "invalid", message: "Marks must be greater than 0." };
  if (marks > QUESTION_LIMITS.marksMax) return { ok: false, reason: "invalid", message: `Marks must be at most ${QUESTION_LIMITS.marksMax}.` };
  return { ok: true, marks: Math.round(marks * 100) / 100 };
}

export type StatusParse = { requested: QuestionStatus | null; recognised: boolean; raw: string };

/** The source file's Status column. It never sets a status; it only decides whether to warn. */
export function parseStatus(value: unknown): StatusParse {
  const raw = cleanText(value);
  const key = raw.toLowerCase();
  if (!raw) return { requested: null, recognised: true, raw };
  if (key === "draft" || key === "active" || key === "archived") return { requested: key, recognised: true, raw };
  return { requested: null, recognised: false, raw };
}
