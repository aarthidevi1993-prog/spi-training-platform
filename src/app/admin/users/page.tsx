import { CircleSlash, MailQuestion, UserCheck, UserX } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { SummaryStat } from "@/components/dashboard/SummaryStat";
import { ErrorState } from "@/components/ui/ErrorState";
import { InviteUserButton } from "@/components/modules/InviteUserButton";
import { UserDetailPanel } from "@/components/modules/UserDetailPanel";
import { UsersTable } from "@/components/modules/UsersTable";
import { EDIT_DETAILS_PARAM, usersHref } from "@/lib/user-management/users";
import { usersService, UsersAuthorizationError } from "@/services/users.service";
import type { UserDetail, UserListPage } from "@/types/user-management";

export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/users";

/**
 * Users (admin). The layout's RoleGuard admits only Super Admins;
 * usersService re-checks the signed-in user server-side and RLS decides
 * every row. Filters come from the URL and are validated there; only the
 * requested page is sent to the browser. `?user=<id>` opens that
 * account's detail panel, whose lifecycle actions go through server
 * actions and the 0017 database functions. `&edit=details` (P3.11-C,
 * e.g. the Trainers list's Edit) opens that panel's existing details form
 * directly — only where the panel itself would offer it.
 */
export default async function AdminUsersPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  let data: UserListPage | null = null;
  let detail: UserDetail | null = null;
  let loadError: string | null = null;
  const selected = typeof searchParams.user === "string" ? searchParams.user : null;
  const editDetails = searchParams.edit === EDIT_DETAILS_PARAM;

  try {
    data = await usersService.listUsers(searchParams);
    if (selected) detail = await usersService.getUserDetail(selected);
  } catch (err) {
    if (err instanceof UsersAuthorizationError) {
      loadError = err.message;
    } else {
      console.error("[admin/users] load failed:", err instanceof Error ? err.message : err);
      loadError = "We couldn't load the users. Please try again.";
    }
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="Every account on the platform: role, account status, domain record and batches. Open an account to manage its lifecycle."
        // P3.12: only Super Admins reach this page (admin layout RoleGuard); the action re-checks on the server.
        actions={loadError ? undefined : <InviteUserButton kind="super_admin" />}
      />
      {loadError || !data ? (
        <ErrorState title="We couldn't load the users" description={loadError ?? "Please try again."} />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryStat label="Active accounts" value={String(data.totals.byStatus.active)} icon={UserCheck} tone="green" />
            <SummaryStat label="Invited (not yet active)" value={String(data.totals.byStatus.invited)} icon={MailQuestion} tone="gold" />
            <SummaryStat label="Suspended" value={String(data.totals.byStatus.suspended)} icon={UserX} tone="red" />
            <SummaryStat label="Missing domain record" value={String(data.totals.missingRecord)} icon={CircleSlash} tone="blue" />
          </div>
          {selected && !detail && (
            <ErrorState title="Account not found" description="That account doesn't exist or can't be shown." />
          )}
          {detail && <UserDetailPanel detail={detail} closeHref={usersHref(BASE_PATH, data.filters)} initialEdit={editDetails} />}
          <UsersTable data={data} basePath={BASE_PATH} selectedId={detail?.user.id ?? null} />
        </div>
      )}
    </div>
  );
}
