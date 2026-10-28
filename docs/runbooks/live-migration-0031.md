# Runbook — live database change: 0031 (positive course and module durations)

**Status: for review. Nothing in this runbook has been run against live Supabase.**
Applies to: the live Supabase project of the ARSÈNE SPI Training Platform. Live has migrations **0001–0030
(+0029a)**; 0030 was applied through the SQL Editor and verified. 0031 is **not** applied. No staging environment
is assumed to exist. There is no `supabase_migrations.schema_migrations` history on live: **never use
`supabase db push`** — apply only as described in section 6, after the project identity check in section 2a.
Never paste connection strings, passwords, keys, tokens, e-mail addresses or other personal data into chats,
tickets, screenshots or files in this repository. Every query below is read-only unless it says otherwise.

## 0. What 0031 does

`supabase/migrations/0031_positive_course_module_durations.sql` — **approved SHA-256
`51bba9428b2675c13a42809169ffcee62edc34313d69ab55604c568342a6f6b7`** (334 lines, UTF-8, LF line endings).

Approved rule: a course's planned duration and a module's planned duration must be **more than 0 hours** (still at
most 9999.9 and at most one decimal place). 0031 replaces four 0030 Super Admin functions with their exact 0030
text plus that check — nothing else:

| Function | Change |
|---|---|
| `admin_create_course(jsonb)` | hours must be more than 0 |
| `admin_update_course(uuid, jsonb)` | hours that are **set or changed** must be more than 0 |
| `admin_create_module(uuid, jsonb)` | hours are now **required** (a missing value is no longer stored as 0) and must be more than 0 |
| `admin_update_module(uuid, jsonb)` | hours that are **set or changed** must be more than 0 |

- `CREATE OR REPLACE` keeps signatures, owner and grants (EXECUTE for `authenticated`, none for `anon`/`public`);
  `SECURITY DEFINER` and `search_path ''` are restated. The Super Admin check and the `course_events` audit
  logging are unchanged parts of the bodies.
- **No table, constraint, policy, trigger, grant or row is changed.** No table constraint is added on purpose.
- **Zero-hour legacy records must remain unchanged.** Courses and modules that already have 0 hours (at least one
  is known on live) are **not** modified by 0031, by this runbook, or by its checks. They stay editable for their
  other fields; only a new or changed duration is checked. Correcting them is a separate, approved data task
  done through the application — never in the SQL Editor or Table Editor.
- One transaction with a **preflight** (0030 applied; the four functions exactly their 0030 versions by whole-body
  fingerprint; 0031 not already applied; a partial state refuses) and a **postflight** (the 0031 fingerprints,
  `SECURITY DEFINER`, `search_path ''`, `authenticated` EXECUTE, no `anon` EXECUTE). Any error changes nothing.
- A scripted, in-place rollback exists: `supabase/rollback/0031_rollback.sql` (section 8).

## 1. Application compatibility — must be documented and verified, not assumed

The database and the application are deployed separately, so for a while one of the two is the "old" side. The
order below is **recommended**, but it is only safe once the checks in this section and in section 4 pass.

**Recommended order:** (1) deploy the application version that contains the positive-duration change;
(2) verify it on live against the 0030 database (section 4); (3) apply 0031 (sections 5–6).

Why the new application should work on a 0030 database (expected — verify in section 4):
- It validates hours before calling the database (more than 0, at most 9999.9, one decimal place) and sends only
  values the 0030 functions also accept.
- Add Module always sends planned hours; an empty field is refused in the form, never sent as 0.
- Edit course and Edit module send `duration_hours` **only when it was changed**, so a 0-hour legacy course or
  module can still have its title or description edited, under 0030 and under 0031.
- A database refusal (SQLSTATE 22023) is shown as a generic invalid-input message
  (`course-management.repository.core.ts`); under 0030 the database never raises the new message.

Known gap while the application is deployed but 0031 is not: the **database** still accepts 0 hours from any
caller that is not the application (for example a direct RPC by a signed-in Super Admin). It closes when 0031 is
applied. Keep this window short.

The other order — 0031 first with the **previous** application — is **not recommended**: the previous Add Module
form turns an empty hours field into 0, which 0031 refuses with only a generic error message. Editing a 0-hour
module's title in the previous application sends the unchanged 0, which 0031 accepts.

**STOP** if the deployed application version cannot be identified, or if any section 4 check fails.

