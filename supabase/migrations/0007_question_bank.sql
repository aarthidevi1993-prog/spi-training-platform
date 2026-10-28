-- ===================================================================
-- 0007 — QUESTION BANK
--
-- Course/module question bank for class tests (Phase 1 types only:
-- single_choice, multiple_choice, true_false — no short answer).
--
--   questions (id)                                     PK
--     course_id               → courses (id)                  [restrict]
--     (module_id, course_id)  → modules (id, course_id)       [0003 key, restrict]
--   question_options (id)                              PK
--     question_id             → questions (id)                [cascade]
--     unique (question_id, display_order)
--
-- True/false questions are stored as exactly two options in the same
-- option table, so all three types are graded the same way later.
--
-- ANSWER KEY PROTECTION: question_options.is_correct is the answer key.
-- Students and anonymous users have NO policy on either table, so they
-- can read nothing (RLS default-deny). There is no student-facing view.
-- Future server-side grading reads the frozen copy (0008) inside
-- security definer functions.
--
-- WRITES: authenticated users get NO insert/update privilege on these
-- tables. Questions and options are written only through the security
-- definer functions below (save_question, set_question_status), which
-- save a question and all of its options in one transaction. The only
-- direct write is DELETE of a never-activated draft by a super admin.
--
-- VALIDITY: every question must always be complete and valid (2–10
-- non-blank options; correct-answer rules per type). Enforced by
-- save_question AND by deferred constraint triggers at commit, so no
-- writer (including the SQL Editor or service role) can leave an
-- invalid question behind. question_content_error() is reusable by
-- 0008 to re-validate each frozen copy when a test is published.
--
-- LIFECYCLE: draft → active ⇄ archived (draft → archived allowed).
-- Once a question has left draft it can never return to draft and can
-- never be hard-deleted (archive instead) — it may already be part of
-- a frozen test (0008: test_questions.source_question_id).
--
-- AUDIT: created_by / updated_by / created_at / updated_at / revision
-- are stamped by the database from auth.uid() / now() (same pattern as
-- 0005/0006); a no-op update keeps the existing stamps; any real change
-- without a signed-in user is refused (questions and question_options
-- alike). revision increases by 1 on every
-- real change (question or options) so 0008 can detect "bank question
-- changed since it was added to a draft test".
--
-- ACCESS: super admin — everything. Trainer — questions of courses
-- they CURRENTLY teach (is_course_trainer: assigned trainer of an
-- upcoming/ongoing batch of the course; previous trainers excluded);
-- create, edit, activate, archive; never hard-delete. Student /
-- anonymous — nothing.
--
-- Reuses the 0002/0003 helpers (current_app_role, is_super_admin) and
-- modules_id_course_key (0003). No existing table is modified. No DROP,
-- DELETE, TRUNCATE or data rewrites.
--
-- Runs as ONE transaction (BEGIN/COMMIT below) — paste into the SQL
-- Editor as-is. Depends on 0001–0006. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless 0001–0006 are in place
--    and 0007 has not been applied.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.courses') is null
     or to_regclass('public.modules') is null
     or to_regclass('public.batches') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.class_assignments') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.current_app_role()') is null then
    raise exception 'Preflight failed: 0002/0003/0006 objects are missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.modules'::regclass
       and conname = 'modules_id_course_key'
  ) then
    raise exception 'Preflight failed: modules_id_course_key (0003) is missing.';
  end if;

  if to_regclass('public.questions') is not null
     or to_regclass('public.question_options') is not null
     or to_regtype('public.question_type') is not null
     or to_regtype('public.question_status') is not null
     or to_regprocedure('public.is_course_trainer(uuid)') is not null
     or to_regprocedure('public.save_question(jsonb)') is not null then
    raise exception 'Preflight failed: 0007 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.question_type   as enum ('single_choice', 'multiple_choice', 'true_false');
create type public.question_status as enum ('draft', 'active', 'archived');

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------

