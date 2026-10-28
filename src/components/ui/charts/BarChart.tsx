export interface GroupedBarDatum {
  label: string;
  present: number;
  absent: number;
}

export interface BarChartProps {
  data: GroupedBarDatum[];
  presentColor?: string;
  absentColor?: string;
  height?: number;
}

/** Dependency-free grouped bar chart (present vs absent per category). */
export function BarChart({ data, presentColor = "#0E6B3E", absentColor = "#F2B705", height = 160 }: BarChartProps) {
  const width = 320;
  const padding = 8;
  const groupWidth = (width - padding * 2) / data.length;
  const barWidth = Math.min(14, groupWidth / 3);
  const max = 100;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Bar chart">
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1={padding}
          x2={width - padding}
          y1={padding + t * (height - padding * 2 - 14)}
          y2={padding + t * (height - padding * 2 - 14)}
          stroke="#DFE4E8"
          strokeWidth={1}
        />
      ))}
      {data.map((d, i) => {
        const groupX = padding + i * groupWidth + groupWidth / 2;
        const chartH = height - padding * 2 - 14;
        const presentH = (d.present / max) * chartH;
        const absentH = (d.absent / max) * chartH;
        const baseY = padding + chartH;
        return (
          <g key={d.label}>
            <rect
              x={groupX - barWidth - 2}
              y={baseY - presentH}
              width={barWidth}
              height={presentH}
              rx={2}
              fill={presentColor}
            />
            <rect x={groupX + 2} y={baseY - absentH} width={barWidth} height={absentH} rx={2} fill={absentColor} />
            <text x={groupX} y={height - 2} textAnchor="middle" fontSize="9" fill="#8896A1">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
