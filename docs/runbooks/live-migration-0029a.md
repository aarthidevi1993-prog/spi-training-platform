# Runbook — live database change: 0029a (invitation binding and recovery)

**Status: for review. Nothing in this runbook has been run against live Supabase.**
Applies to: the live Supabase project of the ARSÈNE SPI Training Platform (currently 0001–0029; 0030 not applied).
Never paste connection strings, passwords, keys, tokens, e-mail addresses or other personal data into chats,
tickets, screenshots or files in this repository.

## 0. What changes and in which order
- `supabase/migrations/0029a_invitation_binding_and_recovery.sql` (this runbook) — stands alone on 0001–0029:
  invitations are accepted only by the Auth account they are bound to; a Super Admin can send a sign-in link to an
  already-registered, never-activated invited account (recovery); two audit event types and three nullable columns.
- `supabase/migrations/0030_course_management.sql` — later, separately. It **refuses to run unless 0029a is applied**
  and carries the same acceptance rule, so applying it later never re-opens unbound acceptance.
- Rollback of 0029a is only possible **before** 0030 (the script refuses afterwards).

## 0a. Required rollout order (application ↔ database)
Do these in this order, each only after the previous one is finished and checked:

1. **Application first.** Deploy the application version that contains P5.2 (the `/auth/recover` page, the
   "Send sign-in link" action in Users, the new acceptance messages). It is safe before the database change:
   acceptance behaves exactly as today, and the new recovery parts simply fail closed — the Users panel shows no
   recovery section (its read of `invitation_recovery_candidate` fails and is logged as an error, harmless); a
   recovery request answers "Sign-in links are turned off on this server until their email setup has been
   confirmed. Nothing was requested or sent." (the recovery switch is off by default — step 3); and
   `/auth/recover` Continue ends any session it started and shows a generic "couldn't" message. Nothing is changed.
2. **Database second:** apply 0029a (section 4) and verify (section 5).
3. **Supabase configuration third:** the staging preparation and checks (sections 5a and 5 — which need the switch
   turned on **in staging only**), then the **production** Magic Link template, set and verified in the production
   project (section 5, "Production template"). Only after all of that, turn recovery e-mails on in production: set
   the **server-only** environment variable
   `INVITATION_RECOVERY_EMAILS_ENABLED=true` for the application and redeploy/restart it. Until then (the default,
   variable absent or anything other than `true`) "Send sign-in link" is refused on the server with "Sign-in links
   are turned off on this server…" and nothing is recorded or sent — the order is enforced by the code, not only by
   this runbook. Never use a `NEXT_PUBLIC_` name for this switch. While it is off, the Users panel still shows an
   "Invitation not linked" section for a stranded account but explains that sign-in links are turned off and offers
   no button.

   **The switch is application-level only.** It controls what the application offers and does. It does **not**
   change the database: an otherwise authorized, active Super Admin who calls `begin_invitation_recovery` directly
   (e.g. with the publishable key and their own session) can still record a recovery request, and
   `complete_invitation_recovery` is not switch-gated. No e-mail is sent by the application in that case, and the
   database still enforces every rule (Super Admin only, eligibility, cooldown/cap, 24 h window, fresh e-mail
   sign-in). Treat recovery as "not offered" — not "impossible" — while the switch is off.
4. **Course management (0030) later**, as a separate change — it requires 0029a and refuses to run without it.

What goes wrong with another order (none of it is dangerous for security, but people get stuck or confused):
- **Database before application:** invitations that are not bound to an account stop being acceptable at once,
  but the old application shows the invitee only a generic "We couldn't complete your account setup" (it does not
  know the new `resend_required` answer), and Super Admins have no "Send sign-in link" button — already-registered
  invitees are stranded until the application is deployed.
- **Magic Link template before the application:** sign-in e-mails point to `/auth/recover`, which the old
  application does not have (page not found).
- **Magic Link template before the database:** links open, but completing recovery fails (generic message).
- **Turning the recovery switch on before the staging `amr` check:** if Supabase's `amr` values differ from what the
  database expects, every recovery fails with "We couldn't confirm that you just signed in from the email link".
  (With the switch off — the default — Super Admins simply cannot send recovery e-mails yet.)
