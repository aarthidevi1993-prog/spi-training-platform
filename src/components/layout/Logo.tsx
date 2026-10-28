import Image from "next/image";
import { cn } from "@/utils/cn";
import { siteConfig } from "@/config/site";

export interface LogoProps {
  /** "full" = mark + wordmark + tagline. "icon" = mark only, roughly square. */
  variant?: "full" | "icon";
  /**
   * Wrap the logo in a white rounded plate. The supplied artwork is
   * designed for a light backdrop (dark green/gray text) — use this
   * wherever the surrounding surface is dark or colored (the login/
   * landing hero panel, the dark sidebar) so it stays legible without
   * altering the logo itself.
   */
  plate?: boolean;
  /** Preload as a high-priority image — reserve for the single largest above-the-fold usage per page (e.g. the login hero). */
  priority?: boolean;
  className?: string;
}

/**
 * The one place the ARSÈNE logo path is referenced. Every other
 * component renders <Logo /> instead of pointing at a file path
 * directly, so swapping to different company branding later means
 * editing only src/config/site.ts.
 */
export function Logo({ variant = "full", plate = false, priority = false, className }: LogoProps) {
  const asset = siteConfig.logo[variant];

  const image = (
    <Image
      src={asset.src}
      alt={asset.alt}
      width={asset.width}
      height={asset.height}
      priority={priority}
      className="h-full w-auto object-contain"
    />
  );

  if (!plate) {
    return <span className={cn("inline-flex h-full items-center", className)}>{image}</span>;
  }

  return (
    <span className={cn("inline-flex items-center rounded-md bg-white px-2.5 py-1.5 shadow-panel", className)}>
      {image}
    </span>
  );
}
