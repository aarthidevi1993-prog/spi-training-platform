import type { Metadata } from "next";
import { Logo } from "@/components/layout/Logo";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { VerifyCertificateResult } from "@/components/modules/VerifyCertificateResult";
import { VerifyCertificateForm } from "@/components/modules/VerifyCertificateForm";
import { certificatesService } from "@/services/certificates.service";
import { siteConfig } from "@/config/site";
import type { PublicVerificationResult } from "@/types/certificate";

// Public, per-request, never cached or indexed.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: `Certificate verification | ${siteConfig.companyName}`,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

/**
 * Public certificate verification: /verify/<number>?code=<code>. No
 * sign-in. verify_certificate() requires BOTH values; every bad or
 * non-matching input shows the same "not found" result.
 */
export default async function VerifyCertificatePage({
  params,
  searchParams,
}: {
  params: { certificateNumber: string };
  searchParams: { code?: string | string[] };
}) {
  const code = typeof searchParams.code === "string" ? searchParams.code : "";
  let result: PublicVerificationResult = { found: false };
  let failed = false;

  try {
    result = await certificatesService.verifyCertificate(params.certificateNumber, code);
  } catch (err) {
    console.error("[verify] verification failed:", err instanceof Error ? err.message : err);
    failed = true;
  }

  return (
    <main className="min-h-screen bg-surface px-4 py-10">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-12">
            <Logo variant="full" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink">Certificate verification</h1>
            <p className="mt-1 text-sm text-ink-muted">Confirm a certificate issued by {siteConfig.companyName}.</p>
          </div>
        </div>

        <Card className="overflow-hidden">
          {failed ? (
            <div className="p-6">
              <ErrorState title="Verification is unavailable" description="We couldn't check this certificate right now. Please try again later." />
            </div>
          ) : (
            <VerifyCertificateResult result={result} />
          )}
        </Card>

        {!result.found && !failed && (
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-ink">Verify another certificate</h2>
            <VerifyCertificateForm />
          </Card>
        )}

        <p className="text-center text-2xs text-ink-faint">
          Verification shows only the certificate details. It never shows scores, attendance or other personal information.
        </p>
      </div>
    </main>
  );
}