## 2. Prerequisites (all must be true — **STOP** otherwise)
1. **The full local database test suite passes with 0031 loaded before production approval:**
   `node tests/question-import-db/run.mjs` on a throwaway database (it loads 0001–0031 + 0029a). Run the full suite,
   not a subset — passing affected tests alone is **not** sufficient. Record the pass/fail counts.
2. `node tests/courses/run.mjs` passes, and type checking and lint are clean.
3. The rollback script is covered by the committed test
   `tests/question-import-db/zz-course-duration-rollback.test.mjs` (part of the full suite in step 1, on a throwaway
   database): it refuses on a 0030 database and after drift, replacing nothing; it restores the exact 0030
   fingerprints with the same owner, `SECURITY DEFINER`, `search_path` and ACL; it changes no course, module or
   `course_events` row; a second run is refused; 0031 can be applied again afterwards.
4. The migration file and the rollback script are reviewed and committed. The application change is reviewed,
   committed, and deployed (section 1). Record the commit of each.
5. A verified backup taken immediately before 0031 (section 3).
6. A quiet window: no Super Admin is creating or editing courses or modules.
7. You can sign in to the application as a Super Admin.

## 2a. Live project identity — before ANY live database operation
Do this **before the first live database operation of this runbook** (the backup in section 3) and again wherever
a later section says so. **Expected values:** the live project's **name** and **project reference**, recorded
independently by the person responsible before the window (for example in their own infrastructure record) —
**never** taken from a chat, a ticket, this repository, or the screen you are about to check.
1. **Dashboard:** the selected project's name and reference (Project Settings → General, and the `/project/<ref>`
   part of the dashboard URL) both equal the expected values.
2. **Backup connection (section 3):** the connection string copied from **that** project's Connect dialog contains
   the expected reference (the session pooler user is `postgres.<ref>`; a direct host is `db.<ref>.supabase.co`).
   Check it without displaying it, for example
   `$env:SUPABASE_DB_URL -match [regex]::Escape("<expected-ref>")` → must print `True`.
3. **Application (section 4):** the hosting environment's `NEXT_PUBLIC_SUPABASE_URL` (a public URL, not a secret)
   is `https://<expected-ref>.supabase.co`. Never open or copy the keys.
4. **SQL Editor (sections 4–8):** before each SQL Editor session (and again in every new tab or browser session),
   repeat check 1.

If any value differs, or cannot be verified: **STOP** — do not take the backup, run SQL or test in the application.
Record the confirmed name and reference, and which checks (1–4) were done when (not secrets; no keys or connection
strings).

## 3. Backup (immediately before 0031 — required)
Use `docs/runbooks/live-migration-0029a.md`, **section 2, option B** (Supabase CLI three-file dump: roles, schema
and data; files kept outside the repository; the connection string kept only in memory, then cleared). It needs
the Supabase CLI **and Docker Desktop (running)**. Do not substitute a plain local `pg_dump`. Supabase Free plan:
no managed backups or Point-in-Time Recovery.
- **First:** section 2a, checks 1 and 2 (the connection string must belong to the expected project).
- The backup timestamp must be **later than** the time 0030 was applied and earlier than the 0031 run. Record both.
- 0031 has a scripted, in-place rollback (section 8), so this backup is the last-resort safety net. Restoring it
  means a **new project** (0030 runbook, section 7) and losing everything written after the backup.

**The backup counts as verified only when B1–B5 below all pass and are recorded.** Until then it is "taken, not
verified". **STOP** (do not continue to section 4) if any check fails, errors, or cannot be done — for example when
no free project slot exists for B5. Never record a check as passed that was not run.

- **B1 — Commands.** All three `supabase db dump` commands ended without an error message. Record the
  `supabase --version` and `docker version` output (versions only) and the dump start and end times.
- **B2 — Files, sizes and hashes.** `roles.sql`, `schema.sql` and `data.sql` exist in the backup folder **outside
  the repository**, and each is larger than 0 bytes. Record each file's size and SHA-256, without opening the files:
  ```powershell
  Get-ChildItem roles.sql, schema.sql, data.sql | Select-Object Name, Length
  Get-FileHash -Algorithm SHA256 roles.sql, schema.sql, data.sql | Select-Object Path, Hash
  ```
  Keep the hashes with the backup record: before any later restore, recompute them — a mismatch means the files
  changed, so the backup must not be used.
