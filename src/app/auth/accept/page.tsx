import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site";
import { AcceptInvitationForm } from "@/components/auth/AcceptInvitationForm";
import { Card, CardContent } from "@/components/ui/Card";
import { inviteLoginErrorPath } from "@/lib/auth/invite-acceptance";
import { invitationAcceptanceService } from "@/services/invitation-acceptance.service";

/**
 * Password setup + acceptance (Phase 7 P3.5), after the Continue step
 * started the invitee's session. No session → fixed /login error;
 * an already active account → its own portal (from the database role);
 * an invited account → the password form.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Set up your account | ${siteConfig.productName}`,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function AcceptInvitationPage() {
  const state = await invitationAcceptanceService.acceptPageState();
  if (state.kind === "session_missing") redirect(inviteLoginErrorPath("invite_session_missing"));
  if (state.kind === "active") redirect(state.home);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">Set up your account</h1>
          <p className="mt-1 text-sm text-ink-muted">Choose a password to finish accepting your invitation.</p>
        </div>

        <Card>
          <CardContent>
            <AcceptInvitationForm email={state.email} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
