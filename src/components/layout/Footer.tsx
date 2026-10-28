import { cn } from "@/utils/cn";
import { siteConfig } from "@/config/site";

export interface FooterProps {
  /** Match the surface it sits on so the text stays legible. */
  variant?: "light" | "dark";
  className?: string;
}

export function Footer({ variant = "light", className }: FooterProps) {
  return (
    <footer className={cn("py-4 text-center", className)}>
      <p
        className={cn(
          "font-mono text-2xs",
          variant === "dark" ? "text-ink-onPanelMuted" : "text-ink-faint"
        )}
      >
        © {new Date().getFullYear()} {siteConfig.companyName}. All rights reserved.
      </p>
    </footer>
  );
}
