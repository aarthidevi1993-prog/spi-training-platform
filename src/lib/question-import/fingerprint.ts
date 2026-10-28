/**
 * Bulk import — duplicate fingerprints, byte-for-byte the 0013 formula
 * (public.question_import_fingerprint / question_import_text_fingerprint):
 *
 *   fingerprint      = SHA-256 hex of UTF-8(
 *                        course_id || U+001E || type || U+001E || normalize(text) || U+001E ||
 *                        normalize(option texts) sorted by code point, joined by U+001F)
 *   text fingerprint = SHA-256 hex of UTF-8(course_id || U+001E || normalize(text))
 *
 * course_id is the lowercase UUID text. Option order and the correct
 * answer are not part of it. Uses Web Crypto (browser and Node alike).
 */
import type { QuestionType } from "@/types/question";
import { compareCodePoints, fingerprintNormalize } from "./normalize";

const RECORD = "\u001e";
const UNIT = "\u001f";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function questionFingerprintInput(courseId: string, type: QuestionType, text: string, optionTexts: readonly string[]): string {
  const options = optionTexts.map(fingerprintNormalize).sort(compareCodePoints).join(UNIT);
  return [courseId.toLowerCase(), type, fingerprintNormalize(text), options].join(RECORD);
}

export function questionFingerprint(courseId: string, type: QuestionType, text: string, optionTexts: readonly string[]): Promise<string> {
  return sha256Hex(questionFingerprintInput(courseId, type, text, optionTexts));
}

export function textFingerprint(courseId: string, text: string): Promise<string> {
  return sha256Hex(courseId.toLowerCase() + RECORD + fingerprintNormalize(text));
}
