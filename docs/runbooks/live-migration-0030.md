# Runbook — live database change: 0030 (Course Management)

**Status: 0030 is applied on live (historical runbook — do not run it again).**
- **Reported by the operator:** the reviewed `supabase/migrations/0030_course_management.sql` (1,310 lines,
  SHA-256 `62352c5dbc3086c76e6d68123315383e9028db47900b3a7e8a05ce36a2764ac4`) was applied through the SQL Editor,
  and a read-only check returned **"FULLY APPLIED: reviewed version"** (12 objects and 26 function fingerprints
  matched).
- **Implied, not separately recorded here:** 0029a is applied on live — the reviewed 0030 preflight refuses unless
  `accept_user_invitation()` is exactly the 0029a definition (section 3a, P3).
- **Not recorded in this repository (verify from the operator's own record — do not assume):** the dates and times
  0029a and 0030 were run, the backup taken before 0030 and its restore rehearsal (sections 2–3), the P1–P9
  results, the section 5b role probes and the section 5c application checks.

The sections below describe the procedure as reviewed for that run. Live now has migrations **0001–0030 (+0029a)**.
No staging environment is assumed to exist. The next live change is 0031 (`docs/runbooks/live-migration-0031.md`).
Never paste connection strings, passwords, keys, tokens, e-mail addresses or other personal data into chats,
tickets, screenshots or files in this repository. Every query below is read-only unless it says otherwise.

## 0. What 0030 does, and the required order

`supabase/migrations/0030_course_management.sql` (one transaction, with a preflight; **no postflight** — the
verification in section 5 is therefore manual and mandatory):
- **Course codes** `CRS-00001…` from a new sequence (started above every existing `CRS-` number) and module codes
  `M01…` per course; existing codes are never changed; codes become immutable and unique case-insensitively.
- **Writes only through Super Admin database functions** (`admin_create_course`, `admin_update_course`,
  `admin_set_course_status`, `admin_delete_course`, `admin_create_module`, `admin_update_module`,
  `admin_move_module`, `admin_delete_module`, read: `admin_course_usage`). Direct client INSERT/UPDATE/DELETE on
  `courses` and `modules` is refused — even for a Super Admin — by new triggers.
- **Audit**: new append-only table `course_events` (Super Admin read only).
- **History lock**: once a course has delivered training (batch ongoing/completed, class live/completed or past,
  attendance, test attempt, submission, completion record or certificate), its title, level, planned duration and
  module structure are locked. A module used by a class or a question can never be deleted.
- **Removal**: only a never-published, unused **Draft** course can be deleted. Active/Inactive courses are kept.
  "Never published" must be proven by the course's own `course_events` history (created as a draft through Course
  Management and never published since). A course that existed before 0030 has no such history, so it is **never
  deleted** — not even an unused legacy draft (refused as `was_published`); it can be deactivated instead.
- **Batches**: new batches only for a **published** course; a batch's course can never change afterwards.
- **Archived (Inactive) courses**: no new students into an **upcoming** batch — 0030 re-creates
  `admin_set_enrollment`, `trainer_enroll_student`, `create_user_invitation` and `accept_user_invitation`
  (the last one keeps the 0029a binding rule; 0030 refuses to run without 0029a).

> **Never change courses or modules directly in the SQL Editor or the Table Editor — before or after 0030.**
> The 0030 triggers refuse direct writes only from application users (`authenticated` / `anon`). Privileged
> writers — the SQL Editor, the Table Editor, the service role — can still write `courses` and `modules` directly
> (only course and module codes stay unchangeable for them). Such a change bypasses every validation, the history
> lock and the `course_events` audit. Use the application (Courses) for every change.

Required order — each step only after the previous one is finished **and verified**:
1. **Application first**: the application version that contains P5.2 **and** Course Management (one build) is
   deployed **before 0029a** — as required by `docs/runbooks/live-migration-0029a.md`, section 0a, step 1. Nothing
   in this runbook deploys it.
2. **Verified backup and restore rehearsal for 0029a**: 0029a runbook sections 2–3.
3. **0029a**: apply and verify with the 0029a runbook (its section 4, the database checks at the start of its
   section 5, and the section 6 counts).
