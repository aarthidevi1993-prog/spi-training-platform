import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { siteConfig } from "@/config/site";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/layout/Logo";
import { Footer } from "@/components/layout/Footer";

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-panel text-ink-onPanel">
      <div className="bg-drafting flex flex-1 items-center px-6 py-16">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
          <Logo variant="full" plate priority className="h-10 sm:h-12" />

          <div className="max-w-2xl">
            <p className="font-mono text-2xs uppercase tracking-wide text-brand-gold">
              {siteConfig.companyName} · {siteConfig.tagline}
            </p>
            <h1 className="mt-2 text-4xl font-bold leading-tight text-white sm:text-5xl">
              {siteConfig.productName}
            </h1>
            <p className="mt-4 max-w-xl text-base text-ink-onPanelMuted">
              {siteConfig.companyDescription} This foundation release lays out the platform
              shell — the full course, batch, attendance, testing and certification
              workflows are built on top of it in later parts.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link href="/login">
              <Button size="lg">
                Enter platform
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>

          <dl className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-panel-border bg-panel-border sm:grid-cols-3">
            {[
              { label: "Admin portal", href: "/admin" },
              { label: "Trainer portal", href: "/trainer" },
              { label: "Student portal", href: "/student" },
            ].map((portal) => (
              <Link
                key={portal.href}
                href={portal.href}
                className="group flex flex-col gap-1 bg-panel-soft px-5 py-4 transition-colors hover:bg-panel"
              >
                <dt className="font-mono text-2xs uppercase tracking-wide text-ink-onPanelMuted">
                  Sign in required
                </dt>
                <dd className="flex items-center gap-1.5 text-sm font-medium text-white">
                  {portal.label}
                  <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </dd>
              </Link>
            ))}
          </dl>
        </div>
      </div>

      <Footer variant="dark" />
    </main>
  );
}