-- One bank question, owned by a course and optionally a module of it.
create table public.questions (
  id             uuid                    primary key default gen_random_uuid(),
  course_id      uuid                    not null,
  module_id      uuid                    null,
  question_text  text                    not null,
  question_type  public.question_type    not null,
  marks          numeric(6, 2)           not null,
  status         public.question_status  not null default 'draft',
  explanation    text                    null,   -- shown only if a test releases correct answers
  revision       integer                 not null default 1,
  created_by     uuid                    not null references public.profiles (id) on delete restrict,
  updated_by     uuid                    not null references public.profiles (id) on delete restrict,
  created_at     timestamptz             not null default now(),
  updated_at     timestamptz             not null default now(),

  constraint questions_course_fk
    foreign key (course_id) references public.courses (id) on delete restrict,
  -- The module (when set) must belong to the question's course.
  constraint questions_module_course_fk
    foreign key (module_id, course_id) references public.modules (id, course_id) on delete restrict,
  constraint questions_text_not_blank     check (length(btrim(question_text)) > 0),
  constraint questions_text_length        check (char_length(question_text) <= 5000),
  constraint questions_marks_positive     check (marks > 0),
  constraint questions_explanation_length check (explanation is null or char_length(explanation) <= 5000),
  constraint questions_revision_positive  check (revision > 0)
);

-- Bank listing per course, filtered by status.
create index questions_course_status_idx on public.questions (course_id, status);
-- Module filter, and the module FK (restrict) lookup.
create index questions_module_id_idx     on public.questions (module_id);

-- One answer option. is_correct is the answer key (never student-visible).
create table public.question_options (
  id             uuid     primary key default gen_random_uuid(),
  question_id    uuid     not null,
  option_text    text     not null,
  display_order  integer  not null,
  is_correct     boolean  not null,

  constraint question_options_question_fk
    foreign key (question_id) references public.questions (id) on delete cascade,
  constraint question_options_question_order_key unique (question_id, display_order),
  constraint question_options_text_not_blank     check (length(btrim(option_text)) > 0),
  constraint question_options_text_length        check (char_length(option_text) <= 1000),
  constraint question_options_order_range        check (display_order between 1 and 10)
);
-- question_id lookups are served by question_options_question_order_key.

-- -------------------------------------------------------------------
-- 3. Validation (shared with 0008)
-- -------------------------------------------------------------------

-- Pure content check. Returns NULL when valid, otherwise a readable
-- message. Options are given in display order. Reused by 0008 to
-- re-validate a test's frozen copy at publish time.
create function public.question_content_error(
  p_type            public.question_type,
  p_text            text,
  p_marks           numeric,
  p_option_texts    text[],
  p_option_correct  boolean[]
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_count    integer := coalesce(cardinality(p_option_texts), 0);
  v_correct  integer := 0;
  i          integer;
begin
  if p_type is null then
    return 'Question type is required.';
  end if;
  if p_text is null or length(btrim(p_text)) = 0 then
    return 'Question text is required.';
  end if;
  if char_length(p_text) > 5000 then
    return 'Question text must be 5000 characters or fewer.';
  end if;
  if p_marks is null or p_marks <= 0 then
    return 'Marks must be greater than 0.';
  end if;
  if p_marks > 9999.99 or p_marks <> round(p_marks, 2) then
    return 'Marks must be at most 9999.99, with up to 2 decimal places.';
  end if;

  if v_count <> coalesce(cardinality(p_option_correct), 0) then
    return 'Each option needs its text and whether it is correct.';
  end if;
  if v_count < 2 or v_count > 10 then
    return 'A question needs between 2 and 10 options.';
  end if;

  for i in 1 .. v_count loop
    if p_option_texts[i] is null or length(btrim(p_option_texts[i])) = 0 then
      return 'Options cannot be blank.';
    end if;
    if char_length(p_option_texts[i]) > 1000 then
      return 'Each option must be 1000 characters or fewer.';
    end if;
    if p_option_correct[i] is null then
      return 'Each option must be marked correct or not correct.';
    end if;
    if p_option_correct[i] then
      v_correct := v_correct + 1;
    end if;
  end loop;

  if p_type = 'true_false' then
    if v_count <> 2 then
      return 'A true/false question needs exactly 2 options.';
    end if;
    if v_correct <> 1 then
      return 'A true/false question needs exactly 1 correct option.';
    end if;
  elsif p_type = 'single_choice' then
    if v_correct <> 1 then
      return 'A single-choice question needs exactly 1 correct option.';
    end if;
  elsif p_type = 'multiple_choice' then
    if v_correct < 1 then
      return 'A multiple-choice question needs at least 1 correct option.';
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.question_content_error(public.question_type, text, numeric, text[], boolean[])
  from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 4. Triggers
-- -------------------------------------------------------------------

-- a) Lifecycle + deletion guard. Left draft => never back to draft and
--    never hard-deleted (archive instead). Applies to every writer.
--    Runs with the caller's rights (not security definer).
create function public.questions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft questions can be deleted. Archive this question instead.' using errcode = '23514';
    end if;
    return old;
  end if;

  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'An active or archived question cannot be moved back to draft.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.questions_guard() from public, anon, authenticated;

