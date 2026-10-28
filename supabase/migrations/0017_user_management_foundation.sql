-- ===================================================================
-- 0017 — USER MANAGEMENT FOUNDATION (database layer, P3.1)
--
-- Database authority for Advanced User Management. Every write goes
-- through a SECURITY DEFINER function that derives the caller from
-- auth.uid() / current_app_role() (0016: active accounts only), checks
-- role, scope and protection rules from database state, changes the
-- data and writes audit/history in the same transaction. No client
-- gets INSERT/UPDATE/DELETE on any table added here.
--
-- Adds:
--   user_invitations    pending → accepted / revoked / expired (no
--                       passwords, tokens or links are ever stored)
--   user_admin_events   append-only audit of user-management actions
--   enrollment_events   append-only enrolment history, written by a
--                       trigger on batch_students for EVERY writer
--                       (batch_students itself is not changed); plus a
--                       one-time 'baseline' row per existing enrolment
--
-- Functions (callable by signed-in users; each checks who may act):
--   Super Admin: create/revoke/expire invitations, account status,
--     role (incl. completing a missing domain record), enrolment,
--     batch trainer, student/trainer details
--   Trainer: invite students into, enrol students into, and edit
--     students of batches they CURRENTLY teach (is_current_batch_trainer)
--   Invitee: accept_user_invitation() — database side of acceptance
--     (the email/confirm/password flow is a later phase)
--
-- Protection: no self status/role change; the last active Super Admin
-- can never be suspended or demoted (super-admin rows are locked so
-- concurrent changes are serialised); role changes are refused while
-- the old role still has live responsibilities, and a student/trainer
-- role always gets its domain record in the same transaction.
--
-- Unchanged: migrations 0001–0016, current_app_role(), account-status
-- semantics, all existing tables, policies, grants and functions.
-- No Auth Admin / service-role behaviour. Requires 0016.
-- ===================================================================

begin;

do $$
begin
  if to_regtype('public.account_status') is null
     or to_regprocedure('public.current_app_role()') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.is_current_batch_trainer(uuid)') is null
     or to_regprocedure('public.set_updated_at()') is null
     or to_regclass('public.batch_students') is null
     or to_regclass('public.test_attempts') is null then
    raise exception 'Preflight failed: 0016 (and 0003/0008/0009) must be applied first.';
  end if;
  if to_regclass('public.user_invitations') is not null then
    raise exception 'Preflight failed: 0017 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.user_invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

-- Delivery bookkeeping for the later sending phase (not used by any function here).
create type public.user_invitation_delivery as enum ('not_sent', 'sent', 'failed');

