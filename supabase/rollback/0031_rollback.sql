-- ===================================================================
-- ROLLBACK for 0031 — restore the 0030 admin_create_course,
-- admin_update_course, admin_create_module and admin_update_module
--
-- NOT a migration (kept outside supabase/migrations so no tool applies it
-- automatically). Run manually in the SQL Editor of the SAME project, after
-- a fresh, verified backup (docs/runbooks/live-migration-0031.md, section 3:
-- backup) and only as described in its section 8 (rollback, including the
-- project name and reference check).
--
-- Effect: the four functions are again exactly their 0030 versions, so a
-- planned duration of 0 hours is accepted again for courses and modules, and
-- a module created without hours is stored with 0. No table, constraint,
-- policy, trigger, grant or row is changed (0031 changed none either):
-- courses and modules created or edited while 0031 was active keep their
-- values, and course_events audit rows stay.
--
-- The four bodies below are copied verbatim from the reviewed
-- supabase/migrations/0030_course_management.sql (SHA-256 62352c5d…), only
-- "create function" → "create or replace function". CREATE OR REPLACE keeps
-- each function's owner, signature and grants (EXECUTE for authenticated,
-- none for anon/public); SECURITY DEFINER and search_path '' are restated.
-- Authorization (user_mgmt_require_super_admin) and audit logging
-- (course_mgmt_log) are part of the restored bodies.
--
-- Preflight: refuses unless 0030 is applied and ALL FOUR functions are
-- exactly their 0031 versions (whole-body md5, whitespace-insensitive).
-- Postflight: verifies the 0030 fingerprints, SECURITY DEFINER,
-- search_path '', EXECUTE for authenticated and none for anon.
-- One transaction: any error changes nothing.
-- ===================================================================

begin;

do $pre$
declare
  f record;
begin
  if to_regclass('public.course_events') is null or to_regclass('public.course_code_seq') is null then
    raise exception 'Rollback preflight failed: 0030 is not applied. Nothing was changed.';
  end if;
  for f in select * from (values
      ('public.admin_create_course(jsonb)',       '9bc1a7322603269f0b452ac23ea4fa2a'),
      ('public.admin_update_course(uuid, jsonb)', '6cbf926a4e84ea6a400b17038e18efd8'),
      ('public.admin_create_module(uuid, jsonb)', '81b8a6995ff2cf06658e93ba682fc92c'),
      ('public.admin_update_module(uuid, jsonb)', '6606099e4bf723e8aff28a5cb944b4fe')
    ) as x(signature, fp_0031) loop
    if coalesce((select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
                  where p.oid = to_regprocedure(f.signature)), '') <> f.fp_0031 then
      raise exception 'Rollback preflight failed: % is not exactly the 0031 version (a different definition is never overwritten). Nothing was changed.', f.signature;
    end if;
  end loop;
end
$pre$;

-- The 0030 definitions, verbatim.
create or replace function public.admin_create_course(p jsonb)
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

create or replace function public.admin_update_course(p_course_id uuid, p jsonb)
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

create or replace function public.admin_create_module(p_course_id uuid, p jsonb)
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

create or replace function public.admin_update_module(p_module_id uuid, p jsonb)
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

do $post$
declare
  f record;
begin
  for f in select * from (values
      ('public.admin_create_course(jsonb)',       '620460b943f6e2e8b7cbc5da78f2a1d0'),
      ('public.admin_update_course(uuid, jsonb)', '91ee8f6a9843e45904ff2aeb8ef74966'),
      ('public.admin_create_module(uuid, jsonb)', 'a8c18b39b659eafbebe9c167d9b1a0cf'),
      ('public.admin_update_module(uuid, jsonb)', '77162d7b0e422a0aa89ede5e4018221b')
    ) as x(signature, fp_0030) loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = to_regprocedure(f.signature)
         and md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) = f.fp_0030
         and p.prosecdef
         and p.proconfig = array['search_path=""']
         and has_function_privilege('authenticated', p.oid, 'execute')
         and not has_function_privilege('anon', p.oid, 'execute')) then
      raise exception 'Rollback postflight failed: % does not have the 0030 definition, attributes or grants.', f.signature;
    end if;
  end loop;
end
$post$;

commit;
