-- ===================================================================
-- 0006 — CLASS ASSIGNMENTS AND SUBMISSIONS
--
-- Class-level assignments (several per class) and one submission per
-- student per assignment, with trainer review (score + feedback).
--
--   class_assignments (id)                            PK
--     (class_id, batch_id)       → classes (id, batch_id)        [0005 key]
--   assignment_submissions (assignment_id, student_id) PK
--     (assignment_id, batch_id)  → class_assignments (id, batch_id)
--     (batch_id, student_id)     → batch_students (batch_id, student_id)
--     student_id                 → students (id)
--
-- Files stay in SharePoint/OneDrive: only http(s) LINKS are stored
-- (resource_url, submission_url). No Supabase Storage.
-- "Late" is not stored: it is submitted_at > due_at.
--
-- Lifecycle: assignment draft → published → closed (closed → published
-- reopen allowed; published/closed → draft prohibited). Submission
-- submitted → returned (trainer/admin may reopen: returned → submitted,
-- which clears the review and lets the student resubmit).
--
-- Audit integrity (same pattern as 0005): created_by / updated_by /
-- reviewed_by / reviewed_at / submitted_at are stamped by the database
-- from auth.uid() / now(); a no-op update keeps the existing stamps;
-- any real change without a signed-in user is refused.
--
-- Reuses the 0003/0005 helpers (current_app_role, is_super_admin,
-- is_batch_trainer, is_enrolled_in_batch, is_class_trainer,
-- owns_student_record) and classes_id_batch_key. No existing table is
-- modified. No DROP TABLE, DELETE, TRUNCATE or data rewrites.
--
-- Runs as ONE transaction (BEGIN/COMMIT below) — paste into the SQL
-- Editor as-is. Depends on 0001–0005. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless 0001–0005 are in place
--    and 0006 has not been applied.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.class_attendance') is null
     or to_regprocedure('public.owns_student_record(uuid)') is null
     or to_regprocedure('public.is_class_trainer(uuid)') is null
     or to_regprocedure('public.is_batch_trainer(uuid)') is null
     or to_regprocedure('public.is_enrolled_in_batch(uuid)') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.current_app_role()') is null then
    raise exception 'Preflight failed: 0003/0005 objects are missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.classes'::regclass
       and conname = 'classes_id_batch_key'
  ) then
    raise exception 'Preflight failed: classes_id_batch_key (0005) is missing.';
  end if;

  if to_regclass('public.class_assignments') is not null
     or to_regclass('public.assignment_submissions') is not null
     or to_regtype('public.assignment_status') is not null
     or to_regtype('public.submission_status') is not null then
    raise exception 'Preflight failed: 0006 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.assignment_status as enum ('draft', 'published', 'closed');
create type public.submission_status as enum ('submitted', 'returned');

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------

-- One task set for one class (several per class allowed).
create table public.class_assignments (
  id            uuid                     primary key default gen_random_uuid(),
  class_id      uuid                     not null,
  batch_id      uuid                     not null,
  title         text                     not null,
  instructions  text                     null,
  resource_url  text                     null,   -- SharePoint/OneDrive brief (link only)
  due_at        timestamptz              null,
  max_score     numeric(6, 2)            null,
  status        public.assignment_status not null default 'draft',
  created_by    uuid                     not null references public.profiles (id) on delete restrict,
  updated_by    uuid                     not null references public.profiles (id) on delete restrict,
  created_at    timestamptz              not null default now(),
  updated_at    timestamptz              not null default now(),

  constraint class_assignments_class_batch_fk
    foreign key (class_id, batch_id) references public.classes (id, batch_id) on delete restrict,
  constraint class_assignments_id_batch_key unique (id, batch_id),   -- target for submissions
  constraint class_assignments_title_not_blank   check (length(btrim(title)) > 0),
  constraint class_assignments_title_length      check (char_length(title) <= 200),
  constraint class_assignments_instructions_len  check (instructions is null or char_length(instructions) <= 5000),
  constraint class_assignments_resource_url_ok   check (resource_url is null
                                                        or (resource_url ~* '^https?://' and char_length(resource_url) <= 2000)),
  constraint class_assignments_max_score_ok      check (max_score is null or max_score > 0)
);

