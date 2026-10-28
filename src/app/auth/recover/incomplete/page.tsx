import type { Metadata } from "next";
import { siteConfig } from "@/config/site";
import { RecoveryIncompletePanel } from "@/components/auth/RecoveryIncompletePanel";
import { Card, CardContent } from "@/components/ui/Card";

/**
 * Safe page after an invitation-recovery sign-out that could not be confirmed (P5.2). It reads no session and
 * redirects nobody — unlike /login, which sends a signed-in account to its portal — so a session this flow may
 * have left behind is never turned into a way into the application. The person can close the session on this
 * device from here, and is told the safe next steps.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Sign-in not completed | ${siteConfig.productName}`,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function RecoveryIncompletePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">Sign-in not completed</h1>
        </div>
        <Card>
          <CardContent>
            <RecoveryIncompletePanel />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