4. **A new verified backup taken after 0029a** and immediately before 0030 (section 2 of this runbook), with its
   own restore rehearsal (section 3). This is the backup you would restore if 0030 has to be undone.
5. **0030**: preflight (section 3a), apply (section 4), verify (section 5).

Application compatibility: the application version before Course Management only **read** courses and modules;
it never wrote them directly. The current application (step 1) writes **only** through the 0030 functions. Between
step 1 and step 5 the Super Admin course detail page is read-only with the notice "Course management isn't set up
in the database yet", the Edit course page shows that title as an error, and course or module changes are refused
with "This page needs the Course Management database update (migration 0030_course_management.sql), which hasn't
been applied to this database. Ask your administrator to apply it." — nothing is changed. Trainer and student
course pages are unaffected (they only read).

## 1. Preconditions (all must be true — **STOP** otherwise)
0. The application version with P5.2 and Course Management is deployed (section 0, step 1).
1. Local: the full local suite passes on a throwaway database (`node tests/question-import-db/run.mjs`,
   including `zz-course-management*.test.mjs`, `zz-course-archived-batches.test.mjs` and
   `zz-invitation-binding-upgrade.test.mjs`), plus `node tests/courses/run.mjs`.
2. 0029a is applied on live and passed the **database** checks of the 0029a runbook (the queries at the start of
   its section 5, and its section 6 counts). The staging recovery prerequisites of that runbook (its section 5a and
   the recovery e-mail checks) concern invitation recovery only and are **not** required for 0030.
3. A **verified, restorable** backup taken **after 0029a** exists, and its restore was rehearsed (sections 2–3).
4. A quiet window: no Super Admin is creating batches, enrolling students, sending invitations or editing courses.
5. You can sign in to the application as a Super Admin (and, ideally, as a test trainer and a test student).
6. The section 3a preflight queries return the expected results.

## 2. Backup (after 0029a, before 0030 — required)
Use `docs/runbooks/live-migration-0029a.md`, **section 2**.

> **Current environment (reported 2026-10-14): Supabase Free plan, PostgreSQL 17.6.1 — managed daily backups and
> Point-in-Time Recovery are not available.** The only method is the 0029a runbook's **option B**, the Supabase CLI
> three-file dump (roles, schema, data; files outside the repository; the connection string kept only in memory and
> cleared). It needs the **Supabase CLI and Docker Desktop (running)** — the CLI runs `pg_dump` inside a Docker
> container. Neither was installed on this machine when checked (2026-10-14): **STOP** until they are, or use
> another machine that has them. Do not substitute a plain local `pg_dump`.

Additional rules for this backup:
- **The backup must be taken after 0029a was applied.** Write down the time 0029a was run and the backup's
  timestamp; the backup timestamp must be later. A backup from before 0029a is **not** enough: restoring it would
  also undo 0029a and everything written since. (If the plan is ever upgraded: a managed daily backup qualifies only
  if it is dated after 0029a; a Point-in-Time Recovery point must be after 0029a.)
- The restore rehearsal (section 3) must confirm that the backup contains 0029a.

## 3. Restore rehearsal
Follow the 0029a runbook, **section 3** in full (restore into a new, temporary PostgreSQL 17 Supabase project with
triggers switched off; the Auth trigger step; its counts-only check; and its **additional restore-integrity checks
A–D** — audit counts and timestamps, sequence values, policy/function/RLS counts, the Auth trigger — which are a
**draft, not yet validated**: an erroring check means "not checked", never "passed"). Run checks A–D with
`public.course_events` left out (it does not exist before 0030). Additionally run on **both** the live project and
the rehearsal project:
- **P1** (section 3a) — on the rehearsal project it must return `binding_rule = true` and `recovery_functions = 3`.
  If not, the backup predates 0029a: **STOP** and take a new backup.
- **P6** (section 3a) — every value must match between live and the rehearsal project. A difference is acceptable
  only if you can attribute it to a change made on live after the backup; otherwise **STOP**.

Then delete the temporary project. Do not continue until the rehearsal passed.

## 3a. Preflight — read-only (SQL Editor of the live project)
Run each query and compare with the expected result. **If any result differs, STOP** — do not apply 0030.

