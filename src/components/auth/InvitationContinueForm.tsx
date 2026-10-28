"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmInvitationAction } from "@/services/invitation-acceptance.actions";
import { INVITE_ACCEPT_PATH, INVITE_OTP_TYPE, inviteLoginErrorPath } from "@/lib/auth/invite-acceptance";

/**
 * The Continue step of /auth/confirm: one deliberate click verifies the
 * invitation link on the server. Navigation goes only to fixed paths.
 * The token is passed to the Server Action and never shown.
 */
export function InvitationContinueForm({ tokenHash }: { tokenHash: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  function handleContinue() {
    if (isPending || done) return;
    startTransition(async () => {
      const result = await confirmInvitationAction(tokenHash, INVITE_OTP_TYPE);
      setDone(true);
      router.replace(result.ok ? INVITE_ACCEPT_PATH : inviteLoginErrorPath(result.code));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        You&apos;ll be signed in to the invited account. If anyone else is signed in on this browser, they&apos;ll be signed out.
      </p>
      <Button type="button" size="lg" className="w-full" onClick={handleContinue} isLoading={isPending || done} disabled={isPending || done}>
        {isPending || done ? "Continuing…" : "Continue"}
      </Button>
    </div>
  );
}
