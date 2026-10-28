-- ===================================================================
-- 0008 — CLASS TESTS (definitions + frozen question set)
--
-- Class-level tests (several per class) whose questions are a FROZEN
-- COPY of active Question Bank (0007) questions. This migration covers
-- ONLY test definitions, the frozen question set, the lifecycle and
-- publish validation, and RLS. Attempts, answers, the server timer and
-- deadline, per-attempt random order, grading, results and security
-- events are 0009.
--
--   tests (id)                                            PK
--     (class_id, batch_id)   → classes (id, batch_id)        [0005 key]
--     unique (id, batch_id)                                  (target for 0009)
--   test_questions (id)                                   PK
--     test_id                → tests (id)                    [cascade: drafts only]
--     source_question_id     → questions (id)                [restrict: lineage]
--     unique (test_id, position), unique (test_id, source_question_id)
--   test_question_options (id)                            PK
--     test_question_id       → test_questions (id)           [cascade]
--     unique (test_question_id, display_order)
--
-- LIFECYCLE (stored status): draft → scheduled | active → closed,
-- closed → scheduled | active (reopen). Never back to draft.
-- Publishing / reopening stores 'active' when available_from has
-- passed, otherwise 'scheduled'. Time moves on without a write, so
-- readers must use test_effective_status(): scheduled becomes active
-- at available_from and anything published becomes closed at
-- available_until (no scheduled job needed).
--
-- PUBLISH VALIDATION (tests_validate): class and batch not cancelled;
-- opening/closing times set, closing after opening and in the future;
-- pass mark (0–100 %) and time limit set; attempt limit >= 1; at least
-- one question; every frozen question still matches its bank source
-- (exists, active, same revision) and passes the 0007
-- question_content_error() check.
--
-- FREEZE: after publishing, the question set (questions, options,
-- marks) and test_type, pass mark, time limit, attempt limit and
-- available_from are locked. Still allowed: title/instructions,
-- close/reopen, and EXTENDING available_until. Frozen rows can never
-- be edited — in a draft they are removed and re-added.
--
-- ANSWER KEY: test_question_options.is_correct is the answer key.
-- Students and anonymous users have NO policy on any 0008 table (RLS
-- default-deny). The student-safe access path is designed in 0009.
--
-- WRITES: tests — direct insert/update/delete under RLS, guarded by
-- triggers (same pattern as 0006). Frozen tables — NO write privilege
-- for authenticated users; rows are created/removed only by the
-- security definer functions add_test_questions / remove_test_question,
-- which copy content from the bank server-side (never from the client).
--
-- ACCESS: super admin — everything. Trainer — manage tests of batches
-- they CURRENTLY run (is_current_batch_trainer: assigned trainer of an
-- upcoming/ongoing batch); add only active questions of the class's
-- course that they may manage in the bank (is_course_trainer). Read:
-- the batch's assigned trainer (tests + frozen questions); a previous
-- class trainer (is_class_trainer) reads test definitions only.
--
-- AUDIT (same pattern as 0005–0007): created_by / updated_by /
-- added_by and timestamps are stamped by the database from auth.uid()
-- / now(); a no-op update keeps the stamps; any real change without a
-- signed-in user is refused (tests and frozen tables alike).
--
-- Reuses 0003/0005/0007 helpers (current_app_role, is_super_admin,
-- is_batch_trainer, is_class_trainer, is_course_trainer,
-- question_content_error) and classes_id_batch_key. No existing table
-- is modified. No DROP, DELETE, TRUNCATE or data rewrites.
--
-- Runs as ONE transaction (BEGIN/COMMIT below) — paste into the SQL
-- Editor as-is. Depends on 0001–0007. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless 0001–0007 are in place
--    and 0008 has not been applied.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.classes') is null
     or to_regclass('public.batches') is null
     or to_regclass('public.questions') is null
     or to_regclass('public.question_options') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.is_batch_trainer(uuid)') is null
     or to_regprocedure('public.is_class_trainer(uuid)') is null
     or to_regprocedure('public.is_course_trainer(uuid)') is null
     or to_regprocedure('public.question_content_error(public.question_type, text, numeric, text[], boolean[])') is null then
    raise exception 'Preflight failed: 0003/0005/0007 objects are missing.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.classes'::regclass
       and conname = 'classes_id_batch_key'
  ) then
    raise exception 'Preflight failed: classes_id_batch_key (0005) is missing.';
  end if;

  if to_regclass('public.tests') is not null
     or to_regclass('public.test_questions') is not null
     or to_regclass('public.test_question_options') is not null
     or to_regtype('public.test_type') is not null
     or to_regtype('public.test_status') is not null
     or to_regprocedure('public.is_current_batch_trainer(uuid)') is not null then
    raise exception 'Preflight failed: 0008 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.test_type   as enum ('quiz', 'module_test', 'final_exam', 'practical');
