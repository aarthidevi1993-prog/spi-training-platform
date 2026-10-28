"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Filter, Search, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { ACCOUNT_STATUS_LABEL, RECORD_FILTER_LABEL, SEARCH_MAX_LENGTH, userDetailHref, usersHref } from "@/lib/user-management/users";
import { formatDate } from "@/utils/format";
import type { UserListPage, UserSummary } from "@/types/user-management";

const RECORD_KIND_LABEL = { student: "Student", trainer: "Trainer" } as const;

function FilterForm({ data, basePath }: { data: UserListPage; basePath: string }) {
  const f = data.filters;
  return (
    <Card>
      <CardContent>
        <form method="get" action={basePath} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Filter users">
          <div className="relative lg:col-span-2">
            <Input
              name="q"
              label="Search"
              placeholder="Name, email, code or ID"
              defaultValue={f.q}
              maxLength={SEARCH_MAX_LENGTH}
              className="w-full pl-9"
            />
            <Search className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4 text-ink-faint" aria-hidden />
          </div>
          <Select
            name="role"
            label="Role"
            defaultValue={f.role}
            options={[
              { value: "all", label: "All roles" },
              { value: "admin", label: ROLE_LABEL.admin },
              { value: "trainer", label: ROLE_LABEL.trainer },
              { value: "student", label: ROLE_LABEL.student },
            ]}
          />
          <Select
            name="status"
            label="Account status"
            defaultValue={f.status}
            options={[
              { value: "all", label: "Any account status" },
              ...(Object.keys(ACCOUNT_STATUS_LABEL) as (keyof typeof ACCOUNT_STATUS_LABEL)[]).map((s) => ({ value: s, label: ACCOUNT_STATUS_LABEL[s] })),
            ]}
          />
          <Select
            name="record"
            label="Domain record"
            defaultValue={f.record}
            options={(Object.keys(RECORD_FILTER_LABEL) as (keyof typeof RECORD_FILTER_LABEL)[]).map((r) => ({ value: r, label: RECORD_FILTER_LABEL[r] }))}
          />
          <div className="flex items-end gap-2 lg:col-span-5">
            <Button type="submit" size="sm">
              <Filter className="h-3.5 w-3.5" /> Apply
            </Button>
            <Link href={basePath} className="px-2 py-1.5 text-sm text-ink-muted hover:text-ink">
              Clear
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RecordCell({ u }: { u: UserSummary }) {
  if (u.recordState === "not_applicable") {
    return <span className="text-xs text-ink-faint">Not applicable</span>;
  }
  if (!u.record) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge tone="amber">Missing</Badge>
        <span className="text-xs text-ink-muted">No {u.role === "trainer" ? "trainer" : "student"} record</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="font-mono text-xs text-ink">{u.record.code}</span>
      <StatusBadge status={u.record.status} />
    </div>
  );
}

function BatchesCell({ u }: { u: UserSummary }) {
  const b = u.batches;
  if (!b) return <span className="text-xs text-ink-faint">—</span>;
  const extra = [
    b.completed > 0 ? `${b.completed} completed` : null,
    b.withdrawn > 0 ? `${b.withdrawn} withdrawn` : null,
  ].filter(Boolean);
  if (b.current.length === 0 && extra.length === 0) return <span className="text-xs text-ink-faint">—</span>;
  return (
    <div className="flex flex-col gap-1">
      {b.current.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {b.current.map((batch) => (
            <Badge key={batch.id} tone={batch.status === "ongoing" ? "blue" : "neutral"} title={`${batch.name} · ${batch.status}`}>
              {batch.code}
            </Badge>
          ))}
        </div>
      )}
      {extra.length > 0 && <span className="text-xs text-ink-muted">{extra.join(" · ")}</span>}
    </div>
  );
}

/**
 * Users table (Super Admin). Rows, filters and page come from the server
 * (usersService); this component only renders them and moves between
 * pages through the URL. It has no actions itself: a name opens that
 * account's detail panel (UserDetailPanel), where lifecycle actions live.
 */
export function UsersTable({ data, basePath, selectedId = null }: { data: UserListPage; basePath: string; selectedId?: string | null }) {
  const router = useRouter();
  const filtered = data.filters.q !== "" || data.filters.role !== "all" || data.filters.status !== "all" || data.filters.record !== "all";

  return (
    <div className="flex flex-col gap-4">
      <FilterForm data={data} basePath={basePath} />

      <p className="text-xs text-ink-muted" aria-live="polite">
        {data.matching === data.totals.all
          ? `${data.totals.all} ${data.totals.all === 1 ? "account" : "accounts"}`
          : `${data.matching} of ${data.totals.all} accounts match`}
        {data.pageCount > 1 && ` · page ${data.page} of ${data.pageCount}`}
      </p>

      {data.rows.length === 0 ? (
        filtered ? (
          <EmptyState icon={Search} title="No users match these filters" description="Try a different search, role, account status or record filter." action={<Link href={basePath} className="text-sm text-signal-blue hover:underline">Clear filters</Link>} />
        ) : (
          <EmptyState icon={Users} title="No users yet" description="Accounts appear here once they exist." />
        )
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Account status</TableHeaderCell>
              <TableHeaderCell>Domain record</TableHeaderCell>
              <TableHeaderCell>Batches</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Updated</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.rows.map((u) => (
              <TableRow key={u.id} data-user={u.id} className={u.id === selectedId ? "bg-signal-blueSoft/40" : undefined}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.name ?? "?"} size="sm" tone={u.name ? "blue" : "neutral"} />
                    <div className="min-w-0">
                      <Link
                        href={userDetailHref(basePath, data.filters, u.id)}
                        aria-current={u.id === selectedId ? "true" : undefined}
                        className={u.name ? "block truncate text-sm font-medium text-ink hover:text-signal-blue hover:underline" : "block truncate text-sm italic text-ink-muted hover:text-signal-blue hover:underline"}
                      >
                        {u.name ?? "Name not recorded"}
                      </Link>
                      <p className="truncate text-xs text-ink-muted">{u.email ?? "—"}</p>
                      <p className="truncate font-mono text-2xs text-ink-faint" title={u.id}>
                        {u.id}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {u.role ? ROLE_LABEL[u.role] : <span className="text-xs text-ink-faint">Unknown</span>}
                  {u.otherRecord && (
                    <p className="mt-1 text-2xs text-ink-muted">
                      Earlier {RECORD_KIND_LABEL[u.otherRecord.kind].toLowerCase()} record {u.otherRecord.code} ({u.otherRecord.status})
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <StatusBadge status={u.accountStatus} />
                    <span className="text-2xs text-ink-faint">since {formatDate(u.accountStatusChangedAt)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <RecordCell u={u} />
                </TableCell>
                <TableCell>
                  <BatchesCell u={u} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-ink-muted">{formatDate(u.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-ink-muted">{formatDate(u.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={data.page} totalPages={data.pageCount} onPageChange={(page) => router.push(usersHref(basePath, data.filters, { page }))} />
    </div>
  );
}
