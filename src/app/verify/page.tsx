import type { Metadata } from "next";
import { Logo } from "@/components/layout/Logo";
import { Card } from "@/components/ui/Card";
import { VerifyCertificateForm } from "@/components/modules/VerifyCertificateForm";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: `Certificate verification | ${siteConfig.companyName}`,
  robots: { index: false, follow: false },
};

/** Public lookup form: enter the certificate number and verification code. */
export default function VerifyLandingPage() {
  return (
    <main className="min-h-screen bg-surface px-4 py-10">
      <div className="mx-auto flex max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-12">
            <Logo variant="full" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink">Certificate verification</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Enter the certificate number and verification code printed on the certificate.
            </p>
          </div>
        </div>
        <Card className="p-5">
          <VerifyCertificateForm />
        </Card>
      </div>
    </main>
  );
}