create type public.test_status as enum ('draft', 'scheduled', 'active', 'closed');

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------

-- One test for one class (several per class allowed). Settings may be
-- incomplete while a draft; publishing requires them (tests_validate +
-- tests_published_complete).
create table public.tests (
  id                  uuid                not null default gen_random_uuid(),
  class_id            uuid                not null,
  batch_id            uuid                not null,
  test_type           public.test_type    not null,
  title               text                not null,
  instructions        text                null,
  status              public.test_status  not null default 'draft',
  pass_mark_percent   numeric(5, 2)       null,
  time_limit_minutes  integer             null,
  attempt_limit       integer             not null default 1,
  available_from      timestamptz         null,
  available_until     timestamptz         null,
  created_by          uuid                not null references public.profiles (id) on delete restrict,
  updated_by          uuid                not null references public.profiles (id) on delete restrict,
  created_at          timestamptz         not null default now(),
  updated_at          timestamptz         not null default now(),

  constraint tests_pkey primary key (id),
  -- The test belongs to this class, and the class to this batch.
  constraint tests_class_batch_fk
    foreign key (class_id, batch_id) references public.classes (id, batch_id) on delete restrict,
  constraint tests_id_batch_key unique (id, batch_id),   -- target for 0009 attempts
  constraint tests_title_not_blank      check (length(btrim(title)) > 0),
  constraint tests_title_length         check (char_length(title) <= 200),
  constraint tests_instructions_length  check (instructions is null or char_length(instructions) <= 5000),
  constraint tests_pass_mark_range      check (pass_mark_percent is null or pass_mark_percent between 0 and 100),
  constraint tests_time_limit_range     check (time_limit_minutes is null or time_limit_minutes between 1 and 600),
  constraint tests_attempt_limit_range  check (attempt_limit between 1 and 10),
  constraint tests_window_order         check (available_from is null or available_until is null
                                               or available_until > available_from),
  -- Anything published carries a complete configuration.
  constraint tests_published_complete   check (
    status = 'draft'
    or (available_from is not null and available_until is not null
        and pass_mark_percent is not null and time_limit_minutes is not null)
  )
);

create index tests_class_id_idx on public.tests (class_id);
create index tests_batch_id_idx on public.tests (batch_id);

