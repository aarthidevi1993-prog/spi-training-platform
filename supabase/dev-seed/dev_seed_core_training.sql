-- ===================================================================
-- DEVELOPMENT SEED — core training data (NOT A MIGRATION)
--
-- For the DEVELOPMENT project only (arsene-spi-training-dev). Never
-- run against production.
--
-- Deliberately kept outside supabase/migrations/ and NOT named
-- supabase/seed.sql, so no Supabase CLI command runs it automatically.
-- Run it by hand in the SQL Editor, after 0003_core_training_model.sql.
--
-- Safe to re-run: inserts only, every insert is keyed on a unique code
-- with ON CONFLICT DO NOTHING. It never updates or deletes anything.
--
-- Part 1 needs no user accounts. Part 2 (trainer / student / enrolment)
-- is commented out because it needs the UUIDs of real auth users you
-- create yourself in the dashboard.
-- ===================================================================

begin;

do $$
begin
  if to_regclass('public.courses') is null
     or to_regclass('public.modules') is null
     or to_regclass('public.batches') is null then
    raise exception 'Seed aborted: run 0003_core_training_model.sql first.';
  end if;
end
$$;

-- -------------------------------------------------------------------
-- Part 1 — courses, modules, batches (no trainer assigned yet)
-- -------------------------------------------------------------------
insert into public.courses (course_code, title, description, level, duration_hours, status)
values
  ('SPI-101', 'SPI Training',    'Smart Plant Instrumentation fundamentals and workflows.', 'foundation',   40, 'published'),
  ('CTL-201', 'Control Systems', 'Control loops, tuning and system integration.',            'intermediate', 32, 'published'),
  ('SAF-101', 'Process Safety',  'Hazard awareness and safe plant operation.',              'foundation',   16, 'published')
on conflict (course_code) do nothing;

insert into public.modules (course_id, module_code, title, sequence, duration_hours)
select c.id, m.module_code, m.title, m.sequence, m.duration_hours
  from (values
    ('SPI-101', 'SPI-M01', 'Instrumentation Fundamentals', 1, 12),
    ('SPI-101', 'SPI-M02', 'Sensors and Transmitters',     2, 14),
    ('CTL-201', 'CTL-M01', 'Control Loops',                1, 16)
  ) as m (course_code, module_code, title, sequence, duration_hours)
  join public.courses c on c.course_code = m.course_code
on conflict (course_id, module_code) do nothing;

insert into public.batches (batch_code, course_id, name, start_date, end_date, status, max_seats)
select b.batch_code, c.id, b.name, b.start_date::date, b.end_date::date, b.status::public.batch_status, b.max_seats
  from (values
    ('SPI-2026-A', 'SPI-101', 'Batch A', '2026-10-01', '2026-12-15', 'upcoming', 25),
    ('CTL-2026-B', 'CTL-201', 'Batch B', '2026-10-15', '2026-12-20', 'upcoming', 20),
    ('SAF-2026-C', 'SAF-101', 'Batch C', '2026-11-01', '2026-11-30', 'upcoming', 30)
  ) as b (batch_code, course_code, name, start_date, end_date, status, max_seats)
  join public.courses c on c.course_code = b.course_code
on conflict (batch_code) do nothing;

commit;

-- -------------------------------------------------------------------
-- Part 2 — OPTIONAL, run manually after creating real test accounts
--
-- A class needs a trainer, and trainers/students must be real auth
-- users. For each test account:
--   1. Dashboard -> Authentication -> Add user (auto-confirm).
--      The 0002 trigger creates its profile with role 'student'.
--   2. For a trainer, promote the profile first (SQL editor):
--        update public.profiles set role = 'trainer' where id = '<trainer-uuid>';
--   3. Then run the matching statements below with the real UUIDs.
-- -------------------------------------------------------------------
-- insert into public.trainers (id, trainer_code, full_name)
-- values ('<trainer-uuid>', 'TRN-0001', 'Test Trainer')
-- on conflict (id) do nothing;
--
-- insert into public.trainer_details (trainer_id, email)
-- values ('<trainer-uuid>', 'trainer@example.com')
-- on conflict (trainer_id) do nothing;
--
-- -- A class's trainer must be its batch's trainer, so assign the
-- -- trainer to the batch before creating classes in it.
-- update public.batches set trainer_id = '<trainer-uuid>'
--  where batch_code = 'SPI-2026-A' and trainer_id is null;
--
-- insert into public.students (id, student_code, full_name)
-- values ('<student-uuid>', 'STU-0001', 'Test Student')
-- on conflict (id) do nothing;
--
-- insert into public.student_details (student_id, email)
-- values ('<student-uuid>', 'student@example.com')
-- on conflict (student_id) do nothing;
--
-- insert into public.batch_students (batch_id, student_id)
-- select b.id, '<student-uuid>' from public.batches b where b.batch_code = 'SPI-2026-A'
-- on conflict (batch_id, student_id) do nothing;
