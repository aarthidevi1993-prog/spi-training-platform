-- ===================================================================
-- 0025 — DASHBOARD RLS PERFORMANCE (Phase D2b-1, policies only)
--
-- PostgreSQL combines permissive policies with OR. For the Super Admin,
-- the SELECT policies of classes and class_attendance evaluated the
-- trainer / student helper functions on every row before reaching the
-- admin policy, which made Super Admin reads of these tables (e.g. the
-- 0024 dashboard analytics) cost ~1 s per 20,000 attendance rows.
--
-- This migration changes ONLY the USING expression of four SELECT
-- policies: each keeps its existing condition unchanged and gains the
-- table's existing Super Admin condition as its FIRST branch, wrapped in
-- a scalar subquery so it is evaluated once per statement:
--
--   classes_trainer_select           (select current_app_role() = 'super_admin') or <existing>
--   classes_student_select           (select current_app_role() = 'super_admin') or <existing>
--   class_attendance_trainer_select  (select is_super_admin()) or <existing>
--   class_attendance_student_select  (select is_super_admin()) or <existing>
--
-- Effective access is identical: the Super Admin already reads every row
-- through classes_admin_all / class_attendance_admin_all (FOR ALL), so
-- adding the same condition to other SELECT policies adds nothing; for
-- everyone else the added branch is false and the existing condition
-- decides, exactly as before.
--
-- Unchanged: the admin policies, every INSERT / UPDATE / DELETE policy,
-- PERMISSIVE / command / roles of all policies, WITH CHECK clauses,
-- helper functions, tables, columns, indexes, triggers, roles, grants.
-- Rollback: alter the four policies back to their previous USING
-- expressions (shown in the preflight below).
-- ===================================================================

begin;

-- Preflight: refuse unless the four policies are exactly as expected (and not yet changed).
do $$
declare
  v_expected constant jsonb := jsonb_build_object(
    'classes.classes_trainer_select', '((current_app_role() = ''trainer''::text) AND (trainer_id = auth.uid()))',
    'classes.classes_student_select', '((current_app_role() = ''student''::text) AND is_enrolled_in_batch(batch_id))',
    'class_attendance.class_attendance_trainer_select', '(is_batch_trainer(batch_id) OR is_class_trainer(class_id))',
    'class_attendance.class_attendance_student_select', 'owns_student_record(student_id)');
  v_key text;
  r record;
begin
  for v_key in select jsonb_object_keys(v_expected) loop
    select p.cmd, p.permissive, p.qual, p.with_check into r
      from pg_catalog.pg_policies p
     where p.schemaname = 'public' and p.tablename = split_part(v_key, '.', 1) and p.policyname = split_part(v_key, '.', 2);
    if not found then
      raise exception 'Preflight failed: policy % not found.', v_key;
    end if;
    if r.cmd <> 'SELECT' or r.permissive <> 'PERMISSIVE' or r.with_check is not null then
      raise exception 'Preflight failed: policy % is not a permissive SELECT policy.', v_key;
    end if;
    if r.qual <> v_expected ->> v_key then
      raise exception 'Preflight failed: policy % differs from the expected definition (0025 already applied?): %', v_key, r.qual;
    end if;
  end loop;
end
$$;

alter policy classes_trainer_select on public.classes
  using ((select public.current_app_role() = 'super_admin') or (public.current_app_role() = 'trainer' and trainer_id = auth.uid()));

alter policy classes_student_select on public.classes
  using ((select public.current_app_role() = 'super_admin') or (public.current_app_role() = 'student' and public.is_enrolled_in_batch(batch_id)));

alter policy class_attendance_trainer_select on public.class_attendance
  using ((select public.is_super_admin()) or (public.is_batch_trainer(batch_id) or public.is_class_trainer(class_id)));

alter policy class_attendance_student_select on public.class_attendance
  using ((select public.is_super_admin()) or public.owns_student_record(student_id));

commit;
