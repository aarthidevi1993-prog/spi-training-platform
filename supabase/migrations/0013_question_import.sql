-- ===================================================================
-- 0013 — BULK QUESTION IMPORT (import history + chunked import engine)
--
-- Server side of the Question Bank bulk import / bulk update. Files are
-- parsed and previewed in the application; this migration records each
-- confirmed import and writes its questions in small atomic chunks
-- through the existing 0007 save_question() rules.
--
--   question_import_runs (id)                               PK
--     created_by → profiles (id)          [restrict]
--     partial unique (created_by) WHERE status = 'in_progress'
--   question_import_items (run_id, row_number)              PK
--     run_id     → question_import_runs (id) [restrict]
--     question_id  (audit reference only — a discarded draft is deleted)
--   question_fingerprint_cache (question_id)                PK (internal)
--     duplicate-check fingerprints, valid for one question revision
--
-- RULES (locked decisions):
--   - New questions are ALWAYS created as draft; a source file can never
--     set a status and nothing here activates a question.
--   - Only DRAFT questions can be bulk-updated. Active and archived
--     questions are protected (their content is what published tests
--     were built from; edit them individually instead).
--   - An update must name the revision seen in the preview; a question
--     changed since then is refused (conflict), never overwritten.
--   - Duplicates (same course, type, normalized text and normalized
--     option set) are refused unless the row explicitly asks to include
--     it anyway. Checked under a per-course lock, so two imports cannot
--     both create the same question.
--   - Scope is the 0007 scope: super admin — every course; trainer —
--     courses they currently teach (is_course_trainer).
--
-- ATOMICITY: import_question_chunk handles at most 100 rows in one
-- transaction. Each row either fully succeeds or is refused with a
-- reason (its own savepoint); any unexpected error rolls back the whole
-- chunk. Rows already imported in the run are reported, never written
-- twice, so a retried chunk is safe. discard_question_import removes the
-- run's created drafts that are still unchanged and unused.
--
-- ACCESS: history is readable by its creator and by super admins; no
-- client writes (functions only). Guard triggers keep history
-- append-only for every writer and refuse any change without a
-- signed-in user. User functions: authenticated only (not anon, not
-- service_role — identity always comes from auth.uid()). Internal
-- helpers: owner only.
--
-- 0013 does NOT alter any existing table, column, policy, trigger or
-- function; questions are written only through save_question().
-- Runs as ONE transaction. Depends on 0001–0012. REVIEW BEFORE RUNNING.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- 0. Preflight — abort unless 0001–0012 are in place and 0013 is not.
-- -------------------------------------------------------------------
do $$
begin
  if current_setting('server_encoding') <> 'UTF8' then
    raise exception 'Preflight failed: the database encoding must be UTF8.';
  end if;

  if to_regclass('public.profiles') is null
     or to_regclass('public.courses') is null
     or to_regclass('public.questions') is null
     or to_regclass('public.question_options') is null
     or to_regclass('public.test_questions') is null
     or to_regclass('public.notifications') is null
     or to_regprocedure('public.save_question(jsonb)') is null
     or to_regprocedure('public.is_course_trainer(uuid)') is null
     or to_regprocedure('public.is_super_admin()') is null
     or to_regprocedure('public.current_app_role()') is null then
    raise exception 'Preflight failed: 0001–0012 objects are missing.';
  end if;

  if to_regclass('public.question_import_runs') is not null
     or to_regclass('public.question_import_items') is not null
     or to_regclass('public.question_fingerprint_cache') is not null
     or to_regtype('public.question_import_source') is not null
     or to_regprocedure('public.import_question_chunk(uuid, jsonb)') is not null then
    raise exception 'Preflight failed: 0013 already applied?';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Types
-- -------------------------------------------------------------------
create type public.question_import_source as enum ('xlsx', 'csv', 'docx', 'pdf', 'pdf_ocr');
create type public.question_import_status as enum ('in_progress', 'completed', 'discarded');
create type public.question_import_action as enum ('create', 'update');

-- -------------------------------------------------------------------
-- 2. Tables
-- -------------------------------------------------------------------

