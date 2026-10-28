-- ===================================================================
-- 0029a — INVITATION BINDING AND RECOVERY (P5.2)
--
-- Runs on the live schema (0001–0029) and does not depend on course
-- management (0030). 0030, applied later, keeps this rule: its preflight
-- requires the 0029a version of accept_user_invitation and its section 7
-- body carries the same lines.
--
-- 1. accept_user_invitation() — acceptance only by the bound Auth account.
--    Until now a pending invitation could be accepted by ANY signed-in
--    account whose Auth e-mail matched it while it was still UNBOUND
--    (auth_user_id is null) — any role, super_admin included. Now:
--      bound to another account         → 'not_pending' (unchanged result)
--      expired                          → 'expired' (marked expired only when
--                                         the caller is the bound account; an
--                                         unbound caller never changes anything)
--      not bound to any account         → 'resend_required' (nothing changes)
--      bound to the caller              → the 0022 body, unchanged.
--    Binding happens only (a) by record_invitation_delivery (0019, service
--    role) when Supabase Auth sent the invitation e-mail to that account, or
--    (b) by complete_invitation_recovery below.
--
-- 2. Recovery for an already-registered, never-activated invited account.
--    When Auth refuses to (re)send an invitation because the address is
--    already registered (the invitee confirmed an earlier link but never
--    activated), the invitation stays unbound and could never be accepted.
--      begin_invitation_recovery(id)  Super Admin only (own session): the
--        invitation is pending, unexpired and unbound; exactly one Auth
--        account has its address and it is a never-activated placeholder
--        (user_mgmt_recoverable_placeholder); the resend cooldown (60 s) and
--        cap (5) are shared. Records who asked and for which account (NOT a
--        binding) and audits 'invitation_recovery_requested'. Returns the
--        database-owned address; the application then sends a passwordless
--        sign-in e-mail to it (never with the service role).
--      complete_invitation_recovery()  the invitee's own session, right after
--        the sign-in link was verified: the account is the one recorded, the
--        request is < 24 h old, the invitation is still pending and
--        unexpired, the account is still eligible, and the session carries a
--        fresh e-mail one-time-code sign-in (JWT amr 'otp'/'magiclink', < 15
--        min). Binds the invitation and audits 'invitation_recovered'.
--        Idempotent for the bound account. The exact amr values Supabase
--        issues must be confirmed on staging before relying on this check.
--      invitation_recovery_candidate(user)  Super Admin read: the pending,
--        unexpired, unbound invitation a placeholder account could recover.
--    No Auth account is ever created, deleted or changed here.
--
-- UNCHANGED: every other function, policy and trigger; accept's signature,
-- return shape, SECURITY DEFINER, search_path '' and grants. Data: no row
-- is modified (three nullable columns are added). Pending unbound
-- invitations need a successful resend — or this recovery — to be accepted.
--
-- Preflight: refuses unless 0029 is applied, accept_user_invitation is
-- exactly the 0022 definition, and 0029a is not already applied.
-- Postflight: verifies the new rule, functions, grants and columns.
-- ROLLBACK (manual, only before 0030): supabase/rollback/0029a_rollback.sql.
-- ===================================================================

begin;

