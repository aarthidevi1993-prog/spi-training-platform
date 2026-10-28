-- ===================================================================
-- 0010 — TEST ATTEMPT FINALIZATION HOOKS
--
-- Closes the lifecycle gaps left (by design) in 0009, where attempts
-- were finalized lazily on the next access:
--
--   1. tests          status → closed                 ⇒ finalize (test_closed)
--   2. classes        status → cancelled              ⇒ finalize (class_cancelled)
--   3. batches        status → cancelled              ⇒ finalize (batch_cancelled)
--   4. batch_students enrolled → withdrawn / other    ⇒ finalize (withdrawn / enrollment_ended)
--   5. Reopening protection: once any attempt of a test is finished,
--      the test can't be reopened (closed → scheduled/active), and a
--      test that already closed by time can't be revived by extending
--      available_until.
--   6. A start racing a close/cancel can't leave a new in-progress
--      attempt behind (shared row locks on the test, class and batch).
--
-- Every hook reuses 0009's finalize_test_attempt() — the one grading
-- algorithm — and runs AFTER the row change, in the SAME transaction:
-- if finalization fails, the lifecycle change rolls back with it.
-- Attempts are locked in id order (FOR UPDATE, never SKIP LOCKED), so a
-- student's in-flight save/submit completes first and is graded, and
-- finalize_test_attempt() ignores attempts that are already finished
-- (no duplicate grading or events).
--
-- AUDIT IDENTITY: triggers run in the session that made the change,
-- so auth.uid() is still the signed-in admin/trainer whose operation
-- caused it (taken from the verified session JWT — never a parameter).
-- The 0009 guards stamp that user as the actor of every finalization
-- event. When there is NO signed-in user (SQL Editor / service role)
-- and in-progress attempts would have to be finalized, the change is
-- REFUSED (fail closed) instead of creating unaudited finalizations.
-- Such changes remain possible when no attempt is in progress.
--
-- Trigger functions are security definer (they must call the internal
-- finalizer and see every attempt regardless of RLS), have a fixed
-- empty search_path, and EXECUTE is revoked from every client role;
-- PostgreSQL also refuses to call trigger functions directly.
--
-- Adds triggers only. No table, column, constraint, policy, grant,
-- view or existing function is created, altered or dropped in
-- 0001–0009. No DROP, DELETE, TRUNCATE or data rewrites.
--
-- Runs as ONE transaction (BEGIN/COMMIT below) — paste into the SQL
-- Editor as-is. Depends on 0001–0009. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort (and roll back) unless 0001–0009 are in place
--    and 0010 has not been applied.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.test_attempts') is null
     or to_regclass('public.test_security_events') is null
     or to_regtype('public.test_attempt_finalize_reason') is null
     or to_regprocedure('public.finalize_test_attempt(uuid, public.test_attempt_finalize_reason)') is null
     or to_regprocedure('public.test_effective_status(public.test_status, timestamptz, timestamptz)') is null then
    raise exception 'Preflight failed: 0008/0009 objects are missing.';
  end if;

  if to_regprocedure('public.finalize_lifecycle_attempts(uuid, uuid, uuid, uuid, public.test_attempt_finalize_reason)') is not null
     or exists (select 1 from pg_trigger where tgname = 'tests_reopen_guard' and tgrelid = 'public.tests'::regclass) then
    raise exception 'Preflight failed: 0010 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Internal finalizer for lifecycle changes (not callable by clients)
--    Finalizes every in-progress attempt matching the given scope,
--    via 0009's finalize_test_attempt(), in a stable lock order.
--    Refuses (and so rolls back the lifecycle change) when attempts
--    must be finalized but no user is signed in.
-- -------------------------------------------------------------------
create function public.finalize_lifecycle_attempts(
  p_test_id     uuid,
  p_class_id    uuid,
  p_batch_id    uuid,
  p_student_id  uuid,
  p_reason      public.test_attempt_finalize_reason
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count  integer := 0;
  r        record;
begin
  if p_reason is null
     or (p_test_id is null and p_class_id is null and p_batch_id is null) then
    raise exception 'A lifecycle scope and reason are required.' using errcode = '22023';
  end if;

  for r in
    select a.id
      from public.test_attempts a
      join public.tests t on t.id = a.test_id
     where a.status = 'in_progress'
       and (p_test_id    is null or a.test_id    = p_test_id)
       and (p_class_id   is null or t.class_id   = p_class_id)
       and (p_batch_id   is null or a.batch_id   = p_batch_id)
       and (p_student_id is null or a.student_id = p_student_id)
     order by a.id
       for update of a
  loop
    if auth.uid() is null then
      raise exception 'Test attempts are in progress. Make this change as a signed-in user so the attempts can be finalized and audited.'
        using errcode = '42501';
    end if;
    -- Re-checks the status under the lock: already-finished attempts are skipped.
    if public.finalize_test_attempt(r.id, p_reason) then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.finalize_lifecycle_attempts(uuid, uuid, uuid, uuid, public.test_attempt_finalize_reason)
  from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 2. Finalization triggers on the existing lifecycle tables
-- -------------------------------------------------------------------

-- a) A test is closed.
create function public.tests_finalize_attempts_on_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.finalize_lifecycle_attempts(new.id, null, null, null, 'test_closed');
  return null;
