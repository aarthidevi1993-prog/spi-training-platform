import Link from "next/link";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/utils/format";
import { STUDENT_TEST_STATE } from "@/app/student/tests/StudentTestsView";
import type { StudentResultRow } from "@/types/test-result";

/**
 * The student's own results (student_available_tests()). Score,
 * percentage and pass/fail appear only once the database has released
 * them (test closed); before that the row reads "Awaiting results".
 * The review link opens the existing secure attempt review.
 */
export function ResultsTable({ rows }: { rows: StudentResultRow[] }) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Course</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell>
          <TableHeaderCell>Attempts</TableHeaderCell>
          <TableHeaderCell>Score</TableHeaderCell>
          <TableHeaderCell>Percentage</TableHeaderCell>
          <TableHeaderCell>Result</TableHeaderCell>
          <TableHeaderCell className="text-right">Review</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r) => {
          const state = STUDENT_TEST_STATE[r.state];
          return (
            <TableRow key={r.testId}>
              <TableCell className="font-medium text-ink">
                {r.title}
                {r.closesAt && <span className="block text-2xs font-normal text-ink-faint">Closing time: {formatDateTime(r.closesAt)} (India time)</span>}
              </TableCell>
              <TableCell>
                {r.courseCode ? `${r.courseCode} — ` : ""}
                {r.courseTitle}
                <span className="block text-2xs text-ink-faint">{r.batchLabel}</span>
              </TableCell>
              <TableCell>
                <Badge tone={state.tone}>{state.label}</Badge>
              </TableCell>
              <TableCell>
                {r.attemptsUsed}/{r.attemptLimit}
              </TableCell>
              {r.released ? (
                <>
                  <TableCell>
                    {r.released.score}/{r.released.maxScore}
                  </TableCell>
                  <TableCell>{r.released.percentage}%</TableCell>
                  <TableCell>
                    <Badge tone={r.released.passed ? "green" : "red"}>{r.released.passed ? "Passed" : "Not passed"}</Badge>
                  </TableCell>
                </>
              ) : (
                <TableCell colSpan={3}>
                  <span className="text-xs text-ink-faint">
                    {r.awaitingResults ? "Awaiting results" : r.attemptsUsed === 0 ? "Not attempted" : "No result"}
                  </span>
                </TableCell>
              )}
              <TableCell className="text-right">
                {r.released ? (
                  <Link
                    href={`/student/tests/${r.testId}/attempt/${r.released.attemptId}`}
                    className="text-xs font-medium text-signal-blue hover:underline"
                  >
                    View review
                  </Link>
                ) : (
                  <Link href={`/student/tests/${r.testId}`} className="text-xs text-ink-muted hover:underline">
                    View test
                  </Link>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
