/**
 * Trainer student editing service (Phase 7 P3.10-B).
 *
 * Identity comes from getCurrentUser (the server session), never from the
 * browser; only a trainer may use this. The browser sends a student id and
 * up to four values; this service validates them and builds the patch
 * (lib/students/trainer-edit: only typed, non-blank values; never another
 * key), then trainer_update_student decides scope and writes the audit
 * row. Every outcome becomes a fixed sentence — no database detail leaves
 * here.
 *
 * Factory without `server-only` so it can be tested against a local
 * database; students.service.ts wires the real session.
 */
import type { AuthUser } from "@/types/auth";
import {
  NOTHING_CHANGED,
  TRAINER_EDIT_MESSAGE,
  buildTrainerStudentPatch,
  isUuid,
  trainerEditErrorMessage,
  trainerEditReasonMessage,
  type TrainerEditResult,
  type TrainerStudentEditInput,
} from "@/lib/students/trainer-edit";
import { StudentsFunctionError, type StudentsWriteRepository } from "@/repositories/students.repository.core";

export class StudentEditAuthorizationError extends Error {
  constructor(message: string = TRAINER_EDIT_MESSAGE.trainersOnly) {
    super(message);
    this.name = "StudentEditAuthorizationError";
  }
}

export interface TrainerStudentEditDeps {
  repository: Pick<StudentsWriteRepository, "readStudentName" | "trainerUpdateStudent">;
  getCurrentUser: () => Promise<AuthUser | null>;
  isDemoMode?: () => boolean;
}

export function createTrainerStudentEditService(deps: TrainerStudentEditDeps) {
  return {
    /** Edit an in-scope student's name / phone / organization / designation as the signed-in trainer. */
    async updateAsTrainer(studentId: unknown, input: TrainerStudentEditInput | null | undefined): Promise<TrainerEditResult> {
      const user = await deps.getCurrentUser();
      if (!user) throw new StudentEditAuthorizationError(TRAINER_EDIT_MESSAGE.signIn);
      if (user.role !== "trainer") throw new StudentEditAuthorizationError();
      if (deps.isDemoMode?.()) return { ok: false, error: TRAINER_EDIT_MESSAGE.demo };
      if (!isUuid(studentId)) return { ok: false, error: TRAINER_EDIT_MESSAGE.notFound };

      try {
        // The current name (readable under RLS) decides whether the name changed; unreadable → not one of theirs.
        const currentName = await deps.repository.readStudentName(studentId);
        if (currentName === null) return { ok: false, error: TRAINER_EDIT_MESSAGE.notFound };
        const built = buildTrainerStudentPatch(currentName, input);
        if (!built.ok) return { ok: false, error: built.error };

        const result = await deps.repository.trainerUpdateStudent(studentId, built.patch);
        if (result.ok) return { ok: true, message: TRAINER_EDIT_MESSAGE.saved };
        return { ok: false, error: result.reason === "unchanged" ? NOTHING_CHANGED : trainerEditReasonMessage(result.reason) };
      } catch (err) {
        if (err instanceof StudentsFunctionError) return { ok: false, error: trainerEditErrorMessage(err.code) };
        return { ok: false, error: TRAINER_EDIT_MESSAGE.generic };
      }
    },
  };
}

export type TrainerStudentEditService = ReturnType<typeof createTrainerStudentEditService>;
