import Link from "next/link";
import { AlertCircle, ChevronRight, Info } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { navigationByRole, portalLabel, type PortalRole } from "@/config/navigation";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface PortalDashboardKpi {
  label: string;
  value: string;
  /** What the value is based on (shown instead of a trend). */
  hint?: string;
}

export interface PortalDashboardProps {
  role: PortalRole;
  /** The signed-in account's display name (or its email when no name is set) — shown under the heading. */
  signedInAs?: string;
  kpis?: PortalDashboardKpi[];
  kpiIcons?: LucideIcon[];
  /** Shown instead of the KPI row when the metrics can't be shown (never as zeros). */
  kpiNotice?: { tone: "info" | "error"; text: string };
  /** Role-specific sections shown between the KPI row and the module directory. */
  sections?: ReactNode;
}

/**
 * Student dashboard shell: a KPI row (the student's own metrics — see
 * src/lib/dashboard/student-dashboard.ts) plus a directory of the portal's
 * modules, built from the navigation config so every tile links to the
 * route the sidebar uses. The Admin and Trainer portals have their own
 * dashboards.
 */
export function PortalDashboard({ role, signedInAs, kpis, kpiIcons, kpiNotice, sections }: PortalDashboardProps) {
  const items = navigationByRole[role].filter((item) => item.href !== `/${role}` && item.label !== "Settings");

  return (
    <div className="flex flex-col gap-6">
      <div>
        {/* A short heading (no name or email, no time-of-day guess); the emoji stays on the heading's line. */}
        <PageHeader
          className="pb-0"
          title={"Welcome back!\u00a0👋"}
          description={`Here's what's happening in your ${portalLabel[role].toLowerCase()} portal today.`}
        />
        {signedInAs && (
          <p className="mt-1 text-xs text-ink-muted [overflow-wrap:anywhere]">
            Signed in as <span className="font-medium text-ink">{signedInAs}</span>
          </p>
        )}
      </div>

      {kpiNotice ? (
        <div
          role={kpiNotice.tone === "error" ? "alert" : "status"}
          className={
            kpiNotice.tone === "error"
              ? "flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red"
              : "flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted"
          }
        >
          {kpiNotice.tone === "error" ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{kpiNotice.text}</span>
        </div>
      ) : (
        kpis &&
        kpis.length > 0 &&
        kpiIcons && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpis.map((kpi, i) => (
              <KpiCard
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                hint={kpi.hint}
                icon={kpiIcons[i] ?? kpiIcons[0]!}
                tone={i % 2 === 0 ? "green" : "gold"}
              />
            ))}
          </div>
        )
      )}

      {sections}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">Explore your modules</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <Card className="h-full transition-colors hover:border-primary-300 hover:shadow-panel">
                  <CardContent className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <p className="text-sm font-medium text-ink">{item.label}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
