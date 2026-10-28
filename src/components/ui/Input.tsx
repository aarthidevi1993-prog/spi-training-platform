import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, error, id, ...props }, ref) => {
    const inputId = id ?? props.name;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-ink">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "h-9 rounded border border-surface-border bg-white px-3 text-sm text-ink placeholder:text-ink-faint",
            "focus:border-signal-blue transition-colors",
            error && "border-signal-red",
            className
          )}
          aria-invalid={Boolean(error)}
          {...props}
        />
        {error ? (
          <span className="text-xs text-signal-red">{error}</span>
        ) : hint ? (
          <span className="text-xs text-ink-muted">{hint}</span>
        ) : null}
      </div>
    );
  }
);

Input.displayName = "Input";
