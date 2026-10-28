import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Users, Wrench, TrendingUp, Award, Sparkles } from "lucide-react";
import { siteConfig } from "@/config/site";
import { authConfig } from "@/config/auth";
import { authService } from "@/services/auth.service";
import { getHomeRouteForRole } from "@/lib/auth/roles";
import { LoginForm } from "@/components/auth/LoginForm";
import { Logo } from "@/components/layout/Logo";
import { Footer } from "@/components/layout/Footer";
import { IndustrialSkyline } from "./IndustrialSkyline";

export const metadata: Metadata = {
  title: `Sign in | ${siteConfig.productName} | ${siteConfig.companyName}`,
};

// Checks the current session on every request to redirect an already
// signed-in visitor straight to their portal — must never be a
// cached/static response.
export const dynamic = "force-dynamic";

const highlights = [
  { icon: Users, title: "Expert Trainers", text: "Learn from certified SPI instrumentation specialists" },
  { icon: Wrench, title: "Practical Learning", text: "Real-world process instrumentation exercises" },
  { icon: TrendingUp, title: "Track Progress", text: "Live attendance, test and performance tracking" },
  { icon: Award, title: "Get Certified", text: "Earn recognised SPI course completion certificates" },
];

export default async function LoginPage() {
  // Already signed in? Skip the login screen entirely.
  const user = await authService.getCurrentUser();
  if (user) {
    redirect(getHomeRouteForRole(user.role));
  }

  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      {/* Left: branding panel */}
      <div className="bg-drafting relative hidden flex-col justify-between overflow-hidden bg-panel px-10 py-10 text-ink-onPanel lg:flex xl:px-16">
        <Link href="/" className="relative z-10 inline-flex">
          <Logo variant="full" plate priority className="h-9" />
        </Link>

        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl font-bold leading-tight text-white xl:text-4xl">
            {siteConfig.productName}
          </h1>
          <p className="mt-3 text-sm text-ink-onPanelMuted">
            Build your SPI skills. Advance your career.
            <br />
            Together towards a smarter future.
          </p>

          <ul className="mt-8 flex flex-col gap-4">
            {highlights.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel-soft text-brand-gold">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-medium text-white">{title}</span>
                  <span className="block text-xs text-ink-onPanelMuted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <Footer variant="dark" className="relative z-10 py-0 text-left" />

        <IndustrialSkyline />
      </div>

      {/* Right: login card */}
      <div className="flex flex-col items-center justify-center bg-surface px-4 py-12 sm:px-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center gap-2 text-center lg:hidden">
            <Logo variant="icon" priority className="h-12" />
            <span className="font-mono text-2xs uppercase tracking-wide text-ink-muted">
              {siteConfig.companyName}
            </span>
          </div>

          <div className="mb-6">
            <h2 className="text-xl font-semibold text-ink">Welcome Back</h2>
            <p className="mt-1 text-sm text-ink-muted">Sign in to continue to {siteConfig.productName}.</p>
          </div>

          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>

          {authConfig.demo.enabled && (
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-primary-100 bg-primary-50 px-4 py-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-primary-700">Demo mode</p>
                <dl className="mt-1.5 flex flex-col gap-1 font-mono text-2xs text-ink-muted">
                  {authConfig.demo.accounts.map((account) => (
                    <div key={account.email} className="flex items-center justify-between gap-2">
                      <dt className="capitalize">{account.role}</dt>
                      <dd>{account.email}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-1.5 font-mono text-2xs text-ink-muted">
                  password: {authConfig.demo.password}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