do $$
begin
  if position('v_role is distinct from ''super_admin''' in
       coalesce((select p.prosrc from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.revoke_user_invitation(uuid, text)')), '')) = 0 then
    raise exception 'Preflight failed: 0029 is not applied (revoke_user_invitation still admits trainers).';
  end if;
  if to_regprocedure('public.begin_invitation_recovery(uuid)') is not null
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'user_invitations' and column_name = 'recovery_user_id') then
    raise exception 'Preflight failed: 0029a is already applied.';
  end if;
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.accept_user_invitation()')) is distinct from '073654ed182b8762f4a902106ab554cd' then
    raise exception 'Preflight failed: public.accept_user_invitation() differs from the 0022 definition (is 0030 applied?).';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Audit event types and recovery bookkeeping
-- -------------------------------------------------------------------
-- IF NOT EXISTS: enum values survive a rollback (PostgreSQL cannot drop them), so a re-apply must not fail on them.
alter type public.user_admin_event_type add value if not exists 'invitation_recovery_requested';
alter type public.user_admin_event_type add value if not exists 'invitation_recovered';

alter table public.user_invitations
  add column recovery_user_id      uuid        null references auth.users (id) on delete set null,
  add column recovery_requested_at timestamptz null,
  add column recovery_requested_by uuid        null references public.profiles (id) on delete restrict,
  add constraint user_invitations_recovery_ok check ((recovery_requested_at is null) = (recovery_requested_by is null));

-- -------------------------------------------------------------------
-- 2. Eligibility: a never-activated placeholder for this address
-- -------------------------------------------------------------------
-- Like 0019's user_mgmt_reinvitable_placeholder, but for the address's
-- CURRENT pending invitation (which it does not exclude).
create function public.user_mgmt_recoverable_placeholder(p_user_id uuid, p_email text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
        exists (select 1 from public.profiles p where p.id = p_user_id and p.account_status = 'invited')
    and exists (select 1 from auth.users u where u.id = p_user_id and lower(btrim(u.email)) = p_email)
    -- never activated, suspended, re-roled or accepted
    and not exists (select 1 from public.user_admin_events e
                     where e.target_user_id = p_user_id
                       and e.event_type in ('account_status_changed', 'role_changed', 'invitation_accepted'))
    -- no training identity
    and not exists (select 1 from public.students s where s.id = p_user_id)
    and not exists (select 1 from public.trainers r where r.id = p_user_id)
    -- no accepted invitation for this account or address
    and not exists (select 1 from public.user_invitations i
                     where i.status = 'accepted' and (i.accepted_user_id = p_user_id or i.email_normalized = p_email))
    -- no invitation for the address bound to a different Auth account
    and not exists (select 1 from public.user_invitations i
                     where i.email_normalized = p_email and i.auth_user_id is not null and i.auth_user_id <> p_user_id),
    false);
$$;

-- -------------------------------------------------------------------
-- 3. accept_user_invitation — the 0022 body; only the bound account accepts
-- -------------------------------------------------------------------
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
  -- 0029a: the address's pending invitation (at most one — 0017 unique index), whatever its binding; then the binding decides.
  select * into i from public.user_invitations
   where email_normalized = v_email and status = 'pending'
   order by created_at desc limit 1 for update;
  if v_email is null or not found or (i.auth_user_id is not null and i.auth_user_id <> v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if i.expires_at <= now() then
    -- 0029a: only the bound account's call marks it expired; an unbound caller never changes an invitation.
    if i.auth_user_id = v_uid then
      update public.user_invitations set status = 'expired' where id = i.id;
      perform public.user_mgmt_log('invitation_expired', null, i.id, i.batch_id, '{}'::jsonb);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  -- 0029a: never accepted by e-mail match alone — only by the Auth account the invitation e-mail was sent to
  -- (bound by record_invitation_delivery, or by complete_invitation_recovery after a fresh mailbox check).
  if i.auth_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'resend_required');
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

-- -------------------------------------------------------------------
-- 4. Recovery (Super Admin request → invitee completes after a mailbox check)
-- -------------------------------------------------------------------
create function public.begin_invitation_recovery(p_invitation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_role     text := public.current_app_role();
  i          public.user_invitations%rowtype;
  v_accounts uuid[];
  v_account  uuid;
  v_resend   boolean;
  v_count    integer;
begin
  if v_uid is null or v_role is distinct from 'super_admin' then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  select * into i from public.user_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if i.status = 'pending' and i.expires_at <= now() then
    update public.user_invitations set status = 'expired' where id = i.id;
    perform public.user_mgmt_log('invitation_expired', null, i.id, i.batch_id, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if i.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', i.status);
  end if;
  if i.auth_user_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_bound');
  end if;
  -- Exactly one Auth account has the address, and it is a never-activated placeholder.
  select coalesce(array_agg(u.id), '{}') into v_accounts from auth.users u where lower(btrim(u.email)) = i.email_normalized;
  if cardinality(v_accounts) <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'not_recoverable');
  end if;
  v_account := v_accounts[1];
  if not public.user_mgmt_recoverable_placeholder(v_account, i.email_normalized) then
    return jsonb_build_object('ok', false, 'reason', 'not_recoverable');
  end if;
  -- The resend cooldown and cap (0019/0028) are shared with recovery e-mails.
  v_resend := i.last_sent_at is not null;
  if v_resend and i.resend_count >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'resend_limit');
  end if;
  if v_resend and i.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (i.last_sent_at + interval '60 seconds' - now())))::integer));
  end if;
  v_count := i.resend_count + case when v_resend then 1 else 0 end;
  -- A request, not a binding: only the account's own fresh sign-in completes it.
  update public.user_invitations
     set last_sent_at = now(), resend_count = v_count,
         recovery_user_id = v_account, recovery_requested_at = now(), recovery_requested_by = v_uid
   where id = i.id;
  perform public.user_mgmt_log('invitation_recovery_requested', v_account, i.id, i.batch_id, jsonb_build_object('resend_count', v_count));
  return jsonb_build_object('ok', true, 'invitation_id', i.id, 'email', i.email, 'expires_at', i.expires_at, 'resend_count', v_count);
end;
$$;

