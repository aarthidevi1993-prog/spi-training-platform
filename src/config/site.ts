/**
 * Central company / branding configuration.
 *
 * Every component that needs the company name, logo, description or
 * contact details should import from here rather than hard-coding
 * those values or a logo path. Swapping to a different company's
 * branding in the future means editing only this file.
 */

export interface LogoAsset {
  /** Path under /public. */
  src: string;
  alt: string;
  /** Intrinsic pixel dimensions, used to preserve aspect ratio (next/image requires these). */
  width: number;
  height: number;
}

export interface SiteConfig {
  companyName: string;
  companyShortName: string;
  /** The remainder of the name after the short form — e.g. "Technology Services" after "ARSÈNE". Used where the brand is shown as a stacked two-line lockup (sidebar). */
  companySuffix: string;
  companyDescription: string;
  tagline: string;
  logo: {
    /** Full lockup: mark + wordmark + tagline. Use on light backgrounds or on a light plate. */
    full: LogoAsset;
    /** Mark only, roughly square — for compact spots (sidebar, favicon-style badges). */
    icon: LogoAsset;
  };
  contact: {
    email: string;
    phone: string;
    address: string;
  };
  productName: string;
}

export const siteConfig: SiteConfig = {
  companyName: "ARSÈNE Technology Services",
  companyShortName: "ARSÈNE",
  companySuffix: "Technology Services",
  companyDescription:
    "Smart Plant Instrumentation (SPI) training and certification for engineering professionals.",
  tagline: "Dream. Plan. Innovate.",
  logo: {
    full: {
      src: "/brand/arsene-logo-full.png",
      alt: "ARSÈNE Technology Services",
      width: 1932,
      height: 543,
    },
    icon: {
      src: "/brand/arsene-logo-icon.png",
      alt: "ARSÈNE",
      width: 540,
      height: 520,
    },
  },
  contact: {
    email: "training@arsene-tech.example",
    phone: "+91 00000 00000",
    address: "Add company address here",
  },
  productName: "SPI Training Management Platform",
};
