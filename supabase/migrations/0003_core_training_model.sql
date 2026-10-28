-- ===================================================================
-- 0003 — CORE TRAINING DATA MODEL
--
-- Adds the parent entities the Classes module depends on and links
-- them together:
--
--   courses 1─* modules
--   courses 1─* batches *─1 trainers (trainers.id = profiles.id)
--   batches *─* students via batch_students (students.id = profiles.id)
--   classes  → courses / modules / batches / trainers (FKs enabled here)
--   trainers 1─1 trainer_details, students 1─1 student_details
--     (contact/personal data, readable only by super_admin and self)
--
-- Also: shared RLS helper functions, role/profile consistency,
-- seat-capacity and class/batch-trainer triggers, RLS for every new
-- table, and the classes policy updates (enrolment-based student
-- access, trainers limited to classes in batches they run).
--
-- Invariants enforced here:
--   - a class's trainer is its batch's assigned trainer (trigger);
--     reassigning a batch's trainer moves its scheduled/live classes
--   - a trainers/students row can only be active for a profile with
--     the matching role; a role change deactivates the stale row
--   - enrolment history blocks deletion of students and batches
--
-- Depends on 0001_classes.sql and 0002_profiles_roles.sql.
-- Does NOT modify profiles' columns, RLS, grants, app_role,
-- current_app_role() or the 0002 guard; it only ADDS an AFTER UPDATE
-- OF role trigger on profiles (section 6).
-- Contains no DROP TABLE, DELETE, TRUNCATE or data rewrites at
-- migration time.
--
-- Runs as ONE transaction (BEGIN/COMMIT below). Paste it into the
-- SQL Editor as-is — do not wrap it in another transaction. If any
-- statement or preflight check fails, nothing is applied.
--
-- REVIEW BEFORE RUNNING. This file has not been executed anywhere.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight safety checks — abort (and roll back) unless the
--    database is exactly in the expected post-0002 state.
-- -------------------------------------------------------------------
do $$
declare
  v_classes_rows bigint;
  v_role_fn      text;
begin
  -- Composite FK "on delete set null (column)" needs PostgreSQL 15+.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'Preflight failed: PostgreSQL 15 or newer is required (found %).',
      current_setting('server_version');
  end if;

  if to_regclass('public.profiles') is null then
    raise exception 'Preflight failed: public.profiles is missing (0002 not applied).';
  end if;
  if to_regclass('public.classes') is null then
    raise exception 'Preflight failed: public.classes is missing (0001 not applied).';
  end if;
  if to_regtype('public.app_role') is null then
    raise exception 'Preflight failed: public.app_role is missing (0002 not applied).';
  end if;
  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'Preflight failed: public.set_updated_at() is missing.';
  end if;
  if to_regprocedure('public.current_app_role()') is null then
    raise exception 'Preflight failed: public.current_app_role() is missing.';
  end if;

  -- current_app_role() must be the profiles-based version from 0002,
  -- not the user_metadata-based version from 0001.
  select pg_get_functiondef('public.current_app_role()'::regprocedure) into v_role_fn;
  if position('public.profiles' in v_role_fn) = 0 then
    raise exception 'Preflight failed: current_app_role() is not the profiles-based version from 0002.';
  end if;

  -- Adding foreign keys to classes is only safe on an empty table.
  select count(*) into v_classes_rows from public.classes;
  if v_classes_rows <> 0 then
    raise exception 'Preflight failed: public.classes contains % row(s); this migration requires it to be empty.',
      v_classes_rows;
  end if;

  -- Refuse to run twice.
  if to_regclass('public.trainers') is not null
     or to_regclass('public.trainer_details') is not null
     or to_regclass('public.students') is not null
     or to_regclass('public.student_details') is not null
     or to_regclass('public.courses') is not null
     or to_regclass('public.modules') is not null
     or to_regclass('public.batches') is not null
     or to_regclass('public.batch_students') is not null then
    raise exception 'Preflight failed: core training tables already exist (0003 already applied?).';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Enum types
-- -------------------------------------------------------------------
create type public.person_status     as enum ('active', 'inactive', 'invited');
create type public.course_level      as enum ('foundation', 'intermediate', 'advanced');
create type public.course_status     as enum ('draft', 'published', 'archived');
create type public.batch_status      as enum ('upcoming', 'ongoing', 'completed', 'cancelled');
create type public.enrollment_status as enum ('enrolled', 'withdrawn', 'completed');

