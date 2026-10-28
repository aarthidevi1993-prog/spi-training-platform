"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { loginAction } from "@/services/auth.actions";
import type { LoginFieldErrors } from "@/types/auth";

// Friendly messages for /auth/callback redirect error codes (see
// src/app/auth/callback/route.ts) — never surfaces raw Supabase error
// details, just a safe, actionable explanation.
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  invalid_callback: "That link is missing information and can't be used. Please try signing in again.",
  auth_not_configured: "Sign-in isn't configured yet. Please contact your administrator.",
  expired_callback: "That link has expired or was already used. Please request a new one.",
  // Invitation acceptance (/auth/confirm, /auth/accept).
  invite_invalid: "That invitation link is invalid, has expired or was already used. Ask your administrator for a new invitation.",
  invite_session_missing: "Your invitation session has ended. Open the invitation link from your email again.",
  invite_failed: "We couldn't open your invitation. Please try again in a moment.",
  recovery_not_eligible:
    "That link can only be used to finish setting up an invited account, so you've been signed out. Sign in here with your email and password. If you can't, use “Forgot your password?” or contact your administrator.",
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [errors, setErrors] = useState<LoginFieldErrors>(() => {
    const code = searchParams.get("error");
    return code && CALLBACK_ERROR_MESSAGES[code] ? { form: CALLBACK_ERROR_MESSAGES[code] } : {};
  });
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});

    startTransition(async () => {
      const next = searchParams.get("next");
      const result = await loginAction(email, password, rememberMe, next);

      if (!result.ok) {
        setErrors(result.errors ?? {});
        return;
      }

      showToast({ variant: "success", title: "Welcome back", description: "You've been signed in." });
      router.push(result.redirectTo ?? "/");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      {errors.form && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{errors.form}</span>
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
        error={errors.email}
        disabled={isPending}
        autoFocus
      />

      <div className="relative">
        <Input
          label="Password"
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          disabled={isPending}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          aria-label={showPassword ? "Hide password" : "Show password"}
          className="absolute right-2.5 top-[34px] text-ink-faint hover:text-ink-muted"
          tabIndex={-1}
        >
          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            disabled={isPending}
            className="h-4 w-4 rounded border-surface-border text-primary-500 focus:ring-signal-blue"
          />
          Remember me
        </label>
        <Link href="/forgot-password" className="text-sm font-medium text-signal-blue hover:underline">
          Forgot your password?
        </Link>
      </div>

      <Button type="submit" size="lg" className="mt-1 w-full" isLoading={isPending} disabled={isPending}>
        {isPending ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
