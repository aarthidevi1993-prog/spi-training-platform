-- ===================================================================
-- 0023 — ENROLLMENT HARDENING (Phase 7 P3.8, database only)
--
-- G1  Enrolments change only through the database functions:
--       revoke INSERT / UPDATE / DELETE on public.batch_students from
--       authenticated (and public). Table privileges are checked against
--       current_user: inside the SECURITY DEFINER functions that is their
--       owner (admin_set_enrollment, trainer_enroll_student,
--       accept_user_invitation and the enrolment triggers keep working);
--       a direct PostgREST write runs as authenticated and is refused
--       (42501) — for every client role, Super Admin included. SELECT,
--       RLS policies, service_role and privileged writers (SQL Editor,
--       migrations, seed — still recorded as 'direct') are unchanged.
--
-- G2  Only an available student may be enrolled or re-enrolled:
--       students.status = 'active', profiles.role = 'student',
--       profiles.account_status = 'active'; otherwise
--       { ok: false, reason: 'student_not_available' }. Checked inside
--       admin_set_enrollment() (only for 'enrolled'; withdraw / complete
--       stay possible) and trainer_enroll_student() (after the existing
--       42501 scope checks), with FOR SHARE locks on the student and
--       profile rows. Each is the exact 0017 body with only that check
--       added; signatures, SECURITY DEFINER, search_path, owner and grants
--       are kept (create or replace).
--
-- Unchanged: tables, columns, enums, triggers, RLS policies, every other
-- function (incl. accept_user_invitation, admin_assign_batch_trainer,
-- batches_trainer_guard / _insert_audit, admin_update_trainer), all
-- existing rows. Existing enrolments of unavailable students are only
-- reported (NOTICE) and left as they are. Requires 0022.
-- ===================================================================

begin;

