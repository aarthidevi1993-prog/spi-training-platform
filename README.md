# SPI Training Management Platform — PART 1 (Foundation)

A Next.js + TypeScript + Tailwind foundation for a Smart Plant Instrumentation
(SPI) training management platform. This is **PART 1 only**: application
shell, routing, design system and architecture. No module (courses, students,
attendance, tests, etc.) is functionally implemented yet — see "What's left
for Part 2" below.

## ⚠️ Build status — please read

This project was generated in a sandboxed environment with **no internet
access**, so `npm install` and `npm run build` could not actually be run
here. Every file was hand-written and passed a TypeScript **syntax**-only
check (parsed with the TypeScript compiler, 0 syntax errors across 121
files), and all `@/…` import paths were verified to resolve to real files.
That is not the same as a real build — you'll need to run the steps below
yourself (or hand the project to an environment with network access, e.g.
Claude Code) to get a true compile/build/lint pass and to click through the
app on desktop and mobile.

## How to run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm run typecheck
npm run lint
```

Copy `.env.example` to `.env.local` if/when you connect a real Supabase
project. The app runs fully on mock data without it.

## Technologies installed

- Next.js 14 (App Router)
- React 18
- TypeScript 5 (strict mode)
- Tailwind CSS 3 (custom design tokens, no default theme)
- lucide-react (icons)
- clsx + tailwind-merge (`cn()` helper)
- @supabase/supabase-js + @supabase/ssr (client scaffolding only — not connected)

## Final folder structure

```
src/
  app/                      # Next.js App Router routes (see "Routes created")
  components/
    ui/                     # Button, Input, Select, Modal, Dialog, Card, Table,
                             # Badge, ProgressBar, Dropdown, Tabs, Toast,
                             # LoadingState, EmptyState, ErrorState
    layout/                 # Sidebar, Topbar, AppShell, PageHeader,
                             # PlaceholderPage, PortalDashboard
  features/                 # students/ trainers/ courses/ batches/ classes/
                             # attendance/ tests/ questions/ results/
                             # performance/ certificates/ notifications/
                             # (each: README.md + index.ts + components/ — empty,
                             # ready for PART 2)
  services/                 # business-logic layer (students.service.ts is the
                             # PART 1 reference implementation)
  repositories/              # data-access layer (students.repository.ts is a
                             # full mock-backed reference implementation;
                             # every other entity has a stub repository with
                             # the same shape, ready to be filled in)
  lib/
    supabase/                # browser/server/admin Supabase client factories
                             # (return null until env vars are set — safe to
                             # ship before a real project is connected)
    mock/                    # mock data used by the reference repository
  types/                     # TypeScript interfaces for all 16 core entities
  hooks/                     # useMediaQuery, useDisclosure, useToast
  utils/                     # cn(), formatDate(), formatPercentage(), initials()
  config/                    # site.ts (company branding), navigation.ts
                             # (role-based sidebar nav)
public/
  logo-placeholder.svg
```

## Routes created

```
/                          landing page (links to /login and each portal)
/login                     placeholder sign-in screen (no real auth yet)

/admin                     dashboard placeholder
/admin/courses
/admin/trainers
/admin/students
/admin/batches
/admin/classes
/admin/attendance
/admin/tests
/admin/questions
/admin/performance
/admin/reports
/admin/certificates
/admin/notifications
/admin/settings

/trainer                   dashboard placeholder
/trainer/courses
/trainer/students
/trainer/batches
/trainer/classes
/trainer/attendance
/trainer/tests
/trainer/questions
/trainer/performance
/trainer/reports

