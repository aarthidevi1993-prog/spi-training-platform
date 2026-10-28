-- ===================================================================
-- 0015 — EXAM INTEGRITY FOUNDATION (anti-malpractice, database layer)
--
-- Builds on the 0009 secure test engine. Nothing about how attempts are
-- started, answered, timed, graded, finalized or released changes.
--
-- 1. Session binding. test_attempts.started_session_id (nullable) keeps
--    the Supabase auth session (JWT claim "session_id") that started the
--    attempt. While an attempt is in progress, get_attempt_paper,
--    save_test_answer and submit_test_attempt note a DIFFERENT session
--    with ONE 'concurrent_session' event per new session. The attempt is
--    never blocked, ended or invalidated by this. Attempts started before
--    0015 keep started_session_id = NULL and are never checked.
--
-- 2. Audit throttling. Routine, student-triggerable events
--    (answer_saved, blocked_answer_save, blocked_start, repeated_start,
--    blocked_submission, invalid_attempt_access, client_*) are written
--    at most N per minute per (actor, attempt, event type) — 121 for
--    answer_saved (so 0009's own "121 saves per minute" rule still fires,
--    once, as before — it is not repeated while the count is held at 121
--    by throttling), 20 for the others — and at most 600 per actor
--    per hour across them. Beyond a limit, ONE 'suspicious_repeated_access'
--    summary is written per window instead. Throttling only skips AUDIT
--    ROWS: every answer is still saved, and lifecycle, grading and
--    summary events are never throttled.
--
-- 3. Client-reported events. record_attempt_client_event() lets a
--    student report browser signals (tab hidden, offline/online, copy,
--    paste, print, multiple tabs, full-screen exit) for their OWN
--    IN-PROGRESS attempt only: strict allow-list, JSON object detail of
--    at most 1 KB, rate-limited, server time and actor (the 0009 guard
--    stamps both). These are lower-trust prompts for review, never proof.
--
-- Re-created functions are 0009's text plus lines tagged "-- 0015";
-- log_test_security_event keeps its signature and grants.
-- Grants: unchanged for re-created functions; the new client-event
-- function is executable by authenticated only; helpers by nobody.
-- No RLS policy changes. No direct table write privileges for anyone.
--
-- Enum values are added BEFORE the transaction (committed first); no
-- statement in this file uses them at migration time.
-- Requires 0009. Safe to re-run.
-- ===================================================================

do $$
begin
  if to_regclass('public.test_attempts') is null
     or to_regclass('public.test_security_events') is null
     or to_regtype('public.test_security_event_type') is null
     or to_regprocedure('public.log_test_security_event(public.test_security_event_type, uuid, uuid, uuid, uuid, jsonb)') is null
     or to_regprocedure('public.start_test_attempt(uuid)') is null
     or to_regprocedure('public.get_attempt_paper(uuid)') is null
     or to_regprocedure('public.save_test_answer(uuid, uuid, uuid[], bigint)') is null
     or to_regprocedure('public.submit_test_attempt(uuid)') is null
     or to_regprocedure('public.require_test_student()') is null
     or to_regprocedure('public.test_attempt_stop_reason(uuid)') is null then
    raise exception 'Preflight failed: 0009 (secure student test engine) is not applied.';
  end if;
end
$$;

-- 1. New event types (committed before the transaction below).
alter type public.test_security_event_type add value if not exists 'concurrent_session';
alter type public.test_security_event_type add value if not exists 'client_hidden';
alter type public.test_security_event_type add value if not exists 'client_offline';
alter type public.test_security_event_type add value if not exists 'client_online';
alter type public.test_security_event_type add value if not exists 'client_copy';
alter type public.test_security_event_type add value if not exists 'client_paste';
alter type public.test_security_event_type add value if not exists 'client_print';
alter type public.test_security_event_type add value if not exists 'client_multiple_tabs';
alter type public.test_security_event_type add value if not exists 'client_fullscreen_exit';

begin;

-- -------------------------------------------------------------------
-- 2. Session binding column + throttle index
-- -------------------------------------------------------------------
alter table public.test_attempts add column if not exists started_session_id uuid null;
comment on column public.test_attempts.started_session_id is
  'Supabase auth session (JWT "session_id") that started the attempt (0015). NULL for attempts started before 0015 or without a session claim.';

create index if not exists test_security_events_actor_type_idx
  on public.test_security_events (actor_id, event_type, occurred_at);

-- -------------------------------------------------------------------
-- 3. Internal helpers (not callable by any client role)
-- -------------------------------------------------------------------

-- The caller's auth session id from the request's JWT claims (NULL if absent or malformed).
create or replace function public.test_attempt_session_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

