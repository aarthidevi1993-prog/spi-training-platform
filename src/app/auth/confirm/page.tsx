import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site";
import { InvitationContinueForm } from "@/components/auth/InvitationContinueForm";
import { Card, CardContent } from "@/components/ui/Card";
import { inviteLoginErrorPath, parseInviteLink } from "@/lib/auth/invite-acceptance";

/**
 * Invitation link landing page (Phase 7 P3.5). Opening it consumes
 * nothing: no Auth or database call happens here, so a mail scanner
 * that fetches the link cannot use up the invitation. Only the
 * Continue button (a same-origin Server Action) verifies the token.
 * An unusable link goes to a fixed /login error; no `next` is read.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Accept your invitation | ${siteConfig.productName}`,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ConfirmInvitationPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const link = parseInviteLink(searchParams);
  if (!link.ok) redirect(inviteLoginErrorPath("invite_invalid"));

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">You&apos;ve been invited</h1>
          <p className="mt-1 text-sm text-ink-muted">Continue to set a password and finish setting up your account.</p>
        </div>

        <Card>
          <CardContent>
            <InvitationContinueForm tokenHash={link.tokenHash} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