-- Frozen copy of one bank question inside one test.
create table public.test_questions (
  id                  uuid                  not null default gen_random_uuid(),
  test_id             uuid                  not null,
  position            integer               not null,
  source_question_id  uuid                  not null,
  source_revision     integer               not null,
  question_text       text                  not null,
  question_type       public.question_type  not null,
  marks               numeric(6, 2)         not null,
  explanation         text                  null,
  added_by            uuid                  not null references public.profiles (id) on delete restrict,
  added_at            timestamptz           not null default now(),

  constraint test_questions_pkey primary key (id),
  constraint test_questions_test_fk
    foreign key (test_id) references public.tests (id) on delete cascade,
  -- Lineage to the bank question it was copied from (bank questions
  -- that left draft can't be deleted anyway — 0007 questions_guard).
  constraint test_questions_source_fk
    foreign key (source_question_id) references public.questions (id) on delete restrict,
  constraint test_questions_test_position_key unique (test_id, position),
  constraint test_questions_test_source_key   unique (test_id, source_question_id),
  constraint test_questions_id_test_key       unique (id, test_id),   -- target for 0009 answers
  constraint test_questions_position_range    check (position between 1 and 500),
  constraint test_questions_revision_positive check (source_revision > 0),
  constraint test_questions_text_not_blank    check (length(btrim(question_text)) > 0),
  constraint test_questions_text_length       check (char_length(question_text) <= 5000),
  constraint test_questions_marks_positive    check (marks > 0),
  constraint test_questions_explanation_len   check (explanation is null or char_length(explanation) <= 5000)
);
-- test_id lookups are served by test_questions_test_position_key.
create index test_questions_source_question_id_idx on public.test_questions (source_question_id);

-- Frozen copy of one answer option. is_correct is the answer key.
create table public.test_question_options (
  id                uuid     not null default gen_random_uuid(),
  test_question_id  uuid     not null,
  option_text       text     not null,
  display_order     integer  not null,
  is_correct        boolean  not null,

  constraint test_question_options_pkey primary key (id),
  constraint test_question_options_question_fk
    foreign key (test_question_id) references public.test_questions (id) on delete cascade,
  constraint test_question_options_order_key    unique (test_question_id, display_order),
  constraint test_question_options_id_question_key unique (id, test_question_id),   -- target for 0009 answers
  constraint test_question_options_text_blank   check (length(btrim(option_text)) > 0),
  constraint test_question_options_text_length  check (char_length(option_text) <= 1000),
  constraint test_question_options_order_range  check (display_order between 1 and 10)
);
-- test_question_id lookups are served by test_question_options_order_key.

-- -------------------------------------------------------------------
-- 3. Helpers
--    - fixed empty search_path, fully qualified names
--    - EXECUTE revoked from public/anon, granted to authenticated
-- -------------------------------------------------------------------

-- Caller is the CURRENT trainer of this batch: its assigned trainer
-- while the batch is upcoming or ongoing. Completed/cancelled batches
-- and reassigned trainers are excluded (read-only visibility stays
-- with is_batch_trainer / is_class_trainer).
create function public.is_current_batch_trainer(p_batch_id uuid)
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
         and b.status in ('upcoming', 'ongoing')
    ),
    false
  );
$$;

-- The status a test is in right now. Stored scheduled/active move on
-- with time: active from available_from, closed from available_until.
-- Draft and (manually) closed are returned as stored.
create function public.test_effective_status(
  p_status           public.test_status,
  p_available_from   timestamptz,
  p_available_until  timestamptz
)
returns public.test_status
language sql
stable
set search_path = ''
as $$
  select case
    when p_status in ('draft', 'closed') then p_status
    when p_available_until is not null and now() >= p_available_until then 'closed'::public.test_status
    when p_available_from is not null and now() >= p_available_from then 'active'::public.test_status
    else 'scheduled'::public.test_status
  end;
$$;

revoke all on function public.is_current_batch_trainer(uuid) from public, anon;
revoke all on function public.test_effective_status(public.test_status, timestamptz, timestamptz) from public, anon;
grant execute on function public.is_current_batch_trainer(uuid) to authenticated, service_role;
grant execute on function public.test_effective_status(public.test_status, timestamptz, timestamptz) to authenticated, service_role;

-- -------------------------------------------------------------------
-- 4. Triggers — tests
-- -------------------------------------------------------------------

-- a) Only drafts can be deleted, and only by a signed-in user (every
--    writer). Published tests are closed instead. Caller's rights.
create function public.tests_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Tests can only be deleted by a signed-in user.' using errcode = '42501';
  end if;
  if old.status <> 'draft' then
    raise exception 'Only draft tests can be deleted. Close this test instead.' using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke all on function public.tests_guard() from public, anon, authenticated;

create trigger tests_guard
  before delete on public.tests
  for each row execute function public.tests_guard();