/student                   dashboard placeholder
/student/courses
/student/classes
/student/attendance
/student/tests
/student/results
/student/performance
/student/certificates
/student/notifications
```

All non-dashboard routes render the shared `PlaceholderPage` component: a
page header, a "Planned — Part 2" badge, and a short list of what that
module will do once it's built. This keeps every unbuilt screen consistent
and testable for navigation today.

## Components created

**UI kit** (`src/components/ui`): Button, Input, Select, Modal, Dialog, Card
(+ Header/Title/Description/Content/Footer), Table (+ Head/Body/Row/HeaderCell/
Cell), Badge, ProgressBar, Dropdown (+ DropdownItem), Tabs (+ List/Trigger/
Content), Toast (+ ToastProvider/useToast), LoadingState, EmptyState,
ErrorState.

**Layout** (`src/components/layout`): Sidebar (desktop collapse + mobile
drawer, active-route highlighting), Topbar (page title, search, notifications,
user menu with logout), AppShell (wires Sidebar + Topbar + content together,
owns the responsive state), PageHeader, PlaceholderPage, PortalDashboard.

## Architecture

```
Frontend (app/, components/, features/)
    ↓
Service layer (src/services)      — business rules, orchestration
    ↓
Repository layer (src/repositories) — the only layer that knows where data
    ↓                                 lives (mock array today, Supabase later)
Supabase / PostgreSQL (src/lib/supabase) — not connected yet
```

`students.repository.ts` + `students.service.ts` are full reference
implementations of this pattern, backed by mock data in `src/lib/mock`. Every
other entity has a repository stub with the identical shape (`findAll`,
`findById`, `create`, `update`, `remove`) so wiring up each module in PART 2
is additive, not a redesign.

## Configuration

Company name, logo, description and contact details are centralized in
`src/config/site.ts` — nothing else hard-codes them. Sidebar navigation is
centralized in `src/config/navigation.ts`, keyed by role.

## Known gaps / things to verify once you can run it

- Real `npm install` / `npm run build` / `npm run typecheck` / `npm run lint`
  have not been executed — please run them and fix anything the compiler
  flags that a syntax-only check couldn't catch (e.g. type mismatches).
- Click through desktop and mobile nav, sidebar collapse, and the mobile
  drawer to confirm the interactions feel right.
- `next/font/google` (Space Grotesk, Inter, IBM Plex Mono) downloads fonts at
  build time and needs network access in whatever environment you build in.

## What is intentionally left for PART 2

- Real authentication (Supabase Auth) and route protection/middleware
- Database schema + live Supabase/PostgreSQL connection
- Course, trainer, student, batch and class management (CRUD)
- Attendance marking
- Tests, question bank, and grading
- Performance analytics
- Certificate generation
- Notification delivery (email/SMS) and read-state tracking
- Reports and exports

Per the brief, this stops here — PART 2 is a separate step.

---

# PART 2 — Authentication, Login & Role-Based Access

Adds authentication on top of the PART 1 foundation. Nothing from PART 1 was deleted or rebuilt — see the diff summary below.

## ⚠️ Build status — please read (same caveat as PART 1)

This sandbox still has no internet access, so `npm install`/`npm run build` could not be run here. Every new/changed file was re-verified with the same method as PART 1:

- TypeScript syntax check (parser-only): **144 files, 0 syntax errors**
- All 35 unique `@/…` import paths resolve to real files
- Every file using a React hook has `"use client"`
- Confirmed no client component imports the server-only `auth.service.ts` / `auth.repository.ts` (the `server-only` package makes this a hard build failure if it ever happens — nothing currently triggers it)

Please run `npm install && npm run build && npm run typecheck && npm run lint` yourself and tell me what the real compiler says — a syntax check is not a substitute for that.

## Authentication architecture

```
Browser
  ↓
LoginForm / ForgotPasswordForm / ResetPasswordForm  (client components)
  ↓  (call Server Actions directly, no fetch/JSON wiring needed)
src/services/auth.actions.ts        "use server" — validation + the RPC boundary
  ↓
src/services/auth.service.ts        business rules, React cache() for per-request dedupe
  ↓
src/repositories/auth.repository.ts the ONLY module that knows *how* a session is made
  ↓
  ├─ demo mode:      httpOnly cookie, base64 JSON payload (src/lib/auth/session.ts)
  └─ supabase mode:  @supabase/ssr server client (src/lib/supabase/server.ts)
       ↓
     Supabase Auth / PostgreSQL