- **B3 — Contents (counts only, no data displayed).** Each command must print a number greater than 0. These
  patterns were written for `pg_dump`-style output (quoted or unquoted names, optional `IF NOT EXISTS`) and have
  **not yet been run against a real Supabase CLI dump**: a 0 or an error means "not verified" — STOP and review the
  pattern with the person responsible; never open `data.sql` to look instead (it holds personal data).
  ```powershell
  (Select-String -Path schema.sql -Pattern 'CREATE TABLE (IF NOT EXISTS )?"?public"?\."?courses"?').Count
  (Select-String -Path schema.sql -Pattern 'admin_create_course').Count
  (Select-String -Path schema.sql -Pattern 'course_events').Count
  (Select-String -Path data.sql -Pattern 'COPY "?public"?\."?courses"?').Count
  (Select-String -Path data.sql -Pattern 'COPY "?public"?\."?modules"?').Count
  ```
- **B4 — Live baseline at backup time (the only live side of every B5 comparison).** Immediately after the dump
  ends, still in the quiet window, repeat section 2a check 1 in the Supabase Dashboard and then, in that same
  verified SQL Editor session, run on the live project and record:
  - the counts-only query of `docs/runbooks/live-migration-0029a.md`, section 3, step 4 (counts and one `true`/`false`
    value — no personal data);
  - **P3** and **P4** (section 5).

  This recorded B4 baseline is what B5 compares the restored project with; the counts query is **not** run on live
  again at B5 time. The baseline is valid only if **no write that could change a B4 value** (Auth accounts,
  profiles, invitations, enrolments, audit rows, courses, modules, course events, or database functions, policies
  and triggers) **reached live between the start of the dump and the end of B4**. If such a write may have happened
  in that interval — a legitimate one included (for example an accepted invitation, a new account or a course
  change), or if this cannot be ruled out — the backup and the baseline no longer describe the same state:
  **discard both and repeat B1–B4** (a new dump and a new baseline) inside the quiet window. Never adjust, explain
  away or "attribute" a difference instead.
- **B5 — Restore validation in an isolated environment.** Restore the three files into a **new, temporary Supabase
  project** — never the live project — and compare it with the B4 baseline, in exactly this order. Each step
  starts only after the previous one is complete; no step relies on a later one for its protection.
  1. **Create the temporary project** as in `docs/runbooks/live-migration-0029a.md`, section 3, step 1, and record
     its name and project reference.
  2. **Temporary connection string.** Use a separate connection string variable for the temporary project and
     confirm, as in section 2a check 2, that it contains the **temporary** project's reference (step 1) and **not**
     the independently recorded live reference (section 2a). Do not continue until this is confirmed.
  3. **Temporary SQL Editor project — before ANY SQL Editor operation on the temporary project**
     (including the Auth trigger statements and the trigger check in step 4). In the Supabase Dashboard, confirm
     that the SQL Editor's selected project is the **temporary** project: its name, and a project reference that
     equals the reference in the temporary connection string (step 2) and differs from the independently recorded
     live reference (section 2a). Repeat this check in every new SQL Editor tab or browser session used for the
     temporary project. If any of this cannot be confirmed, or the SQL Editor shows the live project, **STOP** —
     never run SQL meant for the temporary project against live.
  4. **Restore.** Follow `docs/runbooks/live-migration-0029a.md`, **section 3**, steps 2–3, against the temporary
     project only: the `psql` restore with the connection string checked in step 2 (one transaction with
     `ON_ERROR_STOP`, triggers off while the data loads, only the documented fixes, each recorded), then the Auth
     trigger step — its trigger check (check D) and, if needed, the `drop trigger … create trigger …` statements —
     only in the SQL Editor confirmed in step 3.
  5. **Live side of the comparison = the B4 baseline.** The live-project identity check (section 2a check 1) and
     the live counts query were done in B4, immediately after the dump; nothing is run on live in B5.
  6. **Checks on the temporary project**, only in the SQL Editor confirmed in step 3 (repeat step 3 first if the tab
     or session changed). Run the same counts-only query as in B4: every value must equal the B4
     value. P1 returns `true`, `true`; P2 returns four rows with `is_0030 = true`, `security_definer = true`,
     `search_path_empty = true`, `authenticated_exec = true`, `anon_exec = false`; P3 and P4 equal the B4 values
     exactly. Any difference means the restore is not faithful **or** live changed during B1–B4: in both cases the
     backup is **not verified** — STOP; do not explain the difference away (repeat B1–B5 if live may have changed).
  7. **Record, then delete.** Record all B5 evidence (the step 4 fixes used, the step 6 values, and whether the Auth
     trigger statements were needed). Only then delete the temporary project, and record that it was deleted.

  **B5 passes only when all of these hold:** (a) the restore procedure completed successfully — no error in its
  single transaction, and only the documented fixes used, each recorded; (b) the counts-only query on the temporary
  project equals the B4 baseline exactly; (c) P1–P4 on the temporary project match the expected values in step 6,
  and P3 and P4 equal the B4 baseline exactly. Checks A–D in the 0029a runbook (section 3, step 5) are marked draft
  there: for this procedure they are **informational only** until separately validated — record their output if
  run, but they are **not** B5 pass criteria. This restore procedure has **no recorded successful run yet**: the
  first B5 run that passes is the first recorded evidence that it works (including the local psql 18 restore into
  PostgreSQL 17 that the 0029a runbook notes as unproven) — record it as such.

