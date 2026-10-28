import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export default function StudentTestNotFound() {
  return (
    <div className="flex flex-col items-center gap-4">
      <EmptyState
        icon={FileQuestion}
        title="Test not found"
        description="This test or attempt doesn't exist, or it isn't available to you."
      />
      <Link href="/student/tests">
        <Button variant="secondary" size="sm">
          Back to tests
        </Button>
      </Link>
    </div>
  );
}
