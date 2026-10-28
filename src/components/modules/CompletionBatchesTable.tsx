import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate } from "@/utils/format";
import type { CompletionBatchSummary } from "@/types/certificate";

/** Batches with their completion/certificate counts (read from the database). */
export function CompletionBatchesTable({ rows, basePath }: { rows: CompletionBatchSummary[]; basePath: string }) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Batch</TableHeaderCell>
          <TableHeaderCell>Course</TableHeaderCell>
          <TableHeaderCell>Trainer</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Ends</TableHeaderCell>
          <TableHeaderCell className="text-right">Recommended</TableHeaderCell>
          <TableHeaderCell className="text-right">Approved</TableHeaderCell>
          <TableHeaderCell className="text-right">Certificates</TableHeaderCell>
          <TableHeaderCell className="text-right">Open</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((b) => (
          <TableRow key={b.id}>
            <TableCell className="font-medium text-ink">
              {b.name}
              <span className="block text-2xs font-normal text-ink-faint">{b.batchCode}</span>
            </TableCell>
            <TableCell>
              {b.courseTitle}
              {b.courseCode && <span className="block text-2xs text-ink-faint">{b.courseCode}</span>}
            </TableCell>
            <TableCell>{b.trainerName ?? <span className="text-ink-faint">Not assigned</span>}</TableCell>
            <TableCell>
              <StatusBadge status={b.status} />
            </TableCell>
            <TableCell className="whitespace-nowrap">{b.endDate ? formatDate(b.endDate) : "—"}</TableCell>
            <TableCell className="text-right font-mono text-xs">{b.counts.recommended}</TableCell>
            <TableCell className="text-right font-mono text-xs">{b.counts.approved}</TableCell>
            <TableCell className="text-right font-mono text-xs">
              {b.counts.issued}
              {b.counts.revoked > 0 && <span className="block text-2xs text-ink-faint">{b.counts.revoked} revoked</span>}
            </TableCell>
            <TableCell className="text-right">
              <Link href={`${basePath}/${b.id}`} className="text-xs font-medium text-primary-600 hover:underline">
                Manage
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