```

Two more layers sit alongside this, both server-side:

- **`src/middleware.ts`** — runs on every request. Refreshes the Supabase session cookie (official `@supabase/ssr` pattern, see `src/lib/supabase/middleware.ts`) and does a first, cheap redirect for unauthenticated/wrong-role access to `/admin`, `/trainer`, `/student`.
- **`src/components/auth/RoleGuard.tsx`** (+ `AuthGuard.tsx`) — the authoritative, server-rendered check. Wraps each portal's `layout.tsx`. Even if middleware were bypassed, no protected content renders without passing this.

This is intentional defense in depth — the brief explicitly requires that route protection isn't UI-only.

`src/components/auth/AuthProvider.tsx` (+ `useAuth()`) is a **display convenience only**: the root layout fetches the user server-side once and hands it down as context so client components like the Topbar profile menu can show the name/role and trigger logout — it is not itself a security boundary.

## Authentication flow

1. `LoginForm` collects email/password/remember-me and calls `loginAction` (a Server Action) directly — no manual fetch/route handler needed.
2. `loginAction` validates the fields, then calls `authService.login()` → `authRepository.login()`.
3. In **demo mode**: checks against the 3 built-in demo accounts, sets an httpOnly `spi_auth_session` cookie.
   In **supabase mode**: calls `supabase.auth.signInWithPassword()`, which writes Supabase's own session cookies via the `@supabase/ssr` server client.
4. On success, `loginAction` returns `{ ok: true, redirectTo }` — `redirectTo` is the user's role home (`/admin`, `/trainer`, `/student`), or the original `?next=` deep link if it's safe (same-origin, inside that user's own portal).
5. `LoginForm` calls `router.push(redirectTo)` and shows a success toast.
6. Every subsequent request into `/admin/*`, `/trainer/*`, `/student/*` is checked first by `middleware.ts`, then by that portal's `RoleGuard`.

## Role permissions

Centralized in `src/lib/auth/permissions.ts` (`PERMISSIONS_BY_ROLE`), matching brief section 12 exactly. `authService.hasPermission()` is the server-side check; nothing relies on hiding a button as the only guard.

| Role | Home route | Example permissions |
|---|---|---|
| `admin` (Super Admin) | `/admin` | manage courses/trainers/students/batches/classes/attendance/questions/tests, view results/performance, generate reports/certificates, manage notifications & settings |
| `trainer` | `/trainer` | view assigned courses/batches/students, schedule classes, mark attendance, create tests, manage assigned questions, view results/performance, generate assigned reports |
| `student` | `/student` | view own course/classes/attendance, take tests, view own results/performance/certificates/notifications, update profile |

**Note on role naming:** the brief's example used `SUPER_ADMIN` / `TRAINER` / `STUDENT`. PART 1 already defined `UserRole = "admin" | "trainer" | "student"` and routes under `/admin`. Per the brief's own instruction ("keep types compatible with the existing User type... do not create conflicting duplicate User interfaces"), PART 2 reuses that existing role type rather than introducing a second, conflicting enum — `"admin"` plays the Super Admin role throughout.

## Protected routes

| Path | Access |
|---|---|
| `/`, `/login`, `/forgot-password`, `/reset-password`, `/unauthorized`, `/auth/callback` | Public |
| `/admin/*` | `admin` only |
| `/trainer/*` | `trainer` only |
| `/student/*` | `student` only |

Unauthenticated → `/login?next=<original path>`. Authenticated but wrong role → `/unauthorized`.

## Demo mode

No Supabase project needed to test the app. Controlled by `NEXT_PUBLIC_AUTH_MODE` (see `.env.example`) — defaults to demo when Supabase env vars aren't set, and **never** silently activates in a production build.

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@spi-training.local` | `Demo@12345` |
| Trainer | `trainer@spi-training.local` | `Demo@12345` |
| Student | `student@spi-training.local` | `Demo@12345` |

The login page shows these automatically whenever demo mode is active.

## Environment variables (updated)

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_AUTH_MODE=demo
```

No new npm packages were required — `@supabase/supabase-js`, `@supabase/ssr` and `server-only` were already installed in PART 1.

## Files created

```
src/types/auth.ts
src/config/auth.ts
src/lib/auth/permissions.ts
src/lib/auth/roles.ts
src/lib/auth/session.ts
src/lib/supabase/middleware.ts
src/repositories/auth.repository.ts
src/services/auth.service.ts
src/services/auth.actions.ts
src/components/auth/AuthProvider.tsx
src/components/auth/AuthGuard.tsx
src/components/auth/RoleGuard.tsx
src/components/auth/LoginForm.tsx
src/components/auth/ForgotPasswordForm.tsx
src/components/auth/ResetPasswordForm.tsx
src/components/auth/index.ts
src/hooks/useAuth.ts
src/middleware.ts
src/app/forgot-password/page.tsx
src/app/reset-password/page.tsx
src/app/unauthorized/page.tsx
src/app/unauthorized/GoBackButton.tsx
src/app/auth/callback/route.ts
```

## Files modified

```
src/lib/supabase/client.ts        — accepts NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
src/lib/supabase/server.ts        — accepts NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
src/app/layout.tsx                — fetches current user, wraps children in AuthProvider
src/app/login/page.tsx            — rewritten: split-screen branding + LoginForm + demo hints
src/app/admin/layout.tsx          — wrapped in RoleGuard(["admin"])
src/app/trainer/layout.tsx        — wrapped in RoleGuard(["trainer"])
src/app/student/layout.tsx        — wrapped in RoleGuard(["student"])
src/app/admin/page.tsx            — greets the real signed-in user
src/app/trainer/page.tsx          — greets the real signed-in user
src/app/student/page.tsx          — greets the real signed-in user
src/components/layout/Topbar.tsx  — real user name/role via useAuth(), working logout
src/components/ui/Dropdown.tsx    — DropdownItem now supports a disabled state
src/app/page.tsx                  — portal links now say "Sign in required"
src/types/index.ts                — exports the new auth types
src/repositories/index.ts         — exports auth.repository
src/services/index.ts             — exports auth.service
.env.example                      — adds Supabase publishable key + NEXT_PUBLIC_AUTH_MODE
```

No PART 1 component was duplicated — Button, Input, Card, Badge, Modal, Toast, PageHeader, Sidebar, LoadingState, ErrorState, EmptyState are reused as-is.

## How to test each role (demo mode)

1. `npm install && npm run dev`
2. Visit `/admin` while logged out → should redirect to `/login`
3. Log in as `admin@spi-training.local` / `Demo@12345` → should land on `/admin`
4. Log out (Topbar → profile menu → Log out) → toast "Logged out successfully", redirected to `/login`
5. Try the browser Back button → protected content should not reappear (RoleGuard re-checks on every navigation)
6. Log in as `trainer@spi-training.local` → lands on `/trainer`; manually visit `/admin` → redirected to `/unauthorized`
7. Log in as `student@spi-training.local` → lands on `/student`; manually visit `/admin` or `/trainer` → redirected to `/unauthorized`
8. `/unauthorized` → "Go to dashboard" sends each role to its own home; "Go back" uses browser history
9. `/forgot-password` → submit any email → generic "check your email" message (never reveals whether the account exists)
10. `/reset-password` → password strength indicator updates live; mismatched confirm password shows inline error (in demo mode, the actual update is intentionally disabled with a clear message — this only works end-to-end once Supabase is connected)
11. Refresh the browser while logged in → still authenticated (cookie-based, not localStorage)
12. Resize to a mobile width and repeat login → fully responsive, existing PART 1 sidebar/drawer behavior untouched

## Known simplifications (documented, not hidden)

- The demo-mode session cookie is a base64 JSON payload, **not signed or encrypted** — acceptable only because demo mode can never activate itself in production (see `src/config/auth.ts`), never usable as a real security boundary.
- Role currently comes from Supabase `user_metadata.role` (set at sign-up elsewhere) since there's no `profiles` table yet — matches the brief's instruction to build only the minimum abstraction needed for auth/role detection now, with the full profile/database module coming in a later part.
- Password reset "send email" / "update password" are fully wired for Supabase mode; in demo mode they're intentionally inert (no real mailbox to send to) and say so.

## What's still intentionally not implemented

Course, trainer, student, batch, class, attendance, question bank, test, results, performance, reports, certificates and notification management — all unchanged placeholders from PART 1, per PART 2's scope rule.

Per the brief, stopping here — not starting PART 3.
