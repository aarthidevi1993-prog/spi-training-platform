import "server-only";
import { headers } from "next/headers";

/**
 * The origin of the current request (e.g. "https://training.example.com"),
 * from the host headers. Empty when the host is unknown.
 */
export function requestOrigin(): string {
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "";
  const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto.split(",")[0]?.trim() || "https"}://${host}`;
}

/**
 * The public base URL printed on certificates and encoded in their QR
 * code: the configured NEXT_PUBLIC_APP_URL (production), otherwise the
 * current request's origin (local development). Never hard-coded.
 */
export function publicAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Invalid value — fall back to the request origin.
    }
  }
  return requestOrigin();
}
