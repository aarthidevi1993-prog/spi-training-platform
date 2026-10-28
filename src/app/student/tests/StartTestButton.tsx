"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { startTestAttemptAction } from "@/services/student-tests.actions";

/**
 * Starts (or resumes) an attempt through the server. The database
 * decides whether the student may start and returns the attempt id;
 * the timer starts on the server at that moment.
 */
export function StartTestButton({ testId, timeLimitMinutes }: { testId: string; timeLimitMinutes: number | null }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startTestAttemptAction(testId);
      setConfirming(false);
      if (!result.ok || !result.attemptId) {
        setError(result.error ?? "Something went wrong. Please try again.");
        showToast({ variant: "error", title: "Couldn't start the test", description: result.error });
        router.refresh();
        return;
      }
      router.push(`/student/tests/${testId}/attempt/${result.attemptId}`);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-signal-red">
          {error}
        </p>
      )}
      <Button onClick={() => setConfirming(true)} isLoading={isPending}>
        <PlayCircle className="h-4 w-4" /> Start test
      </Button>
      <Dialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={start}
        title="Start this test now?"
        description={
          timeLimitMinutes
            ? `The ${timeLimitMinutes}-minute timer starts on the server as soon as you start, and keeps running even if you close the page.`
            : "The timer starts on the server as soon as you start, and keeps running even if you close the page."
        }
        confirmLabel="Start now"
        isLoading={isPending}
      />
    </div>
  );
}
