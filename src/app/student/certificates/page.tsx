import { Award, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { CertificatesTable } from "@/components/modules/CertificatesTable";
import { StudentCompletionView } from "@/components/modules/StudentCompletionView";
import { certificatesService } from "@/services/certificates.service";
import type { StudentCertificate, StudentCompletionItem } from "@/types/certificate";

export const dynamic = "force-dynamic";

/**
 * The signed-in student's completion status and certificates. Identity
 * comes from the session only (student_completion_status /
 * student_certificates); the verification code is not listed here.
 */
export default async function StudentCertificatesPage() {
  let completion: StudentCompletionItem[] | null = null;
  let certificates: StudentCertificate[] | null = null;
  let loadError: string | null = null;

  try {
    [completion, certificates] = await Promise.all([
      certificatesService.getStudentCompletion(),
      certificatesService.getStudentCertificates(),
    ]);
  } catch (err) {
    console.error("[student/certificates] load failed:", err instanceof Error ? err.message : err);
    loadError = "We couldn't load your certificates. Please try again.";
  }

  return (
    <div>
      <PageHeader title="My Certificates" description="Your course completion status and the certificates you've earned." />
      {loadError ? (
        <ErrorState title="We couldn't load your certificates" description={loadError} />
      ) : completion === null || certificates === null ? (
        <EmptyState icon={Award} title="Certificates require Supabase mode." description="Sign in with a Supabase account to see your certificates." />
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">Completion status</h2>
            {completion.length === 0 ? (
              <EmptyState icon={GraduationCap} title="No batches yet" description="Your completion status will appear here once you're enrolled in a batch." />
            ) : (
              <StudentCompletionView items={completion} />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">My certificates</h2>
            {certificates.length === 0 ? (
              <EmptyState icon={Award} title="No certificates yet" description="Certificates appear here once a Super Admin issues them." />
            ) : (
              <CertificatesTable
                rows={certificates.map((c) => ({
                  certificateNumber: c.certificateNumber,
                  courseCode: c.courseCode,
                  courseTitle: c.courseTitle,
                  batchCode: c.batchCode,
                  batchName: c.batchName,
                  completionDate: c.completionDate,
                  issuedAt: c.issuedAt,
                  status: c.status,
                  href: `/student/certificates/${encodeURIComponent(c.certificateNumber)}`,
                }))}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