create index class_assignments_class_id_idx on public.class_assignments (class_id);
create index class_assignments_batch_id_idx on public.class_assignments (batch_id);

-- One student's submission for one assignment (resubmissions update it).
create table public.assignment_submissions (
  assignment_id   uuid                     not null,
  student_id      uuid                     not null,
  batch_id        uuid                     not null,
  submission_url  text                     not null,   -- SharePoint/OneDrive link only
  note            text                     null,
  status          public.submission_status not null default 'submitted',
  submitted_at    timestamptz              not null default now(),
  score           numeric(6, 2)            null,
  feedback        text                     null,
  reviewed_by     uuid                     null references public.profiles (id) on delete restrict,
  reviewed_at     timestamptz              null,
  created_at      timestamptz              not null default now(),
  updated_at      timestamptz              not null default now(),

  constraint assignment_submissions_pkey primary key (assignment_id, student_id),
  -- The submission belongs to this assignment's batch; submissions
  -- block deleting their assignment (history).
  constraint assignment_submissions_assignment_batch_fk
    foreign key (assignment_id, batch_id) references public.class_assignments (id, batch_id) on delete restrict,
  -- The student is enrolled (has a batch_students row) in that batch.
  constraint assignment_submissions_enrolment_fk
    foreign key (batch_id, student_id) references public.batch_students (batch_id, student_id) on delete restrict,
  constraint assignment_submissions_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  constraint assignment_submissions_url_ok        check (submission_url ~* '^https?://' and char_length(submission_url) <= 2000),
  constraint assignment_submissions_note_len      check (note is null or char_length(note) <= 1000),
  constraint assignment_submissions_feedback_len  check (feedback is null or char_length(feedback) <= 5000),
  constraint assignment_submissions_score_ok      check (score is null or score >= 0),
  -- Returned <=> reviewer and review time recorded; score/feedback only on returned.
  constraint assignment_submissions_review_consistent check (
    (status = 'returned') = (reviewed_by is not null and reviewed_at is not null)
    and (status = 'returned' or (score is null and feedback is null))
  )
);

create index assignment_submissions_student_id_idx on public.assignment_submissions (student_id);
create index assignment_submissions_batch_id_idx   on public.assignment_submissions (batch_id);

-- -------------------------------------------------------------------
-- 3. Triggers
-- -------------------------------------------------------------------

-- a) Assignments: stamp who/when; class and batch can't change; an
--    update that changes nothing keeps the old stamp. Runs with the
--    caller's rights (not security definer); it needs no extra access.
create function public.class_assignments_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.class_id is distinct from old.class_id or new.batch_id is distinct from old.batch_id then
      raise exception 'An assignment''s class and batch cannot be changed.' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if (new.title, new.instructions, new.resource_url, new.due_at, new.max_score, new.status)
       is not distinct from
       (old.title, old.instructions, old.resource_url, old.due_at, old.max_score, old.status) then
      -- No real change: keep who/when.
      new.updated_by := old.updated_by;
      new.updated_at := old.updated_at;
      return new;
    end if;
  end if;

  if auth.uid() is null then
    raise exception 'Assignments can only be created or changed by a signed-in user.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.class_assignments_stamp() from public, anon, authenticated;

create trigger class_assignments_stamp
  before insert or update on public.class_assignments
  for each row execute function public.class_assignments_stamp();

-- b) Assignments: business rules. Security definer so the class and
--    submission lookups are not hidden by the caller's RLS.
create function public.class_assignments_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_status text;
  v_top_score    numeric;
begin
  -- No creating or publishing assignments for a cancelled class.
  if tg_op = 'INSERT' or (new.status = 'published' and old.status is distinct from 'published') then
    select c.status into v_class_status from public.classes c where c.id = new.class_id;
    if v_class_status = 'cancelled' then
      raise exception 'Assignments cannot be created or published for a cancelled class.' using errcode = '23514';
    end if;
  end if;

  -- Published/closed never goes back to draft.
  if tg_op = 'UPDATE' and old.status <> 'draft' and new.status = 'draft' then
    raise exception 'A published assignment cannot be moved back to draft.' using errcode = '23514';
  end if;

  -- max_score cannot be lowered below an existing score.
  if tg_op = 'UPDATE' and new.max_score is not null and new.max_score is distinct from old.max_score then
    select max(s.score) into v_top_score
      from public.assignment_submissions s
     where s.assignment_id = new.id;
    if v_top_score is not null and v_top_score > new.max_score then
      raise exception 'Maximum score cannot be lower than an existing score (%).', v_top_score using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.class_assignments_validate() from public, anon, authenticated;

