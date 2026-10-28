"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { confirmRecoveryAction } from "@/services/invitation-recovery.actions";
import { RECOVERY_INCOMPLETE_PATH, RECOVERY_OTP_TYPE, RECOVERY_REQUEST_FAILED_MESSAGE, recoveryFailurePath } from "@/lib/auth/invitation-recovery";

/**
 * The Continue step of /auth/recover (P5.2): one deliberate click verifies the
 * sign-in link on the server and completes the invitation recovery.
 * Navigation goes only to fixed paths returned by the server action; a
 * refusal is shown here (the session has been ended). If the request itself
 * fails (network, server), nothing is known about the session: a safe message
 * is shown with a link to the safe page — never a portal, never a claim that
 * anyone was signed out. The token is passed to the Server Action and never shown.
 */
export function RecoveryContinueForm({ tokenHash }: { tokenHash: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);

  function handleContinue() {
    if (isPending || done) return;
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof confirmRecoveryAction>>;
      try {
        result = await confirmRecoveryAction(tokenHash, RECOVERY_OTP_TYPE);
      } catch {
        // The request failed or was rejected: the link may already be used and a session may or may not exist.
        setDone(true);
        setRequestFailed(true);
        return;
      }
      setDone(true);
      if (result.ok) router.replace(result.destination);
      // An unconfirmed sign-out goes to the safe page (never /login, which sends signed-in users to a portal).
      else if ("code" in result) router.replace(recoveryFailurePath(result.code));
      else setError(result.error);
    });
  }

  if (requestFailed) {
    return (
      <div role="alert" className="flex flex-col gap-3 text-sm">
        <p className="flex items-start gap-2 text-signal-red">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {RECOVERY_REQUEST_FAILED_MESSAGE}
        </p>
        <Link href={RECOVERY_INCOMPLETE_PATH} className="font-medium text-signal-blue hover:underline">
          Close any session on this device
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-signal-red">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        You&apos;ll be signed in to your account. If anyone else is signed in on this browser, they&apos;ll be signed out.
      </p>
      <Button type="button" size="lg" className="w-full" onClick={handleContinue} isLoading={isPending || done} disabled={isPending || done}>
        {isPending || done ? "Continuing…" : "Continue"}
      </Button>
    </div>
  );
}
