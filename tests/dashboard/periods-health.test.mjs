// Dashboard D2a — India-time periods and comparisons, health rules (Q2), and the exact rebuild of
// "recommendations pending 7 days ago" from completion status events. Pure functions only.
import { test } from "node:test";
import assert from "node:assert/strict";

const build = process.env.DASHBOARD_BUILD;
const p = await import(`${build}/lib/dashboard/periods.mjs`);
const lib = await import(`${build}/lib/dashboard/admin-dashboard.mjs`);

test("calendar arithmetic on India dates: month, year and leap-day boundaries; invalid dates refused", () => {
  assert.equal(p.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(p.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(p.addDays("2028-02-28", 1), "2028-02-29", "leap year");
  assert.equal(p.addDays("2026-10-06", -7), "2026-09-29", "same weekday last week");
  assert.equal(p.daysInclusive("2026-10-01", "2026-10-06"), 6);
  assert.equal(p.daysInclusive("2026-10-06", "2026-10-01"), 0);
  assert.equal(p.monthStart("2026-01-15", -2), "2025-11-01");
  assert.equal(p.monthEnd("2028-02-10"), "2028-02-29");
  assert.equal(p.isCalendarDate("2026-02-30"), false);
  assert.equal(p.isCalendarDate("2026-2-3"), false);
  assert.throws(() => p.addDays("2026-02-30", 1), RangeError);
});

test("India midnight, not UTC midnight: the day starts at 18:30 UTC the evening before", () => {
  assert.equal(p.indiaDayStart("2026-10-06"), "2026-10-05T18:30:00.000Z");
  assert.equal(lib.indiaDate(new Date("2026-09-30T18:29:59Z")), "2026-09-30");
  assert.equal(lib.indiaDate(new Date("2026-09-30T18:30:00Z")), "2026-10-01", "a new India month while UTC is still in September");
  const firstOfMonth = p.periodRange("this_month", lib.indiaDate(new Date("2026-09-30T18:30:00Z")));
  assert.deepEqual(firstOfMonth, { from: "2026-10-01", to: "2026-10-01" });
  assert.deepEqual(p.previousComparable(firstOfMonth), { from: "2026-09-30", to: "2026-09-30" }, "one day compared with one day");
});

test("periods and their comparison period: the same number of India days immediately before (Q1)", () => {
  const today = "2026-10-06";
  const thisMonth = p.periodRange("this_month", today);
  assert.deepEqual(thisMonth, { from: "2026-10-01", to: "2026-10-06" });
  assert.deepEqual(p.previousComparable(thisMonth), { from: "2026-09-25", to: "2026-09-30" }, "6 days vs 6 days — not the whole of September");
  const prevMonth = p.periodRange("previous_month", today);
  assert.deepEqual(prevMonth, { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(p.previousComparable(prevMonth), { from: "2026-08-02", to: "2026-08-31" }, "30 days vs 30 days");
  assert.deepEqual(p.periodRange("last_3_months", today), { from: "2026-08-01", to: "2026-10-06" });
  assert.deepEqual(p.periodRange("last_6_months", today), { from: "2026-05-01", to: "2026-10-06" });
  assert.deepEqual(p.periodRange("previous_month", "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" }, "year rollover");
  for (const key of p.PERIOD_KEYS) {
    const r = p.periodRange(key, today);
    const prev = p.previousComparable(r);
    assert.equal(p.daysInclusive(prev.from, prev.to), p.daysInclusive(r.from, r.to), key);
    assert.equal(p.addDays(prev.to, 1), r.from, `${key}: adjacent, no gap or overlap`);
  }
  assert.equal(p.isPeriodKey("this_month"), true);
  assert.equal(p.isPeriodKey("all_time"), false);
});

test("last 12 months: 1st of the month eleven months back → today; never more than 366 days (dashboard_analytics cap since 0026)", () => {
  assert.deepEqual(p.PERIOD_KEYS, ["this_month", "previous_month", "last_3_months", "last_6_months", "last_12_months"], "the four existing periods unchanged, the new one last");
  assert.equal(p.PERIOD_LABEL.last_12_months, "Last 12 months");
  assert.equal(p.isPeriodKey("last_12_months"), true);
  assert.equal(p.isPeriodKey("last_12_month"), false);
  const r = p.periodRange("last_12_months", "2026-10-06");
  assert.deepEqual(r, { from: "2025-11-01", to: "2026-10-06" });
  assert.deepEqual(p.previousComparable(r), { from: "2024-11-26", to: "2025-10-31" }, "the same 340 days immediately before");
  assert.deepEqual(p.periodRange("last_12_months", "2024-12-31"), { from: "2024-01-01", to: "2024-12-31" }, "a whole leap year: 366 days");
  assert.equal(p.daysInclusive("2024-01-01", "2024-12-31"), 366);
  assert.deepEqual(p.periodRange("last_12_months", "2028-02-29"), { from: "2027-03-01", to: "2028-02-29" }, "ending on a leap day: 366 days");
  assert.deepEqual(p.periodRange("last_12_months", "2026-01-15"), { from: "2025-02-01", to: "2026-01-15" }, "year rollover");
  // Every India date from 2023 to 2030: within the cap, ends today, starts on a 1st, and the comparison is adjacent.
  let min = Infinity;
  let max = 0;
  for (let d = "2023-01-01"; d <= "2030-12-31"; d = p.addDays(d, 1)) {
    const x = p.periodRange("last_12_months", d);
    const days = p.daysInclusive(x.from, x.to);
    min = Math.min(min, days);
    max = Math.max(max, days);
    assert.ok(days <= 366, `${d}: ${days} days`);
    assert.equal(x.to, d);
    assert.ok(x.from.endsWith("-01"), `${d}: starts on the 1st`);
    const prev = p.previousComparable(x);
    assert.equal(p.addDays(prev.to, 1), x.from, `${d}: comparison adjacent`);
    assert.equal(p.daysInclusive(prev.from, prev.to), days);
  }
  assert.deepEqual([min, max], [335, 366], "shortest on the 1st of a month after a short year; 366 only for a full leap year");
});

test("comparisons: difference always; a percentage only against a non-zero previous value; never negative counts", () => {
  assert.deepEqual(p.compare(5, 3, "vs x"), { current: 5, previous: 3, difference: 2, percent: 66.7, direction: "up", label: "vs x" });
  assert.deepEqual(p.compare(2, 4, "vs x"), { current: 2, previous: 4, difference: -2, percent: -50, direction: "down", label: "vs x" });
  assert.deepEqual(p.compare(3, 0, "vs x"), { current: 3, previous: 0, difference: 3, percent: null, direction: "up", label: "vs x" }, "no % from a zero baseline");
  assert.deepEqual(p.compare(0, 0, "vs x"), { current: 0, previous: 0, difference: 0, percent: null, direction: "same", label: "vs x" }, "empty periods");
  assert.equal(p.compare(4, 4, "vs x").percent, 0);
  assert.throws(() => p.compare(-1, 2, "vs x"), RangeError);
  assert.throws(() => p.compare(Number.NaN, 2, "vs x"), RangeError);
});

test("health thresholds (Q2): attendance 85/75; assessment and assignments 80/65; worst line wins only over calculated lines", () => {
  const t = lib.HEALTH_THRESHOLDS;
  assert.deepEqual([85, 84.99, 75, 74.99].map((v) => lib.percentHealth(v, t.attendance)), ["healthy", "watch", "watch", "attention"]);
  assert.deepEqual([80, 79.99, 65, 64.99].map((v) => lib.percentHealth(v, t.assessment)), ["healthy", "watch", "watch", "attention"]);
  assert.deepEqual([80, 79.99, 65, 64.99].map((v) => lib.percentHealth(v, t.assignments)), ["healthy", "watch", "watch", "attention"]);
  assert.throws(() => lib.percentHealth(Number.NaN, t.attendance), RangeError, "no data is not a health status");
  assert.equal(lib.worstHealth([]), null);
  assert.equal(lib.worstHealth(["healthy", "watch", "healthy"]), "watch");
  assert.equal(lib.worstHealth(["watch", "attention"]), "attention");
});

const batch = (id, extra = {}) => ({
  id, status: "ongoing", maxSeats: 10, startDate: "2026-01-01", trainerId: "t", courseId: "c", course: "C",
  trainerStatus: "active", trainerRole: "trainer", trainerAccountStatus: "active", seatsUsed: 3, ...extra,
});

test("trainer coverage (Q2.1): attention for any current batch without a trainer or with an unavailable one; reasons state the facts", () => {
  assert.deepEqual([lib.trainerCoverageHealth([]).status, lib.trainerCoverageHealth([]).reason], ["healthy", "No upcoming or ongoing batches."]);
  const ok = lib.trainerCoverageHealth([batch("1"), batch("2", { status: "upcoming" })]);
  assert.deepEqual([ok.status, ok.reason], ["healthy", "All 2 upcoming and ongoing batches have an available trainer."]);
  const bad = lib.trainerCoverageHealth([
    batch("1"),
    batch("2", { trainerId: null, trainerStatus: undefined, trainerRole: undefined, trainerAccountStatus: undefined }),
    batch("3", { trainerAccountStatus: "suspended" }),
    batch("4", { trainerStatus: "inactive" }),
  ]);
  assert.equal(bad.status, "attention");
  assert.equal(bad.reason, "1 batch without a trainer and 2 with an unavailable trainer (of 4 upcoming and ongoing).");
  assert.equal(bad.href, "/admin/batches");
});

test("batch capacity (Q2.2): watch for a full upcoming batch; attention when one starts within 7 India days (or is past its start); ongoing ignored", () => {
  const today = "2026-10-06";
  assert.equal(lib.batchCapacityHealth([batch("1", { seatsUsed: 10 })], today).status, "healthy", "a full ONGOING batch is not a capacity risk");
  assert.equal(lib.batchCapacityHealth([batch("1", { status: "upcoming", seatsUsed: 9 })], today).status, "healthy");
  const watch = lib.batchCapacityHealth([batch("1", { status: "upcoming", seatsUsed: 10, startDate: "2026-10-14" })], today);
  assert.deepEqual([watch.status, watch.reason], ["watch", "1 upcoming batch is full (starting in more than 7 days)."]);
  const edge = lib.batchCapacityHealth([batch("1", { status: "upcoming", seatsUsed: 10, startDate: "2026-10-13" })], today);
  assert.deepEqual([edge.status, edge.reason], ["attention", "1 full upcoming batch starts within 7 days."], "exactly 7 days → attention");
  assert.equal(lib.batchCapacityHealth([batch("1", { status: "upcoming", seatsUsed: 12, startDate: "2026-10-01" })], today).status, "attention", "past its start, still upcoming");
});

const ev = (id, completionId, previousStatus, status) => ({ id, completionId, previousStatus, status });

test("pending approvals at an earlier instant: rebuilt exactly from the status events after it", () => {
  assert.equal(lib.pendingApprovalsAt(4, []), 4, "nothing changed since → same as now");
  // New recommendation after T: pending now, not at T.
  assert.equal(lib.pendingApprovalsAt(4, [ev(1, "a", null, "recommended")]), 3);
  // Pending at T, approved / rejected / withdrawn since.
  assert.equal(lib.pendingApprovalsAt(4, [ev(1, "a", "recommended", "approved")]), 5);
  assert.equal(lib.pendingApprovalsAt(4, [ev(1, "a", "recommended", "rejected")]), 5);
  assert.equal(lib.pendingApprovalsAt(4, [ev(1, "a", "recommended", "withdrawn")]), 5, "detail.status is the record status (withdrawn)");
  // Rejected at T, re-recommended since (the record is reused): pending now, not at T.
  assert.equal(lib.pendingApprovalsAt(4, [ev(7, "a", "rejected", "recommended")]), 3);
  // Pending at T, withdrawn then re-recommended since: pending at both instants (order by id, any input order).
  assert.equal(lib.pendingApprovalsAt(4, [ev(9, "a", "withdrawn", "recommended"), ev(8, "a", "recommended", "withdrawn")]), 4);
  // A non-status update on an approved record (same status) is not mistaken for a change from pending.
  assert.equal(lib.pendingApprovalsAt(4, [ev(3, "b", "approved", "approved")]), 4);
  assert.throws(() => lib.pendingApprovalsAt(0, [ev(1, "a", null, "recommended")]), RangeError, "inconsistent input is refused, never shown");
});
