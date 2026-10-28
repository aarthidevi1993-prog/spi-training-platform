/**
 * Dashboard reporting periods (D2a) — pure India-time (Asia/Kolkata)
 * calendar arithmetic. A "date" here is always an India calendar date
 * written YYYY-MM-DD; the arithmetic is done on the date itself (never on
 * a UTC midnight), and instants are derived from India midnight (+05:30,
 * India has no daylight saving).
 *
 * Comparison rule (product decision Q1): a period is compared with the
 * SAME NUMBER of India calendar days immediately before it — never a
 * partial month against a whole month.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function parts(date: string): [number, number, number] {
  if (!isCalendarDate(date)) throw new RangeError(`Not a calendar date: ${String(date)}`);
  const m = DATE.exec(date)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function format(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** The calendar date `n` days after (negative: before) `date`. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return format(y, m, d + n);
}

/** Number of calendar days from `from` to `to`, both included (0 when `to` is before `from`). */
export function daysInclusive(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
  return Math.max(0, days);
}

/** First day of the month `offset` months from `date`'s month. */
export function monthStart(date: string, offset = 0): string {
  const [y, m] = parts(date);
  return format(y, m + offset, 1);
}

/** Last day of `date`'s month. */
export function monthEnd(date: string): string {
  const [y, m] = parts(date);
  return format(y, m + 1, 0);
}

/** The instant India midnight begins on this date (ISO, UTC). */
export function indiaDayStart(date: string): string {
  parts(date);
  return new Date(`${date}T00:00:00+05:30`).toISOString();
}

export const PERIOD_KEYS = ["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  this_month: "This month",
  previous_month: "Previous month",
  last_3_months: "Last 3 months",
  last_6_months: "Last 6 months",
  last_12_months: "Last 12 months",
};

export function isPeriodKey(value: unknown): value is PeriodKey {
  return typeof value === "string" && (PERIOD_KEYS as readonly string[]).includes(value);
}

export interface DateRange {
  /** First India calendar date, included. */
  from: string;
  /** Last India calendar date, included. */
  to: string;
}

/**
 * The period ending on (or, for the previous month, before) the India date `today`:
 *   this_month      1st of this month → today
 *   previous_month  the whole previous calendar month
 *   last_3_months   1st of the month two months back → today (this month + the 2 before)
 *   last_6_months   1st of the month five months back → today
 *   last_12_months  1st of the month eleven months back → today (at most 366 days:
 *                   dashboard_analytics accepts up to 366 since 0026)
 */
export function periodRange(key: PeriodKey, today: string): DateRange {
  switch (key) {
    case "this_month":
      return { from: monthStart(today), to: today };
    case "previous_month": {
      const from = monthStart(today, -1);
      return { from, to: monthEnd(from) };
    }
    case "last_3_months":
      return { from: monthStart(today, -2), to: today };
    case "last_6_months":
      return { from: monthStart(today, -5), to: today };
    case "last_12_months":
      return { from: monthStart(today, -11), to: today };
  }
}

/** The same number of India calendar days immediately before `range`. */
export function previousComparable(range: DateRange): DateRange {
  const days = daysInclusive(range.from, range.to);
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(Math.max(days, 1) - 1)), to };
}

export interface Comparison {
  current: number;
  previous: number;
  /** current − previous. */
  difference: number;
  /** Percentage change, one decimal; null when there is nothing to compare against (previous is 0). */
  percent: number | null;
  direction: "up" | "down" | "same";
  /** What `previous` is, e.g. "vs same day last week". */
  label: string;
}

/** A real comparison of two counts; never invents a percentage from a zero baseline. */
export function compare(current: number, previous: number, label: string): Comparison {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous < 0) {
    throw new RangeError("Comparisons need two non-negative counts.");
  }
  const difference = current - previous;
  return {
    current,
    previous,
    difference,
    percent: previous > 0 ? Math.round((difference / previous) * 1000) / 10 : null,
    direction: difference > 0 ? "up" : difference < 0 ? "down" : "same",
    label,
  };
}