## 4. Application compatibility checks (after the application deployment, before 0031)
Do these in the application on live, as a Super Admin, with a clearly labelled **TEST Draft** course. **Do not
publish it** — only a never-published Draft can be deleted again. **Do not edit any existing course or module.**
0. **Before any test below**, repeat section 2a checks 3 (the application points at the expected project) and 1
   (the SQL Editor's project), then run the P3 query (section 5) in the SQL Editor of the live project and record every
   value as the **original P3 baseline**. Every later P3 comparison (step 5, section 5, V3, section 8) is against
   this original baseline, never against a later run.
1. Add Course → title `ZZ 0031 check <date>`, Draft, hours **0** → refused in the form; nothing saved (the list
   is unchanged). Hours empty → refused. Hours **2** → saved, with a `CRS-…` code.
2. Open the test course → Add module with hours empty → refused; hours **0** → refused; hours **1** → saved (`M01`).
3. Edit that module's **title only** → saved. Edit the course **description only** → saved; Course history shows
   "Details changed: description."
4. Clean-up: **Delete course** on the test course → success. If deletion is refused, follow 0030 runbook section
   5c step 4 (Deactivate; never delete it in SQL); record its code.
5. Run P3 again and compare it with the original P3 baseline (step 0) using the rules in section 5, P3.
- **STOP** (do not apply 0031) if any result differs. The application can stay on 0030 or be rolled back to its
  previous version; the database is unchanged.

## 5. Read-only preflight (SQL Editor of the live project)
First repeat section 2a check 1 in this SQL Editor session. Run each query and compare with the expected result.
**If any result differs, STOP** — do not apply 0031.

**P1 — 0030 applied, 0031 not applied**
```sql
select to_regclass('public.course_events') is not null  as course_events,
       to_regclass('public.course_code_seq') is not null as course_code_seq;
```
Expected: `true`, `true`.

**P2 — the four functions are exactly their 0030 versions, with attributes and grants**
```sql
select x.signature,
       md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) = x.fp_0030 as is_0030,
       p.prosecdef as security_definer,
       p.proconfig = array['search_path=""'] as search_path_empty,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec
  from (values
    ('public.admin_create_course(jsonb)',       '620460b943f6e2e8b7cbc5da78f2a1d0'),
    ('public.admin_update_course(uuid, jsonb)', '91ee8f6a9843e45904ff2aeb8ef74966'),
    ('public.admin_create_module(uuid, jsonb)', 'a8c18b39b659eafbebe9c167d9b1a0cf'),
    ('public.admin_update_module(uuid, jsonb)', '77162d7b0e422a0aa89ede5e4018221b')
  ) as x(signature, fp_0030)
  left join pg_catalog.pg_proc p on p.oid = to_regprocedure(x.signature)
 order by 1;
```
Expected: four rows, each `is_0030 = true`, `security_definer = true`, `search_path_empty = true`,
`authenticated_exec = true`, `anon_exec = false`. A row with `is_0030 = false` or null: **STOP**. If all four match
the 0031 fingerprints instead (section 7, V1), 0031 is already applied — do not run it again.

**P3 — zero-hour baseline (counts and a fingerprint only; no titles or personal data)**
```sql
select (select count(*) from public.courses)                                as courses,
       (select count(*) from public.courses where duration_hours = 0)       as zero_hour_courses,
       (select count(*) from public.modules)                                as modules,
       (select count(*) from public.modules where duration_hours = 0)       as zero_hour_modules,
       (select md5(coalesce(string_agg(id::text || ':' || duration_hours::text || ':' || updated_at::text, ',' order by id), ''))
          from public.courses where duration_hours = 0)                     as zero_courses_fp,
       (select md5(coalesce(string_agg(id::text || ':' || duration_hours::text || ':' || updated_at::text, ',' order by id), ''))
          from public.modules where duration_hours = 0)                     as zero_modules_fp,
       (select count(*) from public.course_events)                          as course_events;
```
The **original P3 baseline** is the run recorded in section 4, step 0, **before** any application test. Run P3
again here and compare it with that original baseline:
- `zero_hour_courses`, `zero_hour_modules`, `zero_courses_fp`, `zero_modules_fp`: **exactly equal**. No exception.
- `courses`, `modules`: equal. The only permitted difference is a section 4 test course that could not be deleted
  and was deactivated instead (section 4, step 4): then +1 course and its one module (positive hours), with its
  `CRS-` code recorded.
- `course_events`: equal or higher, by the audit rows of the recorded section 4 test course only; never lower.

Any other difference: **STOP**. The zero-hour rows are **not** to be corrected as part of this change.

**P4 — schema baseline (other functions, policies, triggers)**
```sql
select (select count(*) from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace) as public_functions,
       (select md5(string_agg(p.oid::regprocedure::text || ':' || md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')), ',' order by p.oid::regprocedure::text))
          from pg_catalog.pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname not in ('admin_create_course', 'admin_update_course', 'admin_create_module', 'admin_update_module')) as other_functions_fp,
       (select count(*) from pg_catalog.pg_policies where schemaname = 'public')                  as policies,
       (select count(*) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
         where c.relnamespace = 'public'::regnamespace and not t.tgisinternal)                    as triggers;
```
Record all values; V2 must match them exactly.

## 6. Apply (SQL Editor of the live project)
0. **Confirm the project before pasting anything** (section 2a check 1, repeated here). In the Supabase
   Dashboard, check that the selected project's **name** and **project reference** (Project Settings → General,
   and the `/project/<ref>` part of the dashboard URL) both match the intended live project, as recorded by the
   person responsible before the window — never a value taken from a chat or ticket. It must also be the same
   project in which sections 4–5 were run. If either differs, or you are unsure, **STOP**: do not paste or run
   anything. Write down the confirmed name and reference for the record (they are not secrets; no keys or
   connection strings).
