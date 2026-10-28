-- ===================================================================
-- 0020 — AUTOMATIC STUDENT / TRAINER CODES (Phase 7 P3.4)
--
-- Student and trainer codes are assigned by the database, never typed:
--   students  STU-00001, STU-00002, …   (sequence student_code_seq)
--   trainers  TRN-00001, TRN-00002, …   (sequence trainer_code_seq)
-- At least five digits, growing past 99999 without truncation
-- (lpad(n, greatest(5, length(n)))). nextval is atomic, so concurrent
-- generations never share a number; numbers are never reused (gaps from
-- refused, revoked or expired invitations are expected).
--
-- Generation points (option A):
--   create_user_invitation   generates the invitation's code and returns it
--   admin_set_user_role      generates the code of a record it creates
--   accept_user_invitation   UNCHANGED — copies the invitation's code
-- Callers can no longer supply a code: both functions now reject a
-- student_code / trainer_code key as an unknown field.
--
-- Database guard on public.students / public.trainers (every writer):
--   INSERT by a client role (authenticated / anon) is refused — records are
--     created only by the user-management functions, so no caller (not even
--     a Super Admin through the existing RLS write policy) can choose a code.
--     Privileged writers (the SECURITY DEFINER functions, SQL Editor,
--     service role) may insert; a missing code is generated.
--   UPDATE of a code is refused for everyone: codes are immutable.
-- Case-insensitive uniqueness is enforced by unique indexes on lower(code).
--
-- Existing codes are never changed or backfilled. The preflight refuses to
-- run if existing codes already collide case-insensitively, and each
-- sequence starts above the highest existing STU-/TRN- number found in
-- records or in invitations of any status.
--
-- Unchanged: RLS policies and grants on every existing table, the 0018
-- activation guard, the 0019 delivery functions and D1, all other
-- functions. Requires 0019.
-- ===================================================================

begin;

do $$
declare
  v_dup text;
begin
  if to_regprocedure('public.begin_invitation_delivery(uuid)') is null
     or to_regprocedure('public.user_mgmt_reinvitable_placeholder(uuid, text)') is null then
    raise exception 'Preflight failed: 0019 must be applied first.';
  end if;
  if to_regclass('public.student_code_seq') is not null or to_regclass('public.trainer_code_seq') is not null
     or to_regprocedure('public.user_mgmt_next_code(text)') is not null then
    raise exception 'Preflight failed: 0020 already applied?';
  end if;
  -- Existing codes must already be unique case-insensitively (no record is changed to make them so).
  select string_agg(c, ', ') into v_dup from (
    select 'student ' || lower(student_code) as c from public.students group by lower(student_code) having count(*) > 1
    union all
    select 'trainer ' || lower(trainer_code) from public.trainers group by lower(trainer_code) having count(*) > 1) d;
  if v_dup is not null then
    raise exception 'Preflight failed: existing codes collide case-insensitively (%). Resolve them first; 0020 changes no existing code.', v_dup;
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Sequences, started above every existing STU-/TRN- number
-- -------------------------------------------------------------------
create sequence public.student_code_seq as bigint minvalue 1;
create sequence public.trainer_code_seq as bigint minvalue 1;

-- Numbers already used anywhere (records of either kind, invitations of any status) are never issued.
select setval('public.student_code_seq', coalesce(max(n), 0) + 1, false)
  from (select (regexp_match(c, '^STU-([0-9]{1,18})$', 'i'))[1]::bigint as n
          from (select student_code as c from public.students
                union all select trainer_code from public.trainers
                union all select student_code from public.user_invitations where student_code is not null
                union all select trainer_code from public.user_invitations where trainer_code is not null) codes) m;
select setval('public.trainer_code_seq', coalesce(max(n), 0) + 1, false)
  from (select (regexp_match(c, '^TRN-([0-9]{1,18})$', 'i'))[1]::bigint as n
          from (select student_code as c from public.students
                union all select trainer_code from public.trainers
                union all select student_code from public.user_invitations where student_code is not null
                union all select trainer_code from public.user_invitations where trainer_code is not null) codes) m;