If the order was wrong, finish the missing steps in the order above; nothing needs to be undone.

## 1. Preconditions (all must be true — stop otherwise)
1. Local: the full local suite passes on a throwaway database (`node tests/question-import-db/run.mjs`, plus
   `node tests/auth/run.mjs` and `node tests/user-management/run.mjs`), including
   `zz-invitation-binding-upgrade.test.mjs` (order and rollback) and `zz-invitation-recovery.test.mjs`.
2. Dashboard settings (look only): public sign-ups OFF, Confirm email ON, Secure email change ON, Azure disabled.
3. The counts in section 6 have been run and written down (counts only).
4. A **verified, restorable** backup exists (section 2) and its restore was rehearsed (section 3).
5. A quiet window: no Super Admin is inviting users while you work.
6. Staging prerequisites for recovery are done (sections 5a and 5) — or recovery stays unused until they are.
7. The application version with P5.2 is already deployed (section 0a, step 1).

## 2. Backup — must be restorable, keep permissions and authentication data
The backup must be **verified by the rehearsal in section 3** before anything is applied.

> **Current environment (reported by the project owner, 2026-10-14): Supabase Free plan, PostgreSQL 17.6.1.**
> **Managed daily backups and Point-in-Time Recovery (PITR) are not available on this plan.** Option A below does
> not apply; **option B is the only backup method**. Supabase's own guidance is that Free plan projects export their
> data themselves with the Supabase CLI (`supabase db dump`) and keep off-site copies.

**A. Supabase-managed backup — not available on the current Free plan**
Applies only after an upgrade to a plan that includes it. Dashboard → your project → **Database → Backups**.
Confirm a daily backup (or a PITR point) exists from **after** the last schema change. Write down its timestamp.

**B. A complete logical dump you keep (the required method on the Free plan)**
Use Supabase's documented CLI method (roles, schema, data). You run it yourself; the tools are installed by you,
not by this project.

**Prerequisites — STOP if any is missing:**
- **Supabase CLI** installed.
- **Docker Desktop** installed **and running**: the CLI's `db dump` runs `pg_dump` inside a Docker container
  built from Supabase's Postgres image, so the dump matches the project's version. On Windows, Docker Desktop
  needs WSL 2 or virtualisation and administrator rights to install.
- `psql` (PostgreSQL client tools) for the restore in section 3.
- **Checked on this machine (2026-10-14): neither the Supabase CLI nor Docker is installed** (only the
  PostgreSQL 18.6 client tools are). Option B **cannot be run here** until both are installed and working
  (`docker info` succeeds, `supabase --version` prints a version) — or it is run from another machine that has them.
- **Do not substitute a plain local `pg_dump`.** It is not Supabase's supported method: it includes Supabase's
  internal schemas and reserved roles, which cause permission errors on restore, and nothing here has proven
  that such a dump restores correctly.

