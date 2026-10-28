-- ===================================================================
-- 0002 — SECURE PROFILE-BASED ROLE MODEL
--
-- Replaces the temporary role source used by 0001_classes.sql
-- (auth.users.raw_user_meta_data->>'role'). User metadata is writable
-- by the user themselves via supabase.auth.updateUser() / signUp(), so
-- it must never grant privileges. From this migration on, the ONLY
-- source of an application role is public.profiles.role.
--
-- What this migration does:
--   1. public.app_role enum: 'super_admin' | 'trainer' | 'student'
--   2. public.profiles (id -> auth.users, role, timestamps)
--   3. Guard trigger: role/id can only be changed by privileged DB roles
--   4. New-user trigger: every new auth user gets role 'student',
--      ignoring any signup metadata
--   5. current_app_role(): now reads profiles, fails closed (NULL)
--   6. RLS on profiles: read-only for end users, no self-service writes
--   7. Aligns the classes admin policy with the new role name
--      ('admin' -> 'super_admin'); no table/column/data changes
--
-- Depends on: 0001_classes.sql (for step 7; skipped if classes is absent).
--
-- REVIEW BEFORE RUNNING. This file has not been executed anywhere.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1. Controlled role type
-- -------------------------------------------------------------------
do $$
begin
  create type public.app_role as enum ('super_admin', 'trainer', 'student');
exception
  when duplicate_object then null;
end
$$;

-- -------------------------------------------------------------------
-- 2. Profiles table
-- -------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid            primary key references auth.users (id) on delete cascade,
  role        public.app_role not null default 'student',
  created_at  timestamptz     not null default now(),
  updated_at  timestamptz     not null default now()
);

-- updated_at maintenance (same definition as 0001_classes.sql, repeated
-- so this migration is self-contained).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- 3. Privileged-column guard (defence in depth)
--
-- RLS below already grants end users no INSERT/UPDATE/DELETE on
-- profiles. This trigger additionally guarantees that even if a
-- future policy or grant is added by mistake, a request running as
-- `anon` / `authenticated` can never:
--   - insert a profile with a role other than 'student'
--   - change any profile's role
--   - change a profile's id
-- Only trusted database roles (migrations / SQL editor as postgres,
-- server code using the service_role key) may do so.
--
-- Deliberately NOT security definer: current_user must be the role
-- that issued the statement.
-- -------------------------------------------------------------------
create or replace function public.profiles_guard_privileged_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role is distinct from 'student'::public.app_role then
      raise exception 'Only a privileged role may create a non-student profile.'
        using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      raise exception 'profiles.role can only be changed by a privileged role.'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id then
      raise exception 'profiles.id cannot be changed.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_privileged_columns on public.profiles;
create trigger profiles_guard_privileged_columns
  before insert or update on public.profiles
  for each row
  execute function public.profiles_guard_privileged_columns();

-- -------------------------------------------------------------------
-- 4. Automatic profile for every new auth user
--
-- The role is ALWAYS 'student'. raw_user_meta_data (user-controlled,
-- e.g. signUp({ options: { data: { role: 'super_admin' } } })) and
-- raw_app_meta_data are intentionally never read here.
--
-- Security definer so the insert succeeds regardless of the calling
-- auth service role; runs as the function owner (postgres), which
-- the guard trigger above treats as trusted.
-- -------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'student'::public.app_role)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- -------------------------------------------------------------------
-- 5. Current-role helper (replaces the 0001 metadata-based version)
--
-- Returns the caller's role as text, or NULL when:
--   - there is no authenticated user (auth.uid() is NULL)
--   - the user has no profile row
-- The enum column cannot hold an invalid value, so "invalid role" is
-- impossible by construction. There is NO default: every policy that
-- compares against this helper evaluates to false/NULL for NULL, so
-- authorization fails closed.
--
-- Return type stays `text` (same signature as 0001) so existing
-- policies that depend on it keep compiling unchanged.
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
   where p.id = auth.uid();
$$;

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated, service_role;

-- -------------------------------------------------------------------
-- 6. Row Level Security on profiles
--
-- End users (anon / authenticated):
--   - SELECT: own row only; super_admin may read all rows
--   - INSERT / UPDATE / DELETE: no policies and no table privileges,
--     so every write is denied
-- Role changes are performed only by trusted server-side code using
-- the service_role key, or by a project owner in the SQL editor.
-- -------------------------------------------------------------------
alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_select_super_admin on public.profiles;
create policy profiles_select_super_admin
  on public.profiles
  for select
  to authenticated
  using ((select public.current_app_role()) = 'super_admin');

-- -------------------------------------------------------------------
-- 7. Align the classes admin policy with the new role name
--
-- 0001 compared current_app_role() to 'admin'. The helper now returns
-- 'super_admin', so without this change admins would lose access to
-- classes (fail-closed, but broken). Trainer/student policies compare
-- against 'trainer'/'student', which are unchanged. No table, column
-- or data in public.classes is modified.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.classes') is not null then
    drop policy if exists classes_admin_all on public.classes;
    create policy classes_admin_all
      on public.classes
      for all
      to authenticated
      using (public.current_app_role() = 'super_admin')
      with check (public.current_app_role() = 'super_admin');
  end if;
end
$$;

-- -------------------------------------------------------------------
-- NOT EXECUTED — manual, reviewed steps after applying this migration
-- -------------------------------------------------------------------
-- a) Auth users created BEFORE this migration have no profile and
--    therefore no access (fail closed). To give them the default
--    student role deliberately:
--
--      insert into public.profiles (id, role)
--      select id, 'student'::public.app_role from auth.users
--      on conflict (id) do nothing;
--
-- b) Bootstrap the first super admin (SQL editor, project owner only):
--
--      update public.profiles
--         set role = 'super_admin'
--       where id = '<auth-user-uuid>';
--
-- c) In the Supabase dashboard, consider disabling public sign-ups
--    (Authentication -> Providers -> Email) so accounts are created
--    by invitation only.
