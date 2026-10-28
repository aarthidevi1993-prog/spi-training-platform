/**
 * Trainer student editing (Phase 7 P3.10-B) — pure logic: which values a
 * trainer's edit may send, and a safe sentence for every answer.
 *
 * Authorization is NOT decided here. trainer_update_student (0017) checks
 * the caller (an active trainer), the scope (the student is enrolled in a
 * batch this trainer currently teaches) and the allowed keys, and writes
 * the audit row. Nothing here can widen what the database allows.
 *
 * Privacy (deliberate): trainers cannot read student_details, so phone,
 * organization and designation are write-only for them. An empty field
 * therefore means "keep the current value" and is never sent — the
 * database would store an empty value as null, erasing data the trainer
 * never saw. Only the student's name is shown and compared.
 */
import { LIMITS, isUuid } from "@/lib/user-management/lifecycle";

export { isUuid };

/** What the trainer's edit dialog may send. Nothing else is ever forwarded. */
export interface TrainerStudentEditInput {
  fullName?: unknown;
  phone?: unknown;
  organization?: unknown;
  designation?: unknown;
}

/** The exact keys trainer_update_student accepts (0017 user_mgmt_check_keys). */
export type TrainerStudentPatch = Partial<Record<"full_name" | "phone" | "organization" | "designation", string>>;

export type TrainerPatchResult = { ok: true; patch: TrainerStudentPatch } | { ok: false; error: string; unchanged?: true };

export const NOTHING_CHANGED = "Nothing changed.";

const OPTIONAL_FIELDS = [
  { input: "phone", key: "phone", label: "Phone", max: LIMITS.phone },
  { input: "organization", key: "organization", label: "Organization", max: LIMITS.organization },
  { input: "designation", key: "designation", label: "Designation", max: LIMITS.designation },
] as const;

/**
 * The patch for trainer_update_student:
 *   - full_name: only when given and different from the current name; never blank;
 *   - phone / organization / designation: only when the trainer typed a non-blank value
 *     (blank = keep the existing, unseen value);
 *   - no other key, whatever the browser sends.
 * An empty patch is "Nothing changed." — answered before any database call.
 */
export function buildTrainerStudentPatch(currentName: string, input: TrainerStudentEditInput | null | undefined): TrainerPatchResult {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const patch: TrainerStudentPatch = {};

  if (src.fullName !== undefined) {
    if (typeof src.fullName !== "string") return { ok: false, error: "Enter the student's full name." };
    const name = src.fullName.trim();
    if (!name) return { ok: false, error: "The student's full name can't be empty." };
    if (name.length > LIMITS.fullName) return { ok: false, error: `The full name can be at most ${LIMITS.fullName} characters.` };
    if (name !== currentName.trim()) patch.full_name = name;
  }

  for (const f of OPTIONAL_FIELDS) {
    const raw = src[f.input];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") return { ok: false, error: `${f.label} isn't valid.` };
    const value = raw.trim();
    if (!value) continue; // blank keeps the existing value
    if (value.length > f.max) return { ok: false, error: `${f.label} can be at most ${f.max} characters.` };
    patch[f.key] = value;
  }

  return Object.keys(patch).length === 0 ? { ok: false, error: NOTHING_CHANGED, unchanged: true } : { ok: true, patch };
}

/** Fixed sentences for the database's answers (reasons and raised SQLSTATEs). */
export const TRAINER_EDIT_MESSAGE = {
  saved: "Student details saved.",
  scope: "You can only edit students enrolled in a batch you currently teach.",
  notFound: "That student no longer exists or isn't one of your current students.",
  noContactRecord: "This student's contact record is missing. Ask a Super Admin to check the account.",
  invalid: "Some of the values aren't valid. Check them and try again.",
  generic: "Something went wrong. Please try again.",
  trainersOnly: "Only trainers can edit their students here.",
  signIn: "You need to be signed in.",
  demo: "Student changes aren't available in demo mode.",
} as const;

/** A database reason → a fixed sentence (unknown reasons become the generic sentence, never passed through). */
export function trainerEditReasonMessage(reason: string | null): string {
  switch (reason) {
    case "not_found":
      return TRAINER_EDIT_MESSAGE.notFound;
    case "unchanged":
      return NOTHING_CHANGED;
    case "no_contact_record":
      return TRAINER_EDIT_MESSAGE.noContactRecord;
    default:
      return TRAINER_EDIT_MESSAGE.generic;
  }
}

/** A raised SQLSTATE → a fixed sentence. */
export function trainerEditErrorMessage(code: string | null): string {
  if (code === "42501") return TRAINER_EDIT_MESSAGE.scope;
  if (code === "22023" || code === "22P02" || code === "23514") return TRAINER_EDIT_MESSAGE.invalid;
  return TRAINER_EDIT_MESSAGE.generic;
}

/** Whether a trainer's current enrolment lets them edit the student (mirrors 0017's scope; the database decides). */
export const EDITABLE_BATCH_STATUSES = ["upcoming", "ongoing"] as const;

/** Plain, serializable result of the trainer edit action. */
export type TrainerEditResult = { ok: true; message: string } | { ok: false; error: string };
