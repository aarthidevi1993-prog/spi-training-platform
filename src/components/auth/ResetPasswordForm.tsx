"use client";

import { useMemo, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, AlertCircle, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { updatePasswordAction } from "@/services/auth.actions";
import { authConfig } from "@/config/auth";

function getPasswordStrength(password: string): { score: number; label: string; tone: "red" | "amber" | "teal" } {
  let score = 0;
  if (password.length >= authConfig.passwordRules.minLength) score += 34;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 22;
  if (/\d/.test(password)) score += 22;
  if (/[^A-Za-z0-9]/.test(password)) score += 22;

  if (score >= 90) return { score: 100, label: "Strong", tone: "teal" };
  if (score >= 56) return { score, label: "Medium", tone: "amber" };
  return { score, label: password ? "Weak" : "", tone: "red" };
}

export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const strength = useMemo(() => getPasswordStrength(password), [password]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);

    startTransition(async () => {
      const result = await updatePasswordAction(password, confirmPassword);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(true);
    });
  }

  if (success) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-signal-green/30 bg-signal-greenSoft px-4 py-6 text-center">
        <CheckCircle2 className="h-6 w-6 text-signal-green" aria-hidden />
        <p className="text-sm font-medium text-ink">Password updated successfully.</p>
        <Button className="mt-1" onClick={() => router.push("/login")}>
          Continue to login
        </Button>
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

      <div className="relative">
        <Input
          label="New Password"
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={isPending}
          className="pr-10"
          autoFocus
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

      {password && <ProgressBar value={strength.score} tone={strength.tone} label={`Strength: ${strength.label}`} />}

      <Input
        label="Confirm Password"
        type={showPassword ? "text" : "password"}
        name="confirmPassword"
        autoComplete="new-password"
        placeholder="••••••••"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        disabled={isPending}
        error={confirmPassword && confirmPassword !== password ? "Passwords do not match." : undefined}
      />

      <p className="text-xs text-ink-muted">
        Must be at least {authConfig.passwordRules.minLength} characters, and stronger passwords mix upper/lowercase
        letters, numbers and symbols.
      </p>

      <Button type="submit" size="lg" className="mt-1 w-full" isLoading={isPending} disabled={isPending}>
        {isPending ? "Updating…" : "Update password"}
      </Button>

      <Link href="/login" className="text-center text-sm font-medium text-signal-blue hover:underline">
        Back to login
      </Link>
    </form>
  );
}
