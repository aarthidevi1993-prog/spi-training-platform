-- ===================================================================
-- 0028 — RESTRICT INVITATION CREATION TO SUPER ADMIN (P3.10-D)
--
-- Product decision: trainers do not invite users. 0017 / 0019 / 0020 let a
-- trainer call two functions directly (no application path ever did):
--   create_user_invitation(p)            student invitations into the
--                                        trainer's current batches
--   begin_invitation_delivery(id)        on invitations they created
-- A trainer could therefore reserve addresses with pending invitations
-- (a Super Admin then got already_invited / email_unavailable) although no
-- email, Auth account or binding could follow (record_invitation_delivery
-- is service_role only).
--
-- Change — exactly one line in each function, the authorization guard:
--   before: v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer')
--   after:  v_uid is null or v_role is distinct from 'super_admin'
-- Every other caller now gets 42501 ('You don''t have permission to do that.')
-- before any read or write. current_app_role() is NULL for invited /
-- suspended accounts (0016/0018), so only an ACTIVE Super Admin passes —
-- the same rule as before for Super Admins. The rest of both bodies is the
-- previous definition verbatim (CREATE OR REPLACE); the trainer-only
-- branches inside them (batch scope, hourly rate limit, generic
-- email_unavailable answer, own-invitation scope) are now unreachable and
-- are left untouched so no Super Admin behaviour can change.
--
-- UNCHANGED: signatures, SECURITY DEFINER, search_path '', owner and EXECUTE
-- grants (CREATE OR REPLACE keeps them; authenticated keeps EXECUTE because
-- the Super Admin calls both through their own session), expiry rules,
-- cooldown / resend limits, record_invitation_delivery (service_role only),
-- revoke_user_invitation, acceptance, every table, policy and trigger.
--
-- Data: nothing is modified. Pending invitations that trainers created
-- earlier are only REPORTED (NOTICE); they keep their normal expiry
-- (at most 30 days) and can still be revoked.
--
-- Preflight: refuses unless both functions are exactly the 0020 / 0019
-- definitions. Postflight: verifies the new guard and attributes.
-- ROLLBACK (manual): re-apply create_user_invitation from 0020 (section 5)
-- and begin_invitation_delivery from 0019 (section 3).
-- Requires 0027.
-- ===================================================================

begin;

-- Preflight: both functions exactly as 0020 / 0019 (whitespace-insensitive).
do $$
begin
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.create_user_invitation(jsonb)')) is distinct from 'fa17c22a8f26b1bc312d7254b7ec393f' then
    raise exception 'Preflight failed: public.create_user_invitation(jsonb) differs from the 0020 definition (0020 missing, or 0028 already applied?).';
  end if;
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.begin_invitation_delivery(uuid)')) is distinct from '6f5b558685d89f6e8875c85973f077cf' then
    raise exception 'Preflight failed: public.begin_invitation_delivery(uuid) differs from the 0019 definition (0019 missing, or 0028 already applied?).';
  end if;
end
$$;

-- Report only: pending, unexpired invitations created by someone who is not a Super Admin today.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from public.user_invitations i
    left join public.profiles p on p.id = i.invited_by
   where i.status = 'pending' and i.expires_at > now() and p.role is distinct from 'super_admin';
  raise notice '0028: % pending invitation(s) created by non-Super-Admin accounts remain (unchanged; they expire normally and can be revoked).', v_count;
end
$$;

-- -------------------------------------------------------------------
-- 1. create_user_invitation — the 0020 body; guard: Super Admin only
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
  if v_uid is null or v_role is distinct from 'super_admin' then  -- 0028: Super Admin only
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  -- 0020: codes are generated, never supplied — a student_code / trainer_code key is an unknown field.
  perform public.user_mgmt_check_keys(p, array['email', 'role', 'full_name', 'phone',
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

  -- Role-specific fields (0020: the code is generated below).
  if v_target = 'trainer' then
    if v_batch is not null then
      raise exception 'Only students are invited into a batch.' using errcode = '22023';
    end if;
  elsif v_target = 'super_admin' then
    if v_batch is not null then
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

  -- 0020: the invitation's code is generated (unique case-insensitively, race-safe, never reused).
  if v_target = 'student' then
    v_scode := public.user_mgmt_next_code('student');
  elsif v_target = 'trainer' then
    v_tcode := public.user_mgmt_next_code('trainer');
  end if;

  insert into public.user_invitations (email, intended_role, full_name, student_code, trainer_code, phone, organization,
                                       designation, specializations, batch_id, invited_by, expires_at)
  values (v_email, v_target, v_name, v_scode, v_tcode, public.user_mgmt_text(p, 'phone', 40),
          public.user_mgmt_text(p, 'organization', 200), public.user_mgmt_text(p, 'designation', 200),
          v_specs, v_batch, v_uid, now() + make_interval(days => v_days))
  returning id into v_id;

  perform public.user_mgmt_log('invitation_created', null, v_id, v_batch, jsonb_build_object('role', v_target));
  return jsonb_build_object('ok', true, 'invitation_id', v_id)
    || case when coalesce(v_scode, v_tcode) is not null then jsonb_build_object('code', coalesce(v_scode, v_tcode)) else '{}'::jsonb end;
end;
$$;

-- -------------------------------------------------------------------
-- 2. begin_invitation_delivery — the 0019 body; guard: Super Admin only
-- -------------------------------------------------------------------
create or replace function public.begin_invitation_delivery(p_invitation_id uuid)
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
  if v_uid is null or v_role is distinct from 'super_admin' then  -- 0028: Super Admin only
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

-- Postflight: the new guard is in place; attributes and grants are as before.
do $$
declare
  f text;
begin
  foreach f in array array['public.create_user_invitation(jsonb)', 'public.begin_invitation_delivery(uuid)'] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = to_regprocedure(f)
         and p.prosecdef
         and p.proconfig = array['search_path=""']
         and position('v_role is distinct from ''super_admin''' in p.prosrc) > 0
         and position('v_role not in (''super_admin'', ''trainer'')' in p.prosrc) = 0
         and has_function_privilege('authenticated', p.oid, 'execute')
         and not has_function_privilege('anon', p.oid, 'execute')
    ) then
      raise exception 'Postflight failed: % does not have the 0028 guard and attributes.', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.record_invitation_delivery(uuid, boolean, uuid)', 'execute') then
    raise exception 'Postflight failed: record_invitation_delivery must stay service_role only.';
  end if;
end
$$;

commit;
