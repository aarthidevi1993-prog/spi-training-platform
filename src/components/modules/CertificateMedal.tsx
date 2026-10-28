import { siteConfig } from "@/config/site";
import { certificateConfig } from "@/config/certificate";

const GREEN = "#0B3B24";

/** Points of a scalloped (starburst) medal rim. */
function starburst(cx: number, cy: number, outer: number, inner: number, points: number): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    out.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return out.join(" ");
}

/** Laurel leaves along an arc (degrees, SVG orientation), each leaf tangent to the arc. */
function laurel(cx: number, cy: number, r: number, from: number, to: number, count: number) {
  const leaves: { x: number; y: number; rot: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const deg = from + ((to - from) * i) / (count - 1);
    const rad = (deg * Math.PI) / 180;
    leaves.push({ x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad), rot: deg + (to > from ? 90 : -90) + 25 });
  }
  return leaves;
}

/**
 * Decorative gold medal for the verification panel: a scalloped gold
 * medallion with laurel branches and two ribbon tails, carrying the
 * real ARSÈNE mark (transparent derivative of the official asset) and
 * the company name. Pure SVG.
 */
export function CertificateMedal({ width = 168 }: { width?: number }) {
  const icon = certificateConfig.icon;
  const c = 100;
  const left = laurel(c, c, 64, 118, 238, 9);
  const right = laurel(c, c, 64, 62, -58, 9);
  return (
    <svg width={width} height={(width * 250) / 200} viewBox="0 0 200 250" role="img" aria-label={`${siteConfig.companyName} medal`}>
      <defs>
        <linearGradient id="medal-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F4DE93" />
          <stop offset="45%" stopColor="#D6AE45" />
          <stop offset="100%" stopColor="#A77E1F" />
        </linearGradient>
        <radialGradient id="medal-face" cx="0.4" cy="0.35" r="0.75">
          <stop offset="0%" stopColor="#F8E7AE" />
          <stop offset="60%" stopColor="#E0BC5C" />
          <stop offset="100%" stopColor="#B88C2A" />
        </radialGradient>
        <linearGradient id="medal-ribbon" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D9B350" />
          <stop offset="100%" stopColor="#A77E1F" />
        </linearGradient>
      </defs>

      {/* Ribbon tails (behind the medal) */}
      <polygon points="70,150 100,168 82,246 67,228 50,236" fill="url(#medal-ribbon)" />
      <polygon points="130,150 100,168 118,246 133,228 150,236" fill="url(#medal-ribbon)" />

      {/* Medal */}
      <polygon points={starburst(c, c, 97, 90, 60)} fill="url(#medal-gold)" />
      <circle cx={c} cy={c} r={84} fill="url(#medal-face)" />
      <circle cx={c} cy={c} r={80} fill="none" stroke="#9C7519" strokeWidth={1.2} strokeOpacity={0.7} />

      {/* Laurel branches */}
      {[...left, ...right].map((l, i) => (
        <ellipse key={i} cx={l.x} cy={l.y} rx={3.4} ry={8.5} transform={`rotate(${l.rot} ${l.x} ${l.y})`} fill="#8C6A12" fillOpacity={0.75} />
      ))}

      {/* Real ARSÈNE mark + name */}
      <circle cx={c} cy={84} r={27} fill="#FFFFFF" fillOpacity={0.35} />
      <image href={icon.src} x={c - 26} y={58} width={52} height={50} preserveAspectRatio="xMidYMid meet" />
      <text x={c} y={128} textAnchor="middle" fill={GREEN} fontSize={19} fontWeight={800} letterSpacing={1} fontFamily="Inter, Arial, sans-serif">
        {siteConfig.companyShortName.toUpperCase()}
      </text>
      <text x={c} y={141} textAnchor="middle" fill={GREEN} fontSize={6.8} fontWeight={600} letterSpacing={1.4} fontFamily="Inter, Arial, sans-serif">
        TECHNOLOGY SERVICES
      </text>
    </svg>
  );
}