1. On the machine you will paste from, verify the file's SHA-256 is exactly
   `51bba9428b2675c13a42809169ffcee62edc34313d69ab55604c568342a6f6b7`:
   PowerShell `Get-FileHash -Algorithm SHA256 supabase\migrations\0031_positive_course_module_durations.sql`, or
   `sha256sum supabase/migrations/0031_positive_course_module_durations.sql`. The hash is of the LF-terminated file
   in the repository; `.gitattributes` (`*.sql text eol=lf`) makes every checkout of a commit that contains it write
   SQL files with LF, also on Windows with `core.autocrlf=true`. If the hash differs (for example a CRLF copy from
   an older checkout or another tool), **STOP**; do not edit the file to make it match — re-export it unchanged
   from the reviewed commit with `git show <commit>:supabase/migrations/0031_positive_course_module_durations.sql
   > <file outside the repository>` run in Git Bash (PowerShell 5.1's `>` re-encodes the output), and verify again.
2. Open that exact file, select **all** of it, paste it into a new SQL Editor query, and run it **once**. Do not
   edit, split or partly select the text.
3. Expected: success with no error. Any error (including `Preflight failed …` or `Postflight failed …`) means the
   whole transaction was rolled back and nothing changed — record the message, confirm with P2, and **STOP**.

## 7. Post-deployment verification (STOP if any expected result differs)
First repeat section 2a check 1 in the Supabase Dashboard: V1–V4 must run on the same live project as section 6.

**V1 — the four functions are the 0031 versions, with attributes and grants**
Run the P2 query with these fingerprints in place of the 0030 ones:
`admin_create_course` `9bc1a7322603269f0b452ac23ea4fa2a`, `admin_update_course` `6cbf926a4e84ea6a400b17038e18efd8`,
`admin_create_module` `81b8a6995ff2cf06658e93ba682fc92c`, `admin_update_module` `6606099e4bf723e8aff28a5cb944b4fe`.
Expected: four rows, all `true` except `anon_exec = false`.

**V2 — nothing else was replaced or added:** run P4 again; every value must equal the section 5 baseline.

**V3 — zero-hour legacy records unchanged** (run it **last**, after V4)**:** run P3 again and compare it with the **original P3 baseline**
(section 4, step 0) using the rules in section 5, P3. The permitted test records are those of the section 4 **and**
V4 test courses (each recorded): `course_events` may be higher by their audit rows, and `courses` / `modules` only
by a test course that could not be deleted. The four zero-hour values must be exactly equal.

**V4 — application checks (live, Super Admin, TEST Draft course as in section 4; do not publish it)**
1. Add Course with hours 0 → refused; with 2 → saved.
2. Add module with hours empty or 0 → refused; with 1 → saved. Edit its title only → saved. Change its hours to
   0 → refused; to 3 → saved.
3. Edit the course description only → saved.
4. Delete the test course (as section 4, step 4).
5. Do **not** edit any existing 0-hour course or module on live to "test" editability: that is covered by the local
   suite (`zz-course-duration-validation.test.mjs`) and would change production data.

## 8. Stop conditions and rollback

**Stop conditions:**
- Prerequisite missing, backup not verified, or section 4 fails → do not apply 0031; nothing in the database changed.
- Preflight (section 5) differs → do not apply; investigate in a separate reviewed change.
- Apply error (section 6) → the transaction rolled back; confirm with P2; record and stop.
- V1–V4 fails → stop course and module editing, keep the window closed, and decide with the person responsible
  whether to roll back. Never edit functions, courses or modules by hand in the SQL Editor or Table Editor.

**Rollback — `supabase/rollback/0031_rollback.sql`** (not a migration; run manually in the SQL Editor of the same
project, the whole file once, in the same way as section 6):
- **Confirm the project before pasting any rollback SQL** (section 2a check 1, repeated here). In the Supabase
  Dashboard, check that the selected project's **name** and **project reference** (Project Settings → General,
  and the `/project/<ref>` part of the dashboard URL) both match the expected values recorded independently by the
  person responsible before the window — never a value taken from a chat or ticket. It must be the same project in
  which 0031 was applied (section 6). If either differs, or cannot be verified, **STOP**: do not paste or run
  anything. Record the confirmed name and reference (not secrets; no keys or connection strings).