-- b) Stamp who/when; class and batch can't change; an update that
--    changes nothing keeps the old stamp. Caller's rights.
create function public.tests_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.class_id is distinct from old.class_id or new.batch_id is distinct from old.batch_id then
      raise exception 'A test''s class and batch cannot be changed.' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if (new.test_type, new.title, new.instructions, new.status, new.pass_mark_percent,
        new.time_limit_minutes, new.attempt_limit, new.available_from, new.available_until)
       is not distinct from
       (old.test_type, old.title, old.instructions, old.status, old.pass_mark_percent,
        old.time_limit_minutes, old.attempt_limit, old.available_from, old.available_until) then
      -- No real change: keep who/when.
      new.updated_by := old.updated_by;
      new.updated_at := old.updated_at;
      return new;
    end if;
  end if;

  if auth.uid() is null then
    raise exception 'Tests can only be created or changed by a signed-in user.' using errcode = '42501';
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

revoke all on function public.tests_stamp() from public, anon, authenticated;

create trigger tests_stamp
  before insert or update on public.tests
  for each row execute function public.tests_stamp();

-- c) Lifecycle, publish validation and the post-publish lock. Security
--    definer so the class, batch and question lookups are not hidden
--    by the caller's RLS. Fires after tests_stamp (name order).
create function public.tests_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_status  text;
  v_batch_status  public.batch_status;
  v_publishing    boolean;
  v_reopening     boolean;
  v_count         integer;
  v_position      integer;
  v_error         text;
  r               record;