-- One confirmed import. The source file itself is never stored.
create table public.question_import_runs (
  id                uuid                          not null default gen_random_uuid(),
  created_by        uuid                          not null references public.profiles (id) on delete restrict,
  source            public.question_import_source not null,
  file_name         text                          not null,
  file_sha256       text                          not null,
  planned_creates   integer                       not null,
  planned_updates   integer                       not null,
  planned_excluded  integer                       not null,
  status            public.question_import_status not null default 'in_progress',
  created_count     integer                       not null default 0,
  updated_count     integer                       not null default 0,
  discarded_count   integer                       not null default 0,
  created_at        timestamptz                   not null default now(),
  updated_at        timestamptz                   not null default now(),
  completed_at      timestamptz                   null,
  discarded_at      timestamptz                   null,

  constraint question_import_runs_pkey primary key (id),
  constraint question_import_runs_file_name_ok
    check (char_length(btrim(file_name)) between 1 and 255 and file_name !~ '[\x01-\x1f\x7f]'),
  constraint question_import_runs_sha256_ok check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint question_import_runs_planned_ok
    check (planned_creates >= 0 and planned_updates >= 0 and planned_excluded >= 0
           and planned_creates + planned_updates >= 1),
  -- Per-import safeguards (questions detected in one file).
  constraint question_import_runs_planned_limit
    check (planned_creates + planned_updates + planned_excluded
           <= case source when 'xlsx' then 5000 when 'csv' then 10000 else 1000 end),
  constraint question_import_runs_counts_ok
    check (created_count between 0 and planned_creates
           and updated_count between 0 and planned_updates
           and discarded_count between 0 and created_count),
  constraint question_import_runs_times_ok
    check ((status = 'in_progress') = (completed_at is null and discarded_at is null and status <> 'discarded')
           and (status = 'discarded') = (discarded_at is not null))
);

-- At most one import in progress per user.
create unique index question_import_runs_one_in_progress_idx
  on public.question_import_runs (created_by) where status = 'in_progress';
create index question_import_runs_created_by_idx on public.question_import_runs (created_by, created_at desc);

-- One question written by an import (created or updated). Refused rows
-- are reported to the caller but not stored.
create table public.question_import_items (
  run_id             uuid                          not null,
  row_number         integer                       not null,
  action             public.question_import_action not null,
  question_id        uuid                          not null,
  previous_revision  integer                       null,
  new_revision       integer                       not null,
  fingerprint        text                          not null,
  created_at         timestamptz                   not null default now(),

  constraint question_import_items_pkey primary key (run_id, row_number),
  constraint question_import_items_run_fk
    foreign key (run_id) references public.question_import_runs (id) on delete restrict,
  constraint question_import_items_row_ok check (row_number between 1 and 1000000),
  constraint question_import_items_revision_ok
    check (new_revision > 0
           and (action = 'create') = (previous_revision is null)
           and (previous_revision is null or new_revision > previous_revision)),
  constraint question_import_items_fingerprint_ok check (fingerprint ~ '^[0-9a-f]{64}$')
);

create index question_import_items_question_id_idx on public.question_import_items (question_id);

-- Duplicate-check cache (internal; no client access). One row per bank
-- question, valid only for the revision it was computed from — every
-- real change to a question or its options raises questions.revision
-- (0007), so a matching (question_id, revision) is never stale. Filled
-- on demand by the import functions; rows of deleted questions are
-- ignored (joined on the live revision) and pruned on refresh.
create table public.question_fingerprint_cache (
  question_id       uuid     not null,
  course_id         uuid     not null,
  revision          integer  not null,
  fingerprint       text     not null,
  text_fingerprint  text     not null,

  constraint question_fingerprint_cache_pkey primary key (question_id)
);

create index question_fingerprint_cache_course_fp_idx on public.question_fingerprint_cache (course_id, fingerprint);

-- -------------------------------------------------------------------
-- 3. Duplicate fingerprints (internal)
--
-- normalize: Unicode NFKC, ASCII A–Z lower-cased, every run of control
-- characters/spaces (U+0001–U+0020, U+007F) collapsed to one space,
-- ends trimmed. Deterministic and collation-independent, so the
-- application can reproduce it exactly.
-- fingerprint: SHA-256 (hex) of
--   course_id || U+001E || type || U+001E || normalize(text) || U+001E ||
--   normalized option texts sorted by UTF-8 byte order, joined by U+001F
-- (option order and the correct answer are not part of it).
-- text fingerprint (similar-question warnings): SHA-256 of
--   course_id || U+001E || normalize(text)
-- -------------------------------------------------------------------
create function public.question_import_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
           translate(normalize(coalesce(p_text, ''), NFKC),
                     'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
           '[\x01-\x20\x7f]+', ' ', 'g'));
