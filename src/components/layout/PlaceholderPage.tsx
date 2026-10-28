import { Construction } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export interface PlaceholderPageProps {
  title: string;
  description: string;
  comingIn?: string[];
}

/**
 * Standard placeholder used by every module route that hasn't been
 * built yet (courses, students, attendance, tests, etc.). Keeps every
 * unimplemented screen visually consistent with the rest of the
 * design system while the module itself is still scoped for a later
 * part.
 */
export function PlaceholderPage({ title, description, comingIn = [] }: PlaceholderPageProps) {
  return (
    <div>
      <PageHeader title={title} description={description} actions={<Badge tone="amber">Coming soon</Badge>} />

      <Card className="flex flex-col items-center gap-4 border-dashed px-6 py-14 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary-600">
          <Construction className="h-6 w-6" />
        </span>
        <div>
          <p className="text-sm font-medium text-ink">{title} isn&rsquo;t built yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">
            This route is a navigation placeholder. Full functionality is scoped for a later part.
          </p>
        </div>

        {comingIn.length > 0 && (
          <ul className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1.5 text-left text-xs text-ink-muted sm:grid-cols-2">
            {comingIn.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="h-1 w-1 shrink-0 rounded-full bg-primary-500" />
                {item}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
