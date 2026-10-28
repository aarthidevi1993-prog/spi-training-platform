import Link from "next/link";
import { Award } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export default function StudentCertificateNotFound() {
  return (
    <div className="flex flex-col items-center gap-4">
      <EmptyState icon={Award} title="Certificate not found" description="This certificate doesn't exist, or it isn't one of yours." />
      <Link href="/student/certificates">
        <Button variant="secondary" size="sm">
          Back to my certificates
        </Button>
      </Link>
    </div>
  );
}
