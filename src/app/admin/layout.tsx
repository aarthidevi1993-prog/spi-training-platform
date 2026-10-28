import { AppShell } from "@/components/layout/AppShell";
import { RoleGuard } from "@/components/auth/RoleGuard";

// Every page under this layout reads the authenticated session
// server-side (via RoleGuard). Force dynamic rendering so an
// authenticated response is never cached/shared between users.
export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGuard allowedRoles={["admin"]}>
      <AppShell role="admin">{children}</AppShell>
    </RoleGuard>
  );
}