-- Note (once per new session) that an in-progress attempt is used from a
-- session other than the one that started it. Never blocks anything.
create or replace function public.test_attempt_note_session(p_attempt_id uuid, p_operation text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a      record;
  v_sid  uuid := public.test_attempt_session_id();
begin
  select x.id, x.test_id, x.batch_id, x.student_id, x.started_session_id
    into a
    from public.test_attempts x
   where x.id = p_attempt_id;
  if not found or a.started_session_id is null or v_sid is null or v_sid = a.started_session_id then
    return;
  end if;
  if exists (select 1 from public.test_security_events e
              where e.attempt_id = a.id
                and e.event_type = 'concurrent_session'
                and e.detail ->> 'session_id' = v_sid::text) then
    return;
  end if;
  perform public.log_test_security_event('concurrent_session', a.id, a.test_id, a.batch_id, a.student_id,
    jsonb_build_object('operation', p_operation, 'session_id', v_sid, 'started_session_id', a.started_session_id));
end;
$$;

-- TRUE when a routine event must NOT be written now (rate limit reached).
-- Writes at most one 'suspicious_repeated_access' summary per window.
create or replace function public.test_security_event_throttled(
  p_type        public.test_security_event_type,
  p_attempt_id  uuid,
  p_test_id     uuid,
  p_batch_id    uuid,
  p_student_id  uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_routine  public.test_security_event_type[] := array[
    'answer_saved', 'blocked_answer_save', 'blocked_start', 'repeated_start', 'blocked_submission',
    'invalid_attempt_access', 'client_hidden', 'client_offline', 'client_online', 'client_copy',
    'client_paste', 'client_print', 'client_multiple_tabs', 'client_fullscreen_exit'
  ]::text[]::public.test_security_event_type[];
  v_limit    integer;
  v_count    integer;
begin
  -- Only routine, student-triggerable events are ever throttled.
  if v_actor is null or not (p_type = any (v_routine)) then
    return false;
  end if;

  -- Per (actor, attempt, event type) per minute.
  v_limit := case when p_type = 'answer_saved' then 121 else 20 end;
  select count(*) into v_count
    from public.test_security_events e
   where e.actor_id = v_actor
     and e.event_type = p_type
     and e.attempt_id is not distinct from p_attempt_id
     and e.occurred_at > now() - interval '1 minute';
  if v_count >= v_limit then
    if not exists (select 1 from public.test_security_events e
                    where e.actor_id = v_actor
                      and e.event_type = 'suspicious_repeated_access'
                      and e.attempt_id is not distinct from p_attempt_id
                      and e.detail ->> 'rule' = 'audit_throttle'
                      and e.detail ->> 'throttled_event' = p_type::text
                      and e.occurred_at > now() - interval '1 minute') then
      insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)
      values ('suspicious_repeated_access', v_actor, p_attempt_id, p_test_id, p_batch_id, p_student_id,
              jsonb_build_object('rule', 'audit_throttle', 'throttled_event', p_type::text,
                                 'limit_per_minute', v_limit));
    end if;
    return true;
  end if;

  -- Per actor per hour, across all routine events.
  select count(*) into v_count
    from public.test_security_events e
   where e.actor_id = v_actor
     and e.event_type = any (v_routine)
     and e.occurred_at > now() - interval '1 hour';
  if v_count >= 600 then
    if not exists (select 1 from public.test_security_events e
                    where e.actor_id = v_actor
                      and e.event_type = 'suspicious_repeated_access'
                      and e.detail ->> 'rule' = 'audit_throttle_hourly'
                      and e.occurred_at > now() - interval '1 hour') then
      insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)
      values ('suspicious_repeated_access', v_actor, p_attempt_id, p_test_id, p_batch_id, p_student_id,
              jsonb_build_object('rule', 'audit_throttle_hourly', 'throttled_event', p_type::text,
                                 'limit_per_hour', 600));
    end if;
    return true;
  end if;

  return false;
end;
$$;

-- -------------------------------------------------------------------
-- 4. The event logger: same signature and grants as 0009, now throttled.
-- -------------------------------------------------------------------
create or replace function public.log_test_security_event(
  p_type        public.test_security_event_type,
  p_attempt_id  uuid,
  p_test_id     uuid,
  p_batch_id    uuid,
  p_student_id  uuid,
  p_detail      jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.test_security_event_throttled(p_type, p_attempt_id, p_test_id, p_batch_id, p_student_id) then
    return;  -- 0015: routine event over its rate limit (a summary was recorded instead)
  end if;
  -- 0015: 0009's "121 saves per minute" rule fires when the attempt's answer_saved count
  -- equals 121. While those rows are throttled the count stays at 121, so without this the
  -- rule would repeat on every further save. It still fires once, exactly as in 0009.
  if p_type = 'suspicious_repeated_access'
     and p_detail ->> 'rule' = 'answer_saves_per_minute'
     and exists (select 1 from public.test_security_events e
                  where e.attempt_id is not distinct from p_attempt_id
                    and e.event_type = 'suspicious_repeated_access'
                    and e.detail ->> 'rule' = 'audit_throttle'
                    and e.detail ->> 'throttled_event' = 'answer_saved'
                    and e.occurred_at > now() - interval '1 minute') then
    return;
  end if;
  insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)
  values (p_type, auth.uid(), p_attempt_id, p_test_id, p_batch_id, p_student_id, coalesce(p_detail, '{}'::jsonb));