revoke all on sequence public.student_code_seq from public, anon, authenticated;
revoke all on sequence public.trainer_code_seq from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 2. Case-insensitive uniqueness (in addition to the 0003 unique constraints)
-- -------------------------------------------------------------------
create unique index students_student_code_ci_key on public.students (lower(student_code));
create unique index trainers_trainer_code_ci_key on public.trainers (lower(trainer_code));

-- -------------------------------------------------------------------
-- 3. Generator (internal; no client execute)
-- -------------------------------------------------------------------
-- The next free code of one kind. A number is skipped (and never reused) if
-- the resulting code already exists case-insensitively as a record or an
-- invitation code of any status — e.g. a legacy hand-typed "stu-00042".
create function public.user_mgmt_next_code(p_kind text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_prefix text;
  v_n      bigint;
  v_code   text;
  v_tries  integer := 0;
begin
  if p_kind = 'student' then
    v_prefix := 'STU-';
  elsif p_kind = 'trainer' then
    v_prefix := 'TRN-';
  else
    raise exception 'Unknown code kind.' using errcode = '22023';
  end if;
  loop
    v_tries := v_tries + 1;
    if v_tries > 1000 then
      raise exception 'Could not allocate a % code.', p_kind using errcode = 'P0001';
    end if;
    v_n := case when p_kind = 'student' then nextval('public.student_code_seq') else nextval('public.trainer_code_seq') end;
    v_code := v_prefix || lpad(v_n::text, greatest(5, length(v_n::text)), '0');
    exit when not exists (select 1 from public.students s where lower(s.student_code) = lower(v_code))
          and not exists (select 1 from public.trainers r where lower(r.trainer_code) = lower(v_code))
          and not exists (select 1 from public.user_invitations i
                           where lower(i.student_code) = lower(v_code) or lower(i.trainer_code) = lower(v_code));
  end loop;
  return v_code;
end;
$$;

revoke all on function public.user_mgmt_next_code(text) from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 4. Code guard on students / trainers (every writer)
-- -------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user is the real writer. Inside the
-- SECURITY DEFINER user-management functions it is their owner (privileged);
-- for a direct PostgREST write it is authenticated (or anon).
create function public.user_mgmt_code_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_client then
      raise exception 'Student and trainer records are created by the user-management functions; codes are assigned automatically.'
        using errcode = '42501';
    end if;
    -- Nested on purpose: each branch may only read its own table's column.
    if tg_table_name = 'students' then
      if new.student_code is null then
        new.student_code := public.user_mgmt_next_code('student');
      end if;
    else
      if new.trainer_code is null then
        new.trainer_code := public.user_mgmt_next_code('trainer');
      end if;
    end if;
    return new;
  end if;
  -- UPDATE: a code never changes, whoever writes.
  if tg_table_name = 'students' then
    if new.student_code is distinct from old.student_code then
      raise exception 'Student and trainer codes cannot be changed.' using errcode = '42501';
    end if;
  else
    if new.trainer_code is distinct from old.trainer_code then
      raise exception 'Student and trainer codes cannot be changed.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.user_mgmt_code_guard() from public, anon, authenticated;

create trigger students_code_guard
  before insert or update on public.students
  for each row execute function public.user_mgmt_code_guard();
create trigger trainers_code_guard
  before insert or update on public.trainers
  for each row execute function public.user_mgmt_code_guard();

-- -------------------------------------------------------------------
-- 5. create_user_invitation — the 0019 body; codes generated, never supplied
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
-- 6. admin_set_user_role — the 0017 body; a created record's code is generated
-- -------------------------------------------------------------------
-- Change an ACTIVE account's role, or complete a missing domain record for its
-- current role. Never yourself; never the last active Super Admin; refused while
-- the old role still has live responsibilities. A student/trainer role always
-- has its domain record in the same transaction: an existing (inactive) record
-- is reactivated, otherwise one is created with a generated code (0020) and the
-- full name from p_details.
-- p_details: { full_name, phone, organization, designation, specializations[] }
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    public.app_role,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.user_mgmt_require_super_admin();
  t         record;
  v_email   text;
  v_name    text;
  v_code    text;
  v_specs   text[] := '{}';
  v_has     boolean;
  v_changed boolean;
begin
  -- 0020: codes are generated, never supplied — a student_code / trainer_code key is an unknown field.
  perform public.user_mgmt_check_keys(coalesce(p_details, '{}'::jsonb),
    array['full_name', 'phone', 'organization', 'designation', 'specializations']);
  if p_user_id is null or p_user_id = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'cannot_change_self');
  end if;
  if p_role is null then
    raise exception 'Choose a role.' using errcode = '22023';
  end if;
  perform public.user_mgmt_lock_super_admins();
  perform public.user_mgmt_require_super_admin();
  select p.id, p.role, p.account_status into t from public.profiles p where p.id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if t.account_status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'account_not_active');
  end if;

  v_has := case p_role
             when 'student' then exists (select 1 from public.students s where s.id = t.id)
             when 'trainer' then exists (select 1 from public.trainers r where r.id = t.id)
             else true end;
  v_changed := t.role is distinct from p_role;
  if not v_changed and (v_has or p_role = 'super_admin') then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;

  if v_changed then
    if t.role = 'super_admin' and public.user_mgmt_active_super_admins(t.id) < 1 then
      return jsonb_build_object('ok', false, 'reason', 'last_super_admin');
    end if;
    if t.role = 'trainer' and exists (select 1 from public.batches b where b.trainer_id = t.id and b.status in ('upcoming', 'ongoing')) then
      return jsonb_build_object('ok', false, 'reason', 'has_current_batches');
    end if;
    if t.role = 'student' and exists (select 1 from public.batch_students bs where bs.student_id = t.id and bs.enrollment_status = 'enrolled') then
      return jsonb_build_object('ok', false, 'reason', 'has_active_enrollments');
    end if;
    if t.role = 'student' and exists (select 1 from public.test_attempts a where a.student_id = t.id and a.status = 'in_progress') then
      return jsonb_build_object('ok', false, 'reason', 'has_attempt_in_progress');
    end if;
  end if;

  -- The domain record the new role needs (checked before anything changes).
  if p_role in ('student', 'trainer') and not v_has then
    v_name := public.user_mgmt_text(p_details, 'full_name', 200);
    if v_name is null then
      return jsonb_build_object('ok', false, 'reason', 'details_required');
    end if;
    select u.email into v_email from auth.users u where u.id = t.id;
    if v_email is null then
      return jsonb_build_object('ok', false, 'reason', 'no_email');
    end if;
  end if;

  if v_changed then
    -- The 0003 trigger retires the old role's domain record (status inactive).
    update public.profiles set role = p_role where id = t.id;
  end if;

  if p_role = 'student' then
    if v_has then
      update public.students set status = 'active' where id = t.id and status <> 'active';
    else
      v_code := public.user_mgmt_next_code('student');
      insert into public.students (id, student_code, full_name) values (t.id, v_code, v_name);
      insert into public.student_details (student_id, email, phone, organization, designation)
      values (t.id, v_email, public.user_mgmt_text(p_details, 'phone', 40),
              public.user_mgmt_text(p_details, 'organization', 200), public.user_mgmt_text(p_details, 'designation', 200))
      on conflict (student_id) do nothing;
    end if;
  elsif p_role = 'trainer' then
    if v_has then
      update public.trainers set status = 'active' where id = t.id and status <> 'active';
    else
      if jsonb_typeof(p_details -> 'specializations') = 'array' then
        select coalesce(array_agg(btrim(x)), '{}') into v_specs
          from jsonb_array_elements_text(p_details -> 'specializations') x where btrim(x) <> '';
      end if;
      v_code := public.user_mgmt_next_code('trainer');
      insert into public.trainers (id, trainer_code, full_name) values (t.id, v_code, v_name);
      insert into public.trainer_details (trainer_id, email, phone, specializations)
      values (t.id, v_email, public.user_mgmt_text(p_details, 'phone', 40), v_specs)
      on conflict (trainer_id) do nothing;
    end if;
  end if;

  perform public.user_mgmt_log('role_changed', t.id, null, null,
    jsonb_build_object('from', t.role, 'to', p_role, 'domain_record_created', not v_has and p_role <> 'super_admin'));
  return jsonb_build_object('ok', true, 'previous', t.role, 'role', p_role)
    || case when v_code is not null then jsonb_build_object('code', v_code) else '{}'::jsonb end;
end;
$$;

comment on function public.user_mgmt_next_code(text) is
  '0020: next STU-/TRN- code (at least 5 digits; never reused; unique case-insensitively). Internal.';

commit;
