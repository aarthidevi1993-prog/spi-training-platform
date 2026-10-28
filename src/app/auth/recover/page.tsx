import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site";
import { RecoveryContinueForm } from "@/components/auth/RecoveryContinueForm";
import { Card, CardContent } from "@/components/ui/Card";
import { inviteLoginErrorPath } from "@/lib/auth/invite-acceptance";
import { parseRecoveryLink } from "@/lib/auth/invitation-recovery";

/**
 * Invitation recovery sign-in link landing page (P5.2). Opening it consumes
 * nothing: no Auth or database call happens here, so a mail scanner that
 * fetches the link cannot use it up. Only the Continue button (a same-origin
 * Server Action) verifies the one-time link and completes the recovery.
 * An unusable link goes to a fixed /login error; no `next` is read.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Finish setting up your account | ${siteConfig.productName}`,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function RecoverInvitationPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const link = parseRecoveryLink(searchParams);
  if (!link.ok) redirect(inviteLoginErrorPath("invite_invalid"));

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">Finish setting up your account</h1>
          <p className="mt-1 text-sm text-ink-muted">Continue to confirm it&apos;s you, then set a password to activate your account.</p>
        </div>
        <Card>
          <CardContent>
            <RecoveryContinueForm tokenHash={link.tokenHash} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
