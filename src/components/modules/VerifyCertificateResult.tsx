import { BadgeCheck, ShieldAlert, ShieldX } from "lucide-react";
import { formatDate } from "@/utils/format";
import type { PublicVerificationResult } from "@/types/certificate";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

/**
 * The public verification result. Shows only the fields returned by
 * verify_certificate() — never ids, scores, attendance, the
 * verification code or a revocation reason. A wrong number, wrong code
 * or malformed input all render the same "not found" state.
 */
export function VerifyCertificateResult({ result }: { result: PublicVerificationResult }) {
  if (!result.found) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-ink-muted">
          <ShieldAlert className="h-6 w-6" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold text-ink">Certificate not found</h2>
        <p className="max-w-md text-sm text-ink-muted">
          We couldn&rsquo;t verify a certificate with these details. Check that the certificate number and verification code
          are exactly as printed on the certificate.
        </p>
      </div>
    );
  }

  const c = result.certificate;
  const revoked = c.status === "revoked";

  return (
    <div>
      <div
        className={
          revoked
            ? "flex items-start gap-3 border-b border-signal-red/30 bg-signal-redSoft px-6 py-4"
            : "flex items-start gap-3 border-b border-primary-100 bg-primary-50 px-6 py-4"
        }
      >
        {revoked ? (
          <ShieldX className="mt-0.5 h-6 w-6 shrink-0 text-signal-red" aria-hidden />
        ) : (
          <BadgeCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary-500" aria-hidden />
        )}
        <div>
          <h2 className={revoked ? "text-base font-semibold text-signal-red" : "text-base font-semibold text-primary-700"}>
            {revoked ? "This certificate has been revoked" : "Valid certificate"}
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {revoked
              ? `It is no longer valid${c.revokedDate ? ` (revoked on ${formatDate(c.revokedDate)})` : ""}.`
              : "This certificate was issued by ARSÈNE Technology Services and is currently valid."}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
        <Field label="Certificate number" value={c.certificateNumber} />
        <Field label="Status" value={revoked ? "Revoked" : "Issued"} />
        <Field label="Awarded to" value={c.studentName} />
        <Field label="Course" value={c.courseCode ? `${c.courseTitle} (${c.courseCode})` : c.courseTitle} />
        <Field label="Batch" value={c.batchCode ? `${c.batchName} (${c.batchCode})` : c.batchName} />
        <Field label="Completion date" value={c.completionDate ? formatDate(c.completionDate) : "—"} />
        <Field label="Issue date" value={c.issueDate ? formatDate(c.issueDate) : "—"} />
        {revoked && c.revokedDate && <Field label="Revoked on" value={formatDate(c.revokedDate)} />}
      </dl>
    </div>
  );
}
