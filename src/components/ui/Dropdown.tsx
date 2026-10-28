"use client";

import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useDisclosure } from "@/hooks/useDisclosure";
import { cn } from "@/utils/cn";

export interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}

export function Dropdown({ trigger, children, align = "right", className }: DropdownProps) {
  const { isOpen, toggle, close } = useDisclosure(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [isOpen, close]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <div onClick={toggle}>{trigger}</div>
      {isOpen && (
        <div
          className={cn(
            "absolute z-40 mt-2 min-w-[12rem] rounded-md border border-surface-border bg-surface-raised py-1 shadow-overlay",
            align === "right" ? "right-0" : "left-0",
            className
          )}
          onClick={close}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DropdownItem({ className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-surface-sunken",
        "disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      {...props}
    />
  );
}
