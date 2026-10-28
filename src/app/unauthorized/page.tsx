import Link from "next/link";
import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { siteConfig } from "@/config/site";
import { authService } from "@/services/auth.service";
import { getHomeRouteForRole, ROLE_LABEL } from "@/lib/auth/roles";
import { Button } from "@/components/ui/Button";
import { GoBackButton } from "./GoBackButton";

export const metadata: Metadata = {
  title: `Access denied | ${siteConfig.productName}`,
};

export const dynamic = "force-dynamic";

export default async function UnauthorizedPage() {
  const user = await authService.getCurrentUser();
  const dashboardHref = user ? getHomeRouteForRole(user.role) : "/login";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-signal-redSoft text-signal-red">
        <ShieldAlert className="h-7 w-7" />
      </span>

      <p className="mt-6 font-mono text-2xs uppercase tracking-wide text-ink-faint">Error 403</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Access denied</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">
        You don&rsquo;t have permission to access this page
        {user ? ` as a ${ROLE_LABEL[user.role].toLowerCase()}` : ""}.
      </p>

      <div className="mt-8 flex items-center gap-3">
        <Link href={dashboardHref}>
          <Button>Go to dashboard</Button>
        </Link>
        <GoBackButton />
      </div>
    </main>
  );
}
