import type { TrendPoint } from "@/lib/dashboard/analytics";
import { formatPercent } from "@/lib/dashboard/analytics";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";

/**
 * Multi-series performance trend (D2b-2A): a lightweight server-rendered
 * SVG — no chart package, no client JavaScript. Values are percentages
 * (0–100) per India-time bucket; a bucket without data is a gap, never an
 * interpolated or zero point. Series are told apart by line pattern as well
 * as colour, and the same figures are always available as a table.
 */

const SERIES = [
  { key: "testAvg", label: "Test average", stroke: "stroke-primary-500", fill: "fill-primary-500", dash: "" },
  { key: "passRate", label: "Pass rate", stroke: "stroke-signal-blue", fill: "fill-signal-blue", dash: "6 4" },
  { key: "attendancePct", label: "Attendance", stroke: "stroke-signal-teal", fill: "fill-signal-teal", dash: "2 3" },
  { key: "assignmentAvg", label: "Assignment average", stroke: "stroke-signal-amber", fill: "fill-signal-amber", dash: "9 3 2 3" },
] as const;

const W = 640;
const H = 220;
const PAD = { left: 36, right: 12, top: 10, bottom: 30 };

function x(i: number, n: number): number {
  const inner = W - PAD.left - PAD.right;
  return n <= 1 ? PAD.left + inner / 2 : PAD.left + (i * inner) / (n - 1);
}
function y(v: number): number {
  return PAD.top + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - PAD.top - PAD.bottom);
}

/** Path segments of consecutive non-null points (a null bucket breaks the line). */
function segments(values: (number | null)[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) out.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? "M" : "L"}${x(i, values.length).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (current.length > 1) out.push(current.join(" "));
  return out;
}

export function TrendChart({ points, captionId }: { points: TrendPoint[]; captionId: string }) {
  const n = points.length;
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-muted" aria-hidden="true">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="22" height="8" viewBox="0 0 22 8">
              <line x1="1" y1="4" x2="21" y2="4" className={s.stroke} strokeWidth="2" strokeDasharray={s.dash || undefined} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" preserveAspectRatio="none" aria-hidden="true">
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)} className="stroke-surface-border" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(g) + 3} textAnchor="end" className="fill-ink-faint text-[10px]">
              {g}%
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.from} x={x(i, n)} y={H - 10} textAnchor="middle" className="fill-ink-faint text-[10px]">
            {p.label}
          </text>
        ))}
        {SERIES.map((s) => {
          const values = points.map((p) => p[s.key]);
          return (
            <g key={s.key}>
              {segments(values).map((d) => (
                <path key={d} d={d} fill="none" className={s.stroke} strokeWidth="2" strokeDasharray={s.dash || undefined} />
              ))}
              {values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i, n)} cy={y(v)} r="3" className={s.fill} />))}
            </g>
          );
        })}
      </svg>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-signal-blue">View the trend as a table</summary>
        <div className="mt-2">
          <Table aria-describedby={captionId}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell className="text-right">Test average</TableHeaderCell>
                <TableHeaderCell className="text-right">Pass rate</TableHeaderCell>
                <TableHeaderCell className="text-right">Results</TableHeaderCell>
                <TableHeaderCell className="text-right">Attendance</TableHeaderCell>
                <TableHeaderCell className="text-right">Records</TableHeaderCell>
                <TableHeaderCell className="text-right">Assignment average</TableHeaderCell>
                <TableHeaderCell className="text-right">Scored</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {points.map((p) => (
                <TableRow key={p.from}>
                  <TableCell className="whitespace-nowrap">{p.label}</TableCell>
                  <TableCell className="text-right font-mono">{formatPercent(p.testAvg)}</TableCell>
                  <TableCell className="text-right font-mono">{formatPercent(p.passRate)}</TableCell>
                  <TableCell className="text-right font-mono text-ink-muted">{p.results}</TableCell>
                  <TableCell className="text-right font-mono">{formatPercent(p.attendancePct)}</TableCell>
                  <TableCell className="text-right font-mono text-ink-muted">{p.attendanceMarked}</TableCell>
                  <TableCell className="text-right font-mono">{formatPercent(p.assignmentAvg)}</TableCell>
                  <TableCell className="text-right font-mono text-ink-muted">{p.assignmentsScored}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}
