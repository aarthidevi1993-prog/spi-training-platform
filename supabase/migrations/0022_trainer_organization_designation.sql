-- ===================================================================
-- 0022 — TRAINER ORGANIZATION & DESIGNATION (Phase 7)
--
-- Two optional trainer profile fields, like the student's:
--   public.trainer_details.organization  text null
--   public.trainer_details.designation   text null
-- No constraint, default, index or backfill: existing trainers simply
-- have none (null). Lengths are enforced by the functions (max 200),
-- exactly as for student_details.
--
-- Invitations already carry both fields (user_invitations, 0017) and
-- create_user_invitation() (0020) already stores them for any role — the
-- application now sends them for trainers too. Replaced here, each from
-- its current (0017) body with only the lines below changed:
--   accept_user_invitation()   trainer branch also copies organization
--                              and designation into trainer_details
--   admin_update_trainer()     accepts organization / designation
--                              (trimmed, max 200, blank → null), audited
--                              in user_details_changed.fields
-- Same signatures, SECURITY DEFINER, search_path = '', owner and grants
-- (create or replace keeps them).
--
-- Unchanged: RLS (the existing trainer_details policies cover every
-- column: Super Admin read/write, the trainer reads their own row),
-- grants, admin_set_user_role(), create_user_invitation(), every other
-- 0001–0021 object, all existing rows. Requires 0021.
-- ===================================================================

begin;

do $$
begin
  if to_regprocedure('public.batches_trainer_guard()') is null
     or to_regprocedure('public.batches_trainer_insert_audit()') is null then
    raise exception 'Preflight failed: 0021 must be applied first.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'trainer_details'
                and column_name in ('organization', 'designation')) then
    raise exception 'Preflight failed: 0022 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Columns (nullable; existing rows stay valid with null)
-- -------------------------------------------------------------------
alter table public.trainer_details
  add column organization text null,
  add column designation  text null;

-- -------------------------------------------------------------------
-- 2. accept_user_invitation() — the 0017 body; the trainer branch also
--    copies organization and designation (nothing else changes)
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

-- -------------------------------------------------------------------
-- 3. admin_update_trainer() — the 0017 body; organization and designation
--    are editable like the student's (trimmed, max 200, blank → null,
--    audited in user_details_changed.fields)
-- -------------------------------------------------------------------
create or replace function public.admin_update_trainer(p_trainer_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fields text[] := '{}';
  v_specs  text[];
  v_email  text;
begin
  perform public.user_mgmt_require_super_admin();
  perform public.user_mgmt_check_keys(p, array['full_name', 'phone', 'organization', 'designation', 'specializations', 'bio']);
  if not exists (select 1 from public.trainers r where r.id = p_trainer_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p ? 'full_name' then
    if public.user_mgmt_text(p, 'full_name', 200) is null then
      raise exception 'A full name is required.' using errcode = '22023';
    end if;
    update public.trainers set full_name = public.user_mgmt_text(p, 'full_name', 200) where id = p_trainer_id;
    v_fields := array_append(v_fields, 'full_name');
  end if;
  if p ?| array['phone', 'organization', 'designation', 'specializations', 'bio'] then
    if jsonb_typeof(p -> 'specializations') = 'array' then
      select coalesce(array_agg(btrim(x)), '{}') into v_specs
        from jsonb_array_elements_text(p -> 'specializations') x where btrim(x) <> '';
      if cardinality(v_specs) > 20 then
        raise exception 'At most 20 specializations.' using errcode = '22023';
      end if;
    elsif p ? 'specializations' then
      raise exception 'Specializations must be a list.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.trainer_details d where d.trainer_id = p_trainer_id) then
      select u.email into v_email from auth.users u where u.id = p_trainer_id;
      if v_email is null then
        return jsonb_build_object('ok', false, 'reason', 'no_contact_record');
      end if;
      insert into public.trainer_details (trainer_id, email) values (p_trainer_id, v_email);
    end if;
    update public.trainer_details d
       set phone           = case when p ? 'phone' then public.user_mgmt_text(p, 'phone', 40) else d.phone end,
           organization    = case when p ? 'organization' then public.user_mgmt_text(p, 'organization', 200) else d.organization end,
           designation     = case when p ? 'designation' then public.user_mgmt_text(p, 'designation', 200) else d.designation end,
           specializations = case when p ? 'specializations' then v_specs else d.specializations end,
           bio             = case when p ? 'bio' then public.user_mgmt_text(p, 'bio', 2000) else d.bio end
     where d.trainer_id = p_trainer_id;
    v_fields := v_fields || array(select k from unnest(array['phone', 'organization', 'designation', 'specializations', 'bio']) k where p ? k);
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  perform public.user_mgmt_log('user_details_changed', p_trainer_id, null, null, jsonb_build_object('fields', v_fields));
  return jsonb_build_object('ok', true, 'fields', v_fields);
end;
$$;

commit;