```sql
-- P1. 0029a is applied (expected: binding_rule = true, recovery_functions = 3)
select position('0029a: never accepted by e-mail match alone' in p.prosrc) > 0 as binding_rule,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
          and proname in ('begin_invitation_recovery', 'complete_invitation_recovery', 'invitation_recovery_candidate')) as recovery_functions
  from pg_proc p where p.oid = 'public.accept_user_invitation()'::regprocedure;

-- P2. 0030 is NOT applied yet (expected: both false)
select to_regclass('public.course_code_seq') is not null as code_seq_exists,
       to_regclass('public.course_events') is not null as course_events_exists;

-- P3. The four functions 0030 replaces are EXACTLY the expected versions — whole-body fingerprints, as the
--     0030 preflight checks them (a marker alone is not enough). Expected: all true.
select
  (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure)
    = 'ab35b62993ccd6464b940540bd443e24' as admin_set_enrollment_0023,
  (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.trainer_enroll_student(uuid, uuid)'::regprocedure)
    = '0f37c61f7eac679b128dde27ab905ee1' as trainer_enroll_student_0023,
  (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.create_user_invitation(jsonb)'::regprocedure)
    = 'f86798cd0a6f4e66c06eb2752168c6ab' as create_user_invitation_0028,
  (select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = 'public.accept_user_invitation()'::regprocedure)
    = '96dd1023a79442f8db66e2e5ef5510f1' as accept_user_invitation_0029a;

-- P4. No case-insensitive duplicate course codes (expected: 0 rows)
select lower(course_code) as code, count(*) from public.courses group by 1 having count(*) > 1;

-- P5. No case-insensitive duplicate module codes within a course (expected: 0 rows)
select course_id, lower(module_code) as code, count(*) from public.modules group by 1, 2 having count(*) > 1;

-- P6. Snapshot of existing training records — WRITE THE RESULT DOWN (compared again in V4)
select
  (select count(*) from public.courses) as courses,
  (select count(*) from public.modules) as modules,
  (select count(*) from public.batches) as batches,
  (select count(*) from public.classes) as classes,
  (select count(*) from public.batch_students) as enrolments,
  (select count(*) from public.class_attendance) as attendance,
  (select count(*) from public.test_attempts) as test_attempts,
  (select count(*) from public.assignment_submissions) as submissions,
  (select count(*) from public.completion_records) as completions,
  (select count(*) from public.certificates) as certificates,
  (select md5(coalesce(string_agg(id::text || '|' || course_code || '|' || title || '|' || status::text, ',' order by id), '')) from public.courses) as courses_fp,
  (select md5(coalesce(string_agg(id::text || '|' || course_id::text || '|' || module_code || '|' || sequence::text || '|' || title, ',' order by id), '')) from public.modules) as modules_fp,
  (select md5(coalesce(string_agg(id::text || '|' || course_id::text || '|' || status::text, ',' order by id), '')) from public.batches) as batches_fp,
  (select md5(coalesce(string_agg(id::text || '|' || course_id::text || '|' || coalesce(module_id::text, '-'), ',' order by id), '')) from public.classes) as classes_fp;

-- P7. Information only: the highest existing CRS- number (the new sequence starts above it)
select max((regexp_match(course_code, '^CRS-([0-9]{1,18})$', 'i'))[1]::bigint) as highest_crs_number from public.courses;

-- P8. Baseline: classes whose module belongs to another course — WRITE IT DOWN (compared in V5).
--     Expected 0; a non-zero value does not block 0030 (0030 does not touch these rows), but record it and
--     report it for a separate, reviewed data correction.
select count(*) as class_module_mismatch
  from public.classes c join public.modules m on m.id = c.module_id where m.course_id <> c.course_id;

-- P9. Information only — what 0030's new rules will affect (does not block; record the numbers and tell the
--     Super Admins before the window):
-- P9a. Existing batches whose course is not published (existing batches keep working; NEW batches for such
--      a course will be refused)
select c.status::text as course_status, count(*) as batches
  from public.batches b join public.courses c on c.id = b.course_id
 where c.status <> 'published' group by 1;
-- P9b. Upcoming batches of archived courses (new enrolments into them will be refused; ongoing batches stay open)
select count(*) as upcoming_batches_of_archived_courses
  from public.batches b join public.courses c on c.id = b.course_id
 where c.status = 'archived' and b.status = 'upcoming';
-- P9c. Open invitations into those batches (accepting them will activate the account without enrolling it)
select count(*) as open_invitations_into_closed_batches
  from public.user_invitations i
  join public.batches b on b.id = i.batch_id
  join public.courses c on c.id = b.course_id
 where i.status = 'pending' and i.expires_at > now() and c.status = 'archived' and b.status = 'upcoming';
-- P9d. Non-archived courses that already share a title (they are kept; editing such a title, or re-activating an
--      archived course with a taken title, will be refused as a duplicate)
select lower(btrim(title)) as title_key, count(*) from public.courses
 where status <> 'archived' group by 1 having count(*) > 1;
```
P4/P5 failing: 0030 would refuse anyway ("codes collide case-insensitively") and change nothing — resolve the
duplicate codes first in a separate, reviewed change; do not edit codes ad hoc (see the warning in section 0).