- **Preflight:** refuses unless 0030 is applied and **all four** functions exactly match the 0031 fingerprints;
  anything else changes nothing.
- **Restores** the exact 0030 bodies of the four functions (copied verbatim from the reviewed 0030 migration),
  keeping owner and grants. `SECURITY DEFINER`, `search_path ''`, the Super Admin check and audit logging are
  part of the restored definitions.
- **Postflight:** the 0030 fingerprints, `SECURITY DEFINER`, `search_path ''`, `authenticated` EXECUTE, no `anon`
  EXECUTE.
- **Effect:** 0 hours (and missing module hours, stored as 0) are accepted again by the database. **No table or row
  is changed**: values saved while 0031 was active stay, and `course_events` rows stay. The deployed application
  keeps refusing 0 (section 1 compatibility applies), so it does not need to be rolled back with it.
- After a rollback, run P2 (expect the 0030 fingerprints) and P3 (compare with the original P3 baseline, section 4
  step 0: the four zero-hour values exactly equal; other differences only from recorded test courses or
  application changes made during the window).
- If the rollback preflight refuses (a function is neither exactly 0031 nor safely restorable): **STOP**. Do not
  edit functions by hand. The last resort is restoring the section 3 backup into a new project (0030 runbook,
  section 7).

## 9. Record (no personal data)
- [ ] Application commit and deployment time; the commits of the migration and rollback script.
- [ ] Full local database suite result with 0031 (pass/fail counts, date), including
      `zz-course-duration-rollback.test.mjs`; `tests/courses` result.
- [ ] Section 2a: the confirmed project name and reference, and when checks 1–4 were done.
- [ ] Time 0030 was applied; backup timestamp and location (later than 0030, before 0031); B1–B5 results
      (CLI and Docker versions, file sizes and SHA-256 hashes, content counts, B4 values, the restore result with
      any documented fixes used, P1–P4 on the temporary project, and its deletion). "Verified" only if B1–B5 passed.
- [ ] Section 4 compatibility results (and the code of any test course that could not be deleted).
- [ ] P1–P4 results, including the zero-hour baseline.
- [ ] Migration SHA-256 as verified on the paste machine (must be `51bba942…a6f6b7`).
- [ ] Time 0031 was run, and the SQL Editor result.
- [ ] V1–V4 results; V3 confirms the zero-hour legacy records are unchanged.
- [ ] Whether a rollback was needed, with its time and P2/P3 results afterwards.
- [ ] Who performed each step.
