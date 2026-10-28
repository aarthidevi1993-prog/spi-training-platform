import { Percent, ClipboardCheck, FileCheck2, NotebookPen, CheckCircle2, AlertTriangle, Info, TrendingUp, Layers } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { ChartContainer } from "@/components/ui/ChartContainer";
import { EmptyState } from "@/components/ui/EmptyState";
import { LineChart } from "@/components/ui/charts";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Badge } from "@/components/ui/Badge";
import { SummaryStat } from "@/components/dashboard/SummaryStat";
import { formatDate } from "@/utils/format";
import { MODULE_STRONG_MIN, MODULE_WEAK_BELOW, type PerformanceData } from "@/types/performance";
import { PerformanceFilters } from "./PerformanceFilters";

function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function tone(value: number): "teal" | "amber" | "red" {
  return value >= MODULE_STRONG_MIN ? "teal" : value >= MODULE_WEAK_BELOW ? "amber" : "red";
}

/**
 * Shared analytics body for /admin, /trainer and /student Performance
 * pages — same visual language, each page supplies its own PageHeader
 * copy and the role-scoped data from performanceService. Separate
 * metrics only (no combined score); every value is read from stored
 * data, and an empty state is shown instead of invented values.
 */
export function PerformanceView({ data }: { data: PerformanceData }) {
  const { metrics: m, trend, modules } = data;
  const isStudent = data.role === "student";

  return (
    <div>
      {data.filters && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">Showing: {data.scopeLabel}</p>
          <PerformanceFilters filters={data.filters} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Test Average" value={pct(m.testAverage)} icon={Percent} tone="gold" />
        <SummaryStat label="Pass Rate" value={pct(m.passRate)} icon={FileCheck2} tone="green" />
        <SummaryStat label="Attendance" value={pct(m.attendancePercent)} icon={ClipboardCheck} tone="blue" />
        <SummaryStat label="Assignment Average" value={pct(m.assignmentAverage)} icon={NotebookPen} tone="green" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartContainer
          title="Performance Trend"
          description={isStudent ? "Your best score on each released test, oldest to newest" : "Average best score per released test, oldest to newest"}
          className="lg:col-span-2"
        >
          {trend.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No released results yet" description="The trend appears once tests have closed and results are released." />
          ) : (
            <>
              <LineChart data={trend.map((p) => ({ label: p.testId, value: p.averagePercent }))} color="#0E6B3E" max={100} />
              <div className="mt-2 flex justify-between gap-2 text-2xs text-ink-faint">
                {trend.map((p) => (
                  <span key={p.testId} title={`${p.title}: ${p.averagePercent}%`} className="truncate">
                    {p.date ? formatDate(p.date) : p.title}
                  </span>
                ))}
              </div>
            </>
          )}
        </ChartContainer>

        {modules ? (
          <ChartContainer title="Module Performance" description="Marks earned by module (best released attempts)">
            {modules.length === 0 ? (
              <EmptyState icon={Layers} title="No module data yet" description="Appears once released tests include questions linked to modules." />
            ) : (
              <div className="flex flex-col gap-3">
                {modules.map((mod) => (
                  <ProgressBar key={mod.moduleId} value={mod.percent} label={mod.title} tone={tone(mod.percent)} />
                ))}
              </div>
            )}
          </ChartContainer>
        ) : (
          <ChartContainer title="Released Results" description="Your best score on each closed test">
            {!data.studentResults || data.studentResults.length === 0 ? (
              <EmptyState icon={FileCheck2} title="No released results yet" description="Scores appear here after each test closes." />
            ) : (
              <div className="flex flex-col gap-3">
                {data.studentResults.map((r) => (
                  <ProgressBar key={r.testId} value={r.percentage} label={`${r.title} · ${r.passed ? "Passed" : "Not passed"}`} tone={r.passed ? "teal" : "red"} />
                ))}
              </div>
            )}
          </ChartContainer>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {modules && (
          <>
            <Card>
              <CardContent>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                  <CheckCircle2 className="h-4 w-4 text-signal-green" /> Stronger Modules
                </h3>
                {data.strongModules.length === 0 ? (
                  <p className="text-xs text-ink-faint">No module at {MODULE_STRONG_MIN}% or above yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {data.strongModules.map((t) => (
                      <Badge key={t} tone="green">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                  <AlertTriangle className="h-4 w-4 text-signal-red" /> Weaker Modules
                </h3>
                {data.weakModules.length === 0 ? (
                  <p className="text-xs text-ink-faint">No module below {MODULE_WEAK_BELOW}%.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {data.weakModules.map((t) => (
                      <Badge key={t} tone="red">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <Card>
          <CardContent>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
              <Info className="h-4 w-4 text-brand-gold" /> What These Numbers Cover
            </h3>
            <ul className="flex flex-col gap-2 text-xs text-ink-muted">
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                Tests: {m.releasedResults} released best result{m.releasedResults === 1 ? "" : "s"}, {m.passedResults} passed.
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                Attendance: {m.attendanceAttended} of {m.attendanceMarked} marked records attended (present, late or excused).
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                Assignments: {m.assignmentsScored} returned, scored submission{m.assignmentsScored === 1 ? "" : "s"}, each as a percentage of its maximum score.
              </li>
              {!isStudent && (
                <li className="flex items-start gap-2">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-faint" />
                  Modules: {MODULE_STRONG_MIN}% or above is stronger; below {MODULE_WEAK_BELOW}% is weaker.
                </li>
              )}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