$$;

create function public.question_import_fingerprint(
  p_course_id     uuid,
  p_type          public.question_type,
  p_text          text,
  p_option_texts  text[]
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
           p_course_id::text || chr(30) || p_type::text || chr(30)
           || public.question_import_normalize(p_text) || chr(30)
           || coalesce((select string_agg(x.n, chr(31) order by x.n collate "C")
                          from (select public.question_import_normalize(o) as n
                                  from unnest(p_option_texts) as o) x), ''),
           'UTF8')), 'hex');
$$;

create function public.question_import_text_fingerprint(p_course_id uuid, p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
           p_course_id::text || chr(30) || public.question_import_normalize(p_text), 'UTF8')), 'hex');
$$;

-- Bring the cache up to date for some courses: compute only missing or
-- outdated rows (a question's first check, or after it changed), prune
-- rows of deleted questions. Callers hold the per-course import locks.
create function public.question_import_refresh_fingerprints(p_course_ids uuid[])
returns void
language sql
volatile
set search_path = ''
as $$
  delete from public.question_fingerprint_cache c
   where c.course_id = any(p_course_ids)
     and not exists (select 1 from public.questions q where q.id = c.question_id and q.course_id = c.course_id);

  insert into public.question_fingerprint_cache as c (question_id, course_id, revision, fingerprint, text_fingerprint)
  select q.id, q.course_id, q.revision,
         public.question_import_fingerprint(
           q.course_id, q.question_type, q.question_text,
           array(select o.option_text from public.question_options o
                  where o.question_id = q.id order by o.display_order)),
         public.question_import_text_fingerprint(q.course_id, q.question_text)
    from public.questions q
    left join public.question_fingerprint_cache x on x.question_id = q.id
   where q.course_id = any(p_course_ids)
     and (x.question_id is null or x.revision <> q.revision or x.course_id <> q.course_id)
   order by q.id
  on conflict (question_id) do update
     set course_id        = excluded.course_id,
         revision         = excluded.revision,
         fingerprint      = excluded.fingerprint,
         text_fingerprint = excluded.text_fingerprint;
$$;

revoke all on function public.question_import_refresh_fingerprints(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.question_import_normalize(text) from public, anon, authenticated, service_role;
revoke all on function public.question_import_fingerprint(uuid, public.question_type, text, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.question_import_text_fingerprint(uuid, text) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------
-- 4. Guards — history is append-only for every writer.
-- -------------------------------------------------------------------
create function public.question_import_runs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Import history cannot be deleted.' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'Import history can only be recorded by a signed-in user.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.created_by      := auth.uid();
    new.status          := 'in_progress';
    new.created_count   := 0;
    new.updated_count   := 0;
    new.discarded_count := 0;
    new.created_at      := now();
    new.updated_at      := now();
    new.completed_at    := null;
    new.discarded_at    := null;
    return new;
  end if;

  if (new.id, new.created_by, new.source, new.file_name, new.file_sha256,
      new.planned_creates, new.planned_updates, new.planned_excluded, new.created_at)
     is distinct from
     (old.id, old.created_by, old.source, old.file_name, old.file_sha256,
      old.planned_creates, old.planned_updates, old.planned_excluded, old.created_at) then
    raise exception 'Import details cannot be changed.' using errcode = '42501';
  end if;
  if old.status = 'discarded' then
    raise exception 'A discarded import cannot be changed.' using errcode = '42501';
  end if;
  if old.status = 'completed' and new.status = 'in_progress' then
    raise exception 'A completed import cannot be reopened.' using errcode = '42501';
  end if;
  if new.created_count < old.created_count or new.updated_count < old.updated_count then
    raise exception 'Import counts cannot decrease.' using errcode = '42501';
  end if;
  if new.status <> 'discarded' and new.discarded_count <> old.discarded_count then
    raise exception 'Only discarding an import records discarded questions.' using errcode = '42501';
  end if;
  if old.status = 'completed' and (new.created_count, new.updated_count) is distinct from (old.created_count, old.updated_count) then
    raise exception 'A completed import cannot import more questions.' using errcode = '42501';
  end if;

  new.completed_at := case when new.status = 'completed' and old.status = 'in_progress' then now() else old.completed_at end;
  new.discarded_at := case when new.status = 'discarded' then now() else null end;
  new.updated_at   := now();
  return new;
end;
$$;

create function public.question_import_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Imported question records cannot be changed.' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'Imported question records can only be written for a signed-in user.' using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create function public.question_import_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Import history cannot be truncated.' using errcode = '42501';
end;
$$;

revoke all on function public.question_import_runs_guard()  from public, anon, authenticated, service_role;
revoke all on function public.question_import_items_guard() from public, anon, authenticated, service_role;
revoke all on function public.question_import_no_truncate() from public, anon, authenticated, service_role;

create trigger question_import_runs_guard
  before insert or update or delete on public.question_import_runs
  for each row execute function public.question_import_runs_guard();

create trigger question_import_items_guard
  before insert or update or delete on public.question_import_items
  for each row execute function public.question_import_items_guard();

create trigger question_import_runs_no_truncate
  before truncate on public.question_import_runs
  for each statement execute function public.question_import_no_truncate();

create trigger question_import_items_no_truncate
  before truncate on public.question_import_items
  for each statement execute function public.question_import_no_truncate();

-- -------------------------------------------------------------------
-- 5. User functions (identity from auth.uid(); question writes only
--    through save_question)
-- -------------------------------------------------------------------

-- Existing-question fingerprints for the preview's duplicate check, for
-- courses the caller manages (1–50 courses; order by id for paging).
-- Volatile: it brings the fingerprint cache up to date first.
create function public.question_import_fingerprints(p_course_ids uuid[])
returns table (
  question_id       uuid,
  course_id         uuid,
  status            public.question_status,
  revision          integer,
  fingerprint       text,
  text_fingerprint  text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_course uuid;
begin
  if auth.uid() is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to import questions.' using errcode = '42501';
  end if;
  if p_course_ids is null or cardinality(p_course_ids) = 0 or cardinality(p_course_ids) > 50 then
    raise exception 'Check between 1 and 50 courses at a time.' using errcode = '22023';
  end if;
  foreach v_course in array p_course_ids loop
    if v_course is null or not (public.is_super_admin() or public.is_course_trainer(v_course)) then
      raise exception 'You can only check courses you manage.' using errcode = '42501';
    end if;
  end loop;

  for v_course in select distinct u from unnest(p_course_ids) u order by u loop
    perform pg_advisory_xact_lock(hashtextextended('public.question_import:' || v_course::text, 0));
  end loop;
  perform public.question_import_refresh_fingerprints(p_course_ids);

  return query
    select q.id, q.course_id, q.status, q.revision, c.fingerprint, c.text_fingerprint
      from public.questions q
      join public.question_fingerprint_cache c on c.question_id = q.id and c.revision = q.revision
     where q.course_id = any(p_course_ids)
     order by q.id;
end;
$$;

-- Start an import. Returns the run id.
create function public.start_question_import(
  p_source            public.question_import_source,
  p_file_name         text,
  p_file_sha256       text,
  p_planned_creates   integer,
  p_planned_updates   integer,
  p_planned_excluded  integer
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_name   text := btrim(coalesce(p_file_name, ''));
  v_limit  integer;
  v_id     uuid;
begin
  if v_uid is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to import questions.' using errcode = '42501';
  end if;
  if p_source is null then
    raise exception 'Choose a supported file type.' using errcode = '22023';
  end if;
  if char_length(v_name) not between 1 and 255 or v_name ~ '[\x01-\x1f\x7f]' then
    raise exception 'The file name is not valid.' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The file checksum is not valid.' using errcode = '22023';
  end if;
  if p_planned_creates is null or p_planned_updates is null or p_planned_excluded is null
     or p_planned_creates < 0 or p_planned_updates < 0 or p_planned_excluded < 0
     or p_planned_creates + p_planned_updates < 1 then
    raise exception 'There is nothing to import.' using errcode = '22023';
  end if;
  v_limit := case p_source when 'xlsx' then 5000 when 'csv' then 10000 else 1000 end;
  if p_planned_creates + p_planned_updates + p_planned_excluded > v_limit then
    raise exception 'This file has more than % questions. Split it into smaller files.', v_limit using errcode = '22023';
  end if;
  if exists (select 1 from public.question_import_runs r where r.created_by = v_uid and r.status = 'in_progress') then
    raise exception 'You already have an import in progress. Finish or discard it first.' using errcode = '23514';
  end if;

  insert into public.question_import_runs (created_by, source, file_name, file_sha256,
                                            planned_creates, planned_updates, planned_excluded)
  values (v_uid, p_source, v_name, p_file_sha256, p_planned_creates, p_planned_updates, p_planned_excluded)
  returning id into v_id;
  return v_id;
end;
$$;

-- Import up to 100 rows of the caller's in-progress run in ONE
-- transaction. Row object keys:
--   row_number int (1–1,000,000, unique in the run) · question_id uuid
--   (update) + expected_revision int · course_id uuid (create; must
--   match on update) · module_id uuid|null · question_type · question_text
--   · marks number · explanation text|null · options [{option_text,
--   is_correct}] · allow_duplicate boolean (default false)
-- Any "status" key is ignored: creates are always draft, and only draft
-- questions can be updated.
-- Returns {ok, run_id, created, updated, results[]} — one result per row:
--   created | updated | unchanged | already_done | rejected (+ reason:
--   duplicate | protected | conflict | not_found | no_permission |
--   invalid | limit, message, duplicate_of).
create function public.import_question_chunk(p_run_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_uuid      constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_uid       uuid := auth.uid();
  v_run       public.question_import_runs%rowtype;
  v_item      jsonb;
  v_row       integer;
  v_results   jsonb := '[]'::jsonb;
  v_courses   uuid[];
  v_course    uuid;
  v_qid       uuid;
  v_expected  integer;
  v_old       record;
  v_type_text text;
  v_texts     text[];
  v_fp        text;
  v_dup       uuid;
  v_payload   jsonb;
  v_saved_id  uuid;
  v_new_rev   integer;
  v_created   integer := 0;
  v_updated   integer := 0;
  v_done      record;
  v_state     text;
  v_msg       text;
  v_hint      text;
  v_reason    text;
begin
  if v_uid is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to import questions.' using errcode = '42501';
  end if;

  -- The run: the caller's own, in progress; locked so chunks of one run never interleave.
  select * into v_run from public.question_import_runs r where r.id = p_run_id for update;
  if not found or v_run.created_by <> v_uid then
    raise exception 'Import not found.' using errcode = '42501';
  end if;
  if v_run.status <> 'in_progress' then
    raise exception 'This import is no longer in progress.' using errcode = '23514';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'Send between 1 and 100 questions at a time.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e(i)
              where jsonb_typeof(i) <> 'object'
                 or jsonb_typeof(i -> 'row_number') is distinct from 'number'
                 or coalesce(case when (i ->> 'row_number') ~ '^[0-9]{1,7}$'
                                  then (i ->> 'row_number')::integer end, 0) not between 1 and 1000000) then
    raise exception 'Each question needs a row number between 1 and 1000000.' using errcode = '22023';
  end if;
  if (select count(*) <> count(distinct (i ->> 'row_number')::integer) from jsonb_array_elements(p_items) e(i)) then
    raise exception 'Row numbers must be unique.' using errcode = '22023';
  end if;

  -- Courses touched by this chunk (new rows' courses + updated questions' courses).
  select coalesce(array_agg(distinct c order by c), '{}') into v_courses
    from (
      select case when (i ->> 'course_id') ~ c_uuid then (i ->> 'course_id')::uuid end as c
        from jsonb_array_elements(p_items) e(i)
       where (i ->> 'question_id') is null
      union
      select q.course_id
        from jsonb_array_elements(p_items) e(i)
        join public.questions q
          on q.id = case when (i ->> 'question_id') ~ c_uuid then (i ->> 'question_id')::uuid end
    ) x
   where x.c is not null;

  -- Serialize imports per course (sorted order: no deadlocks), then
  -- bring those courses' fingerprints up to date.
  foreach v_course in array v_courses loop
    perform pg_advisory_xact_lock(hashtextextended('public.question_import:' || v_course::text, 0));
  end loop;
  perform public.question_import_refresh_fingerprints(v_courses);

  for v_item in
    select i from jsonb_array_elements(p_items) e(i) order by (i ->> 'row_number')::integer
  loop
    v_row := (v_item ->> 'row_number')::integer;

    -- Already imported in this run (a retried chunk): report, never rewrite.
    select it.action, it.question_id into v_done
      from public.question_import_items it
     where it.run_id = p_run_id and it.row_number = v_row;
    if found then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_number', v_row, 'outcome', 'already_done', 'action', v_done.action, 'question_id', v_done.question_id));
      continue;
    end if;

    begin
      v_qid := null; v_expected := null; v_dup := null;

      if jsonb_typeof(v_item -> 'allow_duplicate') not in ('boolean', 'null') then
        raise exception 'Include-anyway must be true or false.' using hint = 'qi:invalid';
      end if;
      v_type_text := v_item ->> 'question_type';
      if v_type_text is null or v_type_text not in ('single_choice', 'multiple_choice', 'true_false') then
        raise exception 'Question type must be single choice, multiple choice or true/false.' using hint = 'qi:invalid';
      end if;
      if jsonb_typeof(v_item -> 'options') is distinct from 'array' then
        raise exception 'A question needs between 2 and 10 options.' using hint = 'qi:invalid';
      end if;
      if exists (select 1 from jsonb_array_elements(v_item -> 'options') e(o)
                  where jsonb_typeof(o) <> 'object'
                     or jsonb_typeof(o -> 'option_text') is distinct from 'string'
                     or jsonb_typeof(o -> 'is_correct') is distinct from 'boolean') then
        raise exception 'Each option needs its text and whether it is correct.' using hint = 'qi:invalid';
      end if;
      select coalesce(array_agg(btrim(o ->> 'option_text') order by ord), '{}') into v_texts
        from jsonb_array_elements(v_item -> 'options') with ordinality e(o, ord);

      if (v_item ->> 'question_id') is null then
        -- Create.
        if coalesce(v_item ->> 'course_id', '') !~ c_uuid then
          raise exception 'Course is required.' using hint = 'qi:invalid';
        end if;
        v_course := (v_item ->> 'course_id')::uuid;
        if not (public.is_super_admin() or public.is_course_trainer(v_course)) then
          raise exception 'You can only add questions to courses you currently teach.' using hint = 'qi:no_permission';
        end if;
        if v_run.created_count + v_created >= v_run.planned_creates then
          raise exception 'This import has already created every planned question.' using hint = 'qi:limit';
        end if;
      else
        -- Update: an existing DRAFT the caller manages, unchanged since the preview.
        if (v_item ->> 'question_id') !~ c_uuid then
          raise exception 'Question not found, or you don''t have permission to change it.' using hint = 'qi:not_found';
        end if;
        v_qid := (v_item ->> 'question_id')::uuid;
        if jsonb_typeof(v_item -> 'expected_revision') is distinct from 'number'
           or (v_item ->> 'expected_revision') !~ '^[0-9]{1,9}$' then
          raise exception 'An update needs the question''s revision from the preview.' using hint = 'qi:invalid';
        end if;
        v_expected := (v_item ->> 'expected_revision')::integer;

        select q.course_id, q.status, q.revision into v_old
          from public.questions q where q.id = v_qid for update;
        if not found or not (public.is_super_admin() or public.is_course_trainer(v_old.course_id)) then
          raise exception 'Question not found, or you don''t have permission to change it.' using hint = 'qi:not_found';
        end if;
        if v_old.status <> 'draft' then
          raise exception 'Only draft questions can be updated by import. Active and archived questions are protected.' using hint = 'qi:protected';
        end if;
        if v_old.revision <> v_expected then
          raise exception 'This question changed after the preview. Reload the preview and try again.' using hint = 'qi:conflict';
        end if;
        if (v_item ->> 'course_id') is not null
           and (case when (v_item ->> 'course_id') ~ c_uuid
                     then (v_item ->> 'course_id')::uuid end) is distinct from v_old.course_id then
          raise exception 'A question''s course cannot be changed.' using hint = 'qi:invalid';
        end if;
        if v_run.updated_count + v_updated >= v_run.planned_updates then
          raise exception 'This import has already updated every planned question.' using hint = 'qi:limit';
        end if;
        v_course := v_old.course_id;
      end if;

      -- Duplicate check (unless the row explicitly includes it anyway).
      v_fp := public.question_import_fingerprint(v_course, v_type_text::public.question_type,
                                                 v_item ->> 'question_text', v_texts);
      if coalesce((v_item ->> 'allow_duplicate')::boolean, false) is false then
        select c.question_id into v_dup
          from public.question_fingerprint_cache c
          join public.questions q on q.id = c.question_id and q.revision = c.revision
         where c.course_id = v_course and c.fingerprint = v_fp and c.question_id is distinct from v_qid
         limit 1;
        if found then
          raise exception 'An identical question already exists in this course.' using hint = 'qi:duplicate';
        end if;
      end if;

      -- Write through the 0007 rules. Always draft.
      v_payload := jsonb_build_object(
        'course_id',     v_course,
        'module_id',     v_item -> 'module_id',
        'question_type', v_type_text,
        'question_text', v_item -> 'question_text',
        'marks',         v_item -> 'marks',
        'explanation',   v_item -> 'explanation',
        'status',        'draft',
        'options',       (select jsonb_agg(jsonb_build_object('option_text', o -> 'option_text',
                                                              'is_correct',  o -> 'is_correct') order by ord)
                            from jsonb_array_elements(v_item -> 'options') with ordinality e(o, ord)));
      if v_qid is not null then
        v_payload := v_payload || jsonb_build_object('id', v_qid);
      end if;
      v_saved_id := public.save_question(v_payload);

      select q.revision into v_new_rev from public.questions q where q.id = v_saved_id;

      if v_qid is not null and v_new_rev = v_expected then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row, 'outcome', 'unchanged', 'question_id', v_saved_id, 'revision', v_new_rev));
      else
        insert into public.question_import_items (run_id, row_number, action, question_id,
                                                  previous_revision, new_revision, fingerprint)
        values (p_run_id, v_row, case when v_qid is null then 'create' else 'update' end::public.question_import_action,
                v_saved_id, v_expected, v_new_rev, v_fp);

        if v_qid is null then
          v_created := v_created + 1;
        else
          v_updated := v_updated + 1;
        end if;
        -- Keep the cache current so later rows of this chunk see this question.
        insert into public.question_fingerprint_cache (question_id, course_id, revision, fingerprint, text_fingerprint)
        values (v_saved_id, v_course, v_new_rev, v_fp,
                public.question_import_text_fingerprint(v_course, v_item ->> 'question_text'))
        on conflict (question_id) do update
           set course_id        = excluded.course_id,
               revision         = excluded.revision,
               fingerprint      = excluded.fingerprint,
               text_fingerprint = excluded.text_fingerprint;

        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row_number', v_row, 'outcome', case when v_qid is null then 'created' else 'updated' end,
          'question_id', v_saved_id, 'revision', v_new_rev));
      end if;

    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
      if v_state = 'P0001' and v_hint like 'qi:%' then
        v_reason := substr(v_hint, 4);
      elsif v_state in ('22023', '23514', '23503') then
        v_reason := 'invalid';
      elsif v_state = '42501' then
        v_reason := 'no_permission';
      else
        raise;   -- unexpected: roll back the whole chunk
      end if;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'row_number', v_row, 'outcome', 'rejected', 'reason', v_reason, 'message', v_msg,
        'duplicate_of', case when v_reason = 'duplicate' then v_dup end)));
    end;
  end loop;

  if v_created > 0 or v_updated > 0 then
    update public.question_import_runs r
       set created_count = r.created_count + v_created,
           updated_count = r.updated_count + v_updated
     where r.id = p_run_id;
  end if;

  return jsonb_build_object('ok', true, 'run_id', p_run_id,
                            'created', v_created, 'updated', v_updated, 'results', v_results);