-- -------------------------------------------------------------------
-- 2. People: trainers and students
--    Identity rule: trainers.id = students.id = profiles.id (the auth
--    user id). No second identity is created.
--
--    Data minimisation: trainers/students hold only what other roles
--    legitimately need to see (code, display name, status). Contact
--    and personal fields live in trainer_details / student_details,
--    readable only by super_admin and the person themselves.
--
--    Deleting an auth user cascades to profiles -> trainers/students
--    (and their details) ONLY when no training history references
--    them: batches, classes and batch_students all RESTRICT, so such a
--    deletion is refused. Deactivate (status = 'inactive') instead.
-- -------------------------------------------------------------------
create table public.trainers (
  id            uuid                 primary key references public.profiles (id) on delete cascade,
  trainer_code  text                 not null,
  full_name     text                 not null,
  status        public.person_status not null default 'active',
  created_at    timestamptz          not null default now(),
  updated_at    timestamptz          not null default now(),

  constraint trainers_trainer_code_key       unique (trainer_code),
  constraint trainers_trainer_code_not_blank check (length(btrim(trainer_code)) > 0),
  constraint trainers_full_name_not_blank    check (length(btrim(full_name)) > 0)
);

create index trainers_status_idx on public.trainers (status);

create table public.trainer_details (
  trainer_id       uuid        primary key references public.trainers (id) on delete cascade,
  email            text        not null,
  phone            text        null,
  specializations  text[]      not null default '{}',
  bio              text        null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint trainer_details_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

create table public.students (
  id            uuid                 primary key references public.profiles (id) on delete cascade,
  student_code  text                 not null,
  full_name     text                 not null,
  status        public.person_status not null default 'active',
  created_at    timestamptz          not null default now(),
  updated_at    timestamptz          not null default now(),

  constraint students_student_code_key       unique (student_code),
  constraint students_student_code_not_blank check (length(btrim(student_code)) > 0),
  constraint students_full_name_not_blank    check (length(btrim(full_name)) > 0)
);

create index students_status_idx on public.students (status);

create table public.student_details (
  student_id    uuid        primary key references public.students (id) on delete cascade,
  email         text        not null,
  phone         text        null,
  organization  text        null,
  designation   text        null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint student_details_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

-- -------------------------------------------------------------------
-- 3. Courses and modules
-- -------------------------------------------------------------------
create table public.courses (
  id              uuid                 primary key default gen_random_uuid(),
  course_code     text                 not null,
  title           text                 not null,
  description     text                 not null default '',
  level           public.course_level  not null,
  duration_hours  numeric(6, 1)        not null default 0,
  status          public.course_status not null default 'draft',
  created_by      uuid                 null references public.profiles (id) on delete set null,
  created_at      timestamptz          not null default now(),
  updated_at      timestamptz          not null default now(),

  constraint courses_course_code_key       unique (course_code),
  constraint courses_course_code_not_blank check (length(btrim(course_code)) > 0),
  constraint courses_title_not_blank       check (length(btrim(title)) > 0),
  constraint courses_duration_non_negative check (duration_hours >= 0)
);

create index courses_status_idx on public.courses (status);

create table public.modules (
  id              uuid          primary key default gen_random_uuid(),
  course_id       uuid          not null references public.courses (id) on delete cascade,
  module_code     text          not null,
  title           text          not null,
  description     text          null,
  sequence        integer       not null,
  duration_hours  numeric(6, 1) not null default 0,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),

  constraint modules_course_sequence_key     unique (course_id, sequence),
  constraint modules_course_module_code_key  unique (course_id, module_code),
  -- Target of the classes (module_id, course_id) composite FK.
  constraint modules_id_course_key           unique (id, course_id),
  constraint modules_module_code_not_blank   check (length(btrim(module_code)) > 0),
  constraint modules_title_not_blank         check (length(btrim(title)) > 0),
  constraint modules_sequence_positive       check (sequence > 0),
  constraint modules_duration_non_negative   check (duration_hours >= 0)
);
-- course_id lookups are served by modules_course_sequence_key.

-- -------------------------------------------------------------------
-- 4. Batches and enrolment
-- -------------------------------------------------------------------
create table public.batches (
  id          uuid                 primary key default gen_random_uuid(),
  batch_code  text                 not null,
  course_id   uuid                 not null references public.courses (id) on delete restrict,
  -- Nullable: a batch can be created before a trainer is assigned.
  trainer_id  uuid                 null references public.trainers (id) on delete restrict,
  name        text                 not null,
  start_date  date                 not null,
  end_date    date                 not null,
  status      public.batch_status  not null default 'upcoming',
  max_seats   integer              not null,
  created_by  uuid                 null references public.profiles (id) on delete set null,
  created_at  timestamptz          not null default now(),
  updated_at  timestamptz          not null default now(),

  constraint batches_batch_code_key       unique (batch_code),
  -- Target of the classes (batch_id, course_id) composite FK.
  constraint batches_id_course_key        unique (id, course_id),
  constraint batches_batch_code_not_blank check (length(btrim(batch_code)) > 0),
  constraint batches_name_not_blank       check (length(btrim(name)) > 0),
  constraint batches_date_range           check (end_date >= start_date),
  constraint batches_max_seats_positive   check (max_seats > 0)
);

create index batches_course_id_idx  on public.batches (course_id);
create index batches_trainer_id_idx on public.batches (trainer_id);
create index batches_status_idx     on public.batches (status);
create index batches_dates_idx      on public.batches (start_date, end_date);

-- Enrolment is training history (including withdrawn/completed rows):
-- RESTRICT on both sides, so deleting a student or a batch that has
-- enrolments is refused instead of silently erasing that history.
create table public.batch_students (
  batch_id           uuid                     not null references public.batches (id) on delete restrict,
  student_id         uuid                     not null references public.students (id) on delete restrict,
  enrollment_status  public.enrollment_status not null default 'enrolled',
  enrolled_at        timestamptz              not null default now(),
  completed_at       timestamptz              null,
  enrolled_by        uuid                     null references public.profiles (id) on delete set null,
  created_at         timestamptz              not null default now(),
  updated_at         timestamptz              not null default now(),

  constraint batch_students_pkey primary key (batch_id, student_id),
  -- Completion (the "Completion" step of the training workflow) must
  -- carry a completion timestamp.
  constraint batch_students_completed_at_required
    check (enrollment_status <> 'completed' or completed_at is not null)
);

-- "My batches" lookups; batch_id lookups use the primary key.
create index batch_students_student_id_idx on public.batch_students (student_id);

-- -------------------------------------------------------------------
-- 5. updated_at triggers (reuse public.set_updated_at from 0001/0002)
-- -------------------------------------------------------------------
create trigger trainers_set_updated_at        before update on public.trainers        for each row execute function public.set_updated_at();
create trigger trainer_details_set_updated_at before update on public.trainer_details for each row execute function public.set_updated_at();
create trigger students_set_updated_at        before update on public.students        for each row execute function public.set_updated_at();
create trigger student_details_set_updated_at before update on public.student_details for each row execute function public.set_updated_at();
create trigger courses_set_updated_at        before update on public.courses        for each row execute function public.set_updated_at();
create trigger modules_set_updated_at        before update on public.modules        for each row execute function public.set_updated_at();
create trigger batches_set_updated_at        before update on public.batches        for each row execute function public.set_updated_at();
create trigger batch_students_set_updated_at before update on public.batch_students for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------
-- 6. Role/profile consistency
--
--    Invariant: a trainers row may be non-inactive only while its
--    profile's role is 'trainer'; a students row only while the role
--    is 'student'. Enforced in two places:
--
--    a) enforce_profile_role (on trainers/students): creating a row,
--       changing its id, or setting it to active/invited requires the
--       matching profile role. Only 'inactive' is allowed for a
--       mismatched role. The expected role is the trigger argument
--       (a fixed literal, never user input).
--
--    b) sync_domain_status_on_role_change (on profiles): when a
--       profile's role changes, any trainers/students row that no
--       longer matches is set to 'inactive'. Rows are kept (not
--       deleted) because they anchor training history. Access is
--       unaffected either way: every RLS helper re-checks the CURRENT
--       role, so a stale row can never grant anything.
--
--    Both are security definer so their reads/writes are not affected
--    by the caller's RLS; they touch only the one profile's rows and
--    return nothing. Trigger functions cannot be invoked directly.
--    Profile roles themselves can still only be changed by trusted DB
--    roles (0002 guard) — nothing here changes that.
-- -------------------------------------------------------------------
create function public.enforce_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  -- Deactivating (or editing an already inactive row) never needs the
  -- role to match; that is how stale rows are retired.
  if tg_op = 'UPDATE'
     and new.id = old.id
     and new.status = 'inactive'::public.person_status then
    return new;
  end if;

  select p.role into v_role
    from public.profiles p
   where p.id = new.id;

  if v_role is null or v_role::text <> tg_argv[0] then
    raise exception '% row % can only be active for a profile with role %.', tg_table_name, new.id, tg_argv[0]
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_profile_role() from public, anon, authenticated;

