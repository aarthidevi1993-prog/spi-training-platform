-- ===================================================================
-- 0030 — COURSE MANAGEMENT
--
-- Courses are permanent, reusable catalogue records: a batch selects an
-- existing course and owns its own dates, trainer, students and training
-- records (unchanged: batches.course_id → courses ON DELETE RESTRICT).
--
-- 1. Automatic course codes (the 0020 convention):
--      CRS-00001, CRS-00002, …   (sequence course_code_seq, ≥ 5 digits,
--      never reused; started above every existing CRS- number). Module codes
--      are generated per course: M01, M02, … Existing codes are never
--      changed. Course and module codes are immutable for every writer, and
--      unique case-insensitively.
-- 2. Writes only through the Super Admin functions below. A direct client
--    INSERT / UPDATE / DELETE on courses or modules (authenticated / anon)
--    is refused, so every change is validated and audited. Privileged
--    writers (these SECURITY DEFINER functions, SQL Editor, service role)
--    may write; a missing code is generated.
-- 3. Audit: public.course_events (append-only; time and actor stamped by
--    the database; Super Admin read only). Survives a course deletion.
-- 4. Historical protection (smallest safe design, no snapshot columns):
--    once a course has delivered training — a batch ongoing/completed, a
--    class live/completed or past, or any attendance, test attempt,
--    assignment submission, completion record or certificate in one of its
--    batches — its title, level and planned duration and its module
--    structure are locked. Description
--    and status stay editable (audited). Issued certificates already keep
--    their own course code/title copy (0011). A module referenced by a
--    class or a question can never be deleted (classes.module_id would
--    otherwise be silently set to NULL).
-- 5. Removal: only a DRAFT course that was never published and that nothing
--    references (batches, classes, questions) can be deleted (audited).
--    "Never published" must be proven by its own history (created as a
--    draft through Course Management); a course that existed before 0030
--    has no such history and is therefore never deleted.
--    Active (published) and inactive (archived) courses are kept permanently;
--    "inactive" is the archived status.
-- 6. Batches: a client can create a batch only for a PUBLISHED course, and
--    a batch's course can never be changed afterwards (any writer).
-- 7. Duplicates: two non-archived courses cannot share a title
--    (case- and whitespace-insensitive), so one catalogue record is reused
--    instead of being re-created per batch.
--
-- 8. Archived courses take no new students into an UPCOMING batch (ongoing
--    batches stay open): admin_set_enrollment, trainer_enroll_student,
--    create_user_invitation and accept_user_invitation (section 7).
--
-- Unchanged: every existing table, column, RLS policy and grant, and every
-- other function. Requires 0020–0029, 0029a (and the 0017 helpers); the
-- four replaced functions must be exactly their expected previous versions.
-- ===================================================================

begin;

do $$
declare
  v_dup text;
begin
  if to_regclass('public.student_code_seq') is null
     or to_regprocedure('public.user_mgmt_check_keys(jsonb, text[])') is null
     or to_regprocedure('public.user_mgmt_append_only_guard()') is null then
    raise exception 'Preflight failed: 0017 and 0020 must be applied first.';
  end if;
  if to_regclass('public.course_code_seq') is not null or to_regclass('public.course_events') is not null then
    raise exception 'Preflight failed: 0030 already applied?';
  end if;
  -- Section 7 replaces four functions with their previous text plus one check: require EXACTLY those previous
  -- versions — the whole body, by a whitespace-insensitive fingerprint (as 0029a does), not a comment marker — so a
  -- definition that differs in any other way (permissions, transitions, capacity, binding, audit …) is never
  -- silently overwritten: 0030 stops here and changes nothing.
  if coalesce((select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
                where p.oid = to_regprocedure('public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)')), '')
       <> 'ab35b62993ccd6464b940540bd443e24'   -- 0023
     or coalesce((select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
                   where p.oid = to_regprocedure('public.trainer_enroll_student(uuid, uuid)')), '')
       <> '0f37c61f7eac679b128dde27ab905ee1'   -- 0023
     or coalesce((select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
                   where p.oid = to_regprocedure('public.create_user_invitation(jsonb)')), '')
       <> 'f86798cd0a6f4e66c06eb2752168c6ab'   -- 0028
     or coalesce((select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
                   where p.oid = to_regprocedure('public.accept_user_invitation()')), '')
       <> '96dd1023a79442f8db66e2e5ef5510f1' then   -- 0029a
    -- P5.2: accept_user_invitation must be the 0029a version (binding rule), so 0030 never re-opens unbound acceptance.
    raise exception 'Preflight failed: admin_set_enrollment / trainer_enroll_student (0023), create_user_invitation (0028) and accept_user_invitation (0029a) must be the current versions (exact definitions; a different definition is never overwritten). Nothing was changed.';
  end if;
  select string_agg(c, ', ') into v_dup from (
    select lower(course_code) as c from public.courses group by lower(course_code) having count(*) > 1) d;
  if v_dup is not null then
    raise exception 'Preflight failed: course codes collide case-insensitively (%). Resolve them first; 0030 changes no existing code.', v_dup;
  end if;
  select string_agg(c, ', ') into v_dup from (
    select course_id::text || ' ' || lower(module_code) as c from public.modules group by course_id, lower(module_code) having count(*) > 1) d;
  if v_dup is not null then
    raise exception 'Preflight failed: module codes collide case-insensitively within a course (%).', v_dup;
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Course code sequence and case-insensitive uniqueness
-- -------------------------------------------------------------------
create sequence public.course_code_seq as bigint minvalue 1;
select setval('public.course_code_seq', coalesce(max(n), 0) + 1, false)
  from (select (regexp_match(course_code, '^CRS-([0-9]{1,18})$', 'i'))[1]::bigint as n from public.courses) m;
