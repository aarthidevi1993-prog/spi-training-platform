-- ===================================================================
-- 0018 — ACCOUNT ACTIVATION GUARD (Phase 7 P3.3)
--
-- Closes a two-step activation path in 0017's admin_set_account_status:
-- a Super Admin could move an INVITED account to SUSPENDED, then
-- reactivate it (suspended → active), activating an account that never
-- went through invitation acceptance / password setup.
--
-- After 0018 the only way from invited to active is
-- accept_user_invitation() (unchanged):
--   invited   → active     refused (as in 0017)
--   invited   → suspended  refused (new; stopping a pending invitation is
--                          invitation revocation, not account suspension)
--   active    → suspended  allowed (unchanged)
--   suspended → active     allowed only for an account that was active
--                          before; an account whose latest account-status
--                          audit row is a change FROM 'invited' (suspended
--                          from invited before 0018) is refused with
--                          reason 'never_activated'
--
-- Replaces ONLY public.admin_set_account_status, with the same
-- signature, SECURITY DEFINER and search_path = ''. CREATE OR REPLACE
-- keeps the owner and the existing grants (authenticated: EXECUTE;
-- anon/public: none). Everything else in the function is unchanged:
-- caller check, reason length, self-protection, the Super Admin row
-- lock and re-check, last-active-Super-Admin protection, the audit row.
-- No table, policy, grant, type or other function changes. Requires 0017.
-- ===================================================================

begin;

do $$
begin
  if to_regprocedure('public.admin_set_account_status(uuid, public.account_status, text)') is null
     or to_regclass('public.user_admin_events') is null
     or to_regprocedure('public.user_mgmt_lock_super_admins()') is null then
    raise exception 'Preflight failed: 0017 must be applied first.';
  end if;
  if coalesce(obj_description('public.admin_set_account_status(uuid, public.account_status, text)'::regprocedure, 'pg_proc'), '') like '0018:%' then
    raise exception 'Preflight failed: 0018 already applied?';
  end if;
end
$$;

-- active → suspended, suspended → active (only if the account was active
-- before). Never yourself; never the last active Super Admin. invited →
-- active happens only through acceptance; invited → suspended is refused.
create or replace function public.admin_set_account_status(
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
  -- 0018: invited → suspended removed (only acceptance moves an account out of invited).
  if not ((t.account_status = 'active' and p_status = 'suspended')
          or (t.account_status = 'suspended' and p_status = 'active')) then
    return jsonb_build_object('ok', false, 'reason', 'transition_not_allowed');
  end if;
  -- 0018: an account suspended straight from invited (allowed by 0017) was never active.
  if t.account_status = 'suspended' and p_status = 'active' and exists (
       select 1
         from (select ev.detail
                 from public.user_admin_events ev
                where ev.target_user_id = t.id
                  and ev.event_type = 'account_status_changed'
                order by ev.id desc
                limit 1) last_change
        where last_change.detail ->> 'from' = 'invited') then
    return jsonb_build_object('ok', false, 'reason', 'never_activated');
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

comment on function public.admin_set_account_status(uuid, public.account_status, text) is
  '0018: active → suspended; suspended → active only for accounts that were active before (never_activated otherwise); invited accounts change only through accept_user_invitation().';

commit;