end;
$$;

-- Mark the caller's in-progress run completed (idempotent).
create function public.finish_question_import(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_run  public.question_import_runs%rowtype;
begin
  if v_uid is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to import questions.' using errcode = '42501';
  end if;
  select * into v_run from public.question_import_runs r where r.id = p_run_id for update;
  if not found or v_run.created_by <> v_uid then
    raise exception 'Import not found.' using errcode = '42501';
  end if;
  if v_run.status = 'discarded' then
    raise exception 'This import was discarded.' using errcode = '23514';
  end if;
  if v_run.status = 'in_progress' then
    update public.question_import_runs r set status = 'completed' where r.id = p_run_id;
  end if;
  return jsonb_build_object('ok', true, 'run_id', p_run_id,
                            'created', v_run.created_count, 'updated', v_run.updated_count);
end;
$$;

-- Discard a run: delete the drafts it CREATED that are still unchanged
-- since the import (same revision) and not part of any test. Updates
-- are never reverted. The run's creator or a super admin.
create function public.discard_question_import(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_run      public.question_import_runs%rowtype;
  v_deleted  integer := 0;
begin
  if v_uid is null or coalesce(public.current_app_role(), '') not in ('super_admin', 'trainer') then
    raise exception 'You don''t have permission to import questions.' using errcode = '42501';
  end if;
  select * into v_run from public.question_import_runs r where r.id = p_run_id for update;
  if not found or not (v_run.created_by = v_uid or public.is_super_admin()) then
    raise exception 'Import not found.' using errcode = '42501';
  end if;
  if v_run.status = 'discarded' then
    return jsonb_build_object('ok', true, 'run_id', p_run_id, 'deleted', v_run.discarded_count,
                              'kept', v_run.created_count - v_run.discarded_count, 'already_discarded', true);
  end if;

  with gone as (
    delete from public.questions q
     using public.question_import_items it
     where it.run_id = p_run_id
       and it.action = 'create'
       and q.id = it.question_id
       and q.status = 'draft'
       and q.revision = it.new_revision
       and not exists (select 1 from public.test_questions tq where tq.source_question_id = q.id)
    returning q.id
  )
  select count(*) into v_deleted from gone;

  update public.question_import_runs r
     set status = 'discarded', discarded_count = v_deleted
   where r.id = p_run_id;

  return jsonb_build_object('ok', true, 'run_id', p_run_id, 'deleted', v_deleted,
                            'kept', v_run.created_count - v_deleted, 'already_discarded', false);
end;
$$;

revoke all on function public.question_import_fingerprints(uuid[]) from public, anon, service_role;
revoke all on function public.start_question_import(public.question_import_source, text, text, integer, integer, integer)
  from public, anon, service_role;
revoke all on function public.import_question_chunk(uuid, jsonb)  from public, anon, service_role;
revoke all on function public.finish_question_import(uuid)        from public, anon, service_role;
revoke all on function public.discard_question_import(uuid)       from public, anon, service_role;

grant execute on function public.question_import_fingerprints(uuid[]) to authenticated;
grant execute on function public.start_question_import(public.question_import_source, text, text, integer, integer, integer)
  to authenticated;
grant execute on function public.import_question_chunk(uuid, jsonb)  to authenticated;
grant execute on function public.finish_question_import(uuid)        to authenticated;
grant execute on function public.discard_question_import(uuid)       to authenticated;

-- -------------------------------------------------------------------
-- 6. Privileges + RLS — creator or super admin reads; no client writes.
-- -------------------------------------------------------------------
alter table public.question_import_runs       enable row level security;
alter table public.question_import_items      enable row level security;
alter table public.question_fingerprint_cache enable row level security;

revoke all on table public.question_import_runs, public.question_import_items, public.question_fingerprint_cache
  from anon, authenticated, service_role;
-- question_fingerprint_cache: RLS on, no policy, no grants (import functions only).
grant select on table public.question_import_runs, public.question_import_items to authenticated, service_role;

create policy question_import_runs_select
  on public.question_import_runs for select to authenticated
  using (created_by = (select auth.uid()) or (select public.is_super_admin()));

create policy question_import_items_select
  on public.question_import_items for select to authenticated
  using (exists (
    select 1 from public.question_import_runs r
     where r.id = question_import_items.run_id
       and (r.created_by = (select auth.uid()) or (select public.is_super_admin()))));

commit;