create trigger trainers_enforce_profile_role
  before insert or update on public.trainers
  for each row execute function public.enforce_profile_role('trainer');

create trigger students_enforce_profile_role
  before insert or update on public.students
  for each row execute function public.enforce_profile_role('student');

create function public.sync_domain_status_on_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    if new.role <> 'trainer'::public.app_role then
      update public.trainers
         set status = 'inactive'::public.person_status
       where id = new.id
         and status <> 'inactive'::public.person_status;
    end if;

    if new.role <> 'student'::public.app_role then
      update public.students
         set status = 'inactive'::public.person_status
       where id = new.id
         and status <> 'inactive'::public.person_status;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.sync_domain_status_on_role_change() from public, anon, authenticated;

create trigger profiles_sync_domain_status
  after update of role on public.profiles
  for each row execute function public.sync_domain_status_on_role_change();

-- -------------------------------------------------------------------
-- 7. Seat capacity (max_seats)
--    Counts enrolled + completed students (withdrawn ones free a seat).
--    The batch row is locked FOR UPDATE so concurrent enrolments into
--    the same batch are serialised and cannot overshoot max_seats.
-- -------------------------------------------------------------------
create function public.enforce_batch_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_seats integer;
  v_taken     integer;
begin
  if new.enrollment_status = 'withdrawn' then
    return new;
  end if;

  select b.max_seats into v_max_seats
    from public.batches b
   where b.id = new.batch_id
     for update;

  select count(*) into v_taken
    from public.batch_students bs
   where bs.batch_id = new.batch_id
     and bs.enrollment_status <> 'withdrawn'
     and bs.student_id <> new.student_id;

  if v_taken >= v_max_seats then
    raise exception 'Batch % is full (% seats).', new.batch_id, v_max_seats
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_batch_capacity() from public, anon, authenticated;