revoke all on sequence public.course_code_seq from public, anon, authenticated;

create unique index courses_course_code_ci_key on public.courses (lower(course_code));
create unique index modules_course_module_code_ci_key on public.modules (course_id, lower(module_code));

-- -------------------------------------------------------------------
-- 2. Audit table
-- -------------------------------------------------------------------
create type public.course_event_type as enum (
  'course_created', 'course_updated', 'course_status_changed', 'course_deleted',
  'module_created', 'module_updated', 'module_moved', 'module_deleted'
);

create table public.course_events (
  id           bigint                    generated always as identity,
  occurred_at  timestamptz               not null default now(),
  actor_id     uuid                      null references public.profiles (id) on delete restrict,
  event_type   public.course_event_type  not null,
  -- Not foreign keys on purpose: the history outlives a deleted course or module.
  course_id    uuid                      not null,
  module_id    uuid                      null,
  detail       jsonb                     not null default '{}'::jsonb,

  constraint course_events_pkey primary key (id),
  constraint course_events_detail_ok check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096)
);
create index course_events_course_idx on public.course_events (course_id, occurred_at);

-- Append-only; time and actor stamped by the database (the 0017 guards).
create trigger course_events_guard
  before insert or update or delete on public.course_events
  for each row execute function public.user_mgmt_append_only_guard();
create trigger course_events_no_truncate
  before truncate on public.course_events
  for each statement execute function public.user_mgmt_no_truncate();

alter table public.course_events enable row level security;
revoke all on table public.course_events from anon, authenticated;
grant select on table public.course_events to authenticated;
grant all on table public.course_events to service_role;
create policy course_events_admin_select
  on public.course_events for select to authenticated
  using (public.is_super_admin());

-- -------------------------------------------------------------------
-- 3. Internal helpers (no client execute)
-- -------------------------------------------------------------------
-- The next free CRS- code; a number whose code already exists (any case) is skipped, never reused.
create function public.course_mgmt_next_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_n     bigint;
  v_code  text;
  v_tries integer := 0;
begin
  loop
    v_tries := v_tries + 1;
    if v_tries > 1000 then
      raise exception 'Could not allocate a course code.' using errcode = 'P0001';
    end if;
    v_n := nextval('public.course_code_seq');
    v_code := 'CRS-' || lpad(v_n::text, greatest(5, length(v_n::text)), '0');
    exit when not exists (select 1 from public.courses c where lower(c.course_code) = lower(v_code));
  end loop;
  return v_code;
end;
$$;

