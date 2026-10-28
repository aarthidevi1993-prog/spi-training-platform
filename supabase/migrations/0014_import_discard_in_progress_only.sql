-- ===================================================================
-- 0014 — BULK IMPORT: DISCARD ONLY UNFINISHED IMPORTS
--
-- Phase I (live security testing) found that 0013's
-- discard_question_import() accepted a run in ANY status. Discarding
-- deletes the run's unchanged, unused new drafts, so:
--   - a trainer could delete draft questions by discarding an old,
--     COMPLETED import of their own — although the Question Bank gives
--     trainers no delete right (questions_admin_delete_draft is
--     super-admin only);
--   - a super admin could discard any user's completed import.
-- The application only ever offers "Discard unfinished import".
--
-- Fix (this function only): after the existing ownership check, refuse
-- unless the run is 'in_progress'. A completed or discarded run is
-- refused (SQLSTATE 23514, a user-facing message) BEFORE anything is
-- deleted or updated, so a refused call changes nothing. Everything
-- else is unchanged from 0013: signature, SECURITY DEFINER, search_path,
-- role check, ownership (creator, or a super admin for unfinished
-- imports), what an in-progress discard deletes and keeps, and grants.
--
-- Note: a repeated discard of an already-discarded run used to return
-- ok (already_discarded = true); it is now refused like any other
-- finished run (no data change either way).
--
-- Requires 0013. Safe to re-run (CREATE OR REPLACE, same grants).
-- ===================================================================

begin;

do $$
begin
  if to_regprocedure('public.discard_question_import(uuid)') is null
     or to_regclass('public.question_import_runs') is null
     or to_regclass('public.question_import_items') is null
     or to_regtype('public.question_import_status') is null then
    raise exception 'Preflight failed: 0013 (bulk question import) is not applied.';
  end if;
end
$$;

create or replace function public.discard_question_import(p_run_id uuid)
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
  -- 0014: only an unfinished import can be discarded (checked before anything is changed).
  if v_run.status <> 'in_progress' then
    raise exception 'Only an unfinished import can be discarded. This import is %.', v_run.status::text
      using errcode = '23514';
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

comment on function public.discard_question_import(uuid) is
  'Discard the caller''s UNFINISHED import (creator, or a super admin): deletes its unchanged, unused new drafts; never reverts updates. Completed or discarded imports are refused (0014).';

-- Same privileges as 0013 (CREATE OR REPLACE keeps them; restated for clarity).
revoke all on function public.discard_question_import(uuid) from public, anon, service_role;
grant execute on function public.discard_question_import(uuid) to authenticated;

commit;