do $$
declare
  v_account_not_active integer;
  v_record_or_role     integer;
  v_direct             integer;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'trainer_details' and column_name = 'organization') then
    raise exception 'Preflight failed: 0022 must be applied first.';
  end if;
  if not has_table_privilege('authenticated', 'public.batch_students', 'INSERT')
     or position('student_not_available' in pg_get_functiondef('public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure)) > 0 then
    raise exception 'Preflight failed: 0023 already applied?';
  end if;
  -- Read-only report: current enrolments whose student is no longer available (left as they are).
  select count(*) filter (where coalesce(s.status = 'active', false) and coalesce(p.role = 'student', false)
                            and p.account_status in ('suspended', 'invited')),
         count(*) filter (where not (coalesce(s.status = 'active', false) and coalesce(p.role = 'student', false)))
    into v_account_not_active, v_record_or_role
    from public.batch_students bs
    left join public.students s on s.id = bs.student_id
    left join public.profiles p on p.id = bs.student_id
   where bs.enrollment_status = 'enrolled'
     and not (coalesce(s.status = 'active', false) and coalesce(p.role = 'student', false)
              and coalesce(p.account_status = 'active', false));
  select count(*) into v_direct from public.enrollment_events where source = 'direct';
  if v_account_not_active > 0 then
    raise notice '0023: % current enrolment(s) belong to a suspended/invited account (kept; suspension keeps enrolments).', v_account_not_active;
  end if;
  if v_record_or_role > 0 then
    raise notice '0023: % current enrolment(s) belong to an inactive student record or a non-student profile (kept; can be withdrawn with admin_set_enrollment()).', v_record_or_role;
  end if;
  if v_direct > 0 then
    raise notice '0023: % enrolment history row(s) were written directly (source direct); new client direct writes are refused from now on.', v_direct;
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. G1 — no direct client writes to batch_students (SELECT unchanged)
-- -------------------------------------------------------------------
revoke insert, update, delete on table public.batch_students from public, authenticated;

-- -------------------------------------------------------------------
-- 2. G2 — admin_set_enrollment(): the 0017 body; availability checked
--    only when enrolling / re-enrolling (withdraw / complete unchanged)
-- -------------------------------------------------------------------
create or replace function public.admin_set_enrollment(
  p_batch_id   uuid,
  p_student_id uuid,
  p_status     public.enrollment_status,
  p_reason     text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.user_mgmt_require_super_admin();
  v_bstatus public.batch_status;
  v_seats   integer;
  v_taken   integer;
  v_current public.enrollment_status;
begin
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'The reason is too long (at most 500 characters).' using errcode = '22023';
  end if;
  select b.status, b.max_seats into v_bstatus, v_seats from public.batches b where b.id = p_batch_id for update;
  if not found or not exists (select 1 from public.students s where s.id = p_student_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_bstatus = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'batch_cancelled');
  end if;
  select bs.enrollment_status into v_current from public.batch_students bs
   where bs.batch_id = p_batch_id and bs.student_id = p_student_id for update;

  if v_current is not distinct from p_status then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  if not ((v_current is null and p_status = 'enrolled')
          or (v_current = 'enrolled' and p_status in ('withdrawn', 'completed'))
          or (v_current = 'withdrawn' and p_status = 'enrolled')) then
    return jsonb_build_object('ok', false, 'reason', 'transition_not_allowed');
  end if;
  if p_status = 'enrolled' then
    -- 0023: only an available student may be enrolled or re-enrolled.
    if not exists (select 1 from public.students s join public.profiles p on p.id = s.id
                    where s.id = p_student_id and s.status = 'active'
                      and p.role = 'student' and p.account_status = 'active'
                    for share of s, p) then
      return jsonb_build_object('ok', false, 'reason', 'student_not_available');
    end if;
    if v_bstatus not in ('upcoming', 'ongoing') then
      return jsonb_build_object('ok', false, 'reason', 'batch_not_current');
    end if;
    select count(*) into v_taken from public.batch_students bs
     where bs.batch_id = p_batch_id and bs.enrollment_status <> 'withdrawn' and bs.student_id <> p_student_id;
    if v_taken >= v_seats then
      return jsonb_build_object('ok', false, 'reason', 'batch_full');
    end if;
  end if;

  perform set_config('app.enrollment_source', 'admin', true);
  perform set_config('app.enrollment_reason', coalesce(nullif(btrim(p_reason), ''), ''), true);
  if v_current is null then
    insert into public.batch_students (batch_id, student_id, enrolled_by) values (p_batch_id, p_student_id, v_uid);
  else
    update public.batch_students
       set enrollment_status = p_status,
           completed_at = case when p_status = 'completed' then now() else completed_at end
     where batch_id = p_batch_id and student_id = p_student_id;
  end if;
  perform set_config('app.enrollment_source', '', true);
  perform set_config('app.enrollment_reason', '', true);

  perform public.user_mgmt_log('enrollment_changed', p_student_id, null, p_batch_id,
    jsonb_build_object('from', v_current, 'to', p_status));
  return jsonb_build_object('ok', true, 'previous', v_current, 'status', p_status);
end;
$$;

-- -------------------------------------------------------------------
-- 3. G2 — trainer_enroll_student(): the 0017 body; availability checked
--    after the existing 42501 caller / scope checks and the batch lock
-- -------------------------------------------------------------------
create or replace function public.trainer_enroll_student(p_batch_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_seats   integer;
  v_taken   integer;
  v_current public.enrollment_status;
begin
  if v_uid is null or public.current_app_role() is distinct from 'trainer' then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  if not public.is_current_batch_trainer(p_batch_id) or not public.user_mgmt_trainer_student_in_scope(p_student_id) then
    raise exception 'You can only enrol your current students into batches you currently teach.' using errcode = '42501';
  end if;
  select b.max_seats into v_seats from public.batches b where b.id = p_batch_id for update;
  -- 0023: only an available student may be enrolled or re-enrolled.
  if not exists (select 1 from public.students s join public.profiles p on p.id = s.id
                  where s.id = p_student_id and s.status = 'active'
                    and p.role = 'student' and p.account_status = 'active'
                  for share of s, p) then
    return jsonb_build_object('ok', false, 'reason', 'student_not_available');
  end if;
  select bs.enrollment_status into v_current from public.batch_students bs
   where bs.batch_id = p_batch_id and bs.student_id = p_student_id for update;
  if v_current = 'enrolled' then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  if v_current is not null then
    return jsonb_build_object('ok', false, 'reason', 'transition_not_allowed');
  end if;
  select count(*) into v_taken from public.batch_students bs where bs.batch_id = p_batch_id and bs.enrollment_status <> 'withdrawn';
  if v_taken >= v_seats then
    return jsonb_build_object('ok', false, 'reason', 'batch_full');
  end if;
  perform set_config('app.enrollment_source', 'trainer', true);
  insert into public.batch_students (batch_id, student_id, enrolled_by) values (p_batch_id, p_student_id, v_uid);
  perform set_config('app.enrollment_source', '', true);
  perform public.user_mgmt_log('enrollment_changed', p_student_id, null, p_batch_id,
    jsonb_build_object('from', null, 'to', 'enrolled'));
  return jsonb_build_object('ok', true, 'status', 'enrolled');
end;
$$;

comment on function public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text) is
  '0023: Super Admin enrolment changes; enrolling / re-enrolling requires an available student (student_not_available).';
comment on function public.trainer_enroll_student(uuid, uuid) is
  '0023: trainer enrolment of an in-scope student into a current batch; requires an available student (student_not_available).';

commit;
