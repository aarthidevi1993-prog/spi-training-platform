-- ===================================================================
-- 0005 — CLASS ATTENDANCE
--
-- One row = one student's attendance for one specific scheduled class.
--
--   class_attendance (class_id, student_id)  PK
--     (class_id, batch_id)   → classes (id, batch_id)
--         the class belongs to the supplied batch
--     (batch_id, student_id) → batch_students (batch_id, student_id)
--         the student is enrolled in that batch
--     student_id             → students (id)
--     marked_by              → profiles (id)
--
-- Identity (verified in 0002/0003, not assumed):
--   auth.users.id ← profiles.id (PK + FK) ← students.id (PK + FK),
--   and students rows are only active for role 'student' profiles.
--   So a student owns exactly the rows whose student_id = auth.uid();
--   the student policy proves this through owns_student_record(), which
--   joins students → profiles and checks auth.uid() and the role.
--
-- Also:
--   - the only change to an existing table is ADDING
--     classes_id_batch_key unique (id, batch_id) — required as the target
--     of the (class_id, batch_id) composite foreign key. classes.id is
--     already the primary key, so no existing row can violate it.
--   - no check-in/check-out: Teams owns join/leave timing.
--
-- No DROP TABLE, DELETE, TRUNCATE or data rewrites. Runs as ONE
-- transaction (BEGIN/COMMIT below) — paste into the SQL Editor as-is.
--
-- Depends on 0001–0004. REVIEW BEFORE RUNNING. Not executed anywhere.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless the database is in the
--    expected post-0004 state.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.classes') is null
     or to_regclass('public.students') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.batch_students') is null then
    raise exception 'Preflight failed: 0001–0003 tables are missing.';
  end if;

  if to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_batch_trainer(uuid)') is null
     or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'Preflight failed: 0002/0003 helper functions are missing.';
  end if;

  -- The student identity chain this migration relies on:
  -- students.id → profiles.id → auth.users.id.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.students'::regclass
       and confrelid = 'public.profiles'::regclass
       and contype = 'f'
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and confrelid = 'auth.users'::regclass
       and contype = 'f'
  ) then
    raise exception 'Preflight failed: students → profiles → auth.users foreign keys not found.';
  end if;

  -- classes must be reachable by signed-in users (0004).
  if not has_table_privilege('authenticated', 'public.classes', 'select') then
    raise exception 'Preflight failed: 0004 (classes privileges) is not applied.';
  end if;

  if to_regclass('public.class_attendance') is not null
     or to_regtype('public.attendance_status') is not null then
    raise exception 'Preflight failed: class_attendance already exists (0005 already applied?).';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Additive constraint on classes (target of the composite FK).
--    Consequence: once a class has attendance, its batch_id can no
--    longer be changed (the FK blocks it) — attendance history stays
--    attached to the batch it was taken in.
-- -------------------------------------------------------------------
alter table public.classes
  add constraint classes_id_batch_key unique (id, batch_id);

-- -------------------------------------------------------------------
-- 2. Status type and table
-- -------------------------------------------------------------------
create type public.attendance_status as enum ('present', 'absent', 'late', 'excused');

create table public.class_attendance (
  class_id    uuid                     not null,
  student_id  uuid                     not null,
  batch_id    uuid                     not null,
  status      public.attendance_status not null,
  remarks     text                     null,
  -- Always stamped by the database (see class_attendance_stamp).
  marked_by   uuid                     not null references public.profiles (id) on delete restrict,
  marked_at   timestamptz              not null default now(),
  created_at  timestamptz              not null default now(),
  updated_at  timestamptz              not null default now(),

  constraint class_attendance_pkey primary key (class_id, student_id),

  -- The class belongs to the supplied batch.
  constraint class_attendance_class_batch_fk
    foreign key (class_id, batch_id) references public.classes (id, batch_id) on delete restrict,

  -- The student is enrolled (has a batch_students row) in that batch.
  constraint class_attendance_enrolment_fk
    foreign key (batch_id, student_id) references public.batch_students (batch_id, student_id) on delete restrict,

  constraint class_attendance_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,

  constraint class_attendance_remarks_length
    check (remarks is null or char_length(remarks) <= 500)
);

-- "My attendance" (student) and batch/trainer views; class_id lookups
-- use the primary key.
create index class_attendance_student_id_idx on public.class_attendance (student_id);
create index class_attendance_batch_id_idx   on public.class_attendance (batch_id);

-- -------------------------------------------------------------------
-- 3. Triggers
-- -------------------------------------------------------------------

