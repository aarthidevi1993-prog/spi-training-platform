-- ===================================================================
-- 0019 — INVITATION DELIVERY FOUNDATION (Phase 7 P3.4, database layer)
--
-- Database authority for SENDING invitations. The application sends the
-- email through a narrow server-only Auth Admin module; this migration
-- decides whether a send may happen and records what happened:
--
--   begin_invitation_delivery(invitation)                caller's session
--     Super Admin (any) / trainer (own invitation, batch they currently
--     teach). Pending + unexpired only (expired → marked expired). Locks
--     the row; 60-second cooldown; at most 5 resends; never extends
--     expires_at. Returns ONLY database-owned values (email, expiry) —
--     no email is ever accepted from the caller. Logs invitation_resent
--     for a resend. last_sent_at = time of the last AUTHORIZED attempt.
--
--   record_invitation_delivery(invitation, sent, auth user)   service_role ONLY
--     Still pending; an attempt was authorized; the Auth user's email
--     equals the invitation's; auth_user_id bound only when null or the
--     same; the account must still be INVITED. Records delivery_status
--     sent / failed. Never activates, never changes role or status.
--
--   D1 — create_user_invitation (replaced; one line changed): an email
--   that already has an Auth account may be invited again only when that
--   account is an unaccepted placeholder (user_mgmt_reinvitable_placeholder):
--   invited profile, never changed status / role, never accepted, no
--   student/trainer record, no accepted invitation, at least one earlier
--   invitation for the address that is revoked or expired, none pending,
--   and no earlier invitation bound to a different Auth account.
--
-- Unchanged: every 0001–0018 object other than create_user_invitation
-- (same signature, SECURITY DEFINER, search_path, owner and grants), all
-- tables, policies, grants, enums, triggers and the 0018 activation
-- guard. No audit enum values added. Requires 0017 and 0018.
-- ===================================================================

begin;

do $$
begin
  if to_regprocedure('public.create_user_invitation(jsonb)') is null
     or to_regclass('public.user_invitations') is null
     or to_regprocedure('public.user_mgmt_log(public.user_admin_event_type, uuid, uuid, uuid, jsonb)') is null
     or coalesce(obj_description('public.admin_set_account_status(uuid, public.account_status, text)'::regprocedure, 'pg_proc'), '') not like '0018:%' then
    raise exception 'Preflight failed: 0017 and 0018 must be applied first.';
  end if;
  if to_regprocedure('public.begin_invitation_delivery(uuid)') is not null
     or to_regprocedure('public.record_invitation_delivery(uuid, boolean, uuid)') is not null
     or to_regprocedure('public.user_mgmt_reinvitable_placeholder(uuid, text)') is not null then
    raise exception 'Preflight failed: 0019 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. D1 — unaccepted invitation placeholder (internal helper)
-- -------------------------------------------------------------------
-- True only when the Auth account p_user_id (whose email is p_email) is a
-- placeholder left by an earlier invitation that never became an account.
create function public.user_mgmt_reinvitable_placeholder(p_user_id uuid, p_email text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
        exists (select 1 from public.profiles p where p.id = p_user_id and p.account_status = 'invited')
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
    -- nothing still pending for the address
    and not exists (select 1 from public.user_invitations i
                     where i.email_normalized = p_email and i.status = 'pending' and i.expires_at > now())
    -- no earlier invitation bound to a different Auth account
    and not exists (select 1 from public.user_invitations i
                     where i.email_normalized = p_email and i.auth_user_id is not null and i.auth_user_id <> p_user_id)
    -- an earlier invitation for the address exists and is no longer pending
    and exists (select 1 from public.user_invitations i
                 where i.email_normalized = p_email
                   and (i.status in ('revoked', 'expired') or (i.status = 'pending' and i.expires_at <= now()))),
    false);
$$;

