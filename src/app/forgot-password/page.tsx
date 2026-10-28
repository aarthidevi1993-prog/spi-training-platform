import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { siteConfig } from "@/config/site";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { Card, CardContent } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: `Forgot password | ${siteConfig.productName}`,
};

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <div className="w-full max-w-sm">
        <Link href="/login" className="mb-6 flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to login
        </Link>

        <div className="mb-6">
          <h1 className="text-xl font-semibold text-ink">Forgot password</h1>
          <p className="mt-1 text-sm text-ink-muted">Enter your registered email address.</p>
        </div>

        <Card>
          <CardContent>
            <ForgotPasswordForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
