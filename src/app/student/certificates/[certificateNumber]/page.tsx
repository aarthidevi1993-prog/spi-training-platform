import { notFound } from "next/navigation";
import { ErrorState } from "@/components/ui/ErrorState";
import { CertificateDocument } from "@/components/modules/CertificateDocument";
import { certificatesService } from "@/services/certificates.service";
import { publicAppOrigin } from "@/utils/request-origin";
import { certificateVerificationPath, type StudentCertificate } from "@/types/certificate";

export const dynamic = "force-dynamic";

/**
 * The signed-in student's own certificate, rendered from its stored
 * snapshot (student_certificates()). Another student's number → 404.
 */
export default async function StudentCertificatePage({ params }: { params: { certificateNumber: string } }) {
  let certificate: StudentCertificate | null = null;
  let loadError: string | null = null;

  try {
    certificate = await certificatesService.getStudentCertificate(params.certificateNumber);
  } catch (err) {
    console.error("[student/certificates/view] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load this certificate. Please try again.";
  }

  if (loadError) return <ErrorState title="We couldn't load this certificate" description={loadError} />;
  if (!certificate) notFound();

  return (
    <CertificateDocument
      certificate={certificate}
      verificationUrl={`${publicAppOrigin()}${certificateVerificationPath(certificate.certificateNumber, certificate.verificationCode)}`}
      backHref="/student/certificates"
      backLabel="Back to my certificates"
    />
  );
}
