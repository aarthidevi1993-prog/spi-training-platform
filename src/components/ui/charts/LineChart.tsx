export interface LineChartPoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  data: LineChartPoint[];
  color?: string;
  max?: number;
  height?: number;
}

/**
 * Minimal, dependency-free line chart. Hand-rolled SVG rather than a
 * charting library, per the "no unnecessary dependencies" constraint
 * on this UI pass — swap for a real library later if the dashboard
 * needs richer interactions (tooltips, zoom, etc).
 */
export function LineChart({ data, color = "#0E6B3E", max, height = 160 }: LineChartProps) {
  const width = 320;
  const padding = 8;
  const resolvedMax = max ?? Math.max(...data.map((d) => d.value), 1);
  const stepX = (width - padding * 2) / Math.max(1, data.length - 1);

  const points = data.map((d, i) => {
    const x = padding + i * stepX;
    const y = padding + (1 - d.value / resolvedMax) * (height - padding * 2);
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1]?.x ?? 0},${height - padding} L${points[0]?.x ?? 0},${height - padding} Z`;
  const gradientId = "line-chart-fill";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Line chart">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1={padding}
          x2={width - padding}
          y1={padding + t * (height - padding * 2)}
          y2={padding + t * (height - padding * 2)}
          stroke="#DFE4E8"
          strokeWidth={1}
        />
      ))}
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p) => (
        <circle key={p.label} cx={p.x} cy={p.y} r={3} fill="white" stroke={color} strokeWidth={2} />
      ))}
    </svg>
  );
}
