import { Badge, type BadgeProps } from "./Badge";

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  active: "green",
  published: "green",
  present: "green",
  pass: "green",
  completed: "green",
  returned: "green",
  submitted: "blue",
  ongoing: "blue",
  scheduled: "blue",
  in_progress: "blue",
  invited: "amber",
  draft: "amber",
  upcoming: "amber",
  late: "amber",
  pending_review: "amber",
  inactive: "neutral",
  not_started: "neutral",
  archived: "neutral",
  closed: "neutral",
  cancelled: "red",
  absent: "red",
  fail: "red",
  expired: "red",
  revoked: "red",
  suspended: "red",
};

function toLabel(status: string): string {
  return status
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export interface StatusBadgeProps {
  status: string;
  /** Optional display text (the tone still follows `status`), e.g. a course's Active / Inactive. */
  label?: string;
  className?: string;
}

/** Maps any of the platform's entity status strings to a consistent badge tone/label. */
export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} className={className}>
      {label ?? toLabel(status)}
    </Badge>
  );
}