## 4. Apply (SQL Editor of the live project)
1. Dashboard → **SQL Editor → New query**. Paste the **full** contents of
   `supabase/migrations/0030_course_management.sql` (1,310 lines, SHA-256
   `62352c5dbc3086c76e6d68123315383e9028db47900b3a7e8a05ce36a2764ac4` — verify it before pasting; copy the whole
   file, from its `begin;` to its final `commit;`). Run once.
2. It is one transaction: if **any** error appears, **nothing** was changed. Re-run P2 to confirm (both still
   `false`), note the error message, and **STOP**. Do not run it a second time after success — a re-run is refused
   ("0030 already applied?").

## 5. Verify (STOP if any expected result differs)
### 5a. Database objects and privileges (read-only)
Run 5a **before** 5b and 5c (V7 must be read before any course is created).
```sql
-- V1. New objects exist (expected: true, true, 5)
select to_regclass('public.course_code_seq') is not null as code_seq,
       to_regclass('public.course_events') is not null as course_events,
       (select count(*) from pg_trigger where not tgisinternal and tgname in
          ('courses_course_mgmt_guard', 'modules_course_mgmt_guard', 'batches_course_guard',
           'course_events_guard', 'course_events_no_truncate')) as triggers;

-- V2. Super Admin functions: SECURITY DEFINER, fixed search_path, signed-in users only, never anonymous
--     (expected: 9 rows, every one definer = true, anon = false, authenticated = true, and config = the single
--     setting search_path="" — psql displays it escaped as {"search_path=\"\""}; other tools may quote it differently)
select p.proname, p.prosecdef as definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('admin_create_course', 'admin_update_course', 'admin_set_course_status', 'admin_delete_course',
                     'admin_create_module', 'admin_update_module', 'admin_move_module', 'admin_delete_module', 'admin_course_usage')
 order by 1;

-- V3. Internal helpers are not client-callable (expected: 0)
select count(*) from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname like 'course_mgmt\_%'
   and has_function_privilege('authenticated', p.oid, 'execute');

-- V4. Existing training records unchanged: run P6 again — EVERY value must equal the P6 result written down.

-- V5. Class ↔ module links (expected: exactly the P8 value written down)
select count(*) as class_module_mismatch
  from public.classes c join public.modules m on m.id = c.module_id where m.course_id <> c.course_id;

-- V6. The 0029a binding rule survived and the archived-course rule is in all four replaced functions
--     (expected: all true)
select
  position('0029a: never accepted by e-mail match alone' in (select prosrc from pg_proc where oid = 'public.accept_user_invitation()'::regprocedure)) > 0 as binding_rule,
  position('course_mgmt_enrolment_closed' in (select prosrc from pg_proc where oid = 'public.accept_user_invitation()'::regprocedure)) > 0 as accept_archived_rule,
  position('course_mgmt_enrolment_closed' in (select prosrc from pg_proc where oid = 'public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure)) > 0 as enrol_archived_rule,
  position('course_mgmt_enrolment_closed' in (select prosrc from pg_proc where oid = 'public.trainer_enroll_student(uuid, uuid)'::regprocedure)) > 0 as trainer_archived_rule,
  position('course_mgmt_enrolment_closed' in (select prosrc from pg_proc where oid = 'public.create_user_invitation(jsonb)'::regprocedure)) > 0 as invite_archived_rule;

-- V7. The next course code is above every existing one
--     (expected: is_called = false and next_number = P7's highest_crs_number + 1, or 1 if P7 was empty)
select last_value as next_number, is_called from public.course_code_seq;

-- V8. The audit table and the code sequence are closed to clients
--     (expected: anon_reads_events = false, client_uses_seq = false, rls_on = true)
select has_table_privilege('anon', 'public.course_events', 'select') as anon_reads_events,
       has_sequence_privilege('authenticated', 'public.course_code_seq', 'usage') as client_uses_seq,
       (select relrowsecurity from pg_class where oid = 'public.course_events'::regclass) as rls_on;
```

