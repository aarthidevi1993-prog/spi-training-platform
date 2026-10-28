-- ===================================================================
-- 0021 — BATCH TRAINER ASSIGNMENT GUARD (Phase 7 P3.6)
--
-- A batch's trainer is assigned through the database, never by a direct
-- client write of public.batches.trainer_id:
--
--   admin_assign_batch_trainer(batch, trainer)   0017, UNCHANGED — the
--     only way to assign or change the trainer of an existing batch:
--     Super Admin only; batch row lock; upcoming/ongoing batches only;
--     the trainer must be available; audited (trainer_assignment_changed);
--     scheduled/live classes follow the batch (0003 trigger).
--
-- Closed here (the 0003 batches_admin_write policy lets a Super Admin
-- write any batches column through PostgREST):
--   UPDATE of trainer_id by a client role (authenticated / anon) is
--     refused — even for a Super Admin — so every change goes through the
--     function's checks and audit.
--   INSERT with a trainer by a Super Admin client (Add Batch) is allowed
--     only for an AVAILABLE trainer: active trainer record, profile role
--     trainer, active account. Other client roles are left to RLS (they
--     cannot insert batches at all).
--   An INSERT with a trainer by a client is audited like an assignment
--     (trainer_assignment_changed, from null).
-- Privileged writers (the SECURITY DEFINER functions, SQL Editor,
-- migrations, seed) are unaffected, as with the 0020 code guard.
--
-- Unchanged: every 0001–0020 object (functions, policies, grants,
-- triggers), all existing rows. Existing batches whose assigned trainer
-- is no longer available are only reported by the preflight (NOTICE);
-- nothing is changed or detached. Trainer removal is not added.
-- Requires 0020.
-- ===================================================================

begin;

do $$
declare
  v_unavailable integer;
begin
  if to_regprocedure('public.admin_assign_batch_trainer(uuid, uuid)') is null
     or to_regprocedure('public.user_mgmt_log(public.user_admin_event_type, uuid, uuid, uuid, jsonb)') is null
     or to_regprocedure('public.user_mgmt_next_code(text)') is null then
    raise exception 'Preflight failed: 0020 must be applied first.';
  end if;
  if to_regprocedure('public.batches_trainer_guard()') is not null
     or to_regprocedure('public.batches_trainer_insert_audit()') is not null then
    raise exception 'Preflight failed: 0021 already applied?';
  end if;
  -- Read-only report: current batches whose assigned trainer is not available (left as they are).
  select count(*) into v_unavailable
    from public.batches b
    left join public.trainers r on r.id = b.trainer_id
    left join public.profiles p on p.id = b.trainer_id
   where b.trainer_id is not null
     and b.status in ('upcoming', 'ongoing')
     and not (coalesce(r.status = 'active', false) and coalesce(p.role = 'trainer', false) and coalesce(p.account_status = 'active', false));
  if v_unavailable > 0 then
    raise notice '0021: % current batch(es) have an assigned trainer who is not available; they are unchanged and can be reassigned with admin_assign_batch_trainer().', v_unavailable;
  end if;
end
$$;

-- -------------------------------------------------------------------
-- 1. Guard (SECURITY INVOKER on purpose: current_user is the real writer —
--    the owner inside SECURITY DEFINER functions, authenticated/anon for
--    a direct PostgREST write)
-- -------------------------------------------------------------------
create function public.batches_trainer_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.trainer_id is distinct from old.trainer_id then
      raise exception 'A batch''s trainer is assigned with admin_assign_batch_trainer(); it cannot be written directly.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  -- INSERT. Only a Super Admin may insert batches (RLS); anyone else is left to RLS to refuse.
  if new.trainer_id is not null and public.is_super_admin() then
    -- Read under the Super Admin's own RLS (trainers and profiles are fully visible to them).
    if not exists (select 1 from public.trainers r join public.profiles p on p.id = r.id
                    where r.id = new.trainer_id and r.status = 'active'
                      and p.role = 'trainer' and p.account_status = 'active') then
      raise exception 'The selected trainer is not available (an active trainer with an active account is required).'
        using errcode = '23514', hint = 'trainer_not_available';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.batches_trainer_guard() from public, anon, authenticated;

create trigger batches_trainer_guard
  before insert or update of trainer_id on public.batches
  for each row execute function public.batches_trainer_guard();

-- -------------------------------------------------------------------
-- 2. Audit of a trainer set at creation by a client (Add Batch)
--    SECURITY DEFINER so it may write the append-only audit table; a
--    client write is recognised by the session's role setting, which a
--    SECURITY DEFINER function does not change (assignments made by the
--    0017 function are UPDATEs and are audited by that function).
-- -------------------------------------------------------------------
create function public.batches_trainer_insert_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.trainer_id is not null and current_setting('role', true) in ('authenticated', 'anon') then
    perform public.user_mgmt_log('trainer_assignment_changed', new.trainer_id, null, new.id,
      jsonb_build_object('from', null, 'to', new.trainer_id, 'source', 'batch_created'));
  end if;
  return null;
end;
$$;

revoke all on function public.batches_trainer_insert_audit() from public, anon, authenticated;

create trigger batches_trainer_insert_audit
  after insert on public.batches
  for each row execute function public.batches_trainer_insert_audit();

comment on function public.batches_trainer_guard() is
  '0021: client roles cannot change batches.trainer_id (use admin_assign_batch_trainer); a Super Admin INSERT needs an available trainer.';
comment on function public.batches_trainer_insert_audit() is
  '0021: audits a trainer set at batch creation by a client (trainer_assignment_changed, from null).';

commit;
