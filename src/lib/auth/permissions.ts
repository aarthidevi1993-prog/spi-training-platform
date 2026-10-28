import type { UserRole } from "@/types/user";

/**
 * Every permission the platform will eventually enforce, namespaced
 * as "<module>:<action>". Server-side code is the source of truth —
 * UI uses this only to decide what to render, never as the actual
 * access-control boundary (see PERMISSIONS_BY_ROLE + hasPermission).
 */
export type Permission =
  | "dashboard:view"
  | "courses:manage"
  | "courses:view"
  | "trainers:manage"
  | "students:manage"
  | "students:view"
  | "batches:manage"
  | "batches:view"
  | "classes:manage"
  | "classes:schedule"
  | "classes:view"
  | "attendance:manage"
  | "attendance:mark"
  | "attendance:view"
  | "questions:manage"
  | "questions:manage:assigned"
  | "tests:manage"
  | "tests:create"
  | "tests:take"
  | "results:view"
  | "results:view:own"
  | "performance:view"
  | "performance:view:own"
  | "reports:generate"
  | "reports:generate:assigned"
  | "certificates:manage"
  | "certificates:view:own"
  | "notifications:manage"
  | "notifications:view"
  | "settings:manage"
  | "profile:update";

/**
 * Central role → permission matrix, following the PART 2 brief
 * section 12 exactly. This is the only place permissions are
 * defined; everything else (RoleGuard, authService.hasPermission,
 * future API routes) reads from here.
 */
export const PERMISSIONS_BY_ROLE: Record<UserRole, Permission[]> = {
  admin: [
    "dashboard:view",
    "courses:manage",
    "trainers:manage",
    "students:manage",
    "batches:manage",
    "classes:manage",
    "attendance:manage",
    "questions:manage",
    "tests:manage",
    "results:view",
    "performance:view",
    "reports:generate",
    "certificates:manage",
    "notifications:manage",
    "notifications:view",
    "settings:manage",
    "profile:update",
  ],
  trainer: [
    "dashboard:view",
    "courses:view",
    "batches:view",
    "students:view",
    "classes:schedule",
    "attendance:mark",
    "tests:create",
    "questions:manage:assigned",
    "results:view",
    "performance:view",
    "reports:generate:assigned",
    "notifications:view",
    "profile:update",
  ],
  student: [
    "dashboard:view",
    "courses:view",
    "classes:view",
    "attendance:view",
    "tests:take",
    "results:view:own",
    "performance:view:own",
    "certificates:view:own",
    "notifications:view",
    "profile:update",
  ],
};

export function hasPermission(role: UserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSIONS_BY_ROLE[role]?.includes(permission) ?? false;
}
