-- ===================================================================
-- 0004 — TABLE PRIVILEGES FOR public.classes
--
-- 0001_classes.sql created public.classes and its RLS policies but no
-- table privileges. This project does not grant new public tables to
-- the API roles by default, so every request from a signed-in user
-- failed with "permission denied for table classes" (42501) before any
-- RLS policy was evaluated.
--
-- This applies the same privilege pattern 0003 uses for its tables:
--   - anon:           no access at all
--   - authenticated:  SELECT / INSERT / UPDATE / DELETE, with every row
--                     still filtered by the existing RLS policies
--                     (classes_admin_all, classes_trainer_*,
--                     classes_student_select)
--   - service_role:   full access (server-side trusted code only)
--
-- No policies, columns, constraints, triggers or data are changed.
-- Safe to re-run: REVOKE/GRANT are idempotent.
--
-- Runs as ONE transaction. Paste it into the SQL Editor as-is — do not
-- wrap it in another transaction.
--
-- REVIEW BEFORE RUNNING. This file has not been executed anywhere.
-- ===================================================================

begin;

-- -------------------------------------------------------------------
-- Preflight: only grant table access while RLS is protecting the rows.
-- -------------------------------------------------------------------
do $$
begin
  if to_regclass('public.classes') is null then
    raise exception 'Preflight failed: public.classes is missing (0001 not applied).';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.classes'::regclass) then
    raise exception 'Preflight failed: row level security is not enabled on public.classes.';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- Privileges (same pattern as 0003)
-- -------------------------------------------------------------------
revoke all on table public.classes from anon, authenticated;

grant select, insert, update, delete on table public.classes to authenticated;

grant all on table public.classes to service_role;

commit;
