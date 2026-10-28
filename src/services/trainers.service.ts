import "server-only";
import { authService } from "./auth.service";
import { trainersRepository, TrainerRepositoryError } from "@/repositories/trainers.repository";
import type { AuthUser } from "@/types/auth";
import type { TrainerSummary } from "@/types/trainer";

/**
 * Trainers service — resolves the caller's identity server-side via
 * authService (never from a client-supplied argument). The trainer
 * directory is an admin-only view: this check is the second layer
 * behind the admin portal's RoleGuard/middleware, and RLS (e.g.
 * trainer_details readable only by super_admin and self) is the
 * database layer. Read-only for now.
 */

export class TrainerAuthorizationError extends Error {
  constructor(message = "You don't have permission to view trainers.") {
    super(message);
    this.name = "TrainerAuthorizationError";
  }
}

async function requireAdmin(): Promise<AuthUser> {
  const user = await authService.getCurrentUser();
  if (!user) throw new TrainerAuthorizationError("You need to be signed in.");
  // "admin" is the application name for the super_admin profile role.
  if (user.role !== "admin") throw new TrainerAuthorizationError();
  return user;
}

export const trainersService = {
  /** All trainers (active, invited and inactive) for the admin table. */
  async listTrainers(): Promise<TrainerSummary[]> {
    await requireAdmin();
    return trainersRepository.findAll();
  },
};

export { TrainerRepositoryError };
