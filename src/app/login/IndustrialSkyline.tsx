/**
 * Decorative process-plant silhouette for the login hero panel —
 * hand-drawn SVG shapes (storage tanks, a distillation column, pipe
 * runs) rather than a stock photo, so there's no external asset
 * dependency or licensing to track. Purely decorative (aria-hidden).
 */
export function IndustrialSkyline() {
  return (
    <svg
      viewBox="0 0 600 200"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full opacity-90"
      aria-hidden
    >
      <defs>
        <linearGradient id="skyline-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#12301F" stopOpacity="0" />
          <stop offset="100%" stopColor="#12301F" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id="gold-stripe" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#F2B705" stopOpacity="0" />
          <stop offset="55%" stopColor="#F2B705" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#FDE7A8" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* pipe runs */}
      <line x1="0" y1="150" x2="600" y2="150" stroke="#204531" strokeWidth="3" />
      <line x1="40" y1="130" x2="220" y2="130" stroke="#204531" strokeWidth="2" />

      {/* storage tanks */}
      <rect x="30" y="110" width="60" height="70" rx="4" fill="#204531" />
      <ellipse cx="60" cy="110" rx="30" ry="8" fill="#2A5A3D" />

      <rect x="110" y="130" width="44" height="50" rx="4" fill="#1A3A28" />
      <ellipse cx="132" cy="130" rx="22" ry="6" fill="#204531" />

      {/* distillation column */}
      <rect x="230" y="60" width="26" height="120" rx="3" fill="#204531" />
      <rect x="222" y="76" width="42" height="6" fill="#2A5A3D" />
      <rect x="222" y="104" width="42" height="6" fill="#2A5A3D" />
      <rect x="222" y="132" width="42" height="6" fill="#2A5A3D" />
      <circle cx="243" cy="52" r="9" fill="#2A5A3D" />

      {/* secondary tanks */}
      <rect x="320" y="120" width="70" height="60" rx="4" fill="#1A3A28" />
      <ellipse cx="355" cy="120" rx="35" ry="8" fill="#204531" />

      <rect x="410" y="140" width="46" height="40" rx="4" fill="#204531" />
      <ellipse cx="433" cy="140" rx="23" ry="6" fill="#2A5A3D" />

      {/* small flare stack */}
      <line x1="500" y1="70" x2="500" y2="180" stroke="#204531" strokeWidth="4" />
      <circle cx="500" cy="62" r="6" fill="#F2B705" opacity="0.7" />

      <rect x="540" y="125" width="50" height="55" rx="4" fill="#1A3A28" />

      <rect x="0" y="0" width="600" height="200" fill="url(#skyline-fade)" />

      {/* gold accent stripe along the base */}
      <rect x="0" y="188" width="600" height="12" fill="url(#gold-stripe)" transform="skewX(-20)" />
    </svg>
  );
}
