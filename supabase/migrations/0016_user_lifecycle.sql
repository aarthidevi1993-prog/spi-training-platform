-- ===================================================================
-- 0016 — USER LIFECYCLE FOUNDATION (account status, database layer)
--
-- Adds an ACCOUNT-level status to public.profiles, separate from the
-- student/trainer person_status (which is unchanged and keeps its
-- meaning for the domain records):
--
--   invited    the auth account exists but has not been activated —
--              no usable role, no application data
--   active     the profile's role applies exactly as before
--   suspended  access withdrawn — no usable role, no application data
--
-- 1. Existing profiles are backfilled to 'active' with their roles
--    unchanged, so every current user keeps working. New profiles
--    (handle_new_user, i.e. every new auth user) start as 'invited'.
--    The role column keeps its 0002 schema and default ('student');
--    an invited account never gets that role's access because:
--
-- 2. current_app_role() returns the role only for an ACTIVE account
--    (NULL for invited, suspended, missing or anonymous). Every RLS
--    policy and helper that relies on it (is_super_admin, trainer and
--    student scope helpers, require_* functions) therefore denies
--    invited/suspended accounts with no further change.
--
-- 3. The few paths that do not go through current_app_role() are
--    closed too:
--    - owns_student_record() (0005) read profiles.role directly; it
--      now also requires an active account (line tagged "-- 0016").
--    - profiles: a RESTRICTIVE select policy — an inactive account
--      cannot read its own profile, so the app's role lookup
--      (fetchProfileRole) finds nothing and refuses sign-in / the
--      session, exactly as for a user with no profile today.
--    - notifications: a RESTRICTIVE select policy, and the two
--      security-definer mark-as-read functions (0012) refuse an
--      inactive account (lines tagged "-- 0016").
--
-- 4. Status changes are stamped (account_status_changed_at /
--    account_status_changed_by) and, like role changes in 0002, can
--    only be made by a privileged database role (postgres,
--    service_role, supabase_admin — i.e. trusted server-side code or
--    the SQL Editor). No client privileges, policies or functions to
--    change it are added here; that belongs to a later phase.
--
-- Not included (later phases): invitations, role or status management
-- functions, audit log, Auth Admin API calls.
--
-- No data is deleted; no existing table, policy or grant is dropped.
-- Requires 0002, 0003, 0005 and 0012. Safe to re-run: the backfill
-- only happens when the column is first added, so a re-run never
-- reactivates an invited or suspended account.
-- ===================================================================

begin;

do $$
begin
  if to_regclass('public.profiles') is null
     or to_regtype('public.app_role') is null
     or to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.handle_new_user()') is null
     or to_regprocedure('public.owns_student_record(uuid)') is null
     or to_regclass('public.notifications') is null
     or to_regprocedure('public.mark_notification_read(uuid)') is null
     or to_regprocedure('public.mark_all_notifications_read()') is null then
    raise exception 'Preflight failed: 0002, 0003, 0005 and 0012 must be applied first.';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Account status type and columns
-- -------------------------------------------------------------------
do $$
begin
  create type public.account_status as enum ('invited', 'active', 'suspended');
exception
  when duplicate_object then null;
end
$$;

-- Added with DEFAULT 'active' so every existing profile is backfilled
-- active in this statement (only when the column is new); the default
-- for new rows is then switched to 'invited'.
alter table public.profiles
  add column if not exists account_status public.account_status not null default 'active';
alter table public.profiles
  add column if not exists account_status_changed_at timestamptz not null default now();
alter table public.profiles
  add column if not exists account_status_changed_by uuid null references public.profiles (id) on delete set null;

alter table public.profiles alter column account_status set default 'invited';

comment on column public.profiles.account_status is
  'Account access lifecycle (0016): invited = not activated, active = role applies, suspended = access withdrawn. Independent of students/trainers.status.';
comment on column public.profiles.account_status_changed_at is
  'When account_status last changed (0016; set to the migration time for accounts that existed before 0016).';
comment on column public.profiles.account_status_changed_by is
  'Who last changed account_status (auth user), when known; NULL for system changes and the 0016 backfill.';

