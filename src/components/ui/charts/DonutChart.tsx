export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  centerValue: string;
  centerLabel: string;
  size?: number;
}

/** Dependency-free donut chart built from stroked SVG circle arcs. */
export function DonutChart({ segments, centerValue, centerLabel, size = 140 }: DonutChartProps) {
  const strokeWidth = 16;
  const radius = size / 2 - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;

  let offsetSoFar = 0;
  const arcs = segments.map((segment) => {
    const fraction = segment.value / total;
    const dash = fraction * circumference;
    const arc = { ...segment, dash, offset: offsetSoFar };
    offsetSoFar += dash;
    return arc;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Donut chart">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#EBEEF0" strokeWidth={strokeWidth} />
          {arcs.map((arc) => (
            <circle
              key={arc.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
              strokeDashoffset={-arc.offset}
              strokeLinecap="butt"
            />
          ))}
        </g>
        <text x="50%" y="47%" textAnchor="middle" fontSize="20" fontWeight="600" fill="#141C22">
          {centerValue}
        </text>
        <text x="50%" y="62%" textAnchor="middle" fontSize="9" fill="#8896A1">
          {centerLabel}
        </text>
      </svg>

      <ul className="flex flex-col gap-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-ink-muted">{s.label}</span>
            <span className="ml-auto font-medium text-ink">{s.value}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
