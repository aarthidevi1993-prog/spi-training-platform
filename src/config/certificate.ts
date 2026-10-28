/**
 * Certificate artwork configuration (presentation only — no database).
 *
 * Logos: transparent-background derivatives of the official ARSÈNE
 * logo files (same artwork, colours and proportions; only the plain
 * background pixels were made transparent) so the logo blends cleanly
 * into the certificate. The originals in /public/brand are unchanged.
 *
 * Signatures: approved, self-hosted signature images can be added
 * later WITHOUT a database migration — put the image files under
 * /public/brand/signatures/ and reference them here. None exist yet, so
 * the certificate shows clean signature lines with the stored
 * signatory names underneath. Never use external URLs or generated
 * signatures.
 */

export interface CertificateImageAsset {
  /** Path under /public. */
  src: string;
  width: number;
  height: number;
}

export interface CertificateConfig {
  logo: CertificateImageAsset;
  icon: CertificateImageAsset;
  signatures: {
    /** Programme manager / issuing authority signature, e.g. "/brand/signatures/programme-manager.png". */
    issuingAuthority: string | null;
    /** Trainer signatures keyed by the trainer name stored on the certificate. */
    trainers: Record<string, string>;
  };
}

export const certificateConfig: CertificateConfig = {
  logo: { src: "/brand/arsene-logo-full-transparent.png", width: 1932, height: 543 },
  icon: { src: "/brand/arsene-logo-icon-transparent.png", width: 540, height: 520 },
  signatures: {
    issuingAuthority: null,
    trainers: {},
  },
};

/** Only local, self-hosted signature images under /brand/signatures/ are used. */
export function localSignature(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^\/brand\/signatures\/[A-Za-z0-9._-]+\.(png|webp|svg)$/.test(path) ? path : null;
}