create trigger questions_guard
  before update or delete on public.questions
  for each row execute function public.questions_guard();

-- b) Stamp who/when + revision; the course can't change; an update that
--    changes nothing keeps the old stamp. save_question signals an
--    options-only change by raising revision. Fires after
--    questions_guard (triggers run in name order). Caller's rights.
create function public.questions_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.course_id is distinct from old.course_id then
      raise exception 'A question''s course cannot be changed.' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if (new.module_id, new.question_text, new.question_type, new.marks, new.status, new.explanation)
       is not distinct from
       (old.module_id, old.question_text, old.question_type, old.marks, old.status, old.explanation)
       and new.revision is not distinct from old.revision then
      -- No real change: keep who/when/revision.
      new.updated_by := old.updated_by;
      new.updated_at := old.updated_at;
      return new;
    end if;
  end if;

  if auth.uid() is null then
    raise exception 'Questions can only be created or changed by a signed-in user.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.revision   := 1;
  else
    new.revision   := old.revision + 1;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.questions_stamp() from public, anon, authenticated;

create trigger questions_stamp
  before insert or update on public.questions
  for each row execute function public.questions_stamp();

-- b2) Options (the answer key) can't be written without a signed-in
--     user — same rule as questions_stamp. save_question always runs
--     with auth.uid() and restamps/revises the parent question, so
--     SQL Editor / service-role option writes can't bypass the audit.
--     Caller's rights (not security definer).
create function public.question_options_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Question options can only be changed by a signed-in user (through save_question).' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.question_options_guard() from public, anon, authenticated;

create trigger question_options_guard
  before insert or update or delete on public.question_options
  for each row execute function public.question_options_guard();

-- c) Every question must be valid at commit (deferred, so a question
--    and its options can be written in either order in one
--    transaction). Security definer so the checks are not hidden by
--    the caller's RLS. Fires for question and option changes.
create function public.questions_enforce_valid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids      uuid[] := '{}';
  v_id       uuid;
  v_type     public.question_type;
  v_text     text;
  v_marks    numeric;
  v_texts    text[];
  v_correct  boolean[];
  v_error    text;
begin
  if tg_table_name = 'questions' then
    v_ids := array[new.id];
  elsif tg_op = 'INSERT' then
    v_ids := array[new.question_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.question_id];
  else
    v_ids := array[new.question_id, old.question_id];
  end if;

  foreach v_id in array v_ids loop
    select q.question_type, q.question_text, q.marks
      into v_type, v_text, v_marks
      from public.questions q
     where q.id = v_id;
    if not found then
      continue;   -- question deleted in this transaction (options cascade)
    end if;

    select array_agg(o.option_text order by o.display_order),
           array_agg(o.is_correct  order by o.display_order)
      into v_texts, v_correct
      from public.question_options o
     where o.question_id = v_id;

    v_error := public.question_content_error(v_type, v_text, v_marks, v_texts, v_correct);
    if v_error is not null then
      raise exception '%', v_error using errcode = '23514';
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function public.questions_enforce_valid() from public, anon, authenticated;

create constraint trigger questions_enforce_valid
  after insert or update on public.questions
  deferrable initially deferred
  for each row execute function public.questions_enforce_valid();

create constraint trigger question_options_enforce_valid
  after insert or update or delete on public.question_options
  deferrable initially deferred
  for each row execute function public.questions_enforce_valid();

-- -------------------------------------------------------------------
-- 5. Helper + write functions
--    - security definer, fixed empty search_path, fully qualified names
--    - identity always from auth.uid(); never from the payload
--    - EXECUTE revoked from public/anon, granted to authenticated
-- -------------------------------------------------------------------

-- Caller is a CURRENT trainer of this course: the assigned trainer of
-- an upcoming or ongoing batch of it. Previous trainers (completed /
-- cancelled batches, or reassigned batches) are excluded.
create function public.is_course_trainer(p_course_id uuid)
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
       where b.course_id = p_course_id
         and b.trainer_id = auth.uid()
         and b.status in ('upcoming', 'ongoing')
    ),
    false
  );
$$;

