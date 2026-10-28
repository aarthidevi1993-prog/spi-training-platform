import Link from "next/link";
import { Award } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export default function CertificatesNotFound() {
  return (
    <div className="flex flex-col items-center gap-4">
      <EmptyState icon={Award} title="Not found" description="This batch or certificate doesn't exist, or you don't have access to it." />
      <Link href="/admin/certificates">
        <Button variant="secondary" size="sm">
          Back to certificates
        </Button>
      </Link>
    </div>
  );
}
