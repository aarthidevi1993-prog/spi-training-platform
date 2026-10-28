import Link from "next/link";
import { Eye } from "lucide-react";
import { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/utils/format";
import type { CertificateStatus } from "@/types/certificate";
import { CERTIFICATE_STATUS } from "./completionLabels";

/** One row of a certificate list. Never carries the verification code. */
export interface CertificateListRow {
  certificateNumber: string;
  studentName?: string;
  courseCode: string;
  courseTitle: string;
  batchCode: string;
  batchName: string;
  completionDate: string;
  issuedAt: string;
  status: CertificateStatus;
  /** Link to the certificate document view, when the viewer has one. */
  href?: string;
}

/**
 * Certificate list (student, admin, trainer). Data comes from the
 * stored certificate snapshots; the verification code is deliberately
 * not part of the row type.
 */
export function CertificatesTable({ rows, showStudent = false }: { rows: CertificateListRow[]; showStudent?: boolean }) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Certificate No.</TableHeaderCell>
          {showStudent && <TableHeaderCell>Student</TableHeaderCell>}
          <TableHeaderCell>Course</TableHeaderCell>
          <TableHeaderCell>Batch</TableHeaderCell>
          <TableHeaderCell>Completion date</TableHeaderCell>
          <TableHeaderCell>Issue date</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell className="text-right">View</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((c) => {
          const status = CERTIFICATE_STATUS[c.status];
          return (
            <TableRow key={c.certificateNumber}>
              <TableCell className="whitespace-nowrap font-mono text-xs text-ink">{c.certificateNumber}</TableCell>
              {showStudent && <TableCell className="font-medium text-ink">{c.studentName}</TableCell>}
              <TableCell>
                {c.courseTitle}
                {c.courseCode && <span className="block text-2xs text-ink-faint">{c.courseCode}</span>}
              </TableCell>
              <TableCell>
                {c.batchName}
                {c.batchCode && <span className="block text-2xs text-ink-faint">{c.batchCode}</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap">{c.completionDate ? formatDate(c.completionDate) : "—"}</TableCell>
              <TableCell className="whitespace-nowrap">{c.issuedAt ? formatDate(c.issuedAt) : "—"}</TableCell>
              <TableCell>
                <Badge tone={status?.tone ?? "neutral"}>{status?.label ?? c.status}</Badge>
              </TableCell>
              <TableCell className="text-right">
                {c.href ? (
                  <Link href={c.href} className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline">
                    <Eye className="h-3.5 w-3.5" /> {c.status === "revoked" ? "View record" : "View"}
                  </Link>
                ) : (
                  <span className="text-xs text-ink-faint">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