1. Create a folder **outside the repository**, for example `D:\arsene-backups\<yyyymmdd-hhmm>\` on an encrypted
   drive. Run every command from that folder (never from the repository; `*.dump`, `*.backup` and `/backups/` are
   git-ignored only as a safety net).
2. Dashboard → **Connect** → copy the *Session pooler* connection string (Supabase's default; use the direct
   connection only if your network supports IPv6 or the IPv4 add-on is enabled). Keep it only in memory:
   ```powershell
   $s = Read-Host "Connection string (input hidden)" -AsSecureString
   $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
   $env:SUPABASE_DB_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
   [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
   ```
3. Dump (three files):
   ```powershell
   supabase db dump --db-url "$env:SUPABASE_DB_URL" -f roles.sql --role-only
   supabase db dump --db-url "$env:SUPABASE_DB_URL" -f schema.sql
   supabase db dump --db-url "$env:SUPABASE_DB_URL" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
   ```
   (The two `-x` exclusions are part of the data-dump command in Supabase's backup guide.)
   Do **not** use `--no-privileges` or a single-schema dump: a restore without grants would expose tables and
   functions that are deliberately revoked, and `public.profiles` depends on `auth.users`.
4. Clear the secret: `Remove-Item Env:SUPABASE_DB_URL; Remove-Variable s, b`.
5. Record: date/time, project, folder, file sizes. The files contain personal data — `data.sql` is expected to
   contain the Auth account records (including password hashes) — keep them encrypted, never in the repository,
   chats or tickets. Until section 3 has passed, this dump is **not** a verified backup.

## 3. Restore rehearsal (before applying anything)
Prove the backup can be restored **without touching the live project**:
1. Create a new, temporary Supabase project (same region, **PostgreSQL 17**). On the Free plan the number of active
   projects is limited — confirm a free slot exists first; if not, STOP (do not pause or delete the live project).
2. Option A (managed backup → restore to a new project) is **not available on the current Free plan**. Option B:
   with the new project's connection string (entered as in 2.B.2):
   ```powershell
   psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql --command "SET session_replication_role = replica" --file data.sql --dbname "$env:REHEARSAL_DB_URL"
   ```
   `SET session_replication_role = replica` switches triggers off while the data loads. This is essential here:
   with triggers on, the 0017 audit guard would overwrite every audit row's `occurred_at` and `actor_id`, and the
   `on_auth_user_created` trigger would create duplicate profiles. One transaction: any error = nothing restored.
   For the errors Supabase's guide lists, use only its documented fixes, and write down each one used:
   comment out `ALTER ... OWNER TO "supabase_admin"` lines in `schema.sql`; comment out the line
   `GRANT "postgres" TO "cli_login_postgres" ...` in `roles.sql` on "permission denied to grant role"; run
   `DROP ROLE IF EXISTS cli_login_postgres;` if the error says role "postgres" is a member of it. Any other error:
   STOP — the backup is not proven restorable.
   The local `psql` is 18.6 while the project runs PostgreSQL 17 — this combination is **not yet proven**; the
   rehearsal is what proves (or disproves) it.
3. **Auth trigger.** Supabase's guide says objects you added to the `auth` schema (triggers, policies) are not
   restored by this method and must be recreated. This project adds exactly one: the `on_auth_user_created` trigger
   (`supabase/migrations/0002_profiles_roles.sql`, the `drop trigger … create trigger …` statements at lines
   144–148; its function `public.handle_new_user` is in `public` and is restored with the schema). Check D below
   shows whether it is present; if not, run those statements in the **rehearsal** project and record that this step
   is needed for every restore.
4. On both the live project and the rehearsal project run the counts-only check below and compare (they must match):
   ```sql
   select (select count(*) from auth.users) as auth_users, (select count(*) from public.profiles) as profiles,
          (select count(*) from public.user_invitations) as invitations, (select count(*) from public.user_admin_events) as audit_rows,
          (select count(*) from public.batch_students) as enrolments,
          has_function_privilege('anon', 'public.accept_user_invitation()', 'execute') as anon_can_accept;  -- must be false
   ```
5. **Additional restore-integrity checks — DRAFT, NOT YET VALIDATED.** The queries below have **not been run
   anywhere yet** (not even on the local throwaway database). Before relying on them, run them on the local test
   database (`tests/question-import-db`) and correct any error; until then a failing or erroring query means "not
   checked", never "passed". Run each on **both** the live project and the rehearsal project; every value must match.
   ```sql
   -- A. Audit history: row counts, first/last timestamp and a per-row fingerprint of time and actor
   --    (proves timestamps/actors were not re-stamped by the 0017 guard). Add public.course_events only for a
   --    backup taken after 0030.
   select 'user_admin_events' as audit_table, count(*) as rows, min(occurred_at) as first_at, max(occurred_at) as last_at,
          md5(coalesce(string_agg(id::text || '|' || extract(epoch from occurred_at)::text || '|' || coalesce(actor_id::text, '-'), ',' order by id), '')) as fp
     from public.user_admin_events
   union all
   select 'enrollment_events', count(*), min(occurred_at), max(occurred_at),
          md5(coalesce(string_agg(id::text || '|' || extract(epoch from occurred_at)::text || '|' || coalesce(actor_id::text, '-'), ',' order by id), ''))
     from public.enrollment_events
   union all
   select 'completion_events', count(*), min(occurred_at), max(occurred_at),
          md5(coalesce(string_agg(id::text || '|' || extract(epoch from occurred_at)::text || '|' || coalesce(actor_id::text, '-'), ',' order by id), ''))
     from public.completion_events
   union all
   select 'test_security_events', count(*), min(occurred_at), max(occurred_at),
          md5(coalesce(string_agg(id::text || '|' || extract(epoch from occurred_at)::text || '|' || coalesce(actor_id::text, '-'), ',' order by id), ''))
     from public.test_security_events;

   -- B. Sequence values (identity columns included) — new codes and ids must not repeat after a restore
   select sequencename, last_value from pg_sequences where schemaname = 'public' order by sequencename;

   -- C. Security structure: policies, functions (with a source and privilege fingerprint), RLS-enabled tables
   select
     (select count(*) from pg_policies where schemaname = 'public') as policies,
     (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as functions,
     (select md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '-'), ',' order by p.oid::regprocedure::text))
        from pg_proc p where p.pronamespace = 'public'::regnamespace) as functions_fp,
     (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relrowsecurity) as rls_tables,
     (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as tables_without_rls,
     (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '-'), ',' order by c.relname))
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')) as table_privileges_fp;

   -- D. The Auth trigger (step 3) — expected: 1 on live, and 1 on the rehearsal project after step 3
   select count(*) as auth_user_trigger from pg_trigger
    where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created' and not tgisinternal;
   ```
   Also sign in to the rehearsal project's Auth with one **test** account if possible (proves Auth accounts work).
6. Delete the temporary project. Write down that the rehearsal passed — including which documented restore fixes
   were needed, whether step 3 was needed, and the results of checks A–D.

## 3a. What a "restore" means on the Free plan — not an in-place rollback
On the Free plan a backup made with option B is restored into a **new, empty Supabase project** — it is **not** an
in-place rollback of the live project. Using it for recovery means **moving the application to that new project**:
- **Switch the application**: replace `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` in the hosting environment with the new project's values and redeploy (values are
  never written into the repository, chats or tickets).
- **Recreate the Auth trigger** (section 3, step 3) if the rehearsal showed it is not restored.
- **Reconfigure dashboard-only settings** — they are not in the dump: Auth settings (public sign-ups OFF, Confirm
  email ON, Secure email change ON, Azure disabled), Site URL and redirect URLs, e-mail templates (including the
  Magic Link template of section 5), and any custom SMTP settings.
- **Plan for everyone to sign in again**: sessions issued by the old project are not valid on the new one. E-mail
  links already sent (invitations, sign-in links) point to the old project and must be re-sent where needed.
- **Keep the old project unchanged** (do not delete or modify it) until the new one is verified.
- Everything written to the old project after the backup is **not** in the new project — record it so it can be
  re-entered. Plan the switch as an outage and announce it.

## 4. Apply (SQL Editor of the live project)
1. Dashboard → **SQL Editor → New query**. Paste the full contents of
   `supabase/migrations/0029a_invitation_binding_and_recovery.sql`. Run. It is one transaction with a preflight and
   a postflight: any error means **nothing** was changed. Do not run it twice (a re-run is refused).
2. Do **not** apply 0030 in the same window unless that is a separate, approved change with its own runbook.

## 5. Verify (read-only) and staging prerequisites
```sql
select p.proname, p.prosecdef as definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('accept_user_invitation', 'begin_invitation_recovery', 'complete_invitation_recovery', 'invitation_recovery_candidate')
 order by 1;
