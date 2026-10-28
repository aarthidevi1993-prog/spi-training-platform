import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./Card";
import { cn } from "@/utils/cn";

export interface ChartContainerProps {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Standard card shell for a dashboard chart — title/description/optional action, consistent padding. */
export function ChartContainer({ title, description, action, children, className }: ChartContainerProps) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}