create function public.complete_invitation_recovery()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_claims jsonb;
  v_fresh  boolean := false;
  i        public.user_invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'You need to be signed in.' using errcode = '42501';
  end if;
  perform 1 from public.profiles p where p.id = v_uid and p.account_status = 'invited' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = v_uid;
  select * into i from public.user_invitations
   where email_normalized = v_email and status = 'pending'
   order by created_at desc limit 1 for update;
  if v_email is null or not found then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  -- Already bound: to this account (a replay — nothing changes) or to another one.
  if i.auth_user_id is not null then
    if i.auth_user_id = v_uid then
      return jsonb_build_object('ok', true, 'bound', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  -- A Super Admin asked for THIS account.
  if i.recovery_user_id is distinct from v_uid or i.recovery_requested_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_requested');
  end if;
  if i.expires_at <= now() then
    update public.user_invitations set status = 'expired' where id = i.id;
    perform public.user_mgmt_log('invitation_expired', null, i.id, i.batch_id, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if i.recovery_requested_at <= now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'recovery_window_passed');
  end if;
  -- Mailbox control proven now: this session comes from an e-mail one-time-code sign-in < 15 min ago.
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if jsonb_typeof(v_claims -> 'amr') = 'array' then
    select exists (
      select 1 from jsonb_array_elements(v_claims -> 'amr') a
       where jsonb_typeof(a) = 'object'
         and a ->> 'method' in ('otp', 'magiclink')
         and coalesce(a ->> 'timestamp', '') ~ '^[0-9]{1,12}$'
         and to_timestamp((a ->> 'timestamp')::bigint) > now() - interval '15 minutes'
         and to_timestamp((a ->> 'timestamp')::bigint) <= now() + interval '1 minute') into v_fresh;
  end if;
  if not v_fresh then
    return jsonb_build_object('ok', false, 'reason', 'stale_sign_in');
  end if;
  if not public.user_mgmt_recoverable_placeholder(v_uid, v_email) then
    return jsonb_build_object('ok', false, 'reason', 'not_recoverable');
  end if;
  update public.user_invitations set auth_user_id = v_uid where id = i.id;
  perform public.user_mgmt_log('invitation_recovered', v_uid, i.id, i.batch_id,
    jsonb_build_object('requested_by', i.recovery_requested_by));
  return jsonb_build_object('ok', true, 'bound', true);
end;
$$;

create function public.invitation_recovery_candidate(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  i       record;
begin
  if auth.uid() is null or public.current_app_role() is distinct from 'super_admin' then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_user_id;
  if v_email is null then
    return jsonb_build_object('ok', false);
  end if;
  select ui.id, ui.expires_at, ui.last_sent_at, ui.resend_count, ui.recovery_requested_at into i
    from public.user_invitations ui
   where ui.email_normalized = v_email and ui.status = 'pending' and ui.auth_user_id is null and ui.expires_at > now()
   order by ui.created_at desc limit 1;
  if not found
     or (select count(*) from auth.users u where lower(btrim(u.email)) = v_email) <> 1
     or not public.user_mgmt_recoverable_placeholder(p_user_id, v_email) then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'invitation_id', i.id, 'expires_at', i.expires_at, 'last_sent_at', i.last_sent_at,
                            'resend_count', i.resend_count, 'recovery_requested_at', i.recovery_requested_at);
end;
$$;

-- -------------------------------------------------------------------
-- 5. Privileges
-- -------------------------------------------------------------------
revoke all on function public.user_mgmt_recoverable_placeholder(uuid, text) from public, anon, authenticated;
revoke all on function public.begin_invitation_recovery(uuid)              from public, anon;
revoke all on function public.complete_invitation_recovery()               from public, anon;
revoke all on function public.invitation_recovery_candidate(uuid)          from public, anon;
grant execute on function public.begin_invitation_recovery(uuid)           to authenticated;
grant execute on function public.complete_invitation_recovery()            to authenticated;
grant execute on function public.invitation_recovery_candidate(uuid)       to authenticated;

-- Postflight
do $$
declare
  f text;
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = to_regprocedure('public.accept_user_invitation()')
       and position('0029a: never accepted by e-mail match alone' in p.prosrc) > 0
       and position('auth_user_id is null or auth_user_id = v_uid' in p.prosrc) = 0
       and position('0022: the invitation''s organization and designation are copied too' in p.prosrc) > 0) then
    raise exception 'Postflight failed: accept_user_invitation() does not have the 0029a rule.';
  end if;
  foreach f in array array['public.accept_user_invitation()', 'public.begin_invitation_recovery(uuid)',
                           'public.complete_invitation_recovery()', 'public.invitation_recovery_candidate(uuid)'] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = to_regprocedure(f) and p.prosecdef and p.proconfig = array['search_path=""']
         and has_function_privilege('authenticated', p.oid, 'execute')
         and not has_function_privilege('anon', p.oid, 'execute')) then
      raise exception 'Postflight failed: % does not have the expected attributes and grants.', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', to_regprocedure('public.user_mgmt_recoverable_placeholder(uuid, text)'), 'execute') then
    raise exception 'Postflight failed: user_mgmt_recoverable_placeholder must not be client-callable.';
  end if;
  if (select count(*) from pg_catalog.pg_enum e where e.enumtypid = 'public.user_admin_event_type'::regtype
        and e.enumlabel in ('invitation_recovery_requested', 'invitation_recovered')) <> 2 then
    raise exception 'Postflight failed: the recovery audit event types are missing.';
  end if;
end
$$;

commit;