-- -------------------------------------------------------------------
-- 2. Status guard + stamp (same privileged-role rule as the 0002 role guard)
-- -------------------------------------------------------------------
create or replace function public.profiles_account_status_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_privileged boolean := current_user in ('postgres', 'service_role', 'supabase_admin');
begin
  if tg_op = 'INSERT' then
    if not v_privileged and new.account_status is distinct from 'invited'::public.account_status then
      raise exception 'A new profile always starts as invited.' using errcode = '42501';
    end if;
    new.account_status_changed_at := now();
    new.account_status_changed_by := auth.uid();
    return new;
  end if;

  if new.account_status is distinct from old.account_status then
    if not v_privileged then
      raise exception 'profiles.account_status can only be changed by a privileged role.' using errcode = '42501';
    end if;
    new.account_status_changed_at := now();
    new.account_status_changed_by := auth.uid();
  else
    -- No status change: the stamp cannot be rewritten.
    new.account_status_changed_at := old.account_status_changed_at;
    new.account_status_changed_by := old.account_status_changed_by;
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_account_status_guard() from public, anon, authenticated;

drop trigger if exists profiles_account_status_guard on public.profiles;
create trigger profiles_account_status_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_account_status_guard();

-- -------------------------------------------------------------------
-- 3. New auth users start invited (role column keeps its 0002 default)
-- -------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role, account_status)
  values (new.id, 'student'::public.app_role, 'invited'::public.account_status)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 4. Status-aware role resolution (same signature, return type, privileges)
--    Role for an ACTIVE account only; NULL for invited, suspended,
--    missing profile or no authenticated user.
-- -------------------------------------------------------------------
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role::text
    from public.profiles p
   where p.id = auth.uid()
     and p.account_status = 'active'::public.account_status;
$$;

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated, service_role;

-- -------------------------------------------------------------------
-- 5. Paths that do not use current_app_role()
-- -------------------------------------------------------------------

-- a) 0005 helper (read profiles.role directly): + active account.
create or replace function public.owns_student_record(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
        from public.students s
        join public.profiles p on p.id = s.id
       where s.id = p_student_id
         and p.id = auth.uid()
         and p.role = 'student'::public.app_role
         and p.account_status = 'active'::public.account_status  -- 0016
    ),
    false
  );
$$;

revoke all on function public.owns_student_record(uuid) from public, anon;
grant execute on function public.owns_student_record(uuid) to authenticated, service_role;

-- b) Profiles: an inactive account cannot read any profile, not even its own.
drop policy if exists profiles_active_account_only on public.profiles;
create policy profiles_active_account_only
  on public.profiles
  as restrictive
  for select
  to authenticated
  using ((select public.current_app_role()) is not null);

-- c) Notifications: reads need an active account (restrictive), and the
--    security-definer mark-as-read functions (0012 + lines tagged "-- 0016")
--    refuse an inactive account.
drop policy if exists notifications_active_account_only on public.notifications;
create policy notifications_active_account_only
  on public.notifications
  as restrictive
  for select
  to authenticated
  using ((select public.current_app_role()) is not null);

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'You need to be signed in.' using errcode = '42501';
  end if;
  if public.current_app_role() is null then  -- 0016
    raise exception 'Your account is not active.' using errcode = '42501';  -- 0016
  end if;  -- 0016
  update public.notifications n
     set read_at = now()
   where n.id = p_notification_id and n.recipient_id = auth.uid() and n.read_at is null;
  return found;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'You need to be signed in.' using errcode = '42501';
  end if;
  if public.current_app_role() is null then  -- 0016
    raise exception 'Your account is not active.' using errcode = '42501';  -- 0016
  end if;  -- 0016
  update public.notifications n
     set read_at = now()
   where n.recipient_id = auth.uid() and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Same privileges as 0012 (restated; CREATE OR REPLACE keeps them).
revoke all on function public.mark_notification_read(uuid)  from public, anon, service_role;
revoke all on function public.mark_all_notifications_read() from public, anon, service_role;
grant execute on function public.mark_notification_read(uuid)  to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

commit;
