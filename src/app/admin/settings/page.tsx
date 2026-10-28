import Link from "next/link";
import { ChevronRight, Info, KeyRound, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";

/**
 * Settings (P5.0). Nothing here is presentation-only any more: there is no settings storage yet, so the
 * page offers no editable fields or save buttons. It points to what already works — the Users page
 * (accounts, invitations, roles, status) and the existing password reset flow — and says plainly what
 * can't be changed here yet.
 */
export default function AdminSettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Settings" description="Account administration and platform settings." />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="flex h-full flex-col gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <Users className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-ink">Users and roles</h3>
              <p className="mt-1 text-sm text-ink-muted">
                Accounts, invitations, roles and account status are managed on the Users page.
              </p>
            </div>
            <Link
              href="/admin/users"
              className="mt-auto inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-surface-border bg-white px-3 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Open Users
              <ChevronRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex h-full flex-col gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-ink">Your password</h3>
              <p className="mt-1 text-sm text-ink-muted">
                Passwords can&apos;t be changed on this page. To set a new one, sign out and choose &ldquo;Forgot your
                password?&rdquo; on the sign-in page; a reset link is sent to your email address.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div role="status" className="flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Company profile, notification preferences, role permissions and system preferences can&apos;t be changed here
          yet.
        </span>
      </div>
    </div>
  );
}
