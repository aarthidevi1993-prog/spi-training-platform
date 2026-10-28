-- ===================================================================
-- 0029 — RESTRICT INVITATION REVOCATION TO SUPER ADMIN (P3.10-D)
--
-- Follows 0028 (creation and delivery: Super Admin only). 0017 still let a
-- trainer call revoke_user_invitation directly (no application path ever
-- did — invitationsService.revokeInvitation is Super Admin only) for
-- invitations they created, while they still teach the invitation's batch.
-- After 0028 only invitations created before it can be such invitations;
-- trainers no longer manage invitations in any way.
--
-- Change — exactly one line, the authorization guard:
--   before: v_uid is null or v_role is null or v_role not in ('super_admin', 'trainer')
--   after:  v_uid is null or v_role is distinct from 'super_admin'
-- Every other caller now gets 42501 ('You don''t have permission to do that.')
-- before any read or write. current_app_role() is NULL for invited /
-- suspended accounts (0016/0018), so only an ACTIVE Super Admin passes —
-- the same rule as before for Super Admins. The rest of the body is the
-- 0017 definition verbatim (CREATE OR REPLACE); its trainer-only scope
-- branch is now unreachable and left untouched.
--
-- UNCHANGED: signature, SECURITY DEFINER, search_path '', owner and EXECUTE
-- grants (authenticated keeps EXECUTE: the Super Admin revokes through their
-- own session), the reason limit (500), pending / expiry / not_pending
-- rules, the state-change-only revoke and its audit event, 0028's functions,
-- every table, policy and trigger. Data: nothing is modified; legacy
-- trainer-created pending invitations remain revocable by a Super Admin.
--
-- Preflight: refuses unless the function is exactly the 0017 definition.
-- Postflight: verifies the new guard and attributes.
-- ROLLBACK (manual): re-apply revoke_user_invitation from 0017.
-- Requires 0028.
-- ===================================================================

begin;

-- Preflight: 0028 applied, and revoke_user_invitation exactly as 0017 (whitespace-insensitive).
do $$
begin
  if position('v_role is distinct from ''super_admin''' in
       coalesce((select p.prosrc from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.create_user_invitation(jsonb)')), '')) = 0 then
    raise exception 'Preflight failed: 0028 is not applied (create_user_invitation still admits trainers).';
  end if;
  if (select md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) from pg_catalog.pg_proc p
       where p.oid = to_regprocedure('public.revoke_user_invitation(uuid, text)')) is distinct from 'e31759a611287a2cc5e491a040c5b00a' then
    raise exception 'Preflight failed: public.revoke_user_invitation(uuid, text) differs from the 0017 definition (0029 already applied?).';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- revoke_user_invitation — the 0017 body; guard: Super Admin only
-- -------------------------------------------------------------------
create or replace function public.revoke_user_invitation(p_invitation_id uuid, p_reason text default null)
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
  if v_uid is null or v_role is distinct from 'super_admin' then  -- 0029: Super Admin only
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

-- Postflight: the new guard is in place; attributes and grants are as before.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = to_regprocedure('public.revoke_user_invitation(uuid, text)')
       and p.prosecdef
       and p.proconfig = array['search_path=""']
       and position('v_role is distinct from ''super_admin''' in p.prosrc) > 0
       and position('v_role not in (''super_admin'', ''trainer'')' in p.prosrc) = 0
       and has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception 'Postflight failed: public.revoke_user_invitation(uuid, text) does not have the 0029 guard and attributes.';
  end if;
end
$$;

commit;
