-- ===================================================================
-- ROLLBACK for 0029a — restore the 0022 accept_user_invitation() and
-- remove the invitation-recovery functions and columns (P5.2)
--
-- NOT a migration (kept outside supabase/migrations so no tool applies it
-- automatically). Run manually in the SQL Editor of the SAME project, after
-- a fresh, verified backup (docs/runbooks/live-migration-0029a.md), and only
-- while 0030 is NOT applied (0030 requires 0029a; refused otherwise).
--
-- Effect: acceptance again allows UNBOUND pending invitations (the
-- weakness 0029a closes) and pending recovery requests are discarded
-- (the three recovery columns are dropped). Invitations accepted or bound
-- while 0029a was active stay as they are; audit rows stay. The two audit
-- event types added by 0029a remain in the enum (PostgreSQL cannot drop
-- enum values); nothing uses them after the rollback.
--
-- Preflight: refuses unless 0030 is absent and accept_user_invitation is
-- exactly the 0029a definition (md5 96dd1023a79442f8db66e2e5ef5510f1,
-- whitespace-insensitive). Nothing is changed when it refuses.
-- Postflight: verifies the 0022 definition (md5 073654ed182b8762f4a902106ab554cd),
-- its attributes and grants, and that the recovery objects are gone.
-- ===================================================================

begin;

do $pre$
begin
  if to_regprocedure('public.course_mgmt_enrolment_closed(uuid)') is not null then
    raise exception 'Rollback preflight failed: 0030 is applied and requires 0029a. Restore from the backup instead. Nothing was changed.';
  end if;
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.accept_user_invitation()')) is distinct from '96dd1023a79442f8db66e2e5ef5510f1' then
    raise exception 'Rollback preflight failed: public.accept_user_invitation() is not the 0029a definition. Nothing was changed.';
  end if;
end
$pre$;

drop function public.invitation_recovery_candidate(uuid);
drop function public.complete_invitation_recovery();
drop function public.begin_invitation_recovery(uuid);

-- The 0022 definition, verbatim.
create or replace function public.accept_user_invitation()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_status   public.account_status;
  v_email    text;
  i          public.user_invitations%rowtype;
  v_bstatus  public.batch_status;
  v_seats    integer;
  v_taken    integer;
  v_enrolled boolean := false;
begin
  if v_uid is null then
    raise exception 'You need to be signed in.' using errcode = '42501';
  end if;
  select p.account_status into v_status from public.profiles p where p.id = v_uid for update;
  if not found or v_status <> 'invited' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = v_uid;
  select * into i from public.user_invitations
   where email_normalized = v_email and status = 'pending' and (auth_user_id is null or auth_user_id = v_uid)
   order by created_at desc limit 1 for update;
  if v_email is null or not found then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if i.expires_at <= now() then
    update public.user_invitations set status = 'expired' where id = i.id;
    perform public.user_mgmt_log('invitation_expired', null, i.id, i.batch_id, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if (i.student_code is not null and exists (select 1 from public.students s where lower(s.student_code) = lower(i.student_code)))
     or (i.trainer_code is not null and exists (select 1 from public.trainers t where lower(t.trainer_code) = lower(i.trainer_code))) then
    return jsonb_build_object('ok', false, 'reason', 'code_in_use');
  end if;

  update public.profiles set role = i.intended_role, account_status = 'active' where id = v_uid;

  if i.intended_role = 'student' then
    insert into public.students (id, student_code, full_name) values (v_uid, i.student_code, i.full_name);
    insert into public.student_details (student_id, email, phone, organization, designation)
    values (v_uid, i.email, i.phone, i.organization, i.designation);
    if i.batch_id is not null then
      select b.status, b.max_seats into v_bstatus, v_seats from public.batches b where b.id = i.batch_id for update;
      select count(*) into v_taken from public.batch_students bs where bs.batch_id = i.batch_id and bs.enrollment_status <> 'withdrawn';
      if v_bstatus in ('upcoming', 'ongoing') and v_taken < v_seats then
        perform set_config('app.enrollment_source', 'invitation', true);
        perform set_config('app.enrollment_reason', 'Accepted invitation', true);
        insert into public.batch_students (batch_id, student_id, enrolled_by) values (i.batch_id, v_uid, i.invited_by);
        perform set_config('app.enrollment_source', '', true);
        perform set_config('app.enrollment_reason', '', true);
        v_enrolled := true;
      end if;
    end if;
  elsif i.intended_role = 'trainer' then
    insert into public.trainers (id, trainer_code, full_name) values (v_uid, i.trainer_code, i.full_name);
    -- 0022: the invitation's organization and designation are copied too (null when not given).
    insert into public.trainer_details (trainer_id, email, phone, organization, designation, specializations)
    values (v_uid, i.email, i.phone, i.organization, i.designation, i.specializations);
  end if;

  update public.user_invitations
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_uid, auth_user_id = v_uid
   where id = i.id;
  perform public.user_mgmt_log('invitation_accepted', v_uid, i.id, i.batch_id,
    jsonb_build_object('role', i.intended_role, 'enrolled', v_enrolled));
  return jsonb_build_object('ok', true, 'role', i.intended_role, 'enrolled', v_enrolled);
end;
$$;

drop function public.user_mgmt_recoverable_placeholder(uuid, text);

alter table public.user_invitations
  drop constraint user_invitations_recovery_ok,
  drop column recovery_requested_by,
  drop column recovery_requested_at,
  drop column recovery_user_id;

do $post$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = to_regprocedure('public.accept_user_invitation()')
       and md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) = '073654ed182b8762f4a902106ab554cd'
       and p.prosecdef
       and p.proconfig = array['search_path=""']
       and has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception 'Rollback postflight failed: accept_user_invitation() is not the 0022 definition.';
  end if;
  if to_regprocedure('public.begin_invitation_recovery(uuid)') is not null
     or to_regprocedure('public.user_mgmt_recoverable_placeholder(uuid, text)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'user_invitations' and column_name like 'recovery\_%') then
    raise exception 'Rollback postflight failed: recovery objects are still present.';
  end if;
end
$post$;

commit;