select position('0029a: never accepted by e-mail match alone' in p.prosrc) > 0 as binding_rule
  from pg_proc p where p.oid = 'public.accept_user_invitation()'::regprocedure;
```
Expected: four rows with `definer = true`, `config = {search_path=""}`, `anon = false`, `authenticated = true`;
`binding_rule = true`.

### 5a. Staging preparation (before any recovery check)
No staging environment is assumed to exist; if there is none, create it first (outside this runbook's scope). It must
be ready on **all** of these points before the checks below start:
- **Separate from production.** Its own Supabase project and its own application deployment. The staging application
  must point only at the staging project (its own `NEXT_PUBLIC_SUPABASE_URL`, publishable key and
  `NEXT_PUBLIC_APP_URL` = the staging URL) — never at the production database, and never with production secrets.
- **Same database shape as production after this change:** migrations 0001–0029, then 0029a (the same files as in
  this repository; applied in the staging SQL Editor). Do not apply 0030 there for these checks unless it is part of a
  separate, planned course-management test. Run the section 5 verification query on staging too.
- **Same application version** as the one to be released to production (the build containing P5.2).
- **Same Authentication settings as production** (section 1, item 2): public sign-ups OFF, Confirm email ON, Secure
  email change ON, Azure disabled; URL Configuration with the staging Site URL and redirect URLs.
- **No real personal data.** Use test accounts only — at least: an active Super Admin; an active student or trainer;
  and an invited account that can be stranded (invite a test address you control, open the invitation link, then let
  the invitation expire or revoke it and invite the address again so Auth refuses with "already registered").
  You must be able to read every test mailbox.
- **E-mail delivery that works and is permitted for those addresses** (Supabase's built-in sender with its low limits,
  or a staging SMTP configuration), so invitation and sign-in e-mails actually arrive.
- **The recovery switch:** `INVITATION_RECOVERY_EMAILS_ENABLED=true` for the staging application only (step below).

**Before anyone uses "Send sign-in link" (recovery), on a STAGING project first.** The switch is set per deployment:
turn it **on in STAGING only** — `INVITATION_RECOVERY_EMAILS_ENABLED=true` for the staging application (server-only
variable; restart/redeploy staging) — so that steps 2–4 below can send and complete recovery links. In
**PRODUCTION keep it absent or not `true`** (disabled) until every step below has passed on staging; only then set it
in production (section 0a, step 3).
1. **STAGING project** Dashboard → **Authentication → Emails → Templates → Magic Link**: the link must be
   `{{ .SiteURL }}/auth/recover?token_hash={{ .TokenHash }}&type=email` (the page consumes nothing until the
   person presses Continue, so mail scanners cannot use the link up). **URL Configuration**: Site URL = the staging
   app URL. (The template is per Supabase project: setting it in staging does **not** change production.)
2. Check the **real `amr` claim**: with a staging test account, send a sign-in link, open it, press Continue, then
   decode the session's access-token payload *locally* (never on a website) and confirm `amr` contains an entry with
   method `otp` (or `magiclink`) and a current Unix `timestamp`. `complete_invitation_recovery` relies on this
   (fresh e-mail sign-in < 15 min). **Until this is confirmed, do not describe the recovery mailbox check as verified.**
3. Run one complete recovery on staging (already-registered test address → Send sign-in link → open → Continue →
   set password → portal) and confirm the account history shows "Sign-in link requested…" and "Invitation linked…".
4. Check that the link is **not** a passwordless login: request a sign-in e-mail for an ACTIVE staging test account
   (e.g. via Supabase's API with the publishable key), open it, press Continue — the session must be ended and the
   browser must land on `/login` with "That link can only be used to finish setting up an invited account…",
   never on a portal page. Also confirm in the browser's developer tools that no `sb-…-auth-token` cookie is left.
   If the browser lands on `/auth/recover/incomplete` ("Sign-in not completed") instead, the application could not
   confirm the session was closed — see the limitation below before enabling recovery.
5. Supabase's built-in e-mail sender has a low hourly limit; configure custom SMTP if more than a few e-mails per
   hour are expected.

Only when steps 1–5 have all passed on staging: enable the switch in production (section 0a, step 3). Until then
production keeps "Send sign-in link" turned off.

**Production template (before the production switch).** Production needs its **own** verified Magic Link template:
in the **PRODUCTION project** Dashboard set the same link (`{{ .SiteURL }}/auth/recover?token_hash={{ .TokenHash }}&type=email`)
and check URL Configuration (Site URL = the production app URL). Verify it without touching real users: read the
saved template and Site URL back, and — if you have a production test mailbox you control — request one sign-in
e-mail for that test account and check only that the link's host and path are the production `/auth/recover`
(there is no need to complete it). Only after this is the production switch turned on.

**Known limitation (session clean-up).** The recovery flow ends any session it should not keep with Supabase's
local sign-out (`scope: "local"`) and then calls `getSession()`; if a session is still reported (or the sign-out
throws, or the read fails) it sends the browser to `/auth/recover/incomplete`, a page that redirects nobody and
offers "Close the session on this device".
What `endSession()` checks: the Supabase client's own **in-memory** session state for this request. In
`@supabase/ssr` (0.12.7) the server client records a removal in memory, and `getSession()` answers from that record
without reading the cookies again; the browser cookies are written separately, when the sign-out event makes the
library call the project's `setAll` (`src/lib/supabase/server.ts`), which swallows its own errors. So "ended" means
"the Supabase client dropped the session and nothing threw" — it does **not** prove that the browser cookie was
deleted. In practice the cookies that verifyOtp created in the same server action go through the same `setAll`, so a
failing `setAll` would also have stopped them from reaching the browser; confirm in the staging step above (no
`sb-…-auth-token` cookie left) before turning recovery on. If the network call to Supabase fails, the already-issued
token is not revoked at Supabase and stays valid until it expires (not verified whether a browser could have
received it earlier in the same request).

## 6. Counts-only queries (before and after; never select addresses)
```sql
-- Q1. Pending invitations and how many are unbound (unbound = cannot be accepted after 0029a without a resend/recovery)
select i.intended_role, i.delivery_status, count(*) as pending,
       count(*) filter (where i.auth_user_id is null) as unbound,
       count(*) filter (where i.auth_user_id is null and i.expires_at <= now()) as unbound_expired
  from public.user_invitations i where i.status = 'pending' group by 1, 2 order by 1, 2;