begin
  select c.status into v_class_status from public.classes c where c.id = new.class_id;
  select b.status into v_batch_status from public.batches b where b.id = new.batch_id;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New tests always start as drafts. Publish the test when it is ready.' using errcode = '23514';
    end if;
    if v_class_status = 'cancelled' or v_batch_status = 'cancelled' then
      raise exception 'Tests cannot be created for a cancelled class or batch.' using errcode = '23514';
    end if;
    return new;
  end if;

  -- Published / closed never goes back to draft.
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'A published test cannot be moved back to draft.' using errcode = '23514';
  end if;
  -- A draft is published first; it can't jump straight to closed.
  if old.status = 'draft' and new.status = 'closed' then
    raise exception 'Publish the test before closing it.' using errcode = '23514';
  end if;

  -- After publishing: settings that affect attempts and grading are locked.
  if old.status <> 'draft' then
    if new.test_type is distinct from old.test_type then
      raise exception 'The test type is locked after publishing.' using errcode = '23514';
    end if;
    if new.pass_mark_percent is distinct from old.pass_mark_percent then
      raise exception 'The pass mark is locked after publishing.' using errcode = '23514';
    end if;
    if new.time_limit_minutes is distinct from old.time_limit_minutes then
      raise exception 'The time limit is locked after publishing.' using errcode = '23514';
    end if;
    if new.attempt_limit is distinct from old.attempt_limit then
      raise exception 'The attempt limit is locked after publishing.' using errcode = '23514';
    end if;
    if new.available_from is distinct from old.available_from then
      raise exception 'The opening time is locked after publishing.' using errcode = '23514';
    end if;
    if new.available_until is distinct from old.available_until then
      if new.available_until is null or new.available_until < old.available_until then
        raise exception 'After publishing, the closing time can only be extended.' using errcode = '23514';
      end if;
      -- Extending can revive a test that closed by time, so it gets the
      -- same checks as reopening.
      if v_class_status = 'cancelled' or v_batch_status = 'cancelled' then
        raise exception 'The closing time cannot be extended for a cancelled class or batch.' using errcode = '23514';
      end if;
      if new.available_until <= now() then
        raise exception 'The closing time must be in the future.' using errcode = '23514';
      end if;
    end if;
  end if;

  v_publishing := old.status = 'draft' and new.status in ('scheduled', 'active');
  v_reopening  := old.status = 'closed' and new.status in ('scheduled', 'active');

  if v_publishing or v_reopening then
    if v_class_status = 'cancelled' or v_batch_status = 'cancelled' then
      raise exception 'Tests cannot be published or reopened for a cancelled class or batch.' using errcode = '23514';
    end if;
    if new.available_from is null or new.available_until is null then
      raise exception 'Set when the test opens and closes before publishing.' using errcode = '23514';
    end if;
    if new.available_until <= now() then
      raise exception 'The closing time must be in the future.' using errcode = '23514';
    end if;
  end if;

  if v_publishing then
    if new.pass_mark_percent is null then
      raise exception 'Set a pass mark (0–100%%) before publishing.' using errcode = '23514';
    end if;
    if new.time_limit_minutes is null then
      raise exception 'Set a time limit before publishing.' using errcode = '23514';
    end if;

    select count(*) into v_count from public.test_questions tq where tq.test_id = new.id;
    if v_count = 0 then
      raise exception 'Add at least one question before publishing.' using errcode = '23514';
    end if;

    -- Every frozen question must still match its bank source.
    select tq.position into v_position
      from public.test_questions tq
      left join public.questions q on q.id = tq.source_question_id
     where tq.test_id = new.id
       and (q.id is null or q.status <> 'active' or q.revision <> tq.source_revision)
     order by tq.position
     limit 1;
    if found then
      raise exception 'Question % was changed or archived in the Question Bank after it was added. Remove it and add it again before publishing.', v_position
        using errcode = '23514';
    end if;

    -- Every frozen question must pass the 0007 content rules.
    for r in
      select tq.position, tq.question_type, tq.question_text, tq.marks,
             array_agg(o.option_text order by o.display_order) as texts,
             array_agg(o.is_correct  order by o.display_order) as correct
        from public.test_questions tq
        left join public.test_question_options o on o.test_question_id = tq.id
       where tq.test_id = new.id
       group by tq.id, tq.position, tq.question_type, tq.question_text, tq.marks
       order by tq.position
    loop
      v_error := public.question_content_error(
        r.question_type, r.question_text, r.marks,
        array_remove(r.texts, null), array_remove(r.correct, null));
      if v_error is not null then
        raise exception 'Question %: %', r.position, v_error using errcode = '23514';
      end if;
    end loop;
  end if;

  -- Store where a published/reopened test is right now (see
  -- test_effective_status for reads).
  if new.status in ('scheduled', 'active') then
    new.status := case when now() >= new.available_from
                       then 'active'::public.test_status
                       else 'scheduled'::public.test_status end;
  end if;

  return new;
end;
$$;

revoke all on function public.tests_validate() from public, anon, authenticated;

create trigger tests_validate
  before insert or update on public.tests
  for each row execute function public.tests_validate();

-- -------------------------------------------------------------------
-- 5. Triggers — frozen question set
--    Frozen rows are never edited; they are only added or removed
--    while their test is a draft, and only by a signed-in user (the
--    add/remove functions). Caller's rights.
-- -------------------------------------------------------------------
create function public.test_questions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_test_id  uuid;
  v_status   public.test_status;
begin
  if auth.uid() is null then
    raise exception 'Test questions can only be changed by a signed-in user.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Frozen test questions cannot be edited. Remove the question and add it again while the test is a draft.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    v_test_id := old.test_id;
  else
    v_test_id := new.test_id;
    -- Who/when is always the signed-in caller, whatever was sent.
    new.added_by := auth.uid();
    new.added_at := now();
  end if;

  select t.status into v_status from public.tests t where t.id = v_test_id;
  -- Not found: the test itself is being deleted (drafts only — tests_guard).
  if found and v_status <> 'draft' then
    raise exception 'The question set is locked after the test is published.' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.test_questions_guard() from public, anon, authenticated;

create trigger test_questions_guard
  before insert or update or delete on public.test_questions
  for each row execute function public.test_questions_guard();

create function public.test_question_options_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_question_id  uuid;
  v_status       public.test_status;