### 5b. Role permissions (nothing is kept — each probe ends in ROLLBACK)
Use only the account ids of **your own test accounts** (ids from the Profiles table — not secrets, but do not
paste them anywhere else). Run **each probe as its own query** (paste one block, run, then the next).

How a probe works: the impersonation (`set local role` and `set_config(…, true)`) exists only inside the probe's
own transaction. The expected refusal is caught inside the `do` block — so on success every statement runs, the
final `rollback;` ends the transaction and the impersonation with it. Any other outcome raises an error.

- **Expected result for each probe: no error** (the editor reports success; psql shows `DO` and `ROLLBACK`).
- **Any ERROR = the probe did not pass: STOP** (the message says which check failed). Before treating it as a
  missing security control, check the id you supplied:
  - **`R1 FAILED`**: the id in R1 must belong to a **trainer or student** account. With a Super Admin's id, R1
    reports `R1 FAILED` even though the protection is in place. Verify the id (it must not be a Super Admin) and
    run R1 again; only a `R1 FAILED` with a confirmed trainer/student id means the protection is missing.
  - **`R2 INCONCLUSIVE`**: either the courses table is empty, **or** the id in R2 is not an **active Super Admin**
    (for any other account the access rules hide every course row, so nothing is tested). Verify the id and run R2
    again. Record R2 as "not applicable" only when P6 showed `courses = 0` — never as passed.
- **After every probe — whatever its result — run this as a separate query:**
  ```sql
  rollback;                 -- harmless if no transaction is open (the editor may show a warning)
  select current_user;      -- expected: postgres
  ```
  If it does not return `postgres`, close that SQL Editor tab and open a new one before running anything else.

```sql
-- R1. A trainer (or student) cannot create a course.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<TEST-TRAINER-ACCOUNT-ID>","role":"authenticated"}', true);
do $$
begin
  perform public.admin_create_course('{"title":"Runbook permission probe","level":"foundation","duration_hours":1}'::jsonb);
  raise exception 'R1 FAILED: a non-admin account was allowed to create a course';
exception when insufficient_privilege then
  if sqlerrm <> 'You don''t have permission to do that.' then raise; end if;   -- any other refusal: report it
end $$;
rollback;
```

```sql
-- R2. Even a Super Admin cannot change the courses table directly (only through Course Management).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<YOUR-SUPER-ADMIN-ACCOUNT-ID>","role":"authenticated"}', true);
do $$
declare
  v_rows integer;
begin
  update public.courses set title = title where id = (select id from public.courses order by id limit 1);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'R2 INCONCLUSIVE: no course row was available to test';
  end if;
  raise exception 'R2 FAILED: a direct table update was accepted';
exception when insufficient_privilege then
  if sqlerrm <> 'Courses are changed through Course Management.' then raise; end if;   -- any other refusal: report it
end $$;
rollback;
```
If R1 created a course before failing, nothing is kept (the transaction is rolled back), but one `CRS-` number
may have been used up (sequence values are never returned) — harmless; record it.

### 5c. Application checks (Super Admin, live — use a clearly labelled TEST course and remove it)
Do these in the application, not in SQL. **Do not publish the test course**: only a never-published Draft can
be deleted again; a published course is kept permanently by design.
1. **Course creation**: Courses → **Add Course** → title `ZZ Runbook check <date>`, any level and hours, status
   **Draft** → Save. Expected: success message; the course shows a generated code `CRS-…` (equal to V7's
   `next_number`). An empty title or invalid hours must be refused with an error message, and nothing is saved.
2. **Module creation and ordering**: open the test course → **Add module** "First", then "Second". Expected codes
   `M01`, `M02` in that order. Move "Second" up → order becomes Second, First. Edit "First"'s title → saved.