-- Q2. Potentially stranded: unbound pending invitations whose address already has a CONFIRMED Auth account
--     (a resend will be refused as "already registered" → use "Send sign-in link" in Users)
select i.intended_role,
       count(*) filter (where u.id is null)                                       as no_account,
       count(*) filter (where u.id is not null and u.email_confirmed_at is null)  as unconfirmed_account,
       count(*) filter (where u.email_confirmed_at is not null)                   as confirmed_account
  from public.user_invitations i
  left join auth.users u on lower(btrim(u.email)) = i.email_normalized
 where i.status = 'pending' and i.auth_user_id is null
 group by 1 order by 1;

-- Q3. Confirmed invited accounts that never activated
select count(*) as confirmed_never_activated
  from public.profiles p join auth.users u on u.id = p.id
 where p.account_status = 'invited' and u.email_confirmed_at is not null;
```
After applying: unbound **unconfirmed/no-account** invitations → Super Admin uses *Resend invitation* (a successful
send binds it); unbound **confirmed** ones → *Send sign-in link* on the account in Users (after section 5).
Expired ones → create a new invitation.

## 7. Roll back (only before 0030)
- SQL Editor → paste `supabase/rollback/0029a_rollback.sql` → Run. It restores exactly the 0022 function (checked
  by fingerprint), removes the recovery functions and the three columns (pending recovery requests are discarded;
  accepted/bound invitations and audit rows stay), and refuses to run unless 0029a is the current version and 0030
  is absent. The two audit event types remain (PostgreSQL cannot drop enum values; nothing uses them afterwards).
- This re-opens unbound acceptance — re-apply 0029a as soon as the cause is fixed.
- After 0030 is applied, 0029a cannot be rolled back on its own. The only way back is the backup from section 2 —
  and on the Free plan that is **not** an in-place rollback: it means moving the application to a new Supabase
  project (section 3a — new URL and keys, dashboard settings redone, everyone signs in again, later data lost).

## 8. Record
Write down (no personal data): backup timestamp/location, rehearsal result (documented restore fixes used, whether
the Auth trigger had to be recreated, checks A–D), the time 0029a was run, verification
output, Q1–Q3 before/after, the staging `amr` result, and who performed each step.