-- Create (no "id") or update (with "id") a question and ALL of its
-- options atomically. Returns the question id.
--
-- payload (jsonb object):
--   id             uuid     optional — omit to create
--   course_id      uuid     required to create; on update must match
--   module_id      uuid     optional (null = course-level question)
--   question_text  text     required
--   question_type  text     single_choice | multiple_choice | true_false
--   marks          number   > 0, up to 2 decimals
--   explanation    text     optional
--   status         text     optional: draft | active | archived
--                           (create defaults to draft; update keeps the
--                           current status when omitted)
--   options        array    2–10 × { option_text: text, is_correct: boolean }
--                           in display order (display_order is assigned
--                           by the database: 1..n)
--
-- Any created_by / updated_by / revision / timestamps in the payload
-- are ignored (the database stamps them).
create function public.save_question(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_role           text := public.current_app_role();
  v_id             uuid;
  v_course_id      uuid;
  v_module_id      uuid;
  v_text           text;
  v_type_text      text;
  v_type           public.question_type;
  v_marks          numeric;
  v_explanation    text;
  v_status_text    text;
  v_status         public.question_status;
  v_old_course_id  uuid;
  v_old_status     public.question_status;
  v_texts          text[];
  v_correct        boolean[];
  v_old_texts      text[];
  v_old_correct    boolean[];
  v_options_changed boolean;
  v_error          text;
begin
  -- Who: a signed-in super admin or trainer.
  if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to manage questions.' using errcode = '42501';
  end if;

  -- Shape.
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'Invalid question data.' using errcode = '22023';
  end if;
  if jsonb_typeof(payload -> 'options') is distinct from 'array' then
    raise exception 'A question needs between 2 and 10 options.' using errcode = '22023';
  end if;
  if jsonb_typeof(payload -> 'marks') is distinct from 'number' then
    raise exception 'Marks must be a number greater than 0.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(payload -> 'options') as e(opt)
     where jsonb_typeof(opt) <> 'object'
        or jsonb_typeof(opt -> 'option_text') is distinct from 'string'
        or jsonb_typeof(opt -> 'is_correct') is distinct from 'boolean'
  ) then
    raise exception 'Each option needs its text and whether it is correct.' using errcode = '22023';
  end if;

  -- Ids (friendly message instead of a raw cast error).
  begin
    v_id        := nullif(btrim(payload ->> 'id'), '')::uuid;
    v_course_id := nullif(btrim(payload ->> 'course_id'), '')::uuid;
    v_module_id := nullif(btrim(payload ->> 'module_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid question, course or module id.' using errcode = '22023';
  end;

  -- Type.
  v_type_text := payload ->> 'question_type';
  if v_type_text is null or v_type_text not in ('single_choice', 'multiple_choice', 'true_false') then
    raise exception 'Question type must be single choice, multiple choice or true/false.' using errcode = '22023';
  end if;
  v_type := v_type_text::public.question_type;

  -- Status (optional).
  v_status_text := payload ->> 'status';
  if v_status_text is not null and v_status_text not in ('draft', 'active', 'archived') then
    raise exception 'Status must be draft, active or archived.' using errcode = '22023';
  end if;

  v_text        := btrim(coalesce(payload ->> 'question_text', ''));
  v_marks       := (payload ->> 'marks')::numeric;
  v_explanation := nullif(btrim(coalesce(payload ->> 'explanation', '')), '');
  if v_explanation is not null and char_length(v_explanation) > 5000 then
    raise exception 'Explanation must be 5000 characters or fewer.' using errcode = '23514';
  end if;

  select array_agg(btrim(opt ->> 'option_text') order by ord),
         array_agg((opt ->> 'is_correct')::boolean order by ord)
    into v_texts, v_correct
    from jsonb_array_elements(payload -> 'options') with ordinality as e(opt, ord);

  -- Existing question: lock it; course is fixed; caller must manage it.
  if v_id is not null then
    select q.course_id, q.status
      into v_old_course_id, v_old_status
      from public.questions q
     where q.id = v_id
       for update;
    if not found
       or not (public.is_super_admin() or public.is_course_trainer(v_old_course_id)) then
      raise exception 'Question not found, or you don''t have permission to change it.' using errcode = '42501';
    end if;
    if v_course_id is not null and v_course_id <> v_old_course_id then
      raise exception 'A question''s course cannot be changed.' using errcode = '42501';
    end if;
    v_course_id := v_old_course_id;
    v_status    := coalesce(v_status_text::public.question_status, v_old_status);
  else
    if v_course_id is null then
      raise exception 'Course is required.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.courses c where c.id = v_course_id) then
      raise exception 'Course not found.' using errcode = '23503';
    end if;
    if not (public.is_super_admin() or public.is_course_trainer(v_course_id)) then
      raise exception 'You can only add questions to courses you currently teach.' using errcode = '42501';
    end if;
    v_status := coalesce(v_status_text::public.question_status, 'draft');
  end if;

  -- Module must belong to the question's course.
  if v_module_id is not null
     and not exists (select 1 from public.modules m where m.id = v_module_id and m.course_id = v_course_id) then
    raise exception 'That module does not belong to this course.' using errcode = '23503';
  end if;

  -- Content rules (type, text, marks, option count, correct answers).
  v_error := public.question_content_error(v_type, v_text, v_marks, v_texts, v_correct);
  if v_error is not null then
    raise exception '%', v_error using errcode = '23514';
  end if;

  if v_id is null then
    insert into public.questions (course_id, module_id, question_text, question_type, marks, explanation, status)
    values (v_course_id, v_module_id, v_text, v_type, v_marks, v_explanation, v_status)
    returning id into v_id;
    v_options_changed := true;
  else
    select array_agg(o.option_text order by o.display_order),
           array_agg(o.is_correct  order by o.display_order)
      into v_old_texts, v_old_correct
      from public.question_options o
     where o.question_id = v_id;
    v_options_changed := v_old_texts is distinct from v_texts or v_old_correct is distinct from v_correct;

    update public.questions q
       set module_id     = v_module_id,
           question_text = v_text,
           question_type = v_type,
           marks         = v_marks,
           explanation   = v_explanation,
           status        = v_status,
           -- Options-only change still counts as a real change (restamp).
           revision      = case when v_options_changed then q.revision + 1 else q.revision end
     where q.id = v_id;
  end if;

  -- Replace the options only when they actually changed.
  if v_options_changed then
    delete from public.question_options o where o.question_id = v_id;
    insert into public.question_options (question_id, option_text, display_order, is_correct)
    select v_id, t.option_text, t.ord::integer, t.is_correct
      from unnest(v_texts, v_correct) with ordinality as t(option_text, is_correct, ord);
  end if;

  return v_id;
end;
$$;

-- Activate or archive a question (or keep a draft a draft). Moving a
-- non-draft question back to draft is refused by questions_guard.
create function public.set_question_status(p_question_id uuid, p_status public.question_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_course_id uuid;
begin
  if auth.uid() is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to manage questions.' using errcode = '42501';
  end if;
  if p_status is null then
    raise exception 'Status is required.' using errcode = '22023';
  end if;

  select q.course_id into v_course_id
    from public.questions q
   where q.id = p_question_id
     for update;
  if not found
     or not (public.is_super_admin() or public.is_course_trainer(v_course_id)) then
    raise exception 'Question not found, or you don''t have permission to change it.' using errcode = '42501';
  end if;

  update public.questions q set status = p_status where q.id = p_question_id;
end;
$$;

revoke all on function public.is_course_trainer(uuid)                                from public, anon;
revoke all on function public.save_question(jsonb)                                   from public, anon;
revoke all on function public.set_question_status(uuid, public.question_status)      from public, anon;

grant execute on function public.is_course_trainer(uuid)                             to authenticated, service_role;
grant execute on function public.save_question(jsonb)                                to authenticated, service_role;
grant execute on function public.set_question_status(uuid, public.question_status)   to authenticated, service_role;

-- -------------------------------------------------------------------
-- 6. Privileges + Row Level Security
--    Anonymous: nothing. Authenticated: SELECT (+ DELETE on questions),
--    every row filtered by the policies below. No INSERT/UPDATE
--    privilege: writes go through the functions in section 5.
--    Students have no policy on either table => no rows, no answer key.
-- -------------------------------------------------------------------
alter table public.questions        enable row level security;
alter table public.question_options enable row level security;

revoke all on table public.questions, public.question_options from anon, authenticated;
grant select, delete on table public.questions        to authenticated;
grant select         on table public.question_options to authenticated;
grant all on table public.questions, public.question_options to service_role;

-- questions -----------------------------------------------------------

-- Read: super admin, or a current trainer of the question's course.
create policy questions_select
  on public.questions for select to authenticated
  using (public.is_super_admin() or public.is_course_trainer(course_id));

-- Delete: super admin only, never-activated drafts only (questions_guard
-- enforces the same rule for every writer). Trainers never hard-delete.
create policy questions_admin_delete_draft
  on public.questions for delete to authenticated
  using (public.is_super_admin() and status = 'draft');

-- question_options ----------------------------------------------------

-- Read (including is_correct): the same staff who can read the question.
create policy question_options_select
  on public.question_options for select to authenticated
  using (
    exists (
      select 1
        from public.questions q
       where q.id = question_options.question_id
         and (public.is_super_admin() or public.is_course_trainer(q.course_id))
    )
  );

commit;
