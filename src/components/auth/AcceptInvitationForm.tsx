"use client";

import { useMemo, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, AlertCircle, Info } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { completeInvitationAction } from "@/services/invitation-acceptance.actions";
import {
  getPasswordStrength,
  isPortalHome,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SETUP_GENERIC_ERROR,
  validateNewPassword,
  type PasswordField,
} from "@/lib/auth/invite-acceptance";

/**
 * Password setup on /auth/accept. The same rules are checked here for
 * instant feedback and again on the server. On success the server's
 * destination is used only if it is one of the three fixed portals.
 * Messages come from the server already mapped; nothing raw is shown.
 */
export function AcceptInvitationForm({ email }: { email: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<{ field: PasswordField; error: string } | null>(null);
  const [ended, setEnded] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  /** Account active, but something in the invitation couldn't be done (0030: archived course) — shown before continuing. */
  const [notice, setNotice] = useState<{ text: string; proceed: () => void } | null>(null);
  const [isPending, startTransition] = useTransition();

  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const busy = isPending || succeeded;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || ended) return;
    setError(undefined);
    setFieldError(null);

    const check = validateNewPassword(password, confirmPassword);
    if (!check.ok) {
      setFieldError({ field: check.field, error: check.error });
      return;
    }

    startTransition(async () => {
      const result = await completeInvitationAction(password, confirmPassword);
      if (result.ok) {
        if (!isPortalHome(result.home)) {
          setError(SETUP_GENERIC_ERROR);
          return;
        }
        setSucceeded(true);
        // The one navigation of this form: only the database role's validated portal home.
        const proceed = () => {
          router.replace(result.home);
          router.refresh();
        };
        if (result.notice) {
          // Active, but something in the invitation couldn't be done: explain first, continue on request.
          setNotice({ text: result.notice, proceed });
          return;
        }
        proceed();
        return;
      }
      if (result.field) setFieldError({ field: result.field, error: result.error });
      else setError(result.error);
      if (result.ended) {
        setEnded(true);
        setPassword("");
        setConfirmPassword("");
      }
    });
  }

  if (notice) {
    return (
      <div className="flex flex-col gap-4">
        <div role="status" className="flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
          <span>{notice.text}</span>
        </div>
        <Button type="button" onClick={notice.proceed}>
          Continue to my portal
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

      {email && !ended && (
        <p className="text-sm text-ink-muted">
          Signed in as <span className="font-medium text-ink">{email}</span>
        </p>
      )}

      {!ended && (
        <>
          <div className="relative">
            <Input
              label="New Password"
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              error={fieldError?.field === "password" ? fieldError.error : undefined}
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
            disabled={busy}
            error={
              fieldError?.field === "confirmPassword"
                ? fieldError.error
                : confirmPassword && confirmPassword !== password
                  ? "Passwords do not match."
                  : undefined
            }
          />

          <p className="text-xs text-ink-muted">
            {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} characters. Stronger passwords mix upper/lowercase letters, numbers and symbols.
          </p>

          <Button type="submit" size="lg" className="mt-1 w-full" isLoading={busy} disabled={busy}>
            {busy ? "Setting up…" : "Set password and continue"}
          </Button>
        </>
      )}

      {ended && (
        <Link href="/login" className="text-center text-sm font-medium text-signal-blue hover:underline">
          Back to sign in
        </Link>
      )}
    </form>
  );
}
