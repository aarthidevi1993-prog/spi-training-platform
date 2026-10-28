import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { CertificateDocument } from "@/components/modules/CertificateDocument";
import { certificatesService } from "@/services/certificates.service";
import { publicAppOrigin } from "@/utils/request-origin";
import { certificateVerificationPath, type CertificateDocument as CertificateSnapshot } from "@/types/certificate";

export const dynamic = "force-dynamic";

/** Super Admin: a certificate rendered from its stored snapshot (issued or revoked). */
export default async function AdminCertificateViewPage({ params }: { params: { certificateNumber: string } }) {
  let certificate: CertificateSnapshot | null = null;
  let loadError: string | null = null;

  try {
    certificate = await certificatesService.getStaffCertificate(params.certificateNumber);
  } catch (err) {
    console.error("[admin/certificates/view] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this certificate. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this certificate" description={loadError} />;
  if (!certificate) notFound();

  return (
    <CertificateDocument
      certificate={certificate}
      verificationUrl={`${publicAppOrigin()}${certificateVerificationPath(certificate.certificateNumber, certificate.verificationCode)}`}
      backHref="/admin/certificates"
      backLabel="Back to certificates"
    />
  );
}