end;
$$;

-- -------------------------------------------------------------------
-- 5. Student functions re-created from 0009 (+ lines tagged "-- 0015")
-- -------------------------------------------------------------------
create or replace function public.start_test_attempt(p_test_id uuid)
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
  -- The session that started the attempt (0015 session binding; NULL when the request has none).  -- 0015
  update public.test_attempts set started_session_id = public.test_attempt_session_id() where id = v_attempt_id;  -- 0015

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

create or replace function public.get_attempt_paper(p_attempt_id uuid)
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

  if a.status = 'in_progress' then  -- 0015
    perform public.test_attempt_note_session(a.id, 'paper');  -- 0015
  end if;  -- 0015
  -- 0015
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

create or replace function public.save_test_answer(
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

  perform public.test_attempt_note_session(a.id, 'save');  -- 0015
  -- 0015
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

create or replace function public.submit_test_attempt(p_attempt_id uuid)
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

  perform public.test_attempt_note_session(a.id, 'submit');  -- 0015
  -- 0015
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

-- -------------------------------------------------------------------
-- 6. Client-reported events (student, own in-progress attempt only)
-- -------------------------------------------------------------------
create or replace function public.record_attempt_client_event(
  p_attempt_id  uuid,
  p_kind        text,
  p_detail      jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.require_test_student();
  a         public.test_attempts%rowtype;
  v_type    public.test_security_event_type;
  v_detail  jsonb := coalesce(p_detail, '{}'::jsonb);
begin
  if p_kind is null or p_kind not in ('client_hidden', 'client_offline', 'client_online', 'client_copy',
                                      'client_paste', 'client_print', 'client_multiple_tabs',
                                      'client_fullscreen_exit') then
    raise exception 'Unknown client event.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_detail) <> 'object' or octet_length(v_detail::text) > 1024 then
    raise exception 'Event detail must be a JSON object of at most 1 KB.' using errcode = '22023';
  end if;
  v_type := p_kind::public.test_security_event_type;

  select * into a from public.test_attempts where id = p_attempt_id;
  if not found or a.student_id <> v_uid then
    perform public.log_test_security_event('invalid_attempt_access',
      case when found then a.id end, case when found then a.test_id end,
      case when found then a.batch_id end, case when found then a.student_id end,
      jsonb_build_object('operation', 'client_event', 'requested_attempt_id', p_attempt_id));
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if a.status <> 'in_progress' or public.test_attempt_stop_reason(a.id) is not null then
    return jsonb_build_object('ok', false, 'reason', 'attempt_finished');
  end if;

  perform public.test_attempt_note_session(a.id, 'client_event');

  if public.test_security_event_throttled(v_type, a.id, a.test_id, a.batch_id, a.student_id) then
    return jsonb_build_object('ok', true, 'recorded', false, 'reason', 'rate_limited');
  end if;

  -- actor_id and occurred_at are always stamped by test_security_events_guard (server side).
  insert into public.test_security_events (event_type, actor_id, attempt_id, test_id, batch_id, student_id, detail)
  values (v_type, v_uid, a.id, a.test_id, a.batch_id, a.student_id,
          jsonb_build_object('source', 'client', 'client', v_detail));
  return jsonb_build_object('ok', true, 'recorded', true);
end;
$$;

comment on function public.record_attempt_client_event(uuid, text, jsonb) is
  'Student-reported browser signal for the caller''s own in-progress attempt (0015): allow-listed kinds, JSON detail <= 1 KB, rate-limited, server time/actor. Lower-trust review prompt, never proof.';

-- -------------------------------------------------------------------
-- 7. Privileges
-- -------------------------------------------------------------------
-- Internal helpers: no client role may call them (they run inside security definer functions).
revoke all on function public.test_attempt_session_id() from public, anon, authenticated;
revoke all on function public.test_attempt_note_session(uuid, text) from public, anon, authenticated;
revoke all on function public.test_security_event_throttled(public.test_security_event_type, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.log_test_security_event(public.test_security_event_type, uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;

-- Re-created student functions: exactly the 0009 privileges (CREATE OR REPLACE keeps them; restated).
revoke all on function public.start_test_attempt(uuid)                    from public, anon;
revoke all on function public.get_attempt_paper(uuid)                     from public, anon;
revoke all on function public.save_test_answer(uuid, uuid, uuid[], bigint) from public, anon;
revoke all on function public.submit_test_attempt(uuid)                   from public, anon;
grant execute on function public.start_test_attempt(uuid)                    to authenticated, service_role;
grant execute on function public.get_attempt_paper(uuid)                     to authenticated, service_role;
grant execute on function public.save_test_answer(uuid, uuid, uuid[], bigint) to authenticated, service_role;
grant execute on function public.submit_test_attempt(uuid)                   to authenticated, service_role;

-- New client-event function: authenticated only (the student check is inside).
revoke all on function public.record_attempt_client_event(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.record_attempt_client_event(uuid, text, jsonb) to authenticated;

commit;
