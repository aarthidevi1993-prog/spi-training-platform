-- ===================================================================
-- 0009 — SECURE STUDENT TEST ENGINE (attempts, answers, grading)
--
-- Server-side attempts for published class tests (0008): the database
-- creates attempts, stores a per-attempt random question AND option
-- order, keeps the server-authoritative deadline, saves answers,
-- grades them (all-or-nothing), and records an append-only security
-- event log. Results/review are released only once the test is
-- effectively closed.
--
--   test_attempts (id)                                        PK
--     (test_id, batch_id)       → tests (id, batch_id)            [0008 key]
--     (batch_id, student_id)    → batch_students (batch_id, student_id)
--     student_id                → students (id)
--     unique (id, test_id), unique (test_id, student_id, attempt_number)
--     partial unique (test_id, student_id) WHERE status = 'in_progress'
--   test_attempt_questions (attempt_id, test_question_id)     PK
--     (attempt_id, test_id)     → test_attempts (id, test_id)
--     (test_question_id, test_id) → test_questions (id, test_id)  [0008 key]
--   test_attempt_answers (attempt_id, test_question_id)       PK
--     → test_attempt_questions (attempt_id, test_question_id)
--   test_attempt_answer_options (attempt_id, test_question_id, option_id) PK
--     → test_attempt_answers (attempt_id, test_question_id)
--     (option_id, test_question_id) → test_question_options (id, test_question_id) [0008 key]
--   test_security_events (id)                                 PK (append-only)
--   test_best_results                                         VIEW (security_invoker)
--
-- ACCESS: students have NO table policy on any 0009 table. Every
-- student operation goes through the security definer functions below,
-- which prove ownership from auth.uid() and never return the answer
-- key (is_correct) or explanations before results are released.
-- Staff read-only RLS: super admin (all) and the CURRENT trainer of an
-- upcoming/ongoing batch (is_current_batch_trainer). Anonymous: none.
-- Nobody gets INSERT/UPDATE/DELETE privileges; all writes are done by
-- the functions, and guard triggers refuse any write without a
-- signed-in user, any change to a finalized attempt or its answers,
-- and any update/delete of security events.
--
-- TIME: the database clock is authoritative. deadline_at = started_at
-- + tests.time_limit_minutes (set by the database). Effective deadline
-- = least(deadline_at, tests.available_until), plus a 5-second network
-- grace for saves and submits. Extending available_until never changes
-- deadline_at and never revives a finalized attempt.
--
-- BLOCKED OPERATIONS (deadline, closed test, cancelled class/batch,
-- withdrawn/not-enrolled student, invalid ownership, finalized attempt,
-- attempt limit) RETURN a status instead of raising, so their security
-- event and any finalization are committed. Only genuine
-- programming/permission errors raise.
--
-- Finalization when a test is closed, a class/batch is cancelled or a
-- student is withdrawn is applied lazily here (on the next student or
-- staff access); 0010 will add triggers on those existing tables. 0009
-- does NOT modify tests, classes, batches, batch_students, questions,
-- question_options or any existing object.
--
-- Runs as ONE transaction (BEGIN/COMMIT below) — paste into the SQL
-- Editor as-is. Depends on 0001–0008. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless 0001–0008 are in place
--    and 0009 has not been applied.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.tests') is null
     or to_regclass('public.test_questions') is null
     or to_regclass('public.test_question_options') is null
     or to_regclass('public.batch_students') is null
     or to_regclass('public.students') is null
     or to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_current_batch_trainer(uuid)') is null
     or to_regprocedure('public.test_effective_status(public.test_status, timestamptz, timestamptz)') is null then
    raise exception 'Preflight failed: 0002/0003/0008 objects are missing.';
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.tests'::regclass and conname = 'tests_id_batch_key')
     or not exists (select 1 from pg_constraint where conrelid = 'public.test_questions'::regclass and conname = 'test_questions_id_test_key')
     or not exists (select 1 from pg_constraint where conrelid = 'public.test_question_options'::regclass and conname = 'test_question_options_id_question_key')
     or not exists (select 1 from pg_constraint where conrelid = 'public.batch_students'::regclass and conname = 'batch_students_pkey') then
    raise exception 'Preflight failed: 0003/0008 composite keys are missing.';
  end if;

  if to_regclass('public.test_attempts') is not null
     or to_regclass('public.test_security_events') is not null
     or to_regtype('public.test_attempt_status') is not null
     or to_regprocedure('public.start_test_attempt(uuid)') is not null then
    raise exception 'Preflight failed: 0009 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.test_attempt_status as enum ('in_progress', 'submitted', 'finalized');

create type public.test_attempt_finalize_reason as enum (
  'student_submit',     -- the student submitted within the effective deadline + grace
  'deadline',           -- effective deadline (+ grace) passed
  'test_closed',        -- the test was closed by staff
  'class_cancelled',
  'batch_cancelled',
  'withdrawn',          -- enrolment became 'withdrawn'
  'enrollment_ended'    -- enrolment is no longer 'enrolled' (e.g. 'completed')
);

create type public.test_security_event_type as enum (
  'attempt_started',
  'repeated_start',
  'blocked_start',
  'answer_saved',
  'blocked_answer_save',
  'submit',
  'auto_submit',
  'blocked_submission',
  'deadline_reached',
  'test_closed_finalization',
  'cancellation_finalization',
  'withdrawal_finalization',
  'invalid_attempt_access',
  'suspicious_repeated_access'
);

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------

