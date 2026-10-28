import { siteConfig } from "@/config/site";
import { certificateConfig } from "@/config/certificate";

const GREEN = "#0B3B24";

/**
 * The ARSÈNE centre stamp: a green double-ring seal with the company
 * name around the top, the tagline around the bottom and the real
 * ARSÈNE mark (transparent derivative of the official asset) in the
 * middle. Pure SVG, so it prints crisply.
 */
export function CertificateSeal({ size = 118 }: { size?: number }) {
  const icon = certificateConfig.icon;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={`${siteConfig.companyName} seal`}>
      <defs>
        {/* Top: 220° arc over the top (text reads outward); bottom: 110° arc under the bottom (text upright). */}
        <path id="stamp-top" d="M 34.2,124 A 70,70 0 1,1 165.8,124" />
        <path id="stamp-bottom" d="M 37.7,143.6 A 76,76 0 0,0 162.3,143.6" />
      </defs>
      <circle cx={100} cy={100} r={95} fill="#FFFFFF" fillOpacity={0.6} stroke={GREEN} strokeWidth={3.5} />
      <circle cx={100} cy={100} r={88} fill="none" stroke={GREEN} strokeWidth={1.2} />
      <circle cx={100} cy={100} r={52} fill="none" stroke={GREEN} strokeWidth={2.2} />
      <text fill={GREEN} fontSize={12.5} fontWeight={700} letterSpacing={1.2} fontFamily="Inter, Arial, sans-serif">
        <textPath href="#stamp-top" startOffset="50%" textAnchor="middle">
          {`${siteConfig.companyShortName.toUpperCase()} TECHNOLOGY SERVICES`}
        </textPath>
      </text>
      <text fill={GREEN} fontSize={11.5} fontStyle="italic" letterSpacing={0.6} fontFamily="Georgia, 'Times New Roman', serif">
        <textPath href="#stamp-bottom" startOffset="50%" textAnchor="middle">
          {siteConfig.tagline}
        </textPath>
      </text>
      <circle cx={35.2} cy={133.7} r={2.2} fill={GREEN} />
      <circle cx={164.8} cy={133.7} r={2.2} fill={GREEN} />
      <image href={icon.src} x={66} y={67} width={68} height={66} preserveAspectRatio="xMidYMid meet" />
    </svg>
  );
}
