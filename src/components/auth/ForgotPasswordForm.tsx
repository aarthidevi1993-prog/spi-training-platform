"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { requestPasswordResetAction } from "@/services/auth.actions";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);

    startTransition(async () => {
      const result = await requestPasswordResetAction(email);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSubmitted(true);
    });
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-signal-green/30 bg-signal-greenSoft px-4 py-6 text-center">
        <CheckCircle2 className="h-6 w-6 text-signal-green" aria-hidden />
        <p className="text-sm font-medium text-ink">Check your email</p>
        <p className="text-sm text-ink-muted">
          If an account exists for <span className="font-medium text-ink">{email}</span>, we&rsquo;ve sent
          password reset instructions to it.
        </p>
        <Link href="/login" className="mt-1 text-sm font-medium text-signal-blue hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      <Input
        label="Email Address"
        type="email"
        name="email"
        autoComplete="email"
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={isPending}
        autoFocus
        hint="Enter your registered email address."
      />

      <Button type="submit" size="lg" className="mt-1 w-full" isLoading={isPending} disabled={isPending}>
        {isPending ? "Sending…" : "Send reset link"}
      </Button>

      <Link href="/login" className="text-center text-sm font-medium text-signal-blue hover:underline">
        Back to login
      </Link>
    </form>
  );
}
