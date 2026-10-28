"use client";

import Image from "next/image";
import Link from "next/link";
import { Source_Serif_4 } from "next/font/google";
import { ArrowLeft, Printer, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { siteConfig } from "@/config/site";
import { certificateConfig, localSignature } from "@/config/certificate";
import { formatDate } from "@/utils/format";
import type { CertificateDocument as CertificateSnapshot } from "@/types/certificate";
import { CertificateMedal } from "./CertificateMedal";
import { CertificateQrCode } from "./CertificateQrCode";
import { CertificateSeal } from "./CertificateSeal";

const serif = Source_Serif_4({ subsets: ["latin"], weight: ["400", "600", "700"], display: "swap" });

/** A4 landscape at 96 dpi — the certificate is laid out at exactly this size. */
const PAGE_W = 1123;
const PAGE_H = 794;
const FRAME = 18;
const PANEL_W = 232;

const FOREST = "#0B3B24";
const INK_GREEN = "#0A2A1B";
const GOLD = "#C9A24A";
const GOLD_LIGHT = "#E3C97E";
const IVORY = "#FAF7EF";
const CHARCOAL = "#2A2F33";

/**
 * Print rules, scoped to this view: only the certificate is printed —
 * the app sidebar, header and toolbar are removed — on one A4
 * landscape page with no margins, colours preserved.
 */
const PRINT_CSS = `
@media print {
  @page { size: A4 landscape; margin: 0; }
  html, body { background: #ffffff !important; margin: 0 !important; padding: 0 !important; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body *:not(:has(#certificate-print)):not(#certificate-print):not(#certificate-print *) { display: none !important; }
  *:has(#certificate-print) {
    margin: 0 !important; padding: 0 !important; border: 0 !important; box-shadow: none !important;
    background: #ffffff !important; width: auto !important; max-width: none !important; min-width: 0 !important;
    height: auto !important; min-height: 0 !important; overflow: visible !important; position: static !important;
    display: block !important; transform: none !important;
  }
  .certificate-screen-only { display: none !important; }
  .certificate-scroll { overflow: visible !important; padding: 0 !important; }
  #certificate-print {
    width: 297mm !important; height: 210mm !important; margin: 0 !important; box-shadow: none !important;
    page-break-inside: avoid; break-inside: avoid; page-break-after: avoid;
  }
}
`;

/** Diagonal gold bands across a frame corner (top-left or bottom-right). */
function CornerBands({ corner }: { corner: "tl" | "br" }) {
  const size = 190;
  const bands = `linear-gradient(${corner === "tl" ? 135 : 315}deg,
    ${FOREST} 0%, ${FOREST} 33%,
    ${GOLD} 33%, ${GOLD} 37.5%,
    transparent 37.5%, transparent 39.2%,
    ${GOLD_LIGHT} 39.2%, ${GOLD_LIGHT} 40.2%,
    transparent 40.2%)`;
  return (
    <div
      aria-hidden
      className="absolute z-30"
      style={{ width: size, height: size, background: bands, ...(corner === "tl" ? { left: 0, top: 0 } : { right: 0, bottom: 0 }) }}
    />
  );
}

function GoldRule({ width }: { width: number }) {
  return <span aria-hidden className="block h-px" style={{ width, backgroundColor: GOLD }} />;
}

function DetailColumn({ label, value, first = false, wrap = false }: { label: string; value: string; first?: boolean; wrap?: boolean }) {
  return (
    <div className={first ? "pr-5" : "px-5"} style={first ? undefined : { borderLeft: `1px solid ${GOLD}` }}>
      <p className="text-[12.5px]" style={{ color: CHARCOAL }}>
        {label}
      </p>
      <p className={`${serif.className} mt-1 text-[15.5px] ${wrap ? "" : "whitespace-nowrap"}`} style={{ color: INK_GREEN }}>
        {value}
      </p>
    </div>
  );
}

function Signature({ name, roles, image, left }: { name: string | null; roles: string[]; image: string | null; left: number }) {
  return (
    <div className="absolute w-[236px] text-center" style={{ left, top: 548 }}>
      <div className="relative mx-auto h-[52px] w-[190px]">
        {image && (
          // Approved, self-hosted signature image (configured in src/config/certificate.ts).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={name ? `Signature of ${name}` : "Signature"} className="absolute inset-x-0 bottom-0 mx-auto max-h-[52px] w-auto object-contain" />
        )}
      </div>
      <div className="mx-auto h-px w-[190px]" style={{ backgroundColor: INK_GREEN, opacity: 0.55 }} aria-hidden />
      <p className={`${serif.className} mt-2 whitespace-nowrap text-[15px] font-semibold`} style={{ color: INK_GREEN }}>
        {name ?? " "}
      </p>
      {roles.map((role) => (
        <p key={role} className="mt-0.5 whitespace-nowrap text-[11px]" style={{ color: CHARCOAL }}>
          {role}
        </p>
      ))}
    </div>
  );
}

export interface CertificateDocumentProps {
  certificate: CertificateSnapshot;
  /** Public verification URL: <app origin>/verify/<number>?code=<code>. Encoded in the QR. */
  verificationUrl: string;
  backHref: string;
  backLabel: string;
}

/**
 * The certificate, rendered only from the stored snapshot (never from
 * live records), laid out after the approved ARSÈNE reference design:
 * forest-green frame with diagonal gold corner bands, ivory body with a
 * faint ARSÈNE watermark, and a dark-green verification panel with a
 * gold medal and a real QR code (the public verification URL). A
 * revoked certificate is clearly marked and never looks valid.
 */
export function CertificateDocument({ certificate: c, verificationUrl, backHref, backLabel }: CertificateDocumentProps) {
  const revoked = c.status === "revoked";
  const authority = c.signatories[0] ?? null;
  const bodyW = PAGE_W - FRAME * 2 - PANEL_W;

  return (
    <div>
      <style>{PRINT_CSS}</style>

      <div className="certificate-screen-only mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={backHref} className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
        </Link>
        <Button onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> {revoked ? "Print record" : "Print / Save as PDF"}
        </Button>
      </div>

      {revoked && (
        <div className="certificate-screen-only mb-4 flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-4 py-3 text-sm text-signal-red">
          <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            This certificate was revoked{c.revokedAt ? ` on ${formatDate(c.revokedAt)}` : ""} and is <strong>not valid</strong>. It is
            shown for your records only.
          </span>
        </div>
      )}

      <div className="certificate-scroll overflow-x-auto pb-3">
        <div
          id="certificate-print"
          className="relative mx-auto overflow-hidden shadow-overlay"
          style={{ width: PAGE_W, height: PAGE_H, backgroundColor: FOREST }}
        >
          {/* ======================= Certificate body ======================= */}
          <div
            className="absolute overflow-hidden"
            style={{ left: FRAME, top: FRAME, width: bodyW, height: PAGE_H - FRAME * 2, backgroundColor: IVORY, border: `1.5px solid ${GOLD}` }}
          >
            <div className="absolute" style={{ inset: 7, border: `1px solid ${GOLD_LIGHT}` }} aria-hidden />

            {/* Faint ARSÈNE watermark (real mark, very low opacity) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={certificateConfig.icon.src}
              alt=""
              aria-hidden
              className="pointer-events-none absolute select-none"
              style={{ left: 520, top: 190, width: 360, opacity: 0.05, filter: "grayscale(1)" }}
            />

            {revoked && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center" aria-hidden>
                <span
                  className="-rotate-[16deg] select-none px-10 py-2 text-[84px] font-black uppercase tracking-[0.2em]"
                  style={{ color: "rgba(178,59,51,0.55)", border: "7px solid rgba(178,59,51,0.6)" }}
                >
                  Revoked
                </span>
              </div>
            )}

            {/* Header */}
            <div className="absolute" style={{ left: 92, top: 38, height: 88, width: 314 }}>
              <Image
                src={certificateConfig.logo.src}
                alt={siteConfig.logo.full.alt}
                width={certificateConfig.logo.width}
                height={certificateConfig.logo.height}
                priority
                unoptimized
                className="h-full w-auto object-contain object-left"
              />
            </div>
            <div className="absolute text-right" style={{ right: 46, top: 62 }}>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.2em]" style={{ color: CHARCOAL }}>
                Certificate No.
              </p>
              <p className="mt-1 text-[14px] font-semibold tracking-[0.04em]" style={{ color: INK_GREEN }}>
                {c.certificateNumber}
              </p>
            </div>

            {/* Title */}
            <div className="absolute inset-x-0 text-center" style={{ top: 150 }}>
              <h1 className={`${serif.className} text-[46px] font-semibold leading-none tracking-[0.015em]`} style={{ color: INK_GREEN }}>
                CERTIFICATE <span className="text-[28px] tracking-[0.04em]">OF</span> COMPLETION
              </h1>
            </div>
            <div className="absolute inset-x-0 flex items-center justify-center gap-6" style={{ top: 226 }}>
              <GoldRule width={140} />
              <p className="whitespace-nowrap text-[14px] font-semibold uppercase tracking-[0.34em]" style={{ color: INK_GREEN }}>
                This certifies that
              </p>
              <GoldRule width={140} />
            </div>

            {/* Name */}
            <p
              className={`${serif.className} absolute inset-x-0 whitespace-nowrap text-center text-[50px] font-semibold leading-none`}
              style={{ top: 272, color: INK_GREEN }}
            >
              {c.studentName}
            </p>

            {/* Statement */}
            <p
              className={`${serif.className} absolute left-1/2 w-[600px] -translate-x-1/2 text-center text-[16.5px] leading-[1.6]`}
              style={{ top: 346, color: CHARCOAL }}
            >
              has successfully completed the {c.courseTitle} programme and fulfilled all the requirements for course completion.
            </p>

            {/* Details */}
            <div
              className="absolute grid items-start"
              style={{ left: 76, right: 56, top: 426, gridTemplateColumns: "minmax(0,1.9fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1.3fr)" }}
            >
              <DetailColumn first wrap label="Course" value={c.courseTitle} />
              <DetailColumn label="Batch" value={c.batchCode || c.batchName} />
              <DetailColumn label="Completion Date" value={c.completionDate ? formatDate(c.completionDate) : "—"} />
              <DetailColumn label="Certificate No." value={c.certificateNumber} />
            </div>

            {/* Recognition */}
            <div className="absolute flex items-center gap-5" style={{ left: 76, right: 56, top: 510 }}>
              <span aria-hidden className="h-px flex-1" style={{ backgroundColor: GOLD }} />
              <p className="whitespace-nowrap text-[12.5px] font-bold uppercase tracking-[0.24em]" style={{ color: INK_GREEN }}>
                In recognition of your dedication and achievement
              </p>
              <span aria-hidden className="h-px flex-1" style={{ backgroundColor: GOLD }} />
            </div>

            {/* Signatures + centre seal */}
            <Signature
              left={82}
              name={c.trainerName}
              roles={["Trainer", siteConfig.companyName]}
              image={c.trainerName ? localSignature(certificateConfig.signatures.trainers[c.trainerName]) : null}
            />
            <div className="absolute" style={{ left: bodyW / 2 - 60, top: 546 }}>
              <CertificateSeal size={120} />
            </div>
            <Signature
              left={bodyW - 82 - 236}
              name={authority?.name ?? c.issuerName}
              roles={authority?.title ? [authority.title, siteConfig.companyName] : ["Programme Manager / Issuing Authority"]}
              image={localSignature(certificateConfig.signatures.issuingAuthority)}
            />

            {/* Footer */}
            <p className="absolute whitespace-nowrap text-[11px] tracking-[0.06em]" style={{ left: 50, bottom: 24, color: INK_GREEN }}>
              <span className="uppercase">{siteConfig.companyName}</span>
              <span className="mx-2" style={{ color: GOLD }}>
                |
              </span>
              <span className="italic">{siteConfig.tagline}</span>
            </p>
            <p className="absolute whitespace-nowrap text-[10px] tracking-[0.08em]" style={{ right: 50, bottom: 24, color: CHARCOAL }}>
              Issued {c.issuedAt ? formatDate(c.issuedAt) : "—"}
            </p>
          </div>

          {/* ======================= Verification panel ======================= */}
          <div
            className="absolute flex flex-col items-center text-center"
            style={{ left: FRAME + bodyW, top: FRAME, width: PANEL_W, height: PAGE_H - FRAME * 2, backgroundColor: FOREST, border: `1.5px solid ${GOLD}` }}
          >
            <div className="absolute" style={{ inset: 7, border: `1px solid ${GOLD}`, opacity: 0.7 }} aria-hidden />

            <div className="mt-[64px]">
              <CertificateMedal width={164} />
            </div>

            <div className="mt-[34px]">
              <GoldRule width={112} />
            </div>
            <p className="mt-4 text-[11px] font-medium uppercase leading-[2.1] tracking-[0.2em]" style={{ color: GOLD_LIGHT }}>
              Skilled professionals
              <br />
              build a stronger
              <br />
              tomorrow
            </p>
            <div className="mt-4">
              <GoldRule width={112} />
            </div>

            <div className="mt-[58px] bg-white p-[7px]">
              <CertificateQrCode value={verificationUrl} size={104} />
            </div>
            <p className="mt-4 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white">Verify this certificate</p>
            <p className="mt-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-white">{c.certificateNumber}</p>
            {revoked && (
              <p className="mt-2.5 rounded-sm px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.2em] text-white" style={{ backgroundColor: "#B23B33" }}>
                Revoked — not valid
              </p>
            )}
            <p className="mt-2 font-mono text-[9px]" style={{ color: "rgba(255,255,255,0.62)" }}>
              Code {c.verificationCode}
            </p>
          </div>

          {/* Diagonal gold corner bands (over frame, body and panel corners) */}
          <CornerBands corner="tl" />
          <CornerBands corner="br" />
        </div>
      </div>
    </div>
  );
}