revoke all on function public.user_mgmt_reinvitable_placeholder(uuid, text) from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 2. create_user_invitation — the 0017 body; only the address check changes (D1)
-- -------------------------------------------------------------------
create or replace function public.create_user_invitation(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_role      text := public.current_app_role();
  v_is_admin  boolean := v_role = 'super_admin';
  v_email     text;
  v_norm      text;
  v_target    public.app_role;
  v_name      text;
  v_scode     text;
  v_tcode     text;
  v_batch     uuid;
  v_days      integer;
  v_specs     text[] := '{}';
  v_bstatus   public.batch_status;
  v_account   boolean;
  v_pending   boolean;
  v_id        uuid;
begin
  if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  perform public.user_mgmt_check_keys(p, array['email', 'role', 'full_name', 'student_code', 'trainer_code', 'phone',
    'organization', 'designation', 'specializations', 'batch_id', 'expires_in_days']);

  if (p ->> 'role') is null or (p ->> 'role') not in ('super_admin', 'trainer', 'student') then
    raise exception 'Choose a valid role.' using errcode = '22023';
  end if;
  v_target := (p ->> 'role')::public.app_role;
  if not v_is_admin and v_target <> 'student' then
    raise exception 'Trainers can only invite students.' using errcode = '42501';
  end if;

  v_email := public.user_mgmt_text(p, 'email', 254);
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  v_norm  := lower(v_email);
  v_name  := public.user_mgmt_text(p, 'full_name', 200);
  if v_name is null then
    raise exception 'A full name is required.' using errcode = '22023';
  end if;
  v_scode := public.user_mgmt_text(p, 'student_code', 40);
  v_tcode := public.user_mgmt_text(p, 'trainer_code', 40);
  if jsonb_typeof(p -> 'specializations') = 'array' then
    select coalesce(array_agg(btrim(x)), '{}') into v_specs
      from jsonb_array_elements_text(p -> 'specializations') x where btrim(x) <> '';
  end if;
  v_days  := coalesce((p ->> 'expires_in_days')::integer, 7);
  if v_days not between 1 and 30 then
    raise exception 'An invitation lasts between 1 and 30 days.' using errcode = '22023';
  end if;
  if (p ->> 'batch_id') is not null then
    v_batch := (p ->> 'batch_id')::uuid;
  end if;

  -- Role-specific fields.
  if v_target = 'student' then
    if v_scode is null then
      raise exception 'A student code is required.' using errcode = '22023';
    end if;
    v_tcode := null;
  elsif v_target = 'trainer' then
    if v_tcode is null then
      raise exception 'A trainer code is required.' using errcode = '22023';
    end if;
    if v_batch is not null then
      raise exception 'Only students are invited into a batch.' using errcode = '22023';
    end if;
    v_scode := null;
  else
    if v_batch is not null or v_scode is not null or v_tcode is not null then
      raise exception 'A Super Admin invitation has no batch or code.' using errcode = '22023';
    end if;
  end if;

  -- Batch scope.
  if not v_is_admin and v_batch is null then
    raise exception 'Choose one of your current batches.' using errcode = '22023';
  end if;
  if v_batch is not null then
    if not v_is_admin and not public.is_current_batch_trainer(v_batch) then
      raise exception 'You can only invite students into batches you currently teach.' using errcode = '42501';
    end if;
    select b.status into v_bstatus from public.batches b where b.id = v_batch;
    if not found or v_bstatus not in ('upcoming', 'ongoing') then
      return jsonb_build_object('ok', false, 'reason', 'batch_not_current');
    end if;
  end if;

  -- Trainer rate limit.
  if not v_is_admin and (
    select count(*) from public.user_admin_events e
     where e.actor_id = v_uid and e.event_type in ('invitation_created', 'invitation_withheld')
       and e.occurred_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  -- Address availability.
  -- 0019 (D1): an unaccepted invitation placeholder may be invited again; every other account still blocks.
  v_account := exists (select 1 from auth.users u
                        where lower(btrim(u.email)) = v_norm
                          and not public.user_mgmt_reinvitable_placeholder(u.id, v_norm));
  v_pending := exists (select 1 from public.user_invitations i where i.email_normalized = v_norm and i.status = 'pending'
                                                                and i.expires_at > now());
  if v_account or v_pending then
    if not v_is_admin then
      perform public.user_mgmt_log('invitation_withheld', null, null, v_batch, jsonb_build_object('role', v_target));
      return jsonb_build_object('ok', false, 'reason', 'email_unavailable');
    end if;
    return jsonb_build_object('ok', false, 'reason', case when v_account then 'account_exists' else 'already_invited' end);
  end if;
  -- An expired-but-still-pending invitation for this address is expired now.
  update public.user_invitations i set status = 'expired'
   where i.email_normalized = v_norm and i.status = 'pending' and i.expires_at <= now();

  -- Codes must be free (domain records and other pending invitations).
  if v_scode is not null and (exists (select 1 from public.students s where lower(s.student_code) = lower(v_scode))
       or exists (select 1 from public.user_invitations i where i.status = 'pending' and lower(i.student_code) = lower(v_scode))) then
    return jsonb_build_object('ok', false, 'reason', 'code_in_use');
  end if;
  if v_tcode is not null and (exists (select 1 from public.trainers t where lower(t.trainer_code) = lower(v_tcode))
       or exists (select 1 from public.user_invitations i where i.status = 'pending' and lower(i.trainer_code) = lower(v_tcode))) then
    return jsonb_build_object('ok', false, 'reason', 'code_in_use');
  end if;

  insert into public.user_invitations (email, intended_role, full_name, student_code, trainer_code, phone, organization,
                                       designation, specializations, batch_id, invited_by, expires_at)
  values (v_email, v_target, v_name, v_scode, v_tcode, public.user_mgmt_text(p, 'phone', 40),
          public.user_mgmt_text(p, 'organization', 200), public.user_mgmt_text(p, 'designation', 200),
          v_specs, v_batch, v_uid, now() + make_interval(days => v_days))
  returning id into v_id;

  perform public.user_mgmt_log('invitation_created', null, v_id, v_batch, jsonb_build_object('role', v_target));
  return jsonb_build_object('ok', true, 'invitation_id', v_id);
end;
$$;

-- -------------------------------------------------------------------
-- 3. Authorize one delivery attempt (caller's own session)
-- -------------------------------------------------------------------
-- Returns { ok: true, invitation_id, email, expires_at, attempt: initial|resend, resend_count }
-- or { ok: false, reason: not_found | expired | not_pending | resend_limit | cooldown }.
create function public.begin_invitation_delivery(p_invitation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text := public.current_app_role();
  i         public.user_invitations%rowtype;
  v_resend  boolean;
  v_count   integer;
begin
  if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  -- The row lock serialises concurrent attempts on the same invitation.
  select * into i from public.user_invitations where id = p_invitation_id for update;
  if not found or (v_role = 'trainer' and (i.invited_by <> v_uid or i.batch_id is null
                                           or not public.is_current_batch_trainer(i.batch_id))) then
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
  v_resend := i.last_sent_at is not null;
  if v_resend and i.resend_count >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'resend_limit');
  end if;
  if v_resend and i.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (i.last_sent_at + interval '60 seconds' - now())))::integer));
  end if;
  v_count := i.resend_count + case when v_resend then 1 else 0 end;
  -- expires_at is deliberately not touched: a resend never extends an invitation.
  update public.user_invitations set last_sent_at = now(), resend_count = v_count where id = i.id;
  if v_resend then
    perform public.user_mgmt_log('invitation_resent', null, i.id, i.batch_id, jsonb_build_object('resend_count', v_count));
  end if;
  return jsonb_build_object('ok', true, 'invitation_id', i.id, 'email', i.email, 'expires_at', i.expires_at,
                            'attempt', case when v_resend then 'resend' else 'initial' end, 'resend_count', v_count);