create trigger class_assignments_validate
  before insert or update on public.class_assignments
  for each row execute function public.class_assignments_validate();

-- c) Submissions: protected fields and stamping, by role. Students own
--    the work fields (submission_url, note); trainers/admins own the
--    review fields (status, score, feedback). Nobody — admins included
--    — can rewrite an existing student's submission_url or note.
--    Runs with the caller's rights (not security definer).
create function public.assignment_submissions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
begin
  if auth.uid() is null then
    raise exception 'Submissions can only be changed by a signed-in user.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new.assignment_id is distinct from old.assignment_id
       or new.student_id is distinct from old.student_id
       or new.batch_id is distinct from old.batch_id then
      raise exception 'A submission''s assignment, student and batch cannot be changed.' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;

  if tg_op = 'INSERT' then
    -- Every new submission starts unreviewed, whatever the caller sent.
    new.status       := 'submitted';
    new.submitted_at := now();
    new.score        := null;
    new.feedback     := null;
    new.reviewed_by  := null;
    new.reviewed_at  := null;
    return new;
  end if;

  if v_role = 'student' then
    if old.status = 'returned' then
      raise exception 'This submission has been returned and can no longer be changed.' using errcode = '42501';
    end if;
    -- Review fields always keep their stored values.
    new.status      := old.status;
    new.score       := old.score;
    new.feedback    := old.feedback;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    -- A resubmission (link or note changed) restamps submitted_at.
    if new.submission_url is distinct from old.submission_url or new.note is distinct from old.note then
      new.submitted_at := now();
    else
      new.submitted_at := old.submitted_at;
    end if;

  elsif v_role in ('trainer', 'super_admin') then
    -- The student's work always keeps its stored values.
    new.submission_url := old.submission_url;
    new.note           := old.note;
    new.submitted_at   := old.submitted_at;
    if new.status = 'submitted' then
      -- Unreviewed or reopened: no review data (lets the student resubmit).
      new.score       := null;
      new.feedback    := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
    elsif new.status is distinct from old.status
          or new.score is distinct from old.score
          or new.feedback is distinct from old.feedback then
      -- A real review change: stamp the reviewer.
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    else
      -- No review change: keep who/when.
      new.reviewed_by := old.reviewed_by;
      new.reviewed_at := old.reviewed_at;
    end if;

  else
    raise exception 'You don''t have permission to change submissions.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.assignment_submissions_guard() from public, anon, authenticated;

create trigger assignment_submissions_guard
  before insert or update on public.assignment_submissions
  for each row execute function public.assignment_submissions_guard();

-- d) Submissions: business rules. Security definer so the assignment,
--    class and enrolment lookups are not hidden by the caller's RLS.
--    Fires after the guard (triggers run in name order).
create function public.assignment_submissions_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment_status public.assignment_status;
  v_max_score         numeric;
  v_class_status      text;
  v_enrolment         public.enrollment_status;
begin
  select a.status, a.max_score, c.status
    into v_assignment_status, v_max_score, v_class_status
    from public.class_assignments a
    join public.classes c on c.id = a.class_id
   where a.id = new.assignment_id;

  -- New work (insert, or a changed link/note) only while published, and
  -- never for a cancelled class. Closed assignments accept no new
  -- submissions or resubmissions (reviewing is still allowed).
  if tg_op = 'INSERT'
     or new.submission_url is distinct from old.submission_url
     or new.note is distinct from old.note then
    if v_assignment_status is distinct from 'published'::public.assignment_status then
      raise exception 'Submissions are only accepted while the assignment is published.' using errcode = '23514';
    end if;
    if v_class_status = 'cancelled' then
      raise exception 'Submissions are not accepted for a cancelled class.' using errcode = '23514';
    end if;
  end if;

  -- Withdrawn students cannot submit.
  if tg_op = 'INSERT' then
    select bs.enrollment_status into v_enrolment
      from public.batch_students bs
     where bs.batch_id = new.batch_id
       and bs.student_id = new.student_id;
    if v_enrolment = 'withdrawn'::public.enrollment_status then
      raise exception 'Withdrawn students cannot submit.' using errcode = '23514';
    end if;
  end if;

  -- Score cannot exceed the assignment's maximum score.
  if new.score is not null and v_max_score is not null and new.score > v_max_score then
    raise exception 'Score cannot exceed the maximum score (%).', v_max_score using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.assignment_submissions_validate() from public, anon, authenticated;