-- One attempt by one student at one test. Result columns are filled
-- (once) by finalize_test_attempt; a finalized attempt never changes.
create table public.test_attempts (
  id               uuid                                 not null default gen_random_uuid(),
  test_id          uuid                                 not null,
  batch_id         uuid                                 not null,
  student_id       uuid                                 not null,
  attempt_number   integer                              not null,
  status           public.test_attempt_status           not null default 'in_progress',
  started_at       timestamptz                          not null default now(),
  deadline_at      timestamptz                          not null,
  question_count   integer                              not null default 0,
  max_score        numeric(9, 2)                        not null default 0,
  finalized_at     timestamptz                          null,
  finalize_reason  public.test_attempt_finalize_reason  null,
  score            numeric(9, 2)                        null,
  percentage       numeric(5, 2)                        null,
  passed           boolean                              null,
  graded_at        timestamptz                          null,

  constraint test_attempts_pkey primary key (id),
  -- The attempt belongs to this test's batch …
  constraint test_attempts_test_batch_fk
    foreign key (test_id, batch_id) references public.tests (id, batch_id) on delete restrict,
  -- … and the student is (or was) enrolled in that batch.
  constraint test_attempts_enrolment_fk
    foreign key (batch_id, student_id) references public.batch_students (batch_id, student_id) on delete restrict,
  constraint test_attempts_student_fk
    foreign key (student_id) references public.students (id) on delete restrict,
  constraint test_attempts_id_test_key          unique (id, test_id),   -- target for attempt questions
  constraint test_attempts_number_key           unique (test_id, student_id, attempt_number),
  constraint test_attempts_number_range         check (attempt_number between 1 and 10),
  constraint test_attempts_deadline_after_start check (deadline_at > started_at),
  constraint test_attempts_question_count_ok    check (question_count >= 0),
  constraint test_attempts_max_score_ok         check (max_score >= 0),
  constraint test_attempts_score_range          check (score is null or (score >= 0 and score <= max_score)),
  constraint test_attempts_percentage_range     check (percentage is null or percentage between 0 and 100),
  -- In progress <=> no result yet; finished <=> complete result, and
  -- 'submitted' exactly when the student submitted.
  constraint test_attempts_state_consistent check (
    (status = 'in_progress'
       and finalized_at is null and finalize_reason is null and score is null
       and percentage is null and passed is null and graded_at is null)
    or
    (status <> 'in_progress'
       and finalized_at is not null and finalize_reason is not null and score is not null
       and percentage is not null and passed is not null and graded_at is not null
       and ((status = 'submitted') = (finalize_reason = 'student_submit')))
  )
);

-- One active attempt per student per test.
create unique index test_attempts_one_active_idx
  on public.test_attempts (test_id, student_id) where status = 'in_progress';
create index test_attempts_batch_id_idx      on public.test_attempts (batch_id);
create index test_attempts_student_id_idx    on public.test_attempts (student_id);
create index test_attempts_test_status_idx   on public.test_attempts (test_id, status);
-- (test_id, student_id, …) lookups are served by test_attempts_number_key.

-- The questions issued to an attempt, in the attempt's random order,
-- with the attempt's random option order. Written once at start.
create table public.test_attempt_questions (
  attempt_id        uuid     not null,
  test_id           uuid     not null,
  test_question_id  uuid     not null,
  position          integer  not null,
  option_order      uuid[]   not null,

  constraint test_attempt_questions_pkey primary key (attempt_id, test_question_id),
  constraint test_attempt_questions_attempt_fk
    foreign key (attempt_id, test_id) references public.test_attempts (id, test_id) on delete restrict,
  -- Only questions from this test's frozen set.
  constraint test_attempt_questions_question_fk
    foreign key (test_question_id, test_id) references public.test_questions (id, test_id) on delete restrict,
  constraint test_attempt_questions_position_key unique (attempt_id, position),
  constraint test_attempt_questions_position_ok  check (position between 1 and 500),
  constraint test_attempt_questions_options_ok   check (cardinality(option_order) between 2 and 10)
);
create index test_attempt_questions_question_idx on public.test_attempt_questions (test_question_id);

-- One saved answer per issued question (graded fields filled at
-- finalization; unanswered questions get a row then, graded incorrect).
create table public.test_attempt_answers (
  attempt_id        uuid           not null,
  test_question_id  uuid           not null,
  client_seq        bigint         not null default 0,   -- ordering only, never trusted for security
  save_count        integer        not null default 0,
  saved_at          timestamptz    null,
  is_correct        boolean        null,
  marks_awarded     numeric(6, 2)  null,

  constraint test_attempt_answers_pkey primary key (attempt_id, test_question_id),
  -- Only questions issued to this attempt can be answered.
  constraint test_attempt_answers_question_fk
    foreign key (attempt_id, test_question_id)
    references public.test_attempt_questions (attempt_id, test_question_id) on delete restrict,
  constraint test_attempt_answers_seq_ok     check (client_seq >= 0),
  constraint test_attempt_answers_count_ok   check (save_count >= 0),
  constraint test_attempt_answers_marks_ok   check (marks_awarded is null or marks_awarded >= 0),
  constraint test_attempt_answers_graded_ok  check ((is_correct is null) = (marks_awarded is null))
);

-- The options selected for a saved answer (none = unanswered/cleared).
create table public.test_attempt_answer_options (
  attempt_id        uuid  not null,
  test_question_id  uuid  not null,
  option_id         uuid  not null,

  constraint test_attempt_answer_options_pkey primary key (attempt_id, test_question_id, option_id),
  constraint test_attempt_answer_options_answer_fk
    foreign key (attempt_id, test_question_id)
    references public.test_attempt_answers (attempt_id, test_question_id) on delete restrict,
  -- A selected option must belong to that frozen question.
  constraint test_attempt_answer_options_option_fk
    foreign key (option_id, test_question_id)
    references public.test_question_options (id, test_question_id) on delete restrict
);
create index test_attempt_answer_options_option_idx on public.test_attempt_answer_options (option_id, test_question_id);

-- Append-only audit of security-relevant attempt events (server-side only).
create table public.test_security_events (
  id           bigint                           generated always as identity,
  occurred_at  timestamptz                      not null default now(),
  event_type   public.test_security_event_type  not null,
  actor_id     uuid                             not null references public.profiles (id) on delete restrict,
  attempt_id   uuid                             null references public.test_attempts (id) on delete restrict,
  test_id      uuid                             null references public.tests (id) on delete restrict,
  batch_id     uuid                             null references public.batches (id) on delete restrict,
  student_id   uuid                             null references public.students (id) on delete restrict,
  detail       jsonb                            not null default '{}'::jsonb,

  constraint test_security_events_pkey primary key (id),
  constraint test_security_events_detail_size check (pg_column_size(detail) <= 4096)
);
create index test_security_events_attempt_idx  on public.test_security_events (attempt_id, occurred_at);
create index test_security_events_test_idx     on public.test_security_events (test_id, occurred_at);
create index test_security_events_student_idx  on public.test_security_events (student_id, occurred_at);
create index test_security_events_batch_idx    on public.test_security_events (batch_id);

-- -------------------------------------------------------------------
-- 3. Guard triggers — every writer (functions, service role, SQL Editor)
-- -------------------------------------------------------------------

-- a) Attempts: server-derived start/deadline; business rules on
--    insert; finalized attempts are immutable; never deleted.
--    Caller's rights.
create function public.test_attempts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status       public.test_status;
  v_from         timestamptz;
  v_until        timestamptz;
  v_limit        integer;
  v_attempts     integer;
  v_time_limit   integer;
  v_class_status text;
  v_batch_status public.batch_status;
  v_enrollment   public.enrollment_status;
