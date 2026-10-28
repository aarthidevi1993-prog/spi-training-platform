/**
 * Browser activity signals for an in-progress test attempt (0015
 * record_attempt_client_event). Shared by the browser (what it may send)
 * and the server (what it passes on). These are review signals only —
 * never proof of malpractice and never a penalty. The database checks
 * the student, the attempt, the kind and the size; this module only
 * keeps details small and free of question, answer or clipboard content.
 *
 * client_fullscreen_exit is allowed by the database but not reported:
 * the test page has no full-screen mode.
 */

export const REPORTED_CLIENT_EVENTS = [
  "client_hidden",
  "client_offline",
  "client_online",
  "client_copy",
  "client_paste",
  "client_print",
  "client_multiple_tabs",
] as const;

export type ClientEventKind = (typeof REPORTED_CLIENT_EVENTS)[number];

/** The only details that are ever sent (numbers/flags, no content, no timestamps). */
export interface ClientEventDetail {
  /** client_hidden: the page was hidden, or became visible again. */
  phase?: "hidden" | "visible";
  /** client_hidden (phase "visible"): roughly how long the page was hidden. */
  hiddenSeconds?: number;
  /** client_copy: the copy was a cut. */
  cut?: boolean;
  /** client_multiple_tabs: other open tabs of this attempt seen by this tab. */
  otherTabs?: number;
}

export interface ClientEvent {
  kind: ClientEventKind;
  detail?: ClientEventDetail;
}

/** Events per server call (one database call each). */
export const MAX_EVENTS_PER_REPORT = 10;

const KINDS = new Set<string>(REPORTED_CLIENT_EVENTS);

export function isReportedClientEventKind(value: unknown): value is ClientEventKind {
  return typeof value === "string" && KINDS.has(value);
}

const MAX_HIDDEN_SECONDS = 24 * 60 * 60;

function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Keep only the known, non-sensitive fields for this kind; drop everything else. */
export function sanitizeClientEventDetail(kind: ClientEventKind, detail: unknown): ClientEventDetail {
  const d = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const out: ClientEventDetail = {};
  if (kind === "client_hidden") {
    if (d.phase === "hidden" || d.phase === "visible") out.phase = d.phase;
    const seconds = out.phase === "visible" ? wholeNumber(d.hiddenSeconds, 0, MAX_HIDDEN_SECONDS) : null;
    if (seconds !== null) out.hiddenSeconds = seconds;
  } else if (kind === "client_copy") {
    if (d.cut === true) out.cut = true;
  } else if (kind === "client_multiple_tabs") {
    const tabs = wholeNumber(d.otherTabs, 1, 10);
    if (tabs !== null) out.otherTabs = tabs;
  }
  return out;
}
