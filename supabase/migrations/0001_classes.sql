-- ===================================================================
-- PHASE 1 — CLASS MANAGEMENT
-- Creates the `classes` table, its constraints, indexes and RLS.
--
-- Run this in the Supabase SQL Editor (or via `supabase db push`)
-- for your project.
--
-- IMPORTANT — read before running:
--   This migration references courses / modules / batches / trainers
--   tables that DO NOT EXIST YET in this project (those modules are
--   still mock-data only). The foreign keys below are therefore
--   commented out and included as documentation of the intended
--   relationships. Uncomment each one as its parent table is created
--   in a later phase. The plain UUID columns work correctly in the
--   meantime, and the application layer already enforces that these
--   references are present and non-empty.
-- ===================================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------
-- Table
-- -------------------------------------------------------------------
create table if not exists public.classes (
  id                  uuid primary key default gen_random_uuid(),

  course_id           uuid        not null,
  module_id           uuid        null,
  batch_id            uuid        not null,
  trainer_id          uuid        not null,

  title               text        not null,
  description         text        null,

  class_date          date        not null,
  start_time          time        not null,
  end_time            time        not null,

  teams_meeting_url   text        null,

  status              text        not null default 'scheduled',
  class_type          text        not null default 'online',
  notes               text        null,

  created_by          uuid        null references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Data integrity (section 25 of the brief)
  constraint classes_title_not_blank check (length(btrim(title)) > 0),
  constraint classes_status_valid    check (status in ('scheduled', 'live', 'completed', 'cancelled')),
  constraint classes_type_valid      check (class_type in ('online', 'offline', 'hybrid')),
  constraint classes_time_range      check (end_time > start_time),
  -- Only http(s) links are accepted; NULL is allowed (link added later).
  constraint classes_teams_url_valid check (
    teams_meeting_url is null
    or teams_meeting_url ~* '^https?://'
  )

  -- Intended foreign keys — uncomment as each parent table lands:
  -- , constraint classes_course_fk  foreign key (course_id)  references public.courses  (id) on delete restrict
  -- , constraint classes_module_fk  foreign key (module_id)  references public.modules  (id) on delete set null
  -- , constraint classes_batch_fk   foreign key (batch_id)   references public.batches  (id) on delete restrict
  -- , constraint classes_trainer_fk foreign key (trainer_id) references public.trainers (id) on delete restrict
);

-- -------------------------------------------------------------------
-- Indexes (section 3 of the brief)
-- -------------------------------------------------------------------
create index if not exists classes_course_id_idx  on public.classes (course_id);
create index if not exists classes_module_id_idx  on public.classes (module_id);
create index if not exists classes_batch_id_idx   on public.classes (batch_id);
create index if not exists classes_trainer_id_idx on public.classes (trainer_id);
create index if not exists classes_class_date_idx on public.classes (class_date);
create index if not exists classes_status_idx     on public.classes (status);
-- Supports the most common list query: a batch's classes in date order.
create index if not exists classes_batch_date_idx on public.classes (batch_id, class_date desc);

-- -------------------------------------------------------------------
-- updated_at maintenance
-- -------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists classes_set_updated_at on public.classes;
create trigger classes_set_updated_at
  before update on public.classes
  for each row
  execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- Row Level Security
--
-- Role currently comes from auth.users.raw_user_meta_data->>'role',
-- matching the application's existing temporary role-resolution
-- adapter (see src/repositories/auth.repository.ts). When the
-- `profiles` table lands in a later phase, replace the helper below
-- with a lookup against it — every policy here keeps working.
-- -------------------------------------------------------------------
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select raw_user_meta_data ->> 'role' from auth.users where id = auth.uid()),
    'student'
  );
$$;

alter table public.classes enable row level security;

-- Admin: full access.
drop policy if exists classes_admin_all on public.classes;
create policy classes_admin_all
  on public.classes
  for all
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

-- Trainer: may read and modify only their own classes.
drop policy if exists classes_trainer_select on public.classes;
create policy classes_trainer_select
  on public.classes
  for select
  to authenticated
  using (public.current_app_role() = 'trainer' and trainer_id = auth.uid());

drop policy if exists classes_trainer_insert on public.classes;
create policy classes_trainer_insert
  on public.classes
  for insert
  to authenticated
  with check (public.current_app_role() = 'trainer' and trainer_id = auth.uid());

drop policy if exists classes_trainer_update on public.classes;
create policy classes_trainer_update
  on public.classes
  for update
  to authenticated
  using (public.current_app_role() = 'trainer' and trainer_id = auth.uid())
  with check (public.current_app_role() = 'trainer' and trainer_id = auth.uid());

-- Student: read-only, and only classes belonging to a batch they are
-- enrolled in.
--
-- The enrolment source of truth (batch_students) does not exist yet.
-- Until it does, this policy denies all student reads — deliberately
-- failing CLOSED rather than open. Uncomment the enrolment clause and
-- delete the `false` line once that table exists.
drop policy if exists classes_student_select on public.classes;
create policy classes_student_select
  on public.classes
  for select
  to authenticated
  using (
    public.current_app_role() = 'student'
    and false
    -- and exists (
    --   select 1
    --     from public.batch_students bs
    --    where bs.batch_id = classes.batch_id
    --      and bs.student_id = auth.uid()
    -- )
  );