begin
  if auth.uid() is null then
    raise exception 'Test questions can only be changed by a signed-in user.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Frozen test question options cannot be edited.' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    v_question_id := old.test_question_id;
  else
    v_question_id := new.test_question_id;
  end if;

  select t.status into v_status
    from public.test_questions tq
    join public.tests t on t.id = tq.test_id
   where tq.id = v_question_id;
  -- Not found: the frozen question (or its draft test) is being deleted.
  if found and v_status <> 'draft' then
    raise exception 'The question set is locked after the test is published.' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.test_question_options_guard() from public, anon, authenticated;

create trigger test_question_options_guard
  before insert or update or delete on public.test_question_options
  for each row execute function public.test_question_options_guard();

-- -------------------------------------------------------------------
-- 6. Question-set functions (the only way to write frozen rows)
--    - security definer, fixed empty search_path, fully qualified names
--    - identity always from auth.uid(); content always copied from the
--      bank server-side, never taken from the caller
--    - EXECUTE revoked from public/anon, granted to authenticated
-- -------------------------------------------------------------------

-- Copy active bank questions (of the class's course) into a draft
-- test, appended in the given order. Returns how many were added.
create function public.add_test_questions(p_test_id uuid, p_question_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid          uuid := auth.uid();
  v_role         text := public.current_app_role();
  v_status       public.test_status;
  v_batch_id     uuid;
  v_course_id    uuid;
  v_position     integer;
  v_added        integer := 0;
  v_question_id  uuid;
  v_new_id       uuid;
  q              record;
begin
  if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to manage tests.' using errcode = '42501';
  end if;

  select t.status, t.batch_id, c.course_id
    into v_status, v_batch_id, v_course_id
    from public.tests t
    join public.classes c on c.id = t.class_id
   where t.id = p_test_id
     for update of t;
  if not found
     or not (public.is_super_admin() or public.is_current_batch_trainer(v_batch_id)) then
    raise exception 'Test not found, or you don''t have permission to change it.' using errcode = '42501';
  end if;
  if v_status <> 'draft' then
    raise exception 'The question set is locked after the test is published.' using errcode = '23514';
  end if;
  if p_question_ids is null or cardinality(p_question_ids) = 0 then
    raise exception 'Choose at least one question to add.' using errcode = '22023';
  end if;
  if cardinality(p_question_ids) > 100 then
    raise exception 'Add at most 100 questions at a time.' using errcode = '22023';
  end if;

  select coalesce(max(tq.position), 0) into v_position
    from public.test_questions tq
   where tq.test_id = p_test_id;

  -- Distinct ids, first occurrence order.
  for v_question_id in
    select u.id
      from unnest(p_question_ids) with ordinality as u(id, ord)
     where u.id is not null
     group by u.id
     order by min(u.ord)
  loop
    select qq.id, qq.course_id, qq.status, qq.revision, qq.question_text,
           qq.question_type, qq.marks, qq.explanation
      into q
      from public.questions qq
     where qq.id = v_question_id
       for share;
    if not found then
      raise exception 'Question not found.' using errcode = '23503';
    end if;
    if not (public.is_super_admin() or public.is_course_trainer(q.course_id)) then
      raise exception 'You can only add questions from courses you currently teach.' using errcode = '42501';
    end if;
    if q.course_id <> v_course_id then
      raise exception 'Only questions from this class''s course can be added.' using errcode = '23514';
    end if;
    if q.status <> 'active' then
      raise exception 'Only active questions can be added to a test.' using errcode = '23514';
    end if;
    if exists (
      select 1 from public.test_questions tq
       where tq.test_id = p_test_id and tq.source_question_id = q.id
    ) then
      raise exception 'That question is already in this test.' using errcode = '23514';
    end if;

    v_position := v_position + 1;
    insert into public.test_questions
      (test_id, position, source_question_id, source_revision, question_text,
       question_type, marks, explanation, added_by, added_at)
    values
      (p_test_id, v_position, q.id, q.revision, q.question_text,
       q.question_type, q.marks, q.explanation, v_uid, now())
    returning id into v_new_id;

    insert into public.test_question_options (test_question_id, option_text, display_order, is_correct)
    select v_new_id, o.option_text, o.display_order, o.is_correct
      from public.question_options o
     where o.question_id = q.id;

    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;

-- Remove one frozen question (and its options) from a draft test.
create function public.remove_test_question(p_test_question_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    public.test_status;
  v_batch_id  uuid;
begin
  if auth.uid() is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to manage tests.' using errcode = '42501';
  end if;

  select t.status, t.batch_id
    into v_status, v_batch_id
    from public.test_questions tq
    join public.tests t on t.id = tq.test_id
   where tq.id = p_test_question_id
     for update of t;
  if not found
     or not (public.is_super_admin() or public.is_current_batch_trainer(v_batch_id)) then
    raise exception 'Test question not found, or you don''t have permission to change it.' using errcode = '42501';
  end if;
  if v_status <> 'draft' then
    raise exception 'The question set is locked after the test is published.' using errcode = '23514';
  end if;

  delete from public.test_questions tq where tq.id = p_test_question_id;
end;
$$;

revoke all on function public.add_test_questions(uuid, uuid[])  from public, anon;
revoke all on function public.remove_test_question(uuid)        from public, anon;
grant execute on function public.add_test_questions(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.remove_test_question(uuid)       to authenticated, service_role;

-- -------------------------------------------------------------------
-- 7. Privileges + Row Level Security
--    Anonymous: nothing. Students: no policy on any 0008 table.
--    tests: authenticated table privileges, every row filtered by RLS.
--    Frozen tables: SELECT only (writes via section 6 functions).
-- -------------------------------------------------------------------
alter table public.tests                 enable row level security;
alter table public.test_questions        enable row level security;
alter table public.test_question_options enable row level security;

revoke all on table public.tests, public.test_questions, public.test_question_options from anon, authenticated;
grant select, insert, update, delete on table public.tests to authenticated;
grant select on table public.test_questions, public.test_question_options to authenticated;
grant all on table public.tests, public.test_questions, public.test_question_options to service_role;

-- tests ---------------------------------------------------------------

-- Super admin: full management (triggers still enforce the lifecycle).
create policy tests_admin_all
  on public.tests for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Trainer read: the batch's assigned trainer, plus a previous trainer
-- of the class (test definitions only — no frozen questions).
create policy tests_trainer_select
  on public.tests for select to authenticated
  using (public.is_batch_trainer(batch_id) or public.is_class_trainer(class_id));

-- Trainer write: only batches they CURRENTLY run (upcoming/ongoing).
create policy tests_trainer_insert
  on public.tests for insert to authenticated
  with check (public.current_app_role() = 'trainer' and public.is_current_batch_trainer(batch_id));

create policy tests_trainer_update
  on public.tests for update to authenticated
  using      (public.current_app_role() = 'trainer' and public.is_current_batch_trainer(batch_id))
  with check (public.current_app_role() = 'trainer' and public.is_current_batch_trainer(batch_id));

create policy tests_trainer_delete_draft
  on public.tests for delete to authenticated
  using (public.current_app_role() = 'trainer' and public.is_current_batch_trainer(batch_id) and status = 'draft');

-- test_questions / test_question_options -------------------------------

-- Read (including the answer key): super admin, or the batch's
-- assigned trainer. Never students; not previous class trainers.
create policy test_questions_staff_select
  on public.test_questions for select to authenticated
  using (
    exists (
      select 1
        from public.tests t
       where t.id = test_questions.test_id
         and (public.is_super_admin() or public.is_batch_trainer(t.batch_id))
    )
  );

create policy test_question_options_staff_select
  on public.test_question_options for select to authenticated
  using (
    exists (
      select 1
        from public.test_questions tq
        join public.tests t on t.id = tq.test_id
       where tq.id = test_question_options.test_question_id
         and (public.is_super_admin() or public.is_batch_trainer(t.batch_id))
    )
  );

commit;
