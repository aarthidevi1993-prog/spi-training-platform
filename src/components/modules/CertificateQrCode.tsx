"use client";

import { QRCodeSVG } from "qrcode.react";

export interface CertificateQrCodeProps {
  /**
   * The public verification URL only: <app origin>/verify/<number>?code=<code>.
   * Never pass anything else (no ids, names or scores).
   */
  value: string;
  size?: number;
}

/**
 * QR code for a certificate's public verification URL. Rendered locally
 * as SVG (sharp in print and PDF; no external QR service is called).
 */
export function CertificateQrCode({ value, size = 150 }: CertificateQrCodeProps) {
  return (
    <QRCodeSVG
      value={value}
      size={size}
      level="Q"
      marginSize={0}
      bgColor="#FFFFFF"
      fgColor="#0B2018"
      title="Scan to verify this certificate"
    />
  );
}