begin
  if auth.uid() is null then
    raise exception 'Test attempts can only be changed by a signed-in user.' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Test attempts cannot be deleted.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if old.status <> 'in_progress' then
      raise exception 'A finished test attempt cannot be changed.' using errcode = '42501';
    end if;
    if (new.id, new.test_id, new.batch_id, new.student_id, new.attempt_number, new.started_at,
        new.deadline_at, new.question_count)
       is distinct from
       (old.id, old.test_id, old.batch_id, old.student_id, old.attempt_number, old.started_at,
        old.deadline_at, old.question_count) then
      raise exception 'An attempt''s identity, start time and deadline cannot be changed.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- INSERT: only the student themselves, only while eligible.
  if new.student_id is distinct from auth.uid() then
    raise exception 'Attempts can only be started by the student themselves.' using errcode = '42501';
  end if;

  select t.status, t.available_from, t.available_until, t.attempt_limit, t.time_limit_minutes, c.status, b.status
    into v_status, v_from, v_until, v_limit, v_time_limit, v_class_status, v_batch_status
    from public.tests t
    join public.classes c on c.id = t.class_id
    join public.batches b on b.id = t.batch_id
   where t.id = new.test_id;
  if not found or public.test_effective_status(v_status, v_from, v_until) <> 'active' then
    raise exception 'This test is not open.' using errcode = '23514';
  end if;
  if v_class_status = 'cancelled' or v_batch_status = 'cancelled' then
    raise exception 'This test''s class or batch was cancelled.' using errcode = '23514';
  end if;

  select bs.enrollment_status into v_enrollment
    from public.batch_students bs
   where bs.batch_id = new.batch_id and bs.student_id = new.student_id;
  if v_enrollment is distinct from 'enrolled'::public.enrollment_status then
    raise exception 'Only enrolled students can start a test.' using errcode = '23514';
  end if;

  select count(*) into v_attempts
    from public.test_attempts a
   where a.test_id = new.test_id and a.student_id = new.student_id;
  if v_attempts >= v_limit then
    raise exception 'The attempt limit for this test has been reached.' using errcode = '23514';
  end if;

  -- Server-derived timing and a clean in-progress state, whatever was sent.
  new.status          := 'in_progress';
  new.started_at      := now();
  new.deadline_at     := now() + make_interval(mins => v_time_limit);
  new.finalized_at    := null;
  new.finalize_reason := null;
  new.score           := null;
  new.percentage      := null;
  new.passed          := null;
  new.graded_at       := null;
  return new;
end;
$$;

revoke all on function public.test_attempts_guard() from public, anon, authenticated;

create trigger test_attempts_guard
  before insert or update or delete on public.test_attempts
  for each row execute function public.test_attempts_guard();

-- b) Issued questions: written once while the attempt is in progress;
--    never updated or deleted. Caller's rights.
create function public.test_attempt_questions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Test attempts can only be changed by a signed-in user.' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'An attempt''s question order cannot be changed.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.test_attempts a where a.id = new.attempt_id and a.status = 'in_progress'
  ) then
    raise exception 'A finished test attempt cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.test_attempt_questions_guard() from public, anon, authenticated;

create trigger test_attempt_questions_guard
  before insert or update or delete on public.test_attempt_questions
  for each row execute function public.test_attempt_questions_guard();

-- c) Answers and selected options: only while the attempt is in
--    progress; answers are never deleted and never change identity;
--    selected options are replaced (delete + insert), never updated.
--    Caller's rights.
create function public.test_attempt_answers_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_attempt_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Test answers can only be changed by a signed-in user.' using errcode = '42501';
  end if;

  if tg_table_name = 'test_attempt_answers' then
    if tg_op = 'DELETE' then
      raise exception 'Saved answers cannot be deleted.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE'
       and (new.attempt_id, new.test_question_id) is distinct from (old.attempt_id, old.test_question_id) then
      raise exception 'A saved answer cannot be moved to another question.' using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' then
    raise exception 'Selected options are replaced, never edited.' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    v_attempt_id := old.attempt_id;
  else
    v_attempt_id := new.attempt_id;
  end if;

  if not exists (
    select 1 from public.test_attempts a where a.id = v_attempt_id and a.status = 'in_progress'
  ) then
    raise exception 'A finished test attempt cannot be changed.' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.test_attempt_answers_guard() from public, anon, authenticated;

create trigger test_attempt_answers_guard
  before insert or update or delete on public.test_attempt_answers
  for each row execute function public.test_attempt_answers_guard();

create trigger test_attempt_answer_options_guard
  before insert or update or delete on public.test_attempt_answer_options
  for each row execute function public.test_attempt_answers_guard();

-- d) Security events: append-only; who/when always from the database.
--    Caller's rights.
create function public.test_security_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Security events are append-only.' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'Security events can only be recorded for a signed-in user.' using errcode = '42501';
  end if;
  new.actor_id    := auth.uid();
  new.occurred_at := now();
  return new;
end;
$$;

revoke all on function public.test_security_events_guard() from public, anon, authenticated;

create trigger test_security_events_guard
  before insert or update or delete on public.test_security_events
  for each row execute function public.test_security_events_guard();

