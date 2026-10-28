"use server";

/**
 * Server Actions — the RPC boundary the Users detail panel calls (Phase
 * 7 P3.3). Each action delegates to usersService, which resolves the
 * caller from the authenticated session and validates every value; the
 * 0017 database functions decide whether the change is allowed and write
 * the audit row. Only an account id, a requested status/role, a reason
 * and detail fields are accepted from the browser. Internal error
 * details are logged, never returned.
 */

import { revalidatePath } from "next/cache";
import { usersService, UsersActionError, UsersAuthorizationError } from "./users.service";
import type { UserActionResult } from "@/types/user-management";

async function run(context: string, fn: () => Promise<string>, alsoRevalidate: string[] = []): Promise<UserActionResult> {
  try {
    const message = await fn();
    revalidatePath("/admin/users");
    for (const p of alsoRevalidate) revalidatePath(p);
    return { ok: true, message };
  } catch (err) {
    // These carry messages written to be shown to users.
    if (err instanceof UsersActionError || err instanceof UsersAuthorizationError) return { ok: false, error: err.message };
    console.error(`[users.actions] ${context}:`, err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

/** Suspend (status "suspended") or reactivate (status "active") an account. */
export async function setAccountStatusAction(userId: string, status: string, reason?: string | null): Promise<UserActionResult> {
  return run("setAccountStatus", () => usersService.setAccountStatus(userId, status, reason ?? null));
}

/** Change an account's role ("admin" | "trainer" | "student"), with the new record's full name when one is needed (its code is generated). */
export async function changeUserRoleAction(
  userId: string,
  role: string,
  record?: { fullName?: string } | null
): Promise<UserActionResult> {
  return run("changeUserRole", () => usersService.changeRole(userId, role, record ?? null));
}

/** Remove (deactivate) a student from the Students list. Only the account id comes from the browser. */
export async function removeStudentAccountAction(userId: string): Promise<UserActionResult> {
  return run("removeStudent", () => usersService.removeStudent(userId), ["/admin/students"]);
}

/** Remove (deactivate) a trainer from the Trainers list; refused while current batches/classes are assigned. */
export async function removeTrainerAccountAction(userId: string): Promise<UserActionResult> {
  return run("removeTrainer", () => usersService.removeTrainer(userId), ["/admin/trainers"]);
}

/** Save the name/contact fields of the account's current student or trainer record. */
export async function updateUserDetailsAction(userId: string, details: Record<string, unknown>): Promise<UserActionResult> {
  return run("updateUserDetails", () => usersService.updateDetails(userId, details));
}