end;
$$;

revoke all on function public.tests_finalize_attempts_on_close() from public, anon, authenticated;

create trigger tests_finalize_attempts_on_close
  after update on public.tests
  for each row
  when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function public.tests_finalize_attempts_on_close();

-- b) A class is cancelled.
create function public.classes_finalize_attempts_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.finalize_lifecycle_attempts(null, new.id, null, null, 'class_cancelled');
  return null;
end;
$$;

revoke all on function public.classes_finalize_attempts_on_cancel() from public, anon, authenticated;

create trigger classes_finalize_attempts_on_cancel
  after update on public.classes
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.classes_finalize_attempts_on_cancel();

-- c) A batch is cancelled.
create function public.batches_finalize_attempts_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.finalize_lifecycle_attempts(null, null, new.id, null, 'batch_cancelled');
  return null;
end;
$$;

revoke all on function public.batches_finalize_attempts_on_cancel() from public, anon, authenticated;

create trigger batches_finalize_attempts_on_cancel
  after update on public.batches
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.batches_finalize_attempts_on_cancel();

-- d) An enrolment stops being 'enrolled' (withdrawn, or e.g. completed).
create function public.batch_students_finalize_attempts_on_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.finalize_lifecycle_attempts(
    null, null, new.batch_id, new.student_id,
    case when new.enrollment_status = 'withdrawn'
         then 'withdrawn'::public.test_attempt_finalize_reason
         else 'enrollment_ended'::public.test_attempt_finalize_reason end);
  return null;
end;
$$;

revoke all on function public.batch_students_finalize_attempts_on_exit() from public, anon, authenticated;

create trigger batch_students_finalize_attempts_on_exit
  after update on public.batch_students
  for each row
  when (old.enrollment_status = 'enrolled' and new.enrollment_status is distinct from 'enrolled')
  execute function public.batch_students_finalize_attempts_on_exit();

-- -------------------------------------------------------------------
-- 3. Reopening protection (tests, BEFORE UPDATE)
--    Consistent with 0008 (closed → scheduled/active is its reopen):
--    once any attempt of the test is finished, results can be
--    released, so the test can't be reopened — and a test that has
--    already closed by time can't be revived by extending
--    available_until. Fires before tests_stamp/tests_validate (name
--    order); those 0008 rules still apply unchanged.
-- -------------------------------------------------------------------
create function public.tests_reopen_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.test_attempts a
     where a.test_id = old.id and a.status <> 'in_progress'
  ) then
    if old.status = 'closed' and new.status in ('scheduled', 'active') then
      raise exception 'This test can''t be reopened: attempts have already been finalized and results can be released.'
        using errcode = '23514';
    end if;
    if old.status in ('scheduled', 'active')
       and new.available_until is distinct from old.available_until
       and old.available_until is not null
       and old.available_until <= now() then
      raise exception 'This test has already closed and its results can be released, so its closing time can''t be extended.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tests_reopen_guard() from public, anon, authenticated;

create trigger tests_reopen_guard
  before update on public.tests
  for each row
  when (   (old.status = 'closed' and new.status in ('scheduled', 'active'))
        or (new.available_until is distinct from old.available_until))
  execute function public.tests_reopen_guard();

-- -------------------------------------------------------------------
-- 4. Start vs close/cancel race (test_attempts, BEFORE INSERT)
--    A new attempt takes SHARE locks on its test, class and batch rows
--    and re-checks them. A concurrent close/cancel (which updates that
--    row) either waits for the start to commit — and then finalizes
--    the new attempt in its own trigger — or commits first, in which
--    case the start sees it here and is refused. Withdrawal is already
--    serialised by start_test_attempt's lock on the enrolment row.
--    Adds a trigger only; the 0009 table and guard are unchanged.
-- -------------------------------------------------------------------
create function public.test_attempts_lifecycle_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status        public.test_status;
  v_from          timestamptz;
  v_until         timestamptz;
  v_class_id      uuid;
  v_class_status  text;
  v_batch_status  public.batch_status;
begin
  select t.status, t.available_from, t.available_until, t.class_id
    into v_status, v_from, v_until, v_class_id
    from public.tests t
   where t.id = new.test_id
     for share;
  select c.status into v_class_status from public.classes c where c.id = v_class_id for share;
  select b.status into v_batch_status from public.batches b where b.id = new.batch_id for share;

  if public.test_effective_status(v_status, v_from, v_until) <> 'active'
     or v_class_status = 'cancelled'
     or v_batch_status = 'cancelled' then
    raise exception 'This test is no longer open.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.test_attempts_lifecycle_lock() from public, anon, authenticated;

create trigger test_attempts_lifecycle_lock
  before insert on public.test_attempts
  for each row execute function public.test_attempts_lifecycle_lock();

commit;