create trigger batch_students_enforce_capacity
  before insert or update of batch_id, enrollment_status on public.batch_students
  for each row execute function public.enforce_batch_capacity();

-- Shrinking a batch below its current enrolment is also refused.
create function public.enforce_batch_max_seats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_taken integer;
begin
  select count(*) into v_taken
    from public.batch_students bs
   where bs.batch_id = new.id
     and bs.enrollment_status <> 'withdrawn';

  if new.max_seats < v_taken then
    raise exception 'Batch % already has % enrolled student(s); max_seats cannot be %.', new.id, v_taken, new.max_seats
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_batch_max_seats() from public, anon, authenticated;

create trigger batches_enforce_max_seats
  before update of max_seats on public.batches
  for each row execute function public.enforce_batch_max_seats();

-- -------------------------------------------------------------------
-- 8. RLS helper functions
--
--    Policies that need to look at OTHER tables go through these
--    helpers instead of inline subqueries. They are SECURITY DEFINER
--    (owned by the migration role, which owns the tables), so their
--    internal reads bypass RLS — this is what prevents policy
--    recursion between batches ↔ batch_students ↔ classes.
--
--    Safety properties of every helper:
--      - fixed search_path = '' and fully-qualified names
--      - static SQL only (no dynamic SQL)
--      - read-only; returns a boolean about the CALLER only
--        (auth.uid() + current_app_role()), never other users' data
--      - fail closed: coalesce(..., false); NULL role => false
--      - EXECUTE revoked from public/anon, granted to authenticated
-- -------------------------------------------------------------------

-- Not security definer: it only calls current_app_role(), which
-- already is.
create function public.is_super_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'super_admin', false);
$$;

