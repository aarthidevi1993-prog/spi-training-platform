import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { authService } from "@/services/auth.service";
import { siteConfig } from "@/config/site";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${siteConfig.productName} | ${siteConfig.companyName}`,
  description: siteConfig.companyDescription,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved once per request and cached (see services/auth.service.ts),
  // so RoleGuard reading it again downstream doesn't re-hit the cookie/
  // Supabase. `null` just means "not signed in" — every page here is
  // still reachable; portal routes enforce their own RoleGuard.
  const currentUser = await authService.getCurrentUser();

  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body>
        <ToastProvider>
          <AuthProvider initialUser={currentUser}>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