create trigger assignment_submissions_validate
  before insert or update on public.assignment_submissions
  for each row execute function public.assignment_submissions_validate();

-- -------------------------------------------------------------------
-- 4. Privileges + Row Level Security
--    Anonymous: nothing. Authenticated: table privileges, with every
--    row filtered by the policies below (RLS is the final boundary).
-- -------------------------------------------------------------------
alter table public.class_assignments      enable row level security;
alter table public.assignment_submissions enable row level security;

revoke all on table public.class_assignments, public.assignment_submissions from anon, authenticated;
grant select, insert, update, delete on table public.class_assignments, public.assignment_submissions to authenticated;
grant all on table public.class_assignments, public.assignment_submissions to service_role;

-- class_assignments --------------------------------------------------

-- Super admin: full lifecycle management.
create policy class_assignments_admin_all
  on public.class_assignments for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Trainer read: batches they run, plus classes they taught (a previous
-- trainer keeps read access to assignments of classes they taught).
create policy class_assignments_trainer_select
  on public.class_assignments for select to authenticated
  using (public.is_batch_trainer(batch_id) or public.is_class_trainer(class_id));

-- Trainer write: only for batches they currently run.
create policy class_assignments_trainer_insert
  on public.class_assignments for insert to authenticated
  with check (public.current_app_role() = 'trainer' and public.is_batch_trainer(batch_id));

create policy class_assignments_trainer_update
  on public.class_assignments for update to authenticated
  using      (public.current_app_role() = 'trainer' and public.is_batch_trainer(batch_id))
  with check (public.current_app_role() = 'trainer' and public.is_batch_trainer(batch_id));

-- Trainer delete: drafts only (submissions also block deletion via FK).
create policy class_assignments_trainer_delete_draft
  on public.class_assignments for delete to authenticated
  using (public.current_app_role() = 'trainer' and public.is_batch_trainer(batch_id) and status = 'draft');

-- Student read: published/closed assignments of batches they are
-- enrolled in (not withdrawn). Never drafts.
create policy class_assignments_student_select
  on public.class_assignments for select to authenticated
  using (status in ('published', 'closed') and public.is_enrolled_in_batch(batch_id));

-- assignment_submissions ---------------------------------------------

-- Super admin: full management; the guard trigger still protects an
-- existing student's submission_url/note.
create policy assignment_submissions_admin_all
  on public.assignment_submissions for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Trainer: read and review submissions for batches they currently run.
-- No insert or delete policies for trainers.
create policy assignment_submissions_trainer_select
  on public.assignment_submissions for select to authenticated
  using (public.is_batch_trainer(batch_id));

create policy assignment_submissions_trainer_update
  on public.assignment_submissions for update to authenticated
  using (public.is_batch_trainer(batch_id))
  with check (public.is_batch_trainer(batch_id));

-- Student: only their own submissions (ownership proven via
-- owns_student_record); submit while enrolled; resubmit until returned.
-- No student delete policy.
create policy assignment_submissions_student_select
  on public.assignment_submissions for select to authenticated
  using (public.owns_student_record(student_id));

create policy assignment_submissions_student_insert
  on public.assignment_submissions for insert to authenticated
  with check (public.owns_student_record(student_id) and public.is_enrolled_in_batch(batch_id));

create policy assignment_submissions_student_update
  on public.assignment_submissions for update to authenticated
  using      (public.owns_student_record(student_id) and status = 'submitted')
  with check (public.owns_student_record(student_id) and status = 'submitted');

commit;