-- Caller is the assigned trainer of this batch.
create function public.is_batch_trainer(p_batch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = 'trainer'
    and exists (
      select 1
        from public.batches b
       where b.id = p_batch_id
         and b.trainer_id = auth.uid()
    ),
    false
  );
$$;

-- Caller is a student currently enrolled in (or who completed) this batch.
create function public.is_enrolled_in_batch(p_batch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = 'student'
    and exists (
      select 1
        from public.batch_students bs
       where bs.batch_id = p_batch_id
         and bs.student_id = auth.uid()
         and bs.enrollment_status in ('enrolled', 'completed')
    ),
    false
  );
$$;

-- Caller taught at least one class in this batch. Keeps a trainer's
-- completed/cancelled classes readable (with their batch and course)
-- after an admin reassigns the batch to another trainer. Read-only
-- visibility only — write access always requires is_batch_trainer().
create function public.is_class_trainer_in_batch(p_batch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = 'trainer'
    and exists (
      select 1
        from public.classes c
       where c.batch_id = p_batch_id
         and c.trainer_id = auth.uid()
    ),
    false
  );
$$;

-- Caller may read this course (and therefore its modules).
create function public.can_read_course(p_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case public.current_app_role()
      when 'super_admin' then true
      when 'trainer' then
        exists (
          select 1 from public.batches b
           where b.course_id = p_course_id
             and b.trainer_id = auth.uid()
        )
        or exists (
          select 1 from public.classes c
           where c.course_id = p_course_id
             and c.trainer_id = auth.uid()
        )
      when 'student' then
        exists (
          select 1
            from public.batches b
            join public.batch_students bs on bs.batch_id = b.id
           where b.course_id = p_course_id
             and bs.student_id = auth.uid()
             and bs.enrollment_status in ('enrolled', 'completed')
        )
      else false
    end,
    false
  );
$$;

-- Caller (a student) may see this trainer: the trainer runs one of the
-- caller's batches, or teaches a class in one of them.
create function public.student_can_read_trainer(p_trainer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = 'student'
    and exists (
      select 1
        from public.batch_students bs
       where bs.student_id = auth.uid()
         and bs.enrollment_status in ('enrolled', 'completed')
         and (
           exists (
             select 1 from public.batches b
              where b.id = bs.batch_id
                and b.trainer_id = p_trainer_id
           )
           or exists (
             select 1 from public.classes c
              where c.batch_id = bs.batch_id
                and c.trainer_id = p_trainer_id
           )
         )
    ),
    false
  );
$$;

-- Caller (a trainer) runs a batch this student is currently enrolled in
-- or has completed. Withdrawn students drop out of trainer visibility.
create function public.trainer_can_read_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = 'trainer'
    and exists (
      select 1
        from public.batch_students bs
        join public.batches b on b.id = bs.batch_id
       where bs.student_id = p_student_id
         and bs.enrollment_status in ('enrolled', 'completed')
         and b.trainer_id = auth.uid()
    ),
    false
  );
$$;

revoke all on function public.is_super_admin()                  from public, anon;
revoke all on function public.is_batch_trainer(uuid)            from public, anon;
revoke all on function public.is_enrolled_in_batch(uuid)        from public, anon;
revoke all on function public.is_class_trainer_in_batch(uuid)   from public, anon;
revoke all on function public.can_read_course(uuid)             from public, anon;
revoke all on function public.student_can_read_trainer(uuid)    from public, anon;
revoke all on function public.trainer_can_read_student(uuid)    from public, anon;

grant execute on function public.is_super_admin()                to authenticated, service_role;
grant execute on function public.is_batch_trainer(uuid)          to authenticated, service_role;
grant execute on function public.is_enrolled_in_batch(uuid)      to authenticated, service_role;
grant execute on function public.is_class_trainer_in_batch(uuid) to authenticated, service_role;
grant execute on function public.can_read_course(uuid)           to authenticated, service_role;
grant execute on function public.student_can_read_trainer(uuid)  to authenticated, service_role;
grant execute on function public.trainer_can_read_student(uuid)  to authenticated, service_role;

-- -------------------------------------------------------------------
-- 9. Table privileges + Row Level Security
--    No anonymous access at all. Authenticated users get table
--    privileges, but every row is filtered by the policies below:
--    reads per role, writes super_admin only.
-- -------------------------------------------------------------------
alter table public.trainers        enable row level security;
alter table public.trainer_details enable row level security;
alter table public.students        enable row level security;
alter table public.student_details enable row level security;
alter table public.courses         enable row level security;
alter table public.modules         enable row level security;
alter table public.batches         enable row level security;
alter table public.batch_students  enable row level security;