-- e) No TRUNCATE of attempt data or the audit log (row triggers don't fire on it).
create function public.test_attempt_data_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Test attempt data and security events cannot be truncated.' using errcode = '42501';
end;
$$;

revoke all on function public.test_attempt_data_no_truncate() from public, anon, authenticated;

create trigger test_attempts_no_truncate               before truncate on public.test_attempts               for each statement execute function public.test_attempt_data_no_truncate();
create trigger test_attempt_questions_no_truncate      before truncate on public.test_attempt_questions      for each statement execute function public.test_attempt_data_no_truncate();
create trigger test_attempt_answers_no_truncate        before truncate on public.test_attempt_answers        for each statement execute function public.test_attempt_data_no_truncate();
create trigger test_attempt_answer_options_no_truncate before truncate on public.test_attempt_answer_options for each statement execute function public.test_attempt_data_no_truncate();
create trigger test_security_events_no_truncate        before truncate on public.test_security_events        for each statement execute function public.test_attempt_data_no_truncate();

-- -------------------------------------------------------------------
-- 4. Internal functions (not callable by any client role)
--    security definer, fixed empty search_path, fully qualified names
-- -------------------------------------------------------------------

-- Record a security event (actor/time are stamped by the guard).
create function public.log_test_security_event(
  p_type        public.test_security_event_type,
  p_attempt_id  uuid,
  p_test_id     uuid,
  p_batch_id    uuid,
  p_student_id  uuid,
  p_detail      jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)
  values (p_type, auth.uid(), p_attempt_id, p_test_id, p_batch_id, p_student_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- Why an in-progress attempt must stop now (NULL = it may continue).
create function public.test_attempt_stop_reason(p_attempt_id uuid)
returns public.test_attempt_finalize_reason
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select a.deadline_at, t.status as test_status, t.available_until,
         c.status as class_status, b.status as batch_status, bs.enrollment_status
    into r
    from public.test_attempts a
    join public.tests t on t.id = a.test_id
    join public.classes c on c.id = t.class_id
    join public.batches b on b.id = a.batch_id
    join public.batch_students bs on bs.batch_id = a.batch_id and bs.student_id = a.student_id
   where a.id = p_attempt_id;
  if not found then
    return null;
  end if;

  if r.enrollment_status = 'withdrawn' then
    return 'withdrawn';
  end if;
  if r.enrollment_status <> 'enrolled' then
    return 'enrollment_ended';
  end if;
  if r.batch_status = 'cancelled' then
    return 'batch_cancelled';
  end if;
  if r.class_status = 'cancelled' then
    return 'class_cancelled';
  end if;
  if r.test_status = 'closed' then
    return 'test_closed';
  end if;
  -- Effective deadline (+ 5-second network grace).
  if now() > least(r.deadline_at, coalesce(r.available_until, r.deadline_at)) + interval '5 seconds' then
    return 'deadline';
  end if;
  return null;
end;
$$;

-- Grade and finalize an in-progress attempt (all-or-nothing per
-- question; unanswered = incorrect). Returns true when this call
-- finalized it, false when it was already finished or doesn't exist.
create function public.finalize_test_attempt(
  p_attempt_id  uuid,
  p_reason      public.test_attempt_finalize_reason
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  a        public.test_attempts%rowtype;
  v_pass   numeric;
  v_score  numeric;
  v_max    numeric;
  v_pct    numeric;
  v_event  public.test_security_event_type;
begin
  if p_reason is null then
    raise exception 'A finalize reason is required.' using errcode = '22023';
  end if;

  select * into a from public.test_attempts where id = p_attempt_id for update;
  if not found or a.status <> 'in_progress' then
    return false;
  end if;

  -- Every issued question gets an answer row (unanswered => graded incorrect).
  insert into public.test_attempt_answers (attempt_id, test_question_id)
  select aq.attempt_id, aq.test_question_id
    from public.test_attempt_questions aq
   where aq.attempt_id = p_attempt_id
  on conflict (attempt_id, test_question_id) do nothing;

  -- All-or-nothing: correct only when the selected set equals the frozen correct set.
  update public.test_attempt_answers ans
     set is_correct    = g.correct,
         marks_awarded = case when g.correct then g.marks else 0 end
    from (
      select aq.test_question_id,
             tq.marks,
             coalesce((select array_agg(ao.option_id order by ao.option_id)
                         from public.test_attempt_answer_options ao
                        where ao.attempt_id = aq.attempt_id
                          and ao.test_question_id = aq.test_question_id), '{}'::uuid[])
             =
             coalesce((select array_agg(o.id order by o.id)
                         from public.test_question_options o
                        where o.test_question_id = aq.test_question_id
                          and o.is_correct), '{}'::uuid[]) as correct
        from public.test_attempt_questions aq
        join public.test_questions tq on tq.id = aq.test_question_id
       where aq.attempt_id = p_attempt_id
    ) g
   where ans.attempt_id = p_attempt_id
     and ans.test_question_id = g.test_question_id;

  select coalesce(sum(ans.marks_awarded), 0) into v_score
    from public.test_attempt_answers ans
   where ans.attempt_id = p_attempt_id;

  select coalesce(sum(tq.marks), 0) into v_max
    from public.test_attempt_questions aq
    join public.test_questions tq on tq.id = aq.test_question_id
   where aq.attempt_id = p_attempt_id;

  select t.pass_mark_percent into v_pass from public.tests t where t.id = a.test_id;
  v_pct := case when v_max > 0 then round(v_score / v_max * 100, 2) else 0 end;

  update public.test_attempts
     set status          = case when p_reason = 'student_submit'
                                then 'submitted'::public.test_attempt_status
                                else 'finalized'::public.test_attempt_status end,
         finalized_at    = now(),
         finalize_reason = p_reason,
         max_score       = v_max,
         score           = v_score,
         percentage      = v_pct,
         passed          = v_pct >= coalesce(v_pass, 100),
         graded_at       = now()
   where id = p_attempt_id;

  v_event := case p_reason
    when 'student_submit'  then 'submit'
    when 'deadline'        then 'auto_submit'
    when 'test_closed'     then 'test_closed_finalization'
    when 'class_cancelled' then 'cancellation_finalization'
    when 'batch_cancelled' then 'cancellation_finalization'
    else 'withdrawal_finalization'
  end;
  perform public.log_test_security_event(
    v_event, a.id, a.test_id, a.batch_id, a.student_id,
    jsonb_build_object('reason', p_reason, 'score', v_score, 'max_score', v_max));

  return true;
end;
$$;

revoke all on function public.log_test_security_event(public.test_security_event_type, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.test_attempt_stop_reason(uuid) from public, anon, authenticated;
revoke all on function public.finalize_test_attempt(uuid, public.test_attempt_finalize_reason) from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 5. Student functions (the only student path to 0009/0008 data)
--    - identity from auth.uid(); role must be 'student'
--    - blocked cases RETURN {ok:false, reason} (events persist)
--    - never return is_correct/explanations before results release
-- -------------------------------------------------------------------

-- Caller must be a signed-in student (genuine permission error otherwise).
create function public.require_test_student()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce(public.current_app_role(), '') <> 'student' then
    raise exception 'Only students can take tests.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

revoke all on function public.require_test_student() from public, anon, authenticated;

-- Tests available to the student's batches, with attempt usage and
-- (only once a test is effectively closed) their best result.
create function public.student_available_tests()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_test_student();
  v_reason  public.test_attempt_finalize_reason;
  r         record;
  v_result  jsonb;
begin
  -- Finish any of this student's attempts that must stop (lazy finalization).
  for r in
    select a.id from public.test_attempts a
     where a.student_id = v_uid and a.status = 'in_progress'
     for update
  loop
    v_reason := public.test_attempt_stop_reason(r.id);
    if v_reason is not null then
      perform public.finalize_test_attempt(r.id, v_reason);
    end if;
  end loop;

  select coalesce(jsonb_agg(x.item order by x.sort_key desc nulls last), '[]'::jsonb)
    into v_result
    from (
      select t.available_from as sort_key,
             jsonb_build_object(
               'test_id',            t.id,
               'title',              t.title,
               'test_type',          t.test_type,
               'instructions',       t.instructions,
               'class_title',        c.title,
               'class_date',         c.class_date,
               'course_code',        co.course_code,
               'course_title',       co.title,
               'batch_code',         b.batch_code,
               'batch_name',         b.name,
               'effective_status',   eff.status,
               'class_cancelled',    c.status = 'cancelled',
               'batch_cancelled',    b.status = 'cancelled',
               'available_from',     t.available_from,
               'available_until',    t.available_until,
               'time_limit_minutes', t.time_limit_minutes,
               'attempt_limit',      t.attempt_limit,
               'question_count',     (select count(*) from public.test_questions tq where tq.test_id = t.id),
               'attempts_used',      stats.used,
               'active_attempt_id',  stats.active_id,
               'can_start',          (bs.enrollment_status = 'enrolled' and eff.status = 'active'
                                      and c.status <> 'cancelled' and b.status <> 'cancelled'
                                      and stats.active_id is null and stats.used < t.attempt_limit),
               'results_available',  eff.status = 'closed',
               'best_result',        case when eff.status = 'closed' then (
                                        select jsonb_build_object(
                                                 'attempt_id', ba.id,
                                                 'score', ba.score,
                                                 'max_score', ba.max_score,
                                                 'percentage', ba.percentage,
                                                 'passed', ba.passed)
                                          from public.test_attempts ba
                                         where ba.test_id = t.id and ba.student_id = v_uid and ba.status <> 'in_progress'
                                         order by ba.percentage desc, ba.score desc, ba.finalized_at asc
                                         limit 1)
                                      else null end
             ) as item
        from public.batch_students bs
        join public.tests t on t.batch_id = bs.batch_id
        join public.classes c on c.id = t.class_id
        join public.batches b on b.id = t.batch_id
        join public.courses co on co.id = c.course_id
        cross join lateral (
          select public.test_effective_status(t.status, t.available_from, t.available_until) as status
        ) eff
        cross join lateral (
          select count(*)::integer as used,
                 (select a2.id from public.test_attempts a2
                   where a2.test_id = t.id and a2.student_id = v_uid and a2.status = 'in_progress') as active_id
            from public.test_attempts a
           where a.test_id = t.id and a.student_id = v_uid
        ) stats
       where bs.student_id = v_uid
         and bs.enrollment_status in ('enrolled', 'completed')
         and t.status <> 'draft'
    ) x;

  return v_result;
end;
$$;

-- Start (or resume) an attempt. Returns {ok, attempt_id, resumed} or
-- {ok:false, reason}. Starts are serialised per student+batch by
-- locking the student's enrolment row; the partial unique index is the
-- final backstop for "one active attempt".
create function public.start_test_attempt(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.require_test_student();
  t             record;
  v_enrollment  public.enrollment_status;
  v_reason      public.test_attempt_finalize_reason;
  v_effective   public.test_status;
  v_active      uuid;
  v_used        integer;
  v_qcount      integer;
  v_max         numeric;
  v_attempt_id  uuid;
  v_repeats     integer;
  r             record;
begin
  select tt.id, tt.batch_id, tt.status, tt.available_from, tt.available_until, tt.attempt_limit,
         tt.time_limit_minutes, c.status as class_status, b.status as batch_status
    into t
    from public.tests tt
    join public.classes c on c.id = tt.class_id
    join public.batches b on b.id = tt.batch_id
   where tt.id = p_test_id;

  if not found or t.status = 'draft' then
    perform public.log_test_security_event('blocked_start', null, null, null, null,
      jsonb_build_object('reason', 'not_found', 'requested_test_id', p_test_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Serialise this student's starts (double clicks, parallel tabs).
  select bs.enrollment_status into v_enrollment
    from public.batch_students bs
   where bs.batch_id = t.batch_id and bs.student_id = v_uid
     for update;
  if not found then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, null,
      jsonb_build_object('reason', 'not_in_batch'));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Finish an active attempt that must stop, then resume one that may continue.
  for r in
    select a.id from public.test_attempts a
     where a.test_id = t.id and a.student_id = v_uid and a.status = 'in_progress'
     for update
  loop
    v_reason := public.test_attempt_stop_reason(r.id);
    if v_reason is not null then
      perform public.finalize_test_attempt(r.id, v_reason);
    end if;
  end loop;

  select a.id into v_active
    from public.test_attempts a
   where a.test_id = t.id and a.student_id = v_uid and a.status = 'in_progress';
  if found then
    perform public.log_test_security_event('repeated_start', v_active, t.id, t.batch_id, v_uid, '{}'::jsonb);
    select count(*) into v_repeats
      from public.test_security_events e
     where e.attempt_id = v_active and e.event_type = 'repeated_start'
       and e.occurred_at > now() - interval '1 minute';
    if v_repeats = 10 then
      perform public.log_test_security_event('suspicious_repeated_access', v_active, t.id, t.batch_id, v_uid,
        jsonb_build_object('rule', 'repeated_start', 'count_per_minute', v_repeats));
    end if;
    return jsonb_build_object('ok', true, 'attempt_id', v_active, 'resumed', true);
  end if;

  if v_enrollment <> 'enrolled' then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, v_uid,
      jsonb_build_object('reason', 'not_enrolled', 'enrollment_status', v_enrollment));
    return jsonb_build_object('ok', false, 'reason', 'not_enrolled');
  end if;

  if t.class_status = 'cancelled' or t.batch_status = 'cancelled' then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, v_uid,
      jsonb_build_object('reason', 'cancelled'));
    return jsonb_build_object('ok', false, 'reason', 'cancelled');
  end if;

  v_effective := public.test_effective_status(t.status, t.available_from, t.available_until);
  if v_effective <> 'active' then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, v_uid,
      jsonb_build_object('reason', 'test_not_open', 'effective_status', v_effective));
    return jsonb_build_object('ok', false, 'reason',
      case when v_effective = 'scheduled' then 'test_not_open' else 'test_closed' end);
  end if;

  select count(*) into v_used
    from public.test_attempts a
   where a.test_id = t.id and a.student_id = v_uid;
  if v_used >= t.attempt_limit then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, v_uid,
      jsonb_build_object('reason', 'attempt_limit', 'attempts_used', v_used, 'attempt_limit', t.attempt_limit));
    return jsonb_build_object('ok', false, 'reason', 'attempt_limit');
  end if;

  select count(*), coalesce(sum(tq.marks), 0) into v_qcount, v_max
    from public.test_questions tq
   where tq.test_id = t.id;
  if v_qcount = 0 then
    perform public.log_test_security_event('blocked_start', null, t.id, t.batch_id, v_uid,
      jsonb_build_object('reason', 'no_questions'));
    return jsonb_build_object('ok', false, 'reason', 'test_not_open');
  end if;

  -- started_at / deadline_at are set by test_attempts_guard from the server clock.
  insert into public.test_attempts (test_id, batch_id, student_id, attempt_number, deadline_at, question_count, max_score)
  values (t.id, t.batch_id, v_uid, v_used + 1, now() + make_interval(mins => t.time_limit_minutes), v_qcount, v_max)
  returning id into v_attempt_id;

  -- Random question order and random option order, stored once.
  insert into public.test_attempt_questions (attempt_id, test_id, test_question_id, position, option_order)
  select v_attempt_id, t.id, tq.id,
         row_number() over (order by random()),
         (select array_agg(o.id order by random())
            from public.test_question_options o
           where o.test_question_id = tq.id)
    from public.test_questions tq
   where tq.test_id = t.id;

  perform public.log_test_security_event('attempt_started', v_attempt_id, t.id, t.batch_id, v_uid,
    jsonb_build_object('attempt_number', v_used + 1));

  return jsonb_build_object('ok', true, 'attempt_id', v_attempt_id, 'resumed', false);
end;
$$;

-- Load (own, in-progress) attempt paper: questions and options in the
-- attempt's stored order, the student's saved selections and the
-- server clock/deadline. NO is_correct, NO explanations.
create function public.get_attempt_paper(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := public.require_test_student();
  a           public.test_attempts%rowtype;
  t           record;
  v_reason    public.test_attempt_finalize_reason;
  v_questions jsonb;
begin
  select * into a from public.test_attempts where id = p_attempt_id for update;
  if not found or a.student_id <> v_uid then
    perform public.log_test_security_event('invalid_attempt_access',
      case when found then a.id end, case when found then a.test_id end,
      case when found then a.batch_id end, case when found then a.student_id end,
      jsonb_build_object('operation', 'paper', 'requested_attempt_id', p_attempt_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if a.status = 'in_progress' then
    v_reason := public.test_attempt_stop_reason(a.id);
    if v_reason is not null then
      perform public.finalize_test_attempt(a.id, v_reason);
      select * into a from public.test_attempts where id = p_attempt_id;
    end if;
  end if;

  select tt.id, tt.title, tt.test_type, tt.instructions, tt.time_limit_minutes, tt.available_until
    into t
    from public.tests tt
   where tt.id = a.test_id;

  if a.status <> 'in_progress' then
    return jsonb_build_object(
      'ok', true, 'attempt_id', a.id, 'status', a.status, 'finalize_reason', a.finalize_reason,
      'attempt_number', a.attempt_number, 'test_id', t.id, 'test_title', t.title,
      'started_at', a.started_at, 'finalized_at', a.finalized_at, 'questions', null);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'test_question_id', aq.test_question_id,
           'position',         aq.position,
           'question_type',    tq.question_type,
           'question_text',    tq.question_text,
           'marks',            tq.marks,
           'options',          (select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text) order by u.ord)
                                  from unnest(aq.option_order) with ordinality as u(option_id, ord)
                                  join public.test_question_options o on o.id = u.option_id),
           'selected',         coalesce((select jsonb_agg(ao.option_id)
                                           from public.test_attempt_answer_options ao
                                          where ao.attempt_id = aq.attempt_id
                                            and ao.test_question_id = aq.test_question_id), '[]'::jsonb)
         ) order by aq.position), '[]'::jsonb)
    into v_questions
    from public.test_attempt_questions aq
    join public.test_questions tq on tq.id = aq.test_question_id
   where aq.attempt_id = a.id;

  return jsonb_build_object(
    'ok', true,
    'attempt_id', a.id,
    'status', a.status,
    'attempt_number', a.attempt_number,
    'test_id', t.id,
    'test_title', t.title,
    'test_type', t.test_type,
    'instructions', t.instructions,
    'time_limit_minutes', t.time_limit_minutes,
    'started_at', a.started_at,
    'deadline_at', a.deadline_at,
    'effective_deadline', least(a.deadline_at, coalesce(t.available_until, a.deadline_at)),
    'grace_seconds', 5,
    'server_now', clock_timestamp(),
    'questions', v_questions);
