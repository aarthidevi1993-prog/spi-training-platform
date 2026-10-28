import type { Config } from "tailwindcss";

// Design tokens for the SPI Training Management Platform.
// Palette is anchored to the ARSÈNE Technology Services brand: a deep
// brand-green "instrument panel" for navigation (replacing the earlier
// generic graphite), a cool blueprint-paper surface for working content,
// brand green as the primary interactive accent, and the brand's gold
// used sparingly as a small controlled highlight (active-state dots,
// icon accents) — never as a large fill, so it never overwhelms the UI.
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: {
          DEFAULT: "#0B2018",
          soft: "#12301F",
          border: "#204531",
        },
        surface: {
          DEFAULT: "#F4F6F7",
          raised: "#FFFFFF",
          sunken: "#EBEEF0",
          border: "#DFE4E8",
        },
        ink: {
          DEFAULT: "#141C22",
          muted: "#54636F",
          faint: "#6B7885",
          onPanel: "#E7EDF1",
          onPanelMuted: "#8FA1AF",
        },
        // Primary interactive accent — brand green (buttons, active tab
        // border, form focus accents). Named "primary" rather than a hue
        // so a future rebrand only ever means editing these hex values.
        primary: {
          50: "#E9F4EE",
          100: "#C6E3D3",
          300: "#6FAE87",
          500: "#0E6B3E",
          600: "#0B5732",
          700: "#084026",
        },
        // Brand gold — the logo's ribbon color. Reserved for small,
        // controlled highlights only (see the module comment above).
        brand: {
          gold: "#F2B705",
          goldSoft: "#FDF1CC",
        },
        signal: {
          teal: "#146B65",
          tealSoft: "#E4F1EF",
          blue: "#2A5C8A",
          blueSoft: "#E7EEF5",
          amber: "#B4790F",
          amberSoft: "#FBF0DC",
          red: "#B23B33",
          redSoft: "#F8E7E5",
          green: "#2F7A50",
          greenSoft: "#E5F1EA",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgb(16 27 36 / 0.06)",
        overlay: "0 12px 32px -8px rgb(16 27 36 / 0.28)",
      },
      backgroundImage: {
        "grid-fine":
          "linear-gradient(to right, rgb(20 28 34 / 0.045) 1px, transparent 1px), linear-gradient(to bottom, rgb(20 28 34 / 0.045) 1px, transparent 1px)",
      },
      backgroundSize: {
        "grid-fine": "24px 24px",
      },
      fontSize: {
        // 11px — table headers, small labels, badges, metadata captions.
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        // ~28px/700 — page titles (PageHeader).
        title: ["1.75rem", { lineHeight: "1.25", letterSpacing: "-0.01em", fontWeight: "700" }],
        // ~20px/600 — section titles.
        section: ["1.25rem", { lineHeight: "1.35", fontWeight: "600" }],
        // ~30px/700 — KPI card numbers.
        kpi: ["1.875rem", { lineHeight: "1.15", letterSpacing: "-0.01em", fontWeight: "700" }],
      },
    },
  },
  plugins: [],
};

export default config;
