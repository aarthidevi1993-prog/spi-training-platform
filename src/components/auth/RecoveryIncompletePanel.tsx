"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { endRecoverySessionAction } from "@/services/invitation-recovery.actions";
import {
  RECOVERY_INCOMPLETE_MESSAGE,
  RECOVERY_SESSION_ENDED_MESSAGE,
  RECOVERY_SESSION_STILL_OPEN_MESSAGE,
} from "@/lib/auth/invitation-recovery";

/**
 * The safe page's content (P5.2): explains that sign-in was not completed and offers one action — close the
 * session on this device (local scope, confirmed on the server). The sign-in link is shown only after that is
 * CONFIRMED, because /login sends a signed-in account to its portal. Nothing here navigates automatically.
 */
export function RecoveryIncompletePanel() {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "ended" | "unconfirmed">("idle");

  function endSession() {
    if (isPending) return;
    startTransition(async () => {
      setState(await endRecoverySessionAction());
    });
  }

  return (
    <div className="flex flex-col gap-4 text-sm text-ink-muted">
      <p role="status">{RECOVERY_INCOMPLETE_MESSAGE}</p>
      {state === "ended" ? (
        <>
          <p role="status" className="text-ink">{RECOVERY_SESSION_ENDED_MESSAGE}</p>
          {/* A plain link (no automatic redirect): only offered once the session is confirmed closed. */}
          <Link href="/login" className="font-medium text-signal-blue hover:underline">
            Go to the sign-in page
          </Link>
        </>
      ) : (
        <>
          <ul className="list-disc space-y-1 pl-5">
            <li>Don&apos;t use the same email link again.</li>
            <li>Close the session on this device with the button below.</li>
            <li>If you were finishing an invitation, ask your administrator to send you a new sign-in link.</li>
          </ul>
          {state === "unconfirmed" && (
            <p role="alert" className="text-signal-red">
              {RECOVERY_SESSION_STILL_OPEN_MESSAGE}
            </p>
          )}
          <Button type="button" variant="secondary" className="w-full" onClick={endSession} isLoading={isPending} disabled={isPending}>
            Close the session on this device
          </Button>
        </>
      )}
    </div>
  );
}