-- a) Stamp: marked_by / marked_at / updated_at are controlled by the
--    database, and a record's identity (class, student, batch) never
--    changes. marked_by and marked_at always describe the same event:
--    the latest real attendance change (new record, or status/remarks
--    changed), which must come from a signed-in profile. Client-supplied
--    marked_by / marked_at values are never trusted. Runs with the
--    caller's rights (not security definer); it needs no extra access.
create function public.class_attendance_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.class_id   is distinct from old.class_id
       or new.student_id is distinct from old.student_id
       or new.batch_id   is distinct from old.batch_id then
      raise exception 'An attendance record''s class, student and batch cannot be changed.'
        using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;

  if tg_op = 'UPDATE'
     and new.status  is not distinct from old.status
     and new.remarks is not distinct from old.remarks then
    -- No attendance change: keep who/when of the last real change,
    -- whatever the caller sent.
    new.marked_by := old.marked_by;
    new.marked_at := old.marked_at;
  else
    -- An attendance change (new record, or status/remarks changed) must
    -- come from a signed-in profile — no exceptions (not even the SQL
    -- editor or the service role), so marked_by is always the person
    -- who made the latest change and can never be stale or faked.
    if auth.uid() is null then
      raise exception 'Attendance can only be recorded or changed by a signed-in user.'
        using errcode = '42501';
    end if;
    new.marked_by := auth.uid();
    new.marked_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public.class_attendance_stamp() from public, anon, authenticated;

create trigger class_attendance_stamp
  before insert or update on public.class_attendance
  for each row execute function public.class_attendance_stamp();

-- b) Validate: no attendance for cancelled classes, and no new records
--    for withdrawn enrolments. Security definer so the class/enrolment
--    lookups are not hidden by the caller's RLS.
--    (Existing records of a student who later withdrew stay readable and
--     can still be corrected by UPDATE.)
create function public.class_attendance_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_status text;
  v_enrolment    public.enrollment_status;
begin
  select c.status into v_class_status
    from public.classes c
   where c.id = new.class_id;

  if v_class_status = 'cancelled' then
    raise exception 'Attendance cannot be recorded for a cancelled class.'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    select bs.enrollment_status into v_enrolment
      from public.batch_students bs
     where bs.batch_id = new.batch_id
       and bs.student_id = new.student_id;

    if v_enrolment = 'withdrawn'::public.enrollment_status then
      raise exception 'Attendance cannot be recorded for a withdrawn student.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.class_attendance_validate() from public, anon, authenticated;

create trigger class_attendance_validate
  before insert or update on public.class_attendance
  for each row execute function public.class_attendance_validate();

-- -------------------------------------------------------------------
-- 4. RLS helpers (same safety properties as the 0003 helpers: fixed
--    search_path, static SQL, read-only, answer about the CALLER only,
--    fail closed).
-- -------------------------------------------------------------------

-- Caller (a trainer) teaches this class. Read-only visibility for a
-- trainer's past classes after a batch reassignment; writes always
-- require is_batch_trainer().
create function public.is_class_trainer(p_class_id uuid)
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
       where c.id = p_class_id
         and c.trainer_id = auth.uid()
    ),
    false
  );
$$;

-- Caller is the student who owns this student record: proven through
-- students → profiles → auth.uid(), with the profile role 'student'.
create function public.owns_student_record(p_student_id uuid)
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
    ),
    false
  );
$$;

revoke all on function public.is_class_trainer(uuid)    from public, anon;
revoke all on function public.owns_student_record(uuid) from public, anon;
grant execute on function public.is_class_trainer(uuid)    to authenticated, service_role;
grant execute on function public.owns_student_record(uuid) to authenticated, service_role;

-- -------------------------------------------------------------------
-- 5. Privileges + Row Level Security
-- -------------------------------------------------------------------
alter table public.class_attendance enable row level security;

revoke all on table public.class_attendance from anon, authenticated;
grant select, insert, update, delete on table public.class_attendance to authenticated;
grant all on table public.class_attendance to service_role;

-- Super admin: full administration (read, correct, delete).
create policy class_attendance_admin_all
  on public.class_attendance for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Trainer read: batches they run, plus classes they taught.
create policy class_attendance_trainer_select
  on public.class_attendance for select to authenticated
  using (
    public.is_batch_trainer(batch_id)
    or public.is_class_trainer(class_id)
  );

-- Trainer write: only for batches they currently run. No DELETE policy
-- for trainers — attendance history cannot be deleted by them.
create policy class_attendance_trainer_insert
  on public.class_attendance for insert to authenticated
  with check (
    public.current_app_role() = 'trainer'
    and public.is_batch_trainer(batch_id)
  );

create policy class_attendance_trainer_update
  on public.class_attendance for update to authenticated
  using (
    public.current_app_role() = 'trainer'
    and public.is_batch_trainer(batch_id)
  )
  with check (
    public.current_app_role() = 'trainer'
    and public.is_batch_trainer(batch_id)
  );

-- Student read: only their own records (ownership proven via
-- owns_student_record). No student write policies.
create policy class_attendance_student_select
  on public.class_attendance for select to authenticated
  using (public.owns_student_record(student_id));

commit;