-- The next free module code of one course: M01, M02, … after the highest existing M<n>.
create function public.course_mgmt_next_module_code(p_course_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_n    integer;
  v_code text;
begin
  select coalesce(max((regexp_match(m.module_code, '^M([0-9]{1,6})$', 'i'))[1]::integer), 0)
    into v_n from public.modules m where m.course_id = p_course_id;
  loop
    v_n := v_n + 1;
    v_code := 'M' || lpad(v_n::text, greatest(2, length(v_n::text)), '0');
    exit when not exists (select 1 from public.modules m where m.course_id = p_course_id and lower(m.module_code) = lower(v_code));
  end loop;
  return v_code;
end;
$$;

-- Delivered training exists. Statuses alone are not enough: the application never moves a batch out
-- of 'upcoming' and class status is set by hand, while attendance, tests, assignments and completion
-- can be recorded regardless. So any of these counts as history:
--   a batch ongoing/completed · a class live/completed, or not cancelled and dated before today ·
--   attendance · a test attempt · an assignment submission · a completion record · a certificate
-- (every training record carries its batch_id; batches carry the course).
create function public.course_mgmt_has_history(p_course_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.batches b where b.course_id = p_course_id and b.status in ('ongoing', 'completed'))
      or exists (select 1 from public.classes c
                  where c.course_id = p_course_id
                    and (c.status in ('live', 'completed') or (c.status <> 'cancelled' and c.class_date < current_date)))
      or exists (select 1 from public.batches b
                  where b.course_id = p_course_id
                    and (   exists (select 1 from public.class_attendance x where x.batch_id = b.id)
                         or exists (select 1 from public.test_attempts x where x.batch_id = b.id)
                         or exists (select 1 from public.assignment_submissions x where x.batch_id = b.id)
                         or exists (select 1 from public.completion_records x where x.batch_id = b.id)
                         or exists (select 1 from public.certificates x where x.batch_id = b.id)));
$$;

-- Anything that references the course (deletion would erase or orphan it).
create function public.course_mgmt_in_use(p_course_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.batches b where b.course_id = p_course_id)
      or exists (select 1 from public.classes c where c.course_id = p_course_id)
      or exists (select 1 from public.questions q where q.course_id = p_course_id);
$$;

-- The course has (or may have) been published at some point. Conservative: only a course whose history PROVES it
-- was created as a draft through Course Management (course_created with status 'draft') and never published since
-- counts as never published. A course that existed before 0030 has no course_created event, so its publication
-- history is unknown and it is treated as published. An active, once-published or legacy course is never
-- deleted — it is deactivated instead.
create function public.course_mgmt_ever_published(p_course_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from public.course_events e
                      where e.course_id = p_course_id
                        and e.event_type = 'course_created' and e.detail ->> 'status' = 'draft')
      or exists (select 1 from public.course_events e
                  where e.course_id = p_course_id
                    and ((e.event_type = 'course_created' and e.detail ->> 'status' = 'published')
                      or (e.event_type = 'course_status_changed' and e.detail ->> 'to' = 'published')));
$$;

-- Another non-archived course with the same title (case/whitespace-insensitive), or NULL.
create function public.course_mgmt_title_clash(p_title text, p_excluding uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('existing_course_id', c.id, 'existing_course_code', c.course_code, 'existing_status', c.status)
    from public.courses c
   where c.status <> 'archived'
     and c.id is distinct from p_excluding
     and regexp_replace(lower(btrim(c.title)), '\s+', ' ', 'g') = regexp_replace(lower(btrim(p_title)), '\s+', ' ', 'g')
   order by c.created_at
   limit 1;
$$;

create function public.course_mgmt_level(p_value text)
returns public.course_level
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value not in ('foundation', 'intermediate', 'advanced') then
    raise exception 'level must be foundation, intermediate or advanced.' using errcode = '22023';
  end if;
  return p_value::public.course_level;
end;
$$;

-- Hours from a jsonb number: 0 … 9999.9, at most one decimal place (numeric(6, 1)).
create function public.course_mgmt_hours(p jsonb, p_key text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if jsonb_typeof(p -> p_key) is distinct from 'number' then
    raise exception '% must be a number of hours.', p_key using errcode = '22023';
  end if;
  v := (p ->> p_key)::numeric;
  if v < 0 or v > 9999.9 or v <> round(v, 1) then
    raise exception '% must be between 0 and 9999.9 hours, with at most one decimal place.', p_key using errcode = '22023';
  end if;
  return v;
end;
$$;

create function public.course_mgmt_log(p_type public.course_event_type, p_course uuid, p_module uuid, p_detail jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.course_events (event_type, course_id, module_id, detail)
  values (p_type, p_course, p_module, coalesce(p_detail, '{}'::jsonb));
$$;

revoke all on function public.course_mgmt_next_code() from public, anon, authenticated;
revoke all on function public.course_mgmt_next_module_code(uuid) from public, anon, authenticated;
revoke all on function public.course_mgmt_has_history(uuid) from public, anon, authenticated;
revoke all on function public.course_mgmt_in_use(uuid) from public, anon, authenticated;
revoke all on function public.course_mgmt_ever_published(uuid) from public, anon, authenticated;
revoke all on function public.course_mgmt_title_clash(text, uuid) from public, anon, authenticated;
revoke all on function public.course_mgmt_level(text) from public, anon, authenticated;
revoke all on function public.course_mgmt_hours(jsonb, text) from public, anon, authenticated;
revoke all on function public.course_mgmt_log(public.course_event_type, uuid, uuid, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------------
-- 4. Guards (every writer)
-- -------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user is the real writer (the function owner inside the
-- SECURITY DEFINER functions below; authenticated / anon for a direct PostgREST write).
create function public.course_mgmt_course_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_client then
      raise exception 'Courses are created through Course Management; course codes are assigned automatically.' using errcode = '42501';
    end if;
    if new.course_code is null then
      new.course_code := public.course_mgmt_next_code();
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.course_code is distinct from old.course_code then
      raise exception 'Course codes cannot be changed.' using errcode = '42501';
    end if;
    if v_client then
      raise exception 'Courses are changed through Course Management.' using errcode = '42501';
    end if;
    return new;
  end if;
  if v_client then
    raise exception 'Courses are removed through Course Management.' using errcode = '42501';
  end if;
  return old;
end;
$$;

create function public.course_mgmt_module_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if v_client then
    raise exception 'Modules are managed through Course Management.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.module_code is null then
      new.module_code := public.course_mgmt_next_module_code(new.course_id);
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.module_code is distinct from old.module_code then
      raise exception 'Module codes cannot be changed.' using errcode = '42501';
    end if;
    if new.course_id is distinct from old.course_id then
      raise exception 'A module cannot be moved to another course.' using errcode = '42501';
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- A Super Admin client may create a batch only for a published course. A batch's course never
-- changes, whoever writes.
create function public.course_mgmt_batch_course_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.course_status;
begin
  if tg_op = 'UPDATE' then
    if new.course_id is distinct from old.course_id then
      raise exception 'A batch''s course cannot be changed. Create a new batch for the other course.'
        using errcode = '23514', hint = 'batch_course_fixed';
    end if;
    return new;
  end if;
  -- Only a Super Admin client can pass the batches RLS write policy; anyone else keeps the RLS
  -- refusal (42501), so the check runs for Super Admin clients only. An unknown course is left to
  -- the foreign key (23503).
  if current_user in ('authenticated', 'anon') and public.is_super_admin() then
    select c.status into v_status from public.courses c where c.id = new.course_id;
    if found and v_status <> 'published' then
      raise exception 'New batches can only be created for a published course.'
        using errcode = '23514', hint = 'course_not_published';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.course_mgmt_course_guard() from public, anon, authenticated;
revoke all on function public.course_mgmt_module_guard() from public, anon, authenticated;
revoke all on function public.course_mgmt_batch_course_guard() from public, anon, authenticated;

create trigger courses_course_mgmt_guard
  before insert or update or delete on public.courses
  for each row execute function public.course_mgmt_course_guard();
create trigger modules_course_mgmt_guard
  before insert or update or delete on public.modules
  for each row execute function public.course_mgmt_module_guard();
create trigger batches_course_guard
  before insert or update of course_id on public.batches
  for each row execute function public.course_mgmt_batch_course_guard();

-- -------------------------------------------------------------------
-- 5. Super Admin functions
--    Results: {ok: true, …} or {ok: false, reason}. Not a Super Admin →
--    42501. Malformed input → 22023.
-- -------------------------------------------------------------------
create function public.admin_create_course(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title  text;
  v_desc   text;
  v_level  public.course_level;
  v_hours  numeric;
  v_status text;
  v_clash  jsonb;
  v_id     uuid;
  v_code   text;
begin
  perform public.user_mgmt_require_super_admin();
  perform public.user_mgmt_check_keys(p, array['title', 'description', 'level', 'duration_hours', 'status']);
  v_title := public.user_mgmt_text(p, 'title', 150);
  if v_title is null then
    raise exception 'A course title is required.' using errcode = '22023';
  end if;
  v_desc  := coalesce(public.user_mgmt_text(p, 'description', 2000), '');
  v_level := public.course_mgmt_level(p ->> 'level');
  v_hours := public.course_mgmt_hours(p, 'duration_hours');
  v_status := coalesce(nullif(btrim(p ->> 'status'), ''), 'draft');
  if v_status not in ('draft', 'published') then
    raise exception 'A new course starts as draft or published.' using errcode = '22023';
  end if;

  -- Serialize title checks so two simultaneous creations cannot both pass.
  perform pg_advisory_xact_lock(hashtext('public.courses.title'));
  v_clash := public.course_mgmt_title_clash(v_title, null);
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_title') || v_clash;
  end if;

  insert into public.courses (title, description, level, duration_hours, status, created_by)
  values (v_title, v_desc, v_level, v_hours, v_status::public.course_status, auth.uid())
  returning id, course_code into v_id, v_code;

  perform public.course_mgmt_log('course_created', v_id, null,
    jsonb_build_object('course_code', v_code, 'title', v_title, 'status', v_status));
  return jsonb_build_object('ok', true, 'course_id', v_id, 'course_code', v_code);
end;
$$;

create function public.admin_update_course(p_course_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r        public.courses%rowtype;
  v_title  text;
  v_desc   text;
  v_level  public.course_level;
  v_hours  numeric;
  v_fields text[] := '{}';
  v_before jsonb := '{}'::jsonb;
  v_locked text[];
  v_clash  jsonb;
begin
  perform public.user_mgmt_require_super_admin();
  perform public.user_mgmt_check_keys(p, array['title', 'description', 'level', 'duration_hours']);
  select * into r from public.courses c where c.id = p_course_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- The 150-character limit applies to a NEW title only: an unchanged legacy title (possibly longer,
  -- from before this limit) is kept as stored, so other fields stay editable.
  v_title := case when p ? 'title' then nullif(btrim(p ->> 'title'), '') else r.title end;
  if v_title is null then
    raise exception 'A course title is required.' using errcode = '22023';
  end if;
  if v_title = btrim(r.title) then
    v_title := r.title;
  elsif char_length(v_title) > 150 then
    raise exception 'title is too long (at most 150 characters).' using errcode = '22023';
  end if;
  v_desc  := case when p ? 'description' then coalesce(public.user_mgmt_text(p, 'description', 2000), '') else r.description end;
  v_level := case when p ? 'level' then public.course_mgmt_level(p ->> 'level') else r.level end;
  v_hours := case when p ? 'duration_hours' then public.course_mgmt_hours(p, 'duration_hours') else r.duration_hours end;

  if v_title is distinct from r.title then
    v_fields := array_append(v_fields, 'title');
    v_before := v_before || jsonb_build_object('title', r.title);
  end if;
  if v_level is distinct from r.level then
    v_fields := array_append(v_fields, 'level');
    v_before := v_before || jsonb_build_object('level', r.level);
  end if;
  if v_hours is distinct from r.duration_hours then
    v_fields := array_append(v_fields, 'duration_hours');
    v_before := v_before || jsonb_build_object('duration_hours', r.duration_hours);
  end if;
  if v_desc is distinct from r.description then
    v_fields := array_append(v_fields, 'description');   -- the old text is not copied into the log
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;

  select coalesce(array_agg(f), '{}') into v_locked from unnest(v_fields) f where f in ('title', 'level', 'duration_hours');
  if cardinality(v_locked) > 0 and public.course_mgmt_has_history(p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_has_history', 'fields', to_jsonb(v_locked));
  end if;

  if 'title' = any (v_fields) and r.status <> 'archived' then
    perform pg_advisory_xact_lock(hashtext('public.courses.title'));
    v_clash := public.course_mgmt_title_clash(v_title, p_course_id);
    if v_clash is not null then
      return jsonb_build_object('ok', false, 'reason', 'duplicate_title') || v_clash;
    end if;
  end if;

  update public.courses c
     set title = v_title, description = v_desc, level = v_level, duration_hours = v_hours
   where c.id = p_course_id;
  perform public.course_mgmt_log('course_updated', p_course_id, null,
    jsonb_build_object('fields', to_jsonb(v_fields), 'before', v_before));
  return jsonb_build_object('ok', true, 'fields', to_jsonb(v_fields));
end;
$$;

-- draft ⇄ published ⇄ archived. Back to draft only while no batch uses the course. Leaving
-- "archived" is refused while another non-archived course has the same title.
create function public.admin_set_course_status(p_course_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r       public.courses%rowtype;
  v_clash jsonb;
begin
  perform public.user_mgmt_require_super_admin();
  if p_status is null or p_status not in ('draft', 'published', 'archived') then
    raise exception 'Status must be draft, published or archived.' using errcode = '22023';
  end if;
  select * into r from public.courses c where c.id = p_course_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status::text = p_status then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  if p_status = 'draft' and exists (select 1 from public.batches b where b.course_id = p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'has_batches');
  end if;
  if r.status = 'archived' then
    perform pg_advisory_xact_lock(hashtext('public.courses.title'));
    v_clash := public.course_mgmt_title_clash(r.title, p_course_id);
    if v_clash is not null then
      return jsonb_build_object('ok', false, 'reason', 'duplicate_title') || v_clash;
    end if;
  end if;

  update public.courses c set status = p_status::public.course_status where c.id = p_course_id;
  perform public.course_mgmt_log('course_status_changed', p_course_id, null,
    jsonb_build_object('from', r.status, 'to', p_status));
  return jsonb_build_object('ok', true, 'from', r.status, 'to', p_status);
end;
$$;

-- Permanent deletion only for a DRAFT course that was never published and that nothing references
-- (no batches, classes or questions). Active and inactive courses — and any course that was ever
-- published — are kept permanently (deactivate instead).
create function public.admin_delete_course(p_course_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.courses%rowtype;
begin
  perform public.user_mgmt_require_super_admin();
  select * into r from public.courses c where c.id = p_course_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft');
  end if;
  if public.course_mgmt_ever_published(p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'was_published');
  end if;
  if public.course_mgmt_in_use(p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_in_use');
  end if;
  begin
    delete from public.courses c where c.id = p_course_id;   -- its modules go with it
  exception when foreign_key_violation then
    return jsonb_build_object('ok', false, 'reason', 'course_in_use');
  end;
  perform public.course_mgmt_log('course_deleted', p_course_id, null,
    jsonb_build_object('course_code', r.course_code, 'title', r.title));
  return jsonb_build_object('ok', true, 'course_code', r.course_code);
end;
$$;

-- Modules: appended at the end; code generated. Refused once the course has delivered training.
create function public.admin_create_module(p_course_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_desc  text;
  v_hours numeric := 0;
  v_seq   integer;
  v_code  text;
  v_id    uuid;
begin
  perform public.user_mgmt_require_super_admin();
  perform public.user_mgmt_check_keys(p, array['title', 'description', 'duration_hours']);
  -- The course row lock serializes module changes of one course.
  perform 1 from public.courses c where c.id = p_course_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_title := public.user_mgmt_text(p, 'title', 150);
  if v_title is null then
    raise exception 'A module title is required.' using errcode = '22023';
  end if;
  v_desc := public.user_mgmt_text(p, 'description', 1000);
  if p ? 'duration_hours' then
    v_hours := public.course_mgmt_hours(p, 'duration_hours');
  end if;
  if public.course_mgmt_has_history(p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_has_history');
  end if;

  select coalesce(max(m.sequence), 0) + 1 into v_seq from public.modules m where m.course_id = p_course_id;
  v_code := public.course_mgmt_next_module_code(p_course_id);
  insert into public.modules (course_id, module_code, title, description, sequence, duration_hours)
  values (p_course_id, v_code, v_title, v_desc, v_seq, v_hours)
  returning id into v_id;

  perform public.course_mgmt_log('module_created', p_course_id, v_id,
    jsonb_build_object('module_code', v_code, 'title', v_title, 'sequence', v_seq));
  return jsonb_build_object('ok', true, 'module_id', v_id, 'module_code', v_code, 'sequence', v_seq);
end;
$$;

create function public.admin_update_module(p_module_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m        public.modules%rowtype;
  v_title  text;
  v_desc   text;
  v_hours  numeric;
  v_fields text[] := '{}';
  v_before jsonb := '{}'::jsonb;
begin
  perform public.user_mgmt_require_super_admin();
  perform public.user_mgmt_check_keys(p, array['title', 'description', 'duration_hours']);
  select * into m from public.modules x where x.id = p_module_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform 1 from public.courses c where c.id = m.course_id for update;
  select * into m from public.modules x where x.id = p_module_id for update;

  v_title := case when p ? 'title' then public.user_mgmt_text(p, 'title', 150) else m.title end;
  if v_title is null then
    raise exception 'A module title is required.' using errcode = '22023';
  end if;
  v_desc  := case when p ? 'description' then public.user_mgmt_text(p, 'description', 1000) else m.description end;
  -- Empty and missing are the same description (legacy rows may hold ''): no false change, row kept as is.
  if coalesce(v_desc, '') = coalesce(m.description, '') then
    v_desc := m.description;
  end if;
  v_hours := case when p ? 'duration_hours' then public.course_mgmt_hours(p, 'duration_hours') else m.duration_hours end;

  if v_title is distinct from m.title then
    v_fields := array_append(v_fields, 'title');
    v_before := v_before || jsonb_build_object('title', m.title);
  end if;
  if v_hours is distinct from m.duration_hours then
    v_fields := array_append(v_fields, 'duration_hours');
    v_before := v_before || jsonb_build_object('duration_hours', m.duration_hours);
  end if;
  if v_desc is distinct from m.description then
    v_fields := array_append(v_fields, 'description');
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;
  if public.course_mgmt_has_history(m.course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_has_history');
  end if;

  update public.modules x set title = v_title, description = v_desc, duration_hours = v_hours where x.id = p_module_id;
  perform public.course_mgmt_log('module_updated', m.course_id, p_module_id,
    jsonb_build_object('module_code', m.module_code, 'fields', to_jsonb(v_fields), 'before', v_before));
  return jsonb_build_object('ok', true, 'fields', to_jsonb(v_fields));
end;
$$;

-- Swap a module with its neighbour ('up' = earlier, 'down' = later).
create function public.admin_move_module(p_module_id uuid, p_direction text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m       public.modules%rowtype;
  n       public.modules%rowtype;
  v_temp  integer;
begin
  perform public.user_mgmt_require_super_admin();
  if p_direction is null or p_direction not in ('up', 'down') then
    raise exception 'Direction must be up or down.' using errcode = '22023';
  end if;
  select * into m from public.modules x where x.id = p_module_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform 1 from public.courses c where c.id = m.course_id for update;
  select * into m from public.modules x where x.id = p_module_id;
  if public.course_mgmt_has_history(m.course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_has_history');
  end if;
  if p_direction = 'up' then
    select * into n from public.modules x where x.course_id = m.course_id and x.sequence < m.sequence order by x.sequence desc limit 1;
  else
    select * into n from public.modules x where x.course_id = m.course_id and x.sequence > m.sequence order by x.sequence asc limit 1;
  end if;
  if n.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unchanged');
  end if;

  -- Three steps through a free number: (course_id, sequence) is unique and sequence > 0.
  select max(x.sequence) + 1 into v_temp from public.modules x where x.course_id = m.course_id;
  update public.modules x set sequence = v_temp where x.id = m.id;
  update public.modules x set sequence = m.sequence where x.id = n.id;
  update public.modules x set sequence = n.sequence where x.id = m.id;

  perform public.course_mgmt_log('module_moved', m.course_id, m.id,
    jsonb_build_object('module_code', m.module_code, 'from', m.sequence, 'to', n.sequence));
  return jsonb_build_object('ok', true, 'from', m.sequence, 'to', n.sequence);
end;
$$;

-- Delete a module that nothing references; later modules move up one place.
create function public.admin_delete_module(p_module_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m public.modules%rowtype;
  r record;
begin
  perform public.user_mgmt_require_super_admin();
  select * into m from public.modules x where x.id = p_module_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform 1 from public.courses c where c.id = m.course_id for update;
  select * into m from public.modules x where x.id = p_module_id;
  if public.course_mgmt_has_history(m.course_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_has_history');
  end if;
  if exists (select 1 from public.classes c where c.module_id = p_module_id)
     or exists (select 1 from public.questions q where q.module_id = p_module_id) then
    return jsonb_build_object('ok', false, 'reason', 'module_in_use');
  end if;

  delete from public.modules x where x.id = p_module_id;
  for r in select x.id, x.sequence from public.modules x
            where x.course_id = m.course_id and x.sequence > m.sequence order by x.sequence loop
    update public.modules x set sequence = r.sequence - 1 where x.id = r.id;
  end loop;

  perform public.course_mgmt_log('module_deleted', m.course_id, p_module_id,
    jsonb_build_object('module_code', m.module_code, 'title', m.title, 'sequence', m.sequence));
  return jsonb_build_object('ok', true);
end;
$$;

-- What the course page needs to offer only allowed actions: usage, the history lock, its batches.
create function public.admin_course_usage(p_course_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.user_mgmt_require_super_admin();
  if not exists (select 1 from public.courses c where c.id = p_course_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object(
    'ok', true,
    'has_history', public.course_mgmt_has_history(p_course_id),
    'can_delete', (select c.status = 'draft' from public.courses c where c.id = p_course_id)
                  and not public.course_mgmt_ever_published(p_course_id)
                  and not public.course_mgmt_in_use(p_course_id),
    'batch_count', (select count(*) from public.batches b where b.course_id = p_course_id),
    -- What archiving affects: upcoming batches stop taking new students, ongoing ones continue, and a
    -- pending invitation into an upcoming batch will activate the account without enrolling it.
    'upcoming_batch_count', (select count(*) from public.batches b where b.course_id = p_course_id and b.status = 'upcoming'),
    'ongoing_batch_count', (select count(*) from public.batches b where b.course_id = p_course_id and b.status = 'ongoing'),
    'pending_upcoming_invitation_count', (
      select count(*) from public.user_invitations i join public.batches b on b.id = i.batch_id
       where b.course_id = p_course_id and b.status = 'upcoming' and i.status = 'pending' and i.expires_at > now()),
    'class_count', (select count(*) from public.classes c where c.course_id = p_course_id),
    'question_count', (select count(*) from public.questions q where q.course_id = p_course_id),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'batch_code', x.batch_code, 'name', x.name, 'status', x.status,
               'start_date', x.start_date, 'end_date', x.end_date, 'trainer_name', x.trainer_name)
             order by x.start_date desc, x.batch_code)
        from (select b.id, b.batch_code, b.name, b.status, b.start_date, b.end_date, t.full_name as trainer_name
                from public.batches b left join public.trainers t on t.id = b.trainer_id
               where b.course_id = p_course_id
               order by b.start_date desc, b.batch_code
               limit 100) x), '[]'::jsonb));
end;
$$;

revoke all on function public.admin_create_course(jsonb) from public, anon;
revoke all on function public.admin_update_course(uuid, jsonb) from public, anon;
revoke all on function public.admin_set_course_status(uuid, text) from public, anon;
revoke all on function public.admin_delete_course(uuid) from public, anon;
revoke all on function public.admin_create_module(uuid, jsonb) from public, anon;
revoke all on function public.admin_update_module(uuid, jsonb) from public, anon;
revoke all on function public.admin_move_module(uuid, text) from public, anon;
revoke all on function public.admin_delete_module(uuid) from public, anon;
revoke all on function public.admin_course_usage(uuid) from public, anon;
grant execute on function public.admin_create_course(jsonb) to authenticated;
grant execute on function public.admin_update_course(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_course_status(uuid, text) to authenticated;
grant execute on function public.admin_delete_course(uuid) to authenticated;
grant execute on function public.admin_create_module(uuid, jsonb) to authenticated;
grant execute on function public.admin_update_module(uuid, jsonb) to authenticated;
grant execute on function public.admin_move_module(uuid, text) to authenticated;
grant execute on function public.admin_delete_module(uuid) to authenticated;
grant execute on function public.admin_course_usage(uuid) to authenticated;


-- -------------------------------------------------------------------
-- 7. Archived courses: no new students in batches that haven't started
--    An archived course keeps its ongoing batches open (enrolment, classes,
--    attendance, tests, assignments, completion all continue), but takes no
--    new or returning students into an UPCOMING batch. Enforced in every
--    enrolment entry point (direct batch_students writes are already refused
--    for clients by 0023):
--      admin_set_enrollment     enrol / re-enrol refused: reason course_archived
--      trainer_enroll_student   refused: reason course_archived
--      create_user_invitation   an invitation into such a batch: reason course_archived
--      accept_user_invitation   the account is still activated; the batch
--                               enrolment is skipped (enrolled: false, plus
--                               enrolment_skipped: course_archived so the
--                               invitee can be told why)
--    Withdrawal and completion are unaffected. Each function below is the
--    previous definition verbatim (0023 / 0023 / 0028 / 0029a — checked by
--    fingerprint in the preflight) plus that one check; grants are kept by
--    CREATE OR REPLACE.
-- -------------------------------------------------------------------

-- True while the batch is upcoming and its course archived. The course row is read FOR SHARE, so an
-- archive (which locks the course row FOR UPDATE) and an enrolment can't interleave.
create function public.course_mgmt_enrolment_closed(p_batch_id uuid)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_batch  public.batch_status;
  v_course public.course_status;
begin
  select b.status, c.status into v_batch, v_course
    from public.batches b join public.courses c on c.id = b.course_id
   where b.id = p_batch_id
     for share of c;
  return found and v_batch = 'upcoming' and v_course = 'archived';
end;
$$;

revoke all on function public.course_mgmt_enrolment_closed(uuid) from public, anon, authenticated;

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
    -- 0030: an archived course takes no new students into a batch that hasn't started.
    if public.course_mgmt_enrolment_closed(p_batch_id) then
      return jsonb_build_object('ok', false, 'reason', 'course_archived');
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
  -- 0030: an archived course takes no new students into a batch that hasn't started.
  if public.course_mgmt_enrolment_closed(p_batch_id) then
    return jsonb_build_object('ok', false, 'reason', 'course_archived');
  end if;
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
    -- 0030: an archived course takes no new students into a batch that hasn't started.
    if public.course_mgmt_enrolment_closed(v_batch) then
      return jsonb_build_object('ok', false, 'reason', 'course_archived');
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
  v_closed   boolean := false;   -- 0030
  v_skipped  text;               -- 0030: why a batch enrolment was skipped (only 'course_archived' is reported)
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
      -- 0030: not into an upcoming batch of an archived course (the account is still activated, and the
      -- result says why, so the invitee can be told to ask a Super Admin for an available batch).
      v_closed := public.course_mgmt_enrolment_closed(i.batch_id);
      if v_bstatus in ('upcoming', 'ongoing') and v_taken < v_seats and not v_closed then
        perform set_config('app.enrollment_source', 'invitation', true);
        perform set_config('app.enrollment_reason', 'Accepted invitation', true);
        insert into public.batch_students (batch_id, student_id, enrolled_by) values (i.batch_id, v_uid, i.invited_by);
        perform set_config('app.enrollment_source', '', true);
        perform set_config('app.enrollment_reason', '', true);
        v_enrolled := true;
      elsif v_closed then
        v_skipped := 'course_archived';
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
    jsonb_build_object('role', i.intended_role, 'enrolled', v_enrolled)
      || case when v_skipped is not null then jsonb_build_object('enrolment_skipped', v_skipped) else '{}'::jsonb end);
  return jsonb_build_object('ok', true, 'role', i.intended_role, 'enrolled', v_enrolled)
      || case when v_skipped is not null then jsonb_build_object('enrolment_skipped', v_skipped) else '{}'::jsonb end;
end;
$$;

commit;