3. **Course edit**: edit the description → saved; the change appears under **Course history**. Do **not** publish.
4. **Clean-up**: **Delete course** on the test course → success; it disappears from the list. Its audit entries stay
   in `course_events` (expected; append-only).
   **If the deletion is refused** (for example because it was published by mistake, or something now uses it): do
   **not** retry, do not remove its modules or references, and never delete it through the SQL Editor or Table
   Editor. Use **Deactivate** on the test course in the application (offered for Draft and Active courses; the
   status becomes **Inactive**), write down its
   `CRS-` code and the refusal message, and report it. It stays as an inactive catalogue record; nobody can start
   new batches for it.
5. **Class ↔ module links (read-only on live)**: open a few existing classes — each still shows its module.
   Open the new-class form, pick a course, and check that the module list shows only that course's modules —
   then **cancel without saving**. (Creating a class on live for testing is not needed: the database rule is covered
   by the local suite and V5.)
6. **Existing courses**: open an existing course that has delivered training — expected: title/level/duration and
   modules are shown as locked; description and status are still editable. Change nothing.
7. **Role views** (if test accounts exist): as a trainer and as a student, the Courses pages are read-only (no
   create/edit/delete buttons) and `/admin/courses` is not reachable; the student sees the same courses as before.

## 6. Stop conditions — what to do
- **Preflight fails (3a)**: nothing has changed. Do not apply 0030; investigate and fix in a separate reviewed change.
- **Apply reports any error (4)**: the transaction was rolled back — confirm with P2 (both `false`). Record the
  message and stop.
- **A verification check fails (5)**: stop using course and module management; keep the window closed; decide with
  the person responsible whether to restore the backup (section 7). Do **not** try to drop objects, edit functions,
  or change courses or modules by hand in the SQL Editor or Table Editor.

## 7. Rollback — there is **no scripted rollback** for 0030
0030 adds a sequence, two unique indexes, an enum type, an audit table, triggers and many functions, and replaces
four existing functions. Undoing it by hand would risk leaving guards or functions half-removed. The only supported
recovery is **restoring the verified backup taken after 0029a and immediately before 0030** (section 2), using the
procedure rehearsed in section 3 (the CLI dump restore — the only method on the current Free plan).

**On the Free plan this is not an in-place rollback.** The dump is restored into a **new Supabase project**, and
recovery means moving the application to it — see the 0029a runbook, **section 3a**:
- **Switch the application** to the new project: replace `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in the hosting environment and redeploy
  (values never go into the repository, chats or tickets).
- **Recreate the `on_auth_user_created` Auth trigger** if the rehearsal showed it is not restored.
- **Reconfigure dashboard-only settings** (Auth settings, Site URL and redirect URLs, e-mail templates, SMTP).
- **Everyone signs in again**; e-mail links sent before the switch point to the old project.
- **Keep the old project unchanged** until the new one is verified.

What a restore does — decide with the person responsible before starting:
- **Everything written after the backup is lost**, in the application data **and in Supabase Auth**: new or
  changed courses, batches, enrolments, attendance, test attempts, submissions, certificates, invitations — and
  Auth changes such as accounts created by accepted invitations, confirmed e-mail addresses, password changes
  and sign-ins/sessions. People who accepted an invitation after the backup will have to be invited again; record
  what changed during the window so it can be re-entered.
- **Downtime**: the application must not be used while the new project is restored, checked and switched to;
  announce it and keep everyone signed out. Plan it as an outage, not as a background task.
- After 0030, 0029a can no longer be rolled back on its own (its rollback script refuses; 0030 depends on it).
- The new project contains 0001–0029 + 0029a; once the application is switched to it, course pages show the
  "migration missing" read-only state again. After the restore, re-run P1, P2 and P6 (and the 0029a runbook's
  section 3 checks) on the new project to confirm the expected state.

## 8. Record
Write down (no personal data): the time 0029a was run, backup timestamp and location (later than 0029a), rehearsal
result (including P1 and P6 on the rehearsal project), P1–P9 results, the time 0030 was run, V1–V8 and R1–R2
results, the application checks (and the code of any test course that could not be deleted), and who performed
each step.