create type public.user_admin_event_type as enum (
  'invitation_created',
  'invitation_withheld',      -- a trainer's invitation refused because the email is unavailable
  'invitation_resent',
  'invitation_revoked',
  'invitation_expired',
  'invitation_accepted',
  'account_status_changed',
  'role_changed',
  'enrollment_changed',
  'trainer_assignment_changed',
  'user_details_changed'
);

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------
create table public.user_invitations (
  id                uuid                                  not null default gen_random_uuid(),
  email             text                                  not null,
  email_normalized  text generated always as (lower(btrim(email))) stored,
  intended_role     public.app_role                       not null,
  full_name         text                                  not null,
  student_code      text                                  null,
  trainer_code      text                                  null,
  phone             text                                  null,
  organization      text                                  null,
  designation       text                                  null,
  specializations   text[]                                not null default '{}',
  batch_id          uuid                                  null references public.batches (id) on delete restrict,
  invited_by        uuid                                  not null references public.profiles (id) on delete restrict,
  status            public.user_invitation_status         not null default 'pending',
  delivery_status   public.user_invitation_delivery       not null default 'not_sent',
  resend_count      integer                               not null default 0,
  last_sent_at      timestamptz                           null,
  auth_user_id      uuid                                  null references auth.users (id) on delete set null,
  expires_at        timestamptz                           not null,
  accepted_at       timestamptz                           null,
  accepted_user_id  uuid                                  null references public.profiles (id) on delete restrict,
  revoked_at        timestamptz                           null,
  revoked_by        uuid                                  null references public.profiles (id) on delete set null,
  revoke_reason     text                                  null,
  created_at        timestamptz                           not null default now(),
  updated_at        timestamptz                           not null default now(),

  constraint user_invitations_pkey primary key (id),
  constraint user_invitations_email_format   check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint user_invitations_name_ok        check (char_length(btrim(full_name)) between 1 and 200),
  constraint user_invitations_codes_ok       check (
    (intended_role = 'student'     and student_code is not null and trainer_code is null)
    or (intended_role = 'trainer'  and trainer_code is not null and student_code is null and batch_id is null)
    or (intended_role = 'super_admin' and student_code is null and trainer_code is null and batch_id is null)),
  constraint user_invitations_code_format    check (
    (student_code is null or student_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
    and (trainer_code is null or trainer_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')),
  constraint user_invitations_text_lengths   check (
    coalesce(char_length(phone), 0) <= 40 and coalesce(char_length(organization), 0) <= 200
    and coalesce(char_length(designation), 0) <= 200 and cardinality(specializations) <= 20
    and coalesce(char_length(revoke_reason), 0) <= 500),
  constraint user_invitations_resend_ok      check (resend_count between 0 and 50),
  constraint user_invitations_expiry_ok      check (expires_at > created_at),
  constraint user_invitations_accepted_ok    check ((status = 'accepted') = (accepted_at is not null and accepted_user_id is not null)),
  constraint user_invitations_revoked_ok     check ((status = 'revoked') = (revoked_at is not null))
);

-- One pending invitation per address (case-insensitive).
create unique index user_invitations_one_pending_per_email
  on public.user_invitations (email_normalized) where status = 'pending';
create index user_invitations_status_idx     on public.user_invitations (status, expires_at);
create index user_invitations_invited_by_idx on public.user_invitations (invited_by, created_at);
create index user_invitations_batch_idx      on public.user_invitations (batch_id) where batch_id is not null;

create table public.user_admin_events (
  id               bigint                        generated always as identity,
  occurred_at      timestamptz                   not null default now(),
  actor_id         uuid                          null references public.profiles (id) on delete restrict,
  event_type       public.user_admin_event_type  not null,
  target_user_id   uuid                          null references public.profiles (id) on delete restrict,
  invitation_id    uuid                          null references public.user_invitations (id) on delete restrict,
  batch_id         uuid                          null references public.batches (id) on delete restrict,
  detail           jsonb                         not null default '{}'::jsonb,

  constraint user_admin_events_pkey primary key (id),
  constraint user_admin_events_detail_ok check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048)
);
create index user_admin_events_target_idx     on public.user_admin_events (target_user_id, occurred_at);
create index user_admin_events_actor_idx      on public.user_admin_events (actor_id, event_type, occurred_at);
create index user_admin_events_invitation_idx on public.user_admin_events (invitation_id) where invitation_id is not null;

create table public.enrollment_events (
  id               bigint                    generated always as identity,
  occurred_at      timestamptz               not null default now(),
  batch_id         uuid                      not null,
  student_id       uuid                      not null,
  previous_status  public.enrollment_status  null,       -- NULL: first enrolment (or the baseline row)
  new_status       public.enrollment_status  not null,
  actor_id         uuid                      null references public.profiles (id) on delete restrict,
  source           text                      not null,
  reason           text                      null,

  -- batch_id/student_id are not foreign keys on purpose: history must not change what may be
  -- done with batch_students rows (e.g. the existing Super Admin delete path).
  constraint enrollment_events_pkey primary key (id),
  constraint enrollment_events_source_ok check (source in ('admin', 'trainer', 'invitation', 'direct', 'baseline')),
  constraint enrollment_events_reason_ok check (reason is null or char_length(reason) <= 500)
);
create index enrollment_events_enrolment_idx on public.enrollment_events (batch_id, student_id, occurred_at);
create index enrollment_events_student_idx   on public.enrollment_events (student_id, occurred_at);

-- -------------------------------------------------------------------
-- 3. Guards (every writer: functions, service role, SQL Editor)
-- -------------------------------------------------------------------

-- Audit and history rows: insert only; time and actor stamped by the database.
create function public.user_mgmt_append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception '% is append-only.', tg_table_name using errcode = '42501';
  end if;
  new.occurred_at := now();
  new.actor_id    := auth.uid();
  return new;
end;
$$;

create function public.user_mgmt_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% cannot be truncated.', tg_table_name using errcode = '42501';
end;
$$;

-- Invitations: never deleted; identity fields fixed; status only moves forward from pending.
create function public.user_invitations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Invitations cannot be deleted; revoke them instead.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'A new invitation always starts as pending.' using errcode = '23514';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if (new.id, new.email, new.intended_role, new.invited_by, new.created_at)
     is distinct from (old.id, old.email, old.intended_role, old.invited_by, old.created_at) then
    raise exception 'An invitation''s address, role, inviter and creation time cannot be changed.' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'A % invitation cannot change state.', old.status using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.user_mgmt_append_only_guard() from public, anon, authenticated;
revoke all on function public.user_mgmt_no_truncate() from public, anon, authenticated;
revoke all on function public.user_invitations_guard() from public, anon, authenticated;

create trigger user_admin_events_guard
  before insert or update or delete on public.user_admin_events
  for each row execute function public.user_mgmt_append_only_guard();
create trigger enrollment_events_guard
  before insert or update or delete on public.enrollment_events
  for each row execute function public.user_mgmt_append_only_guard();
create trigger user_admin_events_no_truncate before truncate on public.user_admin_events for each statement execute function public.user_mgmt_no_truncate();
create trigger enrollment_events_no_truncate before truncate on public.enrollment_events for each statement execute function public.user_mgmt_no_truncate();
create trigger user_invitations_no_truncate  before truncate on public.user_invitations  for each statement execute function public.user_mgmt_no_truncate();

create trigger user_invitations_guard
  before insert or update or delete on public.user_invitations
  for each row execute function public.user_invitations_guard();
create trigger user_invitations_set_updated_at
  before update on public.user_invitations
  for each row execute function public.set_updated_at();

-- Enrolment history: one row per enrolment or status change, whoever writes.
-- Source/reason come from transaction-local settings set by the 0017 functions;
-- any other writer (existing Super Admin RLS path, SQL Editor) is recorded as 'direct'.
create function public.batch_students_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.enrollment_status is not distinct from old.enrollment_status then
    return null;
  end if;
  insert into public.enrollment_events (batch_id, student_id, previous_status, new_status, source, reason)
  values (new.batch_id, new.student_id,
          case when tg_op = 'UPDATE' then old.enrollment_status end,
          new.enrollment_status,
          coalesce(nullif(current_setting('app.enrollment_source', true), ''), 'direct'),
          nullif(current_setting('app.enrollment_reason', true), ''));
  return null;
end;
$$;

revoke all on function public.batch_students_record_event() from public, anon, authenticated;

create trigger batch_students_record_event
  after insert or update of enrollment_status on public.batch_students
  for each row execute function public.batch_students_record_event();

-- Baseline: history starts with the current state of every existing enrolment.
-- batch_students itself is not touched.
insert into public.enrollment_events (batch_id, student_id, previous_status, new_status, source, reason)
select bs.batch_id, bs.student_id, null, bs.enrollment_status, 'baseline', 'State when enrolment history began (0017)'
  from public.batch_students bs
 where not exists (select 1 from public.enrollment_events e where e.batch_id = bs.batch_id and e.student_id = bs.student_id);

-- -------------------------------------------------------------------
-- 4. Internal helpers (no client execute; used inside the functions below)
-- -------------------------------------------------------------------

-- The caller, if an active Super Admin; otherwise a permission error.
create function public.user_mgmt_require_super_admin()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_super_admin() then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create function public.user_mgmt_log(
  p_type        public.user_admin_event_type,
  p_target_user uuid,
  p_invitation  uuid,
  p_batch       uuid,
  p_detail      jsonb
)
returns void
language sql
set search_path = ''
as $$
  insert into public.user_admin_events (event_type, target_user_id, invitation_id, batch_id, detail)
  values (p_type, p_target_user, p_invitation, p_batch, coalesce(p_detail, '{}'::jsonb));
$$;

-- Serialise every change that could affect the number of active Super Admins.
create function public.user_mgmt_lock_super_admins()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.profiles p where p.role = 'super_admin' order by p.id for update;
end;
$$;

create function public.user_mgmt_active_super_admins(p_excluding uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.profiles p
   where p.role = 'super_admin' and p.account_status = 'active' and p.id is distinct from p_excluding;
$$;

-- Trimmed optional text from a jsonb object (NULL when absent/blank); too long → 22023.
create function public.user_mgmt_text(p jsonb, p_key text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(p ->> p_key), '');
begin
  if v is not null and char_length(v) > p_max then
    raise exception '% is too long (at most % characters).', p_key, p_max using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Only these keys may appear in a details object.
create function public.user_mgmt_check_keys(p jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Details must be a JSON object.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (p_allowed)) then
      raise exception 'Unknown field: %.', k using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- Trainer scope: the student is currently enrolled in a batch the caller CURRENTLY teaches.
create function public.user_mgmt_trainer_student_in_scope(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1 from public.batch_students bs
     where bs.student_id = p_student_id
       and bs.enrollment_status = 'enrolled'
       and public.is_current_batch_trainer(bs.batch_id)
  ), false);
$$;

revoke all on function public.user_mgmt_require_super_admin() from public, anon, authenticated;
revoke all on function public.user_mgmt_log(public.user_admin_event_type, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.user_mgmt_lock_super_admins() from public, anon, authenticated;
revoke all on function public.user_mgmt_active_super_admins(uuid) from public, anon, authenticated;
revoke all on function public.user_mgmt_text(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.user_mgmt_check_keys(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.user_mgmt_trainer_student_in_scope(uuid) from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 5. Invitations
-- -------------------------------------------------------------------

-- Create an invitation record (no email is sent here).
--   Super Admin: any role; a student may get an upcoming/ongoing batch.
--   Trainer: students only, into a batch they currently teach (required);
--            at most 20 per hour; an unavailable address (existing account
--            or pending invitation) gets one generic answer and is audited.
-- p: { email, role, full_name, student_code | trainer_code, phone, organization,
--      designation, specializations[], batch_id, expires_in_days (1–30, default 7) }
create function public.create_user_invitation(p jsonb)
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
  v_account := exists (select 1 from auth.users u where lower(btrim(u.email)) = v_norm);
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

-- Revoke a pending invitation (Super Admin: any; trainer: their own, while
-- they still teach its batch). A state change only — no account is touched.
create function public.revoke_user_invitation(p_invitation_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_role  text := public.current_app_role();
  i       public.user_invitations%rowtype;
begin
  if v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'The reason is too long (at most 500 characters).' using errcode = '22023';
  end if;
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
  update public.user_invitations
     set status = 'revoked', revoked_at = now(), revoked_by = v_uid, revoke_reason = nullif(btrim(p_reason), '')
   where id = i.id;
  perform public.user_mgmt_log('invitation_revoked', null, i.id, i.batch_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;

-- Mark every pending invitation past its expiry as expired (Super Admin).
create function public.expire_user_invitations()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  r       record;
begin
  perform public.user_mgmt_require_super_admin();
  for r in
    update public.user_invitations set status = 'expired'
     where status = 'pending' and expires_at <= now()
    returning id, batch_id
  loop
    perform public.user_mgmt_log('invitation_expired', null, r.id, r.batch_id, '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Database side of accepting an invitation: the signed-in INVITED account
-- whose auth email matches a pending, unexpired invitation becomes active
-- with the intended role and domain record (and enrolment when the batch is
-- still current and has room), in one transaction. No arguments: nothing
-- about the role, person or batch can be supplied by the caller.
create function public.accept_user_invitation()
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
    insert into public.trainer_details (trainer_id, email, phone, specializations)
    values (v_uid, i.email, i.phone, i.specializations);
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
-- 6. Account status and role (Super Admin)
-- -------------------------------------------------------------------

-- active ↔ suspended, invited → suspended. Never yourself; never the last
-- active Super Admin. invited → active happens only through acceptance.
create function public.admin_set_account_status(
  p_user_id uuid,
  p_status  public.account_status,
  p_reason  text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.user_mgmt_require_super_admin();
  t      record;
begin
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'The reason is too long (at most 500 characters).' using errcode = '22023';
  end if;
  if p_user_id is null or p_user_id = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'cannot_change_self');
  end if;
  perform public.user_mgmt_lock_super_admins();
  perform public.user_mgmt_require_super_admin();   -- still active after waiting for the lock?
  select p.id, p.role, p.account_status into t from public.profiles p where p.id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if t.account_status = p_status then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  if not ((t.account_status = 'active' and p_status = 'suspended')
          or (t.account_status = 'suspended' and p_status = 'active')
          or (t.account_status = 'invited' and p_status = 'suspended')) then
    return jsonb_build_object('ok', false, 'reason', 'transition_not_allowed');
  end if;
  if t.role = 'super_admin' and t.account_status = 'active' and public.user_mgmt_active_super_admins(t.id) < 1 then
    return jsonb_build_object('ok', false, 'reason', 'last_super_admin');
  end if;
  update public.profiles set account_status = p_status where id = t.id;
  perform public.user_mgmt_log('account_status_changed', t.id, null, null,
    jsonb_build_object('from', t.account_status, 'to', p_status, 'reason', nullif(btrim(p_reason), '')));
  return jsonb_build_object('ok', true, 'previous', t.account_status, 'status', p_status);
end;
$$;

-- Change an ACTIVE account's role, or complete a missing domain record for its
-- current role. Never yourself; never the last active Super Admin; refused while
-- the old role still has live responsibilities. A student/trainer role always
-- has its domain record in the same transaction: an existing (inactive) record
-- is reactivated, otherwise p_details must supply it — nothing is invented.
-- p_details: { student_code | trainer_code, full_name, phone, organization, designation, specializations[] }
create function public.admin_set_user_role(
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
  perform public.user_mgmt_check_keys(coalesce(p_details, '{}'::jsonb),
    array['student_code', 'trainer_code', 'full_name', 'phone', 'organization', 'designation', 'specializations']);
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
    v_code := public.user_mgmt_text(p_details, case when p_role = 'student' then 'student_code' else 'trainer_code' end, 40);
    if v_name is null or v_code is null or v_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' then
      return jsonb_build_object('ok', false, 'reason', 'details_required');
    end if;
    if (p_role = 'student' and (exists (select 1 from public.students s where lower(s.student_code) = lower(v_code))
          or exists (select 1 from public.user_invitations i where i.status = 'pending' and lower(i.student_code) = lower(v_code))))
       or (p_role = 'trainer' and (exists (select 1 from public.trainers r where lower(r.trainer_code) = lower(v_code))
          or exists (select 1 from public.user_invitations i where i.status = 'pending' and lower(i.trainer_code) = lower(v_code)))) then
      return jsonb_build_object('ok', false, 'reason', 'code_in_use');
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
      insert into public.trainers (id, trainer_code, full_name) values (t.id, v_code, v_name);
      insert into public.trainer_details (trainer_id, email, phone, specializations)
      values (t.id, v_email, public.user_mgmt_text(p_details, 'phone', 40), v_specs)
      on conflict (trainer_id) do nothing;
    end if;
  end if;

  perform public.user_mgmt_log('role_changed', t.id, null, null,
    jsonb_build_object('from', t.role, 'to', p_role, 'domain_record_created', not v_has and p_role <> 'super_admin'));
  return jsonb_build_object('ok', true, 'previous', t.role, 'role', p_role);
end;
$$;

-- -------------------------------------------------------------------
-- 7. Enrolment and batch trainer
-- -------------------------------------------------------------------

-- Super Admin: enrol (new or re-enrol a withdrawn student), withdraw, complete.
-- Withdrawing/completing finalizes in-progress test attempts (0010) as before.
create function public.admin_set_enrollment(
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

-- Trainer: enrol a student who is already in their current scope into another
-- batch they currently teach. Enrol only (no withdraw/complete/re-enrol).
create function public.trainer_enroll_student(p_batch_id uuid, p_student_id uuid)
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

-- Super Admin: assign an active trainer to an upcoming/ongoing batch
-- (the 0003 trigger moves the batch's scheduled/live classes along).
create function public.admin_assign_batch_trainer(p_batch_id uuid, p_trainer_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.user_mgmt_require_super_admin();
  v_bstatus public.batch_status;
  v_old     uuid;
begin
  select b.status, b.trainer_id into v_bstatus, v_old from public.batches b where b.id = p_batch_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_bstatus not in ('upcoming', 'ongoing') then
    return jsonb_build_object('ok', false, 'reason', 'batch_not_current');
  end if;
  if not exists (select 1 from public.trainers r join public.profiles p on p.id = r.id
                  where r.id = p_trainer_id and r.status = 'active' and p.role = 'trainer' and p.account_status = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'trainer_not_available');
  end if;
  if v_old is not distinct from p_trainer_id then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  update public.batches set trainer_id = p_trainer_id where id = p_batch_id;
  perform public.user_mgmt_log('trainer_assignment_changed', p_trainer_id, null, p_batch_id,
    jsonb_build_object('from', v_old, 'to', p_trainer_id));
  return jsonb_build_object('ok', true, 'previous', v_old, 'trainer_id', p_trainer_id);
end;
$$;

-- -------------------------------------------------------------------
-- 8. Details (Super Admin; trainer for students in their current scope)
-- -------------------------------------------------------------------

-- Shared body: name + contact details of a student. The audit records which
-- fields changed, never their values.
create function public.user_mgmt_update_student(p_student_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_fields text[] := '{}';
  v_email  text;
begin
  perform public.user_mgmt_check_keys(p, array['full_name', 'phone', 'organization', 'designation']);
  if not exists (select 1 from public.students s where s.id = p_student_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p ? 'full_name' then
    if public.user_mgmt_text(p, 'full_name', 200) is null then
      raise exception 'A full name is required.' using errcode = '22023';
    end if;
    update public.students set full_name = public.user_mgmt_text(p, 'full_name', 200) where id = p_student_id;
    v_fields := array_append(v_fields, 'full_name');
  end if;
  if p ?| array['phone', 'organization', 'designation'] then
    if not exists (select 1 from public.student_details d where d.student_id = p_student_id) then
      select u.email into v_email from auth.users u where u.id = p_student_id;
      if v_email is null then
        return jsonb_build_object('ok', false, 'reason', 'no_contact_record');
      end if;
      insert into public.student_details (student_id, email) values (p_student_id, v_email);
    end if;
    update public.student_details d
       set phone        = case when p ? 'phone'        then public.user_mgmt_text(p, 'phone', 40)         else d.phone end,
           organization = case when p ? 'organization' then public.user_mgmt_text(p, 'organization', 200) else d.organization end,
           designation  = case when p ? 'designation'  then public.user_mgmt_text(p, 'designation', 200)  else d.designation end
     where d.student_id = p_student_id;
    v_fields := v_fields || array(select k from unnest(array['phone', 'organization', 'designation']) k where p ? k);
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  perform public.user_mgmt_log('user_details_changed', p_student_id, null, null, jsonb_build_object('fields', v_fields));
  return jsonb_build_object('ok', true, 'fields', v_fields);
end;
$$;

revoke all on function public.user_mgmt_update_student(uuid, jsonb) from public, anon, authenticated;

create function public.admin_update_student(p_student_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.user_mgmt_require_super_admin();
  return public.user_mgmt_update_student(p_student_id, p);
end;
$$;

create function public.trainer_update_student(p_student_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.current_app_role() is distinct from 'trainer' then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  if not public.user_mgmt_trainer_student_in_scope(p_student_id) then
    raise exception 'You can only edit students in batches you currently teach.' using errcode = '42501';
  end if;
  return public.user_mgmt_update_student(p_student_id, p);
end;
$$;

create function public.admin_update_trainer(p_trainer_id uuid, p jsonb)
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
  perform public.user_mgmt_check_keys(p, array['full_name', 'phone', 'specializations', 'bio']);
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
  if p ?| array['phone', 'specializations', 'bio'] then
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
           specializations = case when p ? 'specializations' then v_specs else d.specializations end,
           bio             = case when p ? 'bio' then public.user_mgmt_text(p, 'bio', 2000) else d.bio end
     where d.trainer_id = p_trainer_id;
    v_fields := v_fields || array(select k from unnest(array['phone', 'specializations', 'bio']) k where p ? k);
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  perform public.user_mgmt_log('user_details_changed', p_trainer_id, null, null, jsonb_build_object('fields', v_fields));
  return jsonb_build_object('ok', true, 'fields', v_fields);
end;
$$;

-- -------------------------------------------------------------------
-- 9. Privileges + Row Level Security (read-only for clients)
-- -------------------------------------------------------------------
revoke all on function public.create_user_invitation(jsonb)                      from public, anon;
revoke all on function public.revoke_user_invitation(uuid, text)                 from public, anon;
revoke all on function public.expire_user_invitations()                          from public, anon;
revoke all on function public.accept_user_invitation()                           from public, anon;
revoke all on function public.admin_set_account_status(uuid, public.account_status, text) from public, anon;
revoke all on function public.admin_set_user_role(uuid, public.app_role, jsonb)  from public, anon;
revoke all on function public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text) from public, anon;
revoke all on function public.trainer_enroll_student(uuid, uuid)                 from public, anon;
revoke all on function public.admin_assign_batch_trainer(uuid, uuid)             from public, anon;
revoke all on function public.admin_update_student(uuid, jsonb)                  from public, anon;
revoke all on function public.trainer_update_student(uuid, jsonb)                from public, anon;
revoke all on function public.admin_update_trainer(uuid, jsonb)                  from public, anon;
grant execute on function public.create_user_invitation(jsonb)                      to authenticated;
grant execute on function public.revoke_user_invitation(uuid, text)                 to authenticated;
grant execute on function public.expire_user_invitations()                          to authenticated;
grant execute on function public.accept_user_invitation()                           to authenticated;
grant execute on function public.admin_set_account_status(uuid, public.account_status, text) to authenticated;
grant execute on function public.admin_set_user_role(uuid, public.app_role, jsonb)  to authenticated;
grant execute on function public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text) to authenticated;
grant execute on function public.trainer_enroll_student(uuid, uuid)                 to authenticated;
grant execute on function public.admin_assign_batch_trainer(uuid, uuid)             to authenticated;
grant execute on function public.admin_update_student(uuid, jsonb)                  to authenticated;
grant execute on function public.trainer_update_student(uuid, jsonb)                to authenticated;
grant execute on function public.admin_update_trainer(uuid, jsonb)                  to authenticated;

alter table public.user_invitations  enable row level security;
alter table public.user_admin_events enable row level security;
alter table public.enrollment_events enable row level security;

revoke all on table public.user_invitations, public.user_admin_events, public.enrollment_events from anon, authenticated;
grant select on table public.user_invitations, public.user_admin_events, public.enrollment_events to authenticated;
grant all on table public.user_invitations, public.user_admin_events, public.enrollment_events to service_role;

-- Invitations: Super Admin all; trainer — their own, or for a batch they currently teach.
create policy user_invitations_admin_select
  on public.user_invitations for select to authenticated
  using ((select public.is_super_admin()));
create policy user_invitations_trainer_select
  on public.user_invitations for select to authenticated
  using ((select public.current_app_role()) = 'trainer'
         and (invited_by = (select auth.uid())
              or (batch_id is not null and public.is_current_batch_trainer(batch_id))));

-- Audit: Super Admin all; trainer — only actions they performed.
create policy user_admin_events_admin_select
  on public.user_admin_events for select to authenticated
  using ((select public.is_super_admin()));
create policy user_admin_events_trainer_select
  on public.user_admin_events for select to authenticated
  using ((select public.current_app_role()) = 'trainer' and actor_id = (select auth.uid()));

-- Enrolment history: Super Admin all; trainer — batches they currently teach.
create policy enrollment_events_admin_select
  on public.enrollment_events for select to authenticated
  using ((select public.is_super_admin()));
create policy enrollment_events_trainer_select
  on public.enrollment_events for select to authenticated
  using (public.is_current_batch_trainer(batch_id));

commit;