end;
$$;

-- Save (replace) the selected options for one issued question.
-- p_client_seq orders saves from one browser (older/duplicate saves are
-- ignored); it is never trusted for security.
create function public.save_test_answer(
  p_attempt_id        uuid,
  p_test_question_id  uuid,
  p_option_ids        uuid[],
  p_client_seq        bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := public.require_test_student();
  a           public.test_attempts%rowtype;
  v_reason    public.test_attempt_finalize_reason;
  v_order     uuid[];
  v_type      public.question_type;
  v_ids       uuid[];
  v_prev_seq  bigint;
  v_until     timestamptz;
  v_saves     integer;
begin
  select * into a from public.test_attempts where id = p_attempt_id for update;
  if not found or a.student_id <> v_uid then
    perform public.log_test_security_event('invalid_attempt_access',
      case when found then a.id end, case when found then a.test_id end,
      case when found then a.batch_id end, case when found then a.student_id end,
      jsonb_build_object('operation', 'save', 'requested_attempt_id', p_attempt_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if a.status <> 'in_progress' then
    perform public.log_test_security_event('blocked_answer_save', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', 'attempt_finished', 'test_question_id', p_test_question_id));
    return jsonb_build_object('ok', false, 'reason', 'attempt_finished', 'status', a.status,
                              'finalize_reason', a.finalize_reason);
  end if;

  v_reason := public.test_attempt_stop_reason(a.id);
  if v_reason is not null then
    if v_reason = 'deadline' then
      perform public.log_test_security_event('deadline_reached', a.id, a.test_id, a.batch_id, a.student_id,
        jsonb_build_object('operation', 'save'));
    end if;
    perform public.log_test_security_event('blocked_answer_save', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', v_reason, 'test_question_id', p_test_question_id));
    perform public.finalize_test_attempt(a.id, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  select aq.option_order, tq.question_type into v_order, v_type
    from public.test_attempt_questions aq
    join public.test_questions tq on tq.id = aq.test_question_id
   where aq.attempt_id = a.id and aq.test_question_id = p_test_question_id;
  if not found then
    perform public.log_test_security_event('blocked_answer_save', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', 'invalid_question', 'test_question_id', p_test_question_id));
    return jsonb_build_object('ok', false, 'reason', 'invalid_question');
  end if;

  if p_client_seq is null or p_client_seq <= 0 then
    perform public.log_test_security_event('blocked_answer_save', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', 'invalid_request', 'test_question_id', p_test_question_id));
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  v_ids := coalesce(array(
    select distinct x from unnest(coalesce(p_option_ids, '{}'::uuid[])) as x where x is not null
  ), '{}'::uuid[]);
  if not (v_ids <@ v_order)
     or (v_type in ('single_choice', 'true_false') and cardinality(v_ids) > 1) then
    perform public.log_test_security_event('blocked_answer_save', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', 'invalid_options', 'test_question_id', p_test_question_id));
    return jsonb_build_object('ok', false, 'reason', 'invalid_options');
  end if;

  select t.available_until into v_until from public.tests t where t.id = a.test_id;

  select ans.client_seq into v_prev_seq
    from public.test_attempt_answers ans
   where ans.attempt_id = a.id and ans.test_question_id = p_test_question_id;
  if found and p_client_seq <= v_prev_seq then
    -- An older or duplicate save arrived late: keep the newer one.
    return jsonb_build_object('ok', true, 'ignored', true, 'server_now', clock_timestamp(),
      'effective_deadline', least(a.deadline_at, coalesce(v_until, a.deadline_at)));
  end if;

  insert into public.test_attempt_answers (attempt_id, test_question_id, client_seq, save_count, saved_at)
  values (a.id, p_test_question_id, p_client_seq, 1, now())
  on conflict (attempt_id, test_question_id) do update
     set client_seq = excluded.client_seq,
         save_count = public.test_attempt_answers.save_count + 1,
         saved_at   = excluded.saved_at;

  delete from public.test_attempt_answer_options ao
   where ao.attempt_id = a.id and ao.test_question_id = p_test_question_id;
  insert into public.test_attempt_answer_options (attempt_id, test_question_id, option_id)
  select a.id, p_test_question_id, x from unnest(v_ids) as x;

  perform public.log_test_security_event('answer_saved', a.id, a.test_id, a.batch_id, a.student_id,
    jsonb_build_object('test_question_id', p_test_question_id, 'option_count', cardinality(v_ids),
                       'client_seq', p_client_seq));

  select count(*) into v_saves
    from public.test_security_events e
   where e.attempt_id = a.id and e.event_type = 'answer_saved'
     and e.occurred_at > now() - interval '1 minute';
  if v_saves = 121 then
    perform public.log_test_security_event('suspicious_repeated_access', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('rule', 'answer_saves_per_minute', 'count_per_minute', v_saves));
  end if;

  return jsonb_build_object('ok', true, 'ignored', false, 'saved_at', now(), 'server_now', clock_timestamp(),
    'effective_deadline', least(a.deadline_at, coalesce(v_until, a.deadline_at)));
end;
$$;

-- Submit (own) attempt. Idempotent: a finished attempt returns its
-- state. Within the effective deadline + grace it is a student
-- submission; after it (or if the test/class/batch/enrolment stopped
-- it) it is finalized with that reason. Scores are not returned here.
create function public.submit_test_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_test_student();
  a         public.test_attempts%rowtype;
  v_reason  public.test_attempt_finalize_reason;
begin
  select * into a from public.test_attempts where id = p_attempt_id for update;
  if not found or a.student_id <> v_uid then
    perform public.log_test_security_event('invalid_attempt_access',
      case when found then a.id end, case when found then a.test_id end,
      case when found then a.batch_id end, case when found then a.student_id end,
      jsonb_build_object('operation', 'submit', 'requested_attempt_id', p_attempt_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if a.status <> 'in_progress' then
    perform public.log_test_security_event('blocked_submission', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('reason', 'attempt_finished'));
    return jsonb_build_object('ok', true, 'already_finished', true, 'attempt_id', a.id,
      'status', a.status, 'finalize_reason', a.finalize_reason);
  end if;

  v_reason := public.test_attempt_stop_reason(a.id);
  if v_reason = 'deadline' then
    perform public.log_test_security_event('deadline_reached', a.id, a.test_id, a.batch_id, a.student_id,
      jsonb_build_object('operation', 'submit'));
  end if;
  perform public.finalize_test_attempt(a.id, coalesce(v_reason, 'student_submit'));

  select * into a from public.test_attempts where id = p_attempt_id;
  return jsonb_build_object('ok', true, 'already_finished', false, 'attempt_id', a.id,
    'status', a.status, 'finalize_reason', a.finalize_reason);
end;
$$;

-- Own attempt state; score, pass/fail and the full review (correct
-- answers + explanations) only once the test is effectively closed.
create function public.get_attempt_result(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := public.require_test_student();
  a           public.test_attempts%rowtype;
  t           record;
  v_reason    public.test_attempt_finalize_reason;
  v_released  boolean;
  v_answered  integer;
  v_best_id   uuid;
  v_base      jsonb;
  v_review    jsonb;
begin
  select * into a from public.test_attempts where id = p_attempt_id for update;
  if not found or a.student_id <> v_uid then
    perform public.log_test_security_event('invalid_attempt_access',
      case when found then a.id end, case when found then a.test_id end,
      case when found then a.batch_id end, case when found then a.student_id end,
      jsonb_build_object('operation', 'result', 'requested_attempt_id', p_attempt_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if a.status = 'in_progress' then
    v_reason := public.test_attempt_stop_reason(a.id);
    if v_reason is not null then
      perform public.finalize_test_attempt(a.id, v_reason);
      select * into a from public.test_attempts where id = p_attempt_id;
    end if;
  end if;

  select tt.id, tt.title, tt.status, tt.available_from, tt.available_until, tt.pass_mark_percent
    into t
    from public.tests tt
   where tt.id = a.test_id;

  v_released := a.status <> 'in_progress'
                and public.test_effective_status(t.status, t.available_from, t.available_until) = 'closed';

  select count(distinct ao.test_question_id) into v_answered
    from public.test_attempt_answer_options ao
   where ao.attempt_id = a.id;

  v_base := jsonb_build_object(
    'ok', true,
    'attempt_id', a.id,
    'attempt_number', a.attempt_number,
    'test_id', t.id,
    'test_title', t.title,
    'status', a.status,
    'finalize_reason', a.finalize_reason,
    'started_at', a.started_at,
    'finalized_at', a.finalized_at,
    'question_count', a.question_count,
    'answered_count', v_answered,
    'results_available', v_released);

  if not v_released then
    return v_base;
  end if;

  select ba.id into v_best_id
    from public.test_attempts ba
   where ba.test_id = a.test_id and ba.student_id = a.student_id and ba.status <> 'in_progress'
   order by ba.percentage desc, ba.score desc, ba.finalized_at asc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'position',       aq.position,
           'question_type',  tq.question_type,
           'question_text',  tq.question_text,
           'marks',          tq.marks,
           'explanation',    tq.explanation,
           'is_correct',     ans.is_correct,
           'marks_awarded',  ans.marks_awarded,
           'options',        (select jsonb_agg(jsonb_build_object(
                                       'id', o.id,
                                       'text', o.option_text,
                                       'is_correct', o.is_correct,
                                       'selected', exists (
                                         select 1 from public.test_attempt_answer_options ao
                                          where ao.attempt_id = aq.attempt_id
                                            and ao.test_question_id = aq.test_question_id
                                            and ao.option_id = o.id))
                                     order by u.ord)
                                from unnest(aq.option_order) with ordinality as u(option_id, ord)
                                join public.test_question_options o on o.id = u.option_id)
         ) order by aq.position), '[]'::jsonb)
    into v_review
    from public.test_attempt_questions aq
    join public.test_questions tq on tq.id = aq.test_question_id
    left join public.test_attempt_answers ans
      on ans.attempt_id = aq.attempt_id and ans.test_question_id = aq.test_question_id
   where aq.attempt_id = a.id;

  return v_base || jsonb_build_object(
    'score', a.score,
    'max_score', a.max_score,
    'percentage', a.percentage,
    'passed', a.passed,
    'pass_mark_percent', t.pass_mark_percent,
    'is_best_attempt', a.id = v_best_id,
    'review', v_review);
end;
$$;

-- -------------------------------------------------------------------
-- 6. Staff function
-- -------------------------------------------------------------------

-- Finalize every in-progress attempt of a test that must stop now
-- (deadline, closed test, cancellation, enrolment). Super admin, or the
-- test batch's CURRENT trainer. Returns {ok, finalized}.
create function public.staff_finalize_due_attempts(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_id  uuid;
  v_reason    public.test_attempt_finalize_reason;
  v_count     integer := 0;
  r           record;
begin
  select t.batch_id into v_batch_id from public.tests t where t.id = p_test_id;
  if auth.uid() is null
     or not found
     or not (public.is_super_admin() or public.is_current_batch_trainer(v_batch_id)) then
    raise exception 'Test not found, or you don''t have permission to manage it.' using errcode = '42501';
  end if;

  for r in
    select a.id from public.test_attempts a
     where a.test_id = p_test_id and a.status = 'in_progress'
     for update skip locked
  loop
    v_reason := public.test_attempt_stop_reason(r.id);
    if v_reason is not null and public.finalize_test_attempt(r.id, v_reason) then
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'finalized', v_count);
end;
$$;

revoke all on function public.student_available_tests()                                  from public, anon;
revoke all on function public.start_test_attempt(uuid)                                   from public, anon;
revoke all on function public.get_attempt_paper(uuid)                                    from public, anon;
revoke all on function public.save_test_answer(uuid, uuid, uuid[], bigint)                from public, anon;
revoke all on function public.submit_test_attempt(uuid)                                  from public, anon;
revoke all on function public.get_attempt_result(uuid)                                   from public, anon;
revoke all on function public.staff_finalize_due_attempts(uuid)                          from public, anon;

grant execute on function public.student_available_tests()                               to authenticated, service_role;
grant execute on function public.start_test_attempt(uuid)                                to authenticated, service_role;
grant execute on function public.get_attempt_paper(uuid)                                 to authenticated, service_role;
grant execute on function public.save_test_answer(uuid, uuid, uuid[], bigint)             to authenticated, service_role;
grant execute on function public.submit_test_attempt(uuid)                               to authenticated, service_role;
grant execute on function public.get_attempt_result(uuid)                                to authenticated, service_role;
grant execute on function public.staff_finalize_due_attempts(uuid)                       to authenticated, service_role;

-- -------------------------------------------------------------------
-- 7. Best results (derived, never stored twice)
--    security_invoker: the caller's RLS on test_attempts applies, so
--    staff see their scope and students see nothing (they use functions).
-- -------------------------------------------------------------------
create view public.test_best_results
  with (security_invoker = true)
as
select distinct on (a.test_id, a.student_id)
       a.test_id,
       a.batch_id,
       a.student_id,
       a.id           as best_attempt_id,
       a.score,
       a.max_score,
       a.percentage,
       a.passed,
       a.finalized_at,
       count(*) over (partition by a.test_id, a.student_id) as finished_attempts
  from public.test_attempts a
 where a.status <> 'in_progress'
 order by a.test_id, a.student_id, a.percentage desc, a.score desc, a.finalized_at asc;

-- -------------------------------------------------------------------
-- 8. Privileges + Row Level Security (staff read-only; no student,
--    no anonymous; no client writes at all)
-- -------------------------------------------------------------------
alter table public.test_attempts               enable row level security;
alter table public.test_attempt_questions      enable row level security;
alter table public.test_attempt_answers        enable row level security;
alter table public.test_attempt_answer_options enable row level security;
alter table public.test_security_events        enable row level security;

revoke all on table
  public.test_attempts, public.test_attempt_questions, public.test_attempt_answers,
  public.test_attempt_answer_options, public.test_security_events, public.test_best_results
  from anon, authenticated;

grant select on table
  public.test_attempts, public.test_attempt_questions, public.test_attempt_answers,
  public.test_attempt_answer_options, public.test_security_events, public.test_best_results
  to authenticated;

grant all on table
  public.test_attempts, public.test_attempt_questions, public.test_attempt_answers,
  public.test_attempt_answer_options, public.test_security_events, public.test_best_results
  to service_role;

-- Super admin, or the CURRENT trainer of an upcoming/ongoing batch.
create policy test_attempts_staff_select
  on public.test_attempts for select to authenticated
  using ((select public.is_super_admin()) or public.is_current_batch_trainer(batch_id));

create policy test_attempt_questions_staff_select
  on public.test_attempt_questions for select to authenticated
  using (exists (
    select 1 from public.test_attempts a
     where a.id = test_attempt_questions.attempt_id
       and ((select public.is_super_admin()) or public.is_current_batch_trainer(a.batch_id))));

create policy test_attempt_answers_staff_select
  on public.test_attempt_answers for select to authenticated
  using (exists (
    select 1 from public.test_attempts a
     where a.id = test_attempt_answers.attempt_id
       and ((select public.is_super_admin()) or public.is_current_batch_trainer(a.batch_id))));

create policy test_attempt_answer_options_staff_select
  on public.test_attempt_answer_options for select to authenticated
  using (exists (
    select 1 from public.test_attempts a
     where a.id = test_attempt_answer_options.attempt_id
       and ((select public.is_super_admin()) or public.is_current_batch_trainer(a.batch_id))));

create policy test_security_events_staff_select
  on public.test_security_events for select to authenticated
  using ((select public.is_super_admin())
         or (batch_id is not null and public.is_current_batch_trainer(batch_id)));

commit;