revoke all on table
  public.trainers, public.trainer_details, public.students, public.student_details,
  public.courses, public.modules, public.batches, public.batch_students
  from anon, authenticated;

grant select, insert, update, delete on table
  public.trainers, public.trainer_details, public.students, public.student_details,
  public.courses, public.modules, public.batches, public.batch_students
  to authenticated;

grant all on table
  public.trainers, public.trainer_details, public.students, public.student_details,
  public.courses, public.modules, public.batches, public.batch_students
  to service_role;

-- trainers --------------------------------------------------------------
create policy trainers_select
  on public.trainers for select to authenticated
  using (
    public.is_super_admin()
    or (id = (select auth.uid()) and public.current_app_role() = 'trainer')
    or public.student_can_read_trainer(id)
  );

create policy trainers_admin_write
  on public.trainers for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- trainer_details: contact/personal data — super_admin and self only.
create policy trainer_details_select
  on public.trainer_details for select to authenticated
  using (
    public.is_super_admin()
    or (trainer_id = (select auth.uid()) and public.current_app_role() = 'trainer')
  );

create policy trainer_details_admin_write
  on public.trainer_details for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- students --------------------------------------------------------------
create policy students_select
  on public.students for select to authenticated
  using (
    public.is_super_admin()
    or (id = (select auth.uid()) and public.current_app_role() = 'student')
    or public.trainer_can_read_student(id)
  );

create policy students_admin_write
  on public.students for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- student_details: contact/personal data — super_admin and self only.
create policy student_details_select
  on public.student_details for select to authenticated
  using (
    public.is_super_admin()
    or (student_id = (select auth.uid()) and public.current_app_role() = 'student')
  );

create policy student_details_admin_write
  on public.student_details for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- courses ---------------------------------------------------------------
create policy courses_select
  on public.courses for select to authenticated
  using (public.can_read_course(id));

create policy courses_admin_write
  on public.courses for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- modules ---------------------------------------------------------------
create policy modules_select
  on public.modules for select to authenticated
  using (public.can_read_course(course_id));

create policy modules_admin_write
  on public.modules for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- batches ---------------------------------------------------------------
create policy batches_select
  on public.batches for select to authenticated
  using (
    public.is_super_admin()
    or public.is_batch_trainer(id)
    or public.is_class_trainer_in_batch(id)
    or public.is_enrolled_in_batch(id)
  );

create policy batches_admin_write
  on public.batches for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- batch_students --------------------------------------------------------
create policy batch_students_select
  on public.batch_students for select to authenticated
  using (
    public.is_super_admin()
    -- Trainers see active/completed enrolments in their batches only.
    or (public.is_batch_trainer(batch_id) and enrollment_status <> 'withdrawn')
    -- Students see their own enrolment history, including withdrawals.
    or (student_id = (select auth.uid()) and public.current_app_role() = 'student')
  );

create policy batch_students_admin_write
  on public.batch_students for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- -------------------------------------------------------------------
-- 10. Classes: relationships and policies
--     classes is verified empty in the preflight, so adding the FKs
--     cannot fail on existing rows. No column, row or data changes.
-- -------------------------------------------------------------------
alter table public.classes
  add constraint classes_course_fk
    foreign key (course_id) references public.courses (id) on delete restrict,
  -- Batch must belong to the class's course.
  add constraint classes_batch_fk
    foreign key (batch_id, course_id) references public.batches (id, course_id) on delete restrict,
  -- Module (optional) must belong to the class's course. MATCH SIMPLE
  -- skips the check when module_id is NULL; deleting a module clears
  -- only module_id, never course_id.
  add constraint classes_module_fk
    foreign key (module_id, course_id) references public.modules (id, course_id) on delete set null (module_id),
  add constraint classes_trainer_fk
    foreign key (trainer_id) references public.trainers (id) on delete restrict;

