"use server";

/**
 * Server Actions — the RPC boundary the class attendance roster calls.
 * Each action delegates to attendanceService (which resolves the
 * caller's identity and authorization server-side) and returns a plain,
 * serializable result. Internal error details are logged, never
 * returned to the browser.
 */

import { revalidatePath } from "next/cache";
import {
  attendanceService,
  AttendanceAuthorizationError,
  AttendanceRepositoryError,
  AttendanceValidationError,
} from "./attendance.service";
import type { AttendanceMarkInput } from "@/types/attendance";

export interface AttendanceActionResult {
  ok: boolean;
  error?: string;
}

export async function saveClassAttendanceAction(
  classId: string,
  marks: AttendanceMarkInput[]
): Promise<AttendanceActionResult> {
  try {
    await attendanceService.markAttendance(classId, marks);

    for (const portal of ["admin", "trainer", "student"]) {
      revalidatePath(`/${portal}/classes/${classId}`);
      revalidatePath(`/${portal}/attendance`);
    }
    return { ok: true };
  } catch (err) {
    if (
      err instanceof AttendanceValidationError ||
      err instanceof AttendanceAuthorizationError ||
      err instanceof AttendanceRepositoryError
    ) {
      // These carry messages written to be shown to users.
      return { ok: false, error: err.message };
    }
    console.error("[attendance.actions] saveClassAttendance:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