end;
$$;

-- -------------------------------------------------------------------
-- 4. Record the outcome of an authorized attempt (service_role only)
-- -------------------------------------------------------------------
-- Returns { ok: true, delivery_status } or { ok: false, reason: not_found | not_pending |
-- not_started | auth_user_required | auth_user_mismatch | account_not_invited }.
create function public.record_invitation_delivery(p_invitation_id uuid, p_sent boolean, p_auth_user_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i         public.user_invitations%rowtype;
  v_email   text;
  v_status  public.account_status;
begin
  if p_sent is null then
    raise exception 'The delivery outcome is required.' using errcode = '22023';
  end if;
  select * into i from public.user_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if i.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', i.status);
  end if;
  if i.last_sent_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  if p_auth_user_id is null then
    if p_sent then
      return jsonb_build_object('ok', false, 'reason', 'auth_user_required');
    end if;
  else
    select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_auth_user_id;
    if v_email is null or v_email <> i.email_normalized
       or (i.auth_user_id is not null and i.auth_user_id <> p_auth_user_id) then
      return jsonb_build_object('ok', false, 'reason', 'auth_user_mismatch');
    end if;
    select p.account_status into v_status from public.profiles p where p.id = p_auth_user_id;
    if v_status is distinct from 'invited' then
      return jsonb_build_object('ok', false, 'reason', 'account_not_invited');
    end if;
  end if;
  update public.user_invitations
     set delivery_status = (case when p_sent then 'sent' else 'failed' end)::public.user_invitation_delivery,
         auth_user_id    = coalesce(i.auth_user_id, p_auth_user_id)
   where id = i.id;
  return jsonb_build_object('ok', true, 'delivery_status', case when p_sent then 'sent' else 'failed' end);
end;
$$;

-- -------------------------------------------------------------------
-- 5. Privileges (create_user_invitation keeps its 0017 grants)
-- -------------------------------------------------------------------
revoke all on function public.begin_invitation_delivery(uuid) from public, anon;
grant execute on function public.begin_invitation_delivery(uuid) to authenticated;
revoke all on function public.record_invitation_delivery(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.record_invitation_delivery(uuid, boolean, uuid) to service_role;

comment on function public.begin_invitation_delivery(uuid) is
  '0019: authorize one invitation email (pending, unexpired, 60 s cooldown, at most 5 resends); returns the database-owned address.';
comment on function public.record_invitation_delivery(uuid, boolean, uuid) is
  '0019: service_role only. Record sent/failed for an authorized attempt; binds only the matching, still-invited Auth account.';

commit;