-- Class ↔ batch trainer invariant.
--
-- Product rule: a class belongs to a batch, a batch has one designated
-- trainer, and that trainer runs the batch's classes. So a class's
-- trainer_id must equal its batch's trainer_id whenever a class is
-- created or its trainer/batch changes — for every role, admins
-- included. (Substitute trainers are intentionally not modelled.)
--
-- Only checked when trainer_id or batch_id actually changes, so
-- editing other fields of a historical class whose batch has since
-- been reassigned (see below) still works.
--
-- Security definer so the batch lookup is not hidden by the caller's
-- RLS (a hidden batch would otherwise look like "no trainer").
create function public.enforce_class_batch_trainer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_trainer uuid;
begin
  if tg_op = 'UPDATE'
     and new.trainer_id is not distinct from old.trainer_id
     and new.batch_id is not distinct from old.batch_id then
    return new;
  end if;

  select b.trainer_id into v_batch_trainer
    from public.batches b
   where b.id = new.batch_id;

  if v_batch_trainer is null then
    raise exception 'Batch % has no assigned trainer; assign one before scheduling classes.', new.batch_id
      using errcode = '23514';
  end if;

  if new.trainer_id <> v_batch_trainer then
    raise exception 'The class trainer must be the assigned trainer of batch %.', new.batch_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_class_batch_trainer() from public, anon, authenticated;

create trigger classes_enforce_batch_trainer
  before insert or update of trainer_id, batch_id on public.classes
  for each row execute function public.enforce_class_batch_trainer();

-- Reassigning a batch's trainer (super_admin only — batches are
-- admin-write) moves its scheduled/live classes to the new trainer.
-- Completed/cancelled classes keep the trainer who taught them
-- (history). Removing the trainer from a batch that still has
-- scheduled/live classes is refused.
--
-- NOT security definer: it runs with the privileges of the admin (or
-- service role) who changed the batch, so RLS on classes still applies.
create function public.sync_batch_trainer_to_classes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trainer_id is not distinct from old.trainer_id then
    return null;
  end if;

  if new.trainer_id is null then
    if exists (
      select 1 from public.classes c
       where c.batch_id = new.id
         and c.status in ('scheduled', 'live')
    ) then
      raise exception 'Batch % has scheduled or live classes; assign another trainer instead of removing it.', new.id
        using errcode = '23514';
    end if;
    return null;
  end if;

  update public.classes c
     set trainer_id = new.trainer_id
   where c.batch_id = new.id
     and c.status in ('scheduled', 'live')
     and c.trainer_id is distinct from new.trainer_id;

  return null;
end;
$$;

revoke all on function public.sync_batch_trainer_to_classes() from public, anon, authenticated;

create trigger batches_sync_trainer_to_classes
  after update of trainer_id on public.batches
  for each row execute function public.sync_batch_trainer_to_classes();

-- Admin policy (classes_admin_all, from 0002) and trainer select
-- (classes_trainer_select, from 0001) are unchanged.

-- Trainers may only create classes in batches they run, assigned to
-- themselves (trainer_id = auth.uid() is preserved).
drop policy if exists classes_trainer_insert on public.classes;
create policy classes_trainer_insert
  on public.classes
  for insert
  to authenticated
  with check (
    public.current_app_role() = 'trainer'
    and trainer_id = auth.uid()
    and public.is_batch_trainer(batch_id)
  );

-- Trainers may only change classes that are theirs AND sit in a batch
-- they currently run (USING), and the result must still be theirs in
-- a batch they run (WITH CHECK). So a trainer can never touch a class
-- in another trainer's batch, move a class into another trainer's
-- batch, or reassign it; course_id is pinned to the batch by the
-- classes_batch_fk composite key.
drop policy if exists classes_trainer_update on public.classes;
create policy classes_trainer_update
  on public.classes
  for update
  to authenticated
  using (
    public.current_app_role() = 'trainer'
    and trainer_id = auth.uid()
    and public.is_batch_trainer(batch_id)
  )
  with check (
    public.current_app_role() = 'trainer'
    and trainer_id = auth.uid()
    and public.is_batch_trainer(batch_id)
  );

-- Students: replaces the hard-coded `and false` from 0001 with real
-- enrolment. Withdrawn students lose access; completed ones keep it.
drop policy if exists classes_student_select on public.classes;
create policy classes_student_select
  on public.classes
  for select
  to authenticated
  using (
    public.current_app_role() = 'student'
    and public.is_enrolled_in_batch(batch_id)
  );

commit;
