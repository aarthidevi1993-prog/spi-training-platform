\set VERBOSITY terse
\set ON_ERROR_STOP 1
create schema t;
grant usage on schema t to anon, authenticated, service_role;
create table t.ids (k text primary key, v uuid);
grant select on t.ids to anon, authenticated, service_role;
create table t.results (n serial, section text, name text, ok boolean, detail text);
grant all on t.results to anon, authenticated, service_role;
grant usage on sequence t.results_n_seq to anon, authenticated, service_role;
create function t.id(p_k text) returns uuid language sql stable as $f$ select v from t.ids where k = p_k $f$;
grant execute on function t.id(text) to anon, authenticated, service_role;
create function t.as_(p_k text) returns void language sql as
$f$ select set_config('request.jwt.claims', case when p_k is null then '' else json_build_object('sub', t.id(p_k))::text end, false) $f$;
grant execute on function t.as_(text) to anon, authenticated, service_role;
create function t.ok(p_section text, p_name text, p_cond boolean, p_detail text default null) returns boolean language plpgsql as $f$
begin insert into t.results (section, name, ok, detail) values (p_section, p_name, coalesce(p_cond, false), p_detail); return coalesce(p_cond, false); end $f$;
grant execute on function t.ok(text, text, boolean, text) to anon, authenticated, service_role;
create function t.fails(p_section text, p_name text, p_sql text, p_state text default null) returns boolean language plpgsql as $f$
declare v_state text; v_msg text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    return t.ok(p_section, p_name, p_state is null or v_state = p_state, v_state || ' ' || v_msg);
  end;
  return t.ok(p_section, p_name, false, 'no error');
end $f$;
grant execute on function t.fails(text, text, text, text) to anon, authenticated, service_role;
create function t.p(p_course uuid, p_type text, p_marks numeric, p_options jsonb, p_text text)
returns jsonb language sql immutable as
$f$ select jsonb_build_object('course_id', p_course, 'question_text', p_text, 'question_type', p_type, 'marks', p_marks,
      'options', p_options, 'explanation', 'Because ' || p_text) $f$;
grant all on t.ids to anon, authenticated, service_role;
create table t.out (k text primary key, v jsonb);
grant all on t.out to anon, authenticated, service_role;
create function t.o(p_k text) returns jsonb language sql stable as $f$ select v from t.out where k = p_k $f$;
-- result object for one row_number of a stored chunk result
create function t.r(p_k text, p_row int) returns jsonb language sql stable as
$f$ select e from jsonb_array_elements((select v from t.out where k = p_k) -> 'results') e where (e ->> 'row_number')::int = p_row $f$;
-- options: 'text*' = correct
create function t.opts(variadic p text[]) returns jsonb language sql immutable as
$f$ select jsonb_agg(jsonb_build_object('option_text', rtrim(x, '*'), 'is_correct', right(x, 1) = '*') order by n)
      from unnest(p) with ordinality u(x, n) $f$;
create function t.item(p_row int, p_course text, p_type text, p_text text, p_opts jsonb, p_marks numeric default 1, p_extra jsonb default '{}')
returns jsonb language sql stable as
$f$ select jsonb_build_object('row_number', p_row, 'course_id', t.id(p_course), 'question_type', p_type,
      'question_text', p_text, 'options', p_opts, 'marks', p_marks, 'explanation', null) || p_extra $f$;
grant execute on all functions in schema t to anon, authenticated, service_role;
create function t.sha() returns text language sql immutable as $f$ select repeat('ab', 32) $f$;
grant execute on function t.sha() to anon, authenticated, service_role;

-- People: A, A2 super admins; T1 (teaches C1 now; C3 only in a completed batch); T2 (teaches C2); T3 (no batches); ST1 student.
insert into t.ids (k, v) select k, gen_random_uuid() from unnest(array['A','A2','T1','T2','T3','ST1','C1','C2','C3','C9','M1','M2','M3']) k;
insert into auth.users (id) select v from t.ids where k in ('A','A2','T1','T2','T3','ST1');
update public.profiles set role = 'super_admin' where id in (t.id('A'), t.id('A2'));
update public.profiles set role = 'trainer' where id in (t.id('T1'), t.id('T2'), t.id('T3'));
-- 0016: new auth users start invited (no usable role). The test people are
-- activated here, as accepting an invitation will do (skipped before 0016).
do $act$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'account_status') then
    execute $u$update public.profiles set account_status = 'active' where id in (select v from t.ids where k in ('A','A2','T1','T2','T3','ST1'))$u$;
  end if;
end $act$;
insert into public.trainers (id, trainer_code, full_name) values (t.id('T1'), 'T1', 'Trainer One'), (t.id('T2'), 'T2', 'Trainer Two'), (t.id('T3'), 'T3', 'Trainer Three');
insert into public.students (id, student_code, full_name) values (t.id('ST1'), 'ST1', 'Student One');
-- Published: batches are created for published courses only (0030 guard on client inserts).
insert into public.courses (id, course_code, title, level, status) values
  (t.id('C1'), 'SPI-101', 'Instrumentation Fundamentals', 'foundation', 'published'),
  (t.id('C2'), 'SPI-201', 'Control Systems', 'foundation', 'published'),
  (t.id('C3'), 'SPI-301', 'Legacy Course', 'foundation', 'published'),
  (t.id('C9'), 'SPI-900', 'Scale Course', 'foundation', 'published');
insert into public.modules (id, course_id, module_code, title, sequence) values
  (t.id('M1'), t.id('C1'), 'M1', 'Basics', 1), (t.id('M2'), t.id('C2'), 'M1', 'Loops', 1), (t.id('M3'), t.id('C1'), 'M2', 'Advanced', 2);
insert into public.batches (batch_code, course_id, trainer_id, name, start_date, end_date, status, max_seats) values
  ('B1', t.id('C1'), t.id('T1'), 'B1', '2026-01-01', '2026-12-31', 'ongoing', 30),
  ('B2', t.id('C2'), t.id('T2'), 'B2', '2027-01-01', '2027-06-30', 'upcoming', 30),
  ('B3', t.id('C3'), t.id('T1'), 'B3', '2025-01-01', '2025-06-30', 'completed', 30);
select t.as_('A');
insert into t.ids values
 ('qa1', public.save_question(t.p(t.id('C1'), 'single_choice', 2, t.opts('Flow transmitter*','Flow totaliser','Flow switch'), 'What does FT stand for?'))),
 ('qd1', public.save_question(t.p(t.id('C1'), 'single_choice', 1, t.opts('4-20 mA*','0-5 V'), 'Standard analog signal?'))),
 ('qd2', public.save_question(t.p(t.id('C1'), 'true_false', 1, t.opts('True*','False'), 'A PT measures pressure.'))),
 ('qx1', public.save_question(t.p(t.id('C1'), 'multiple_choice', 3, t.opts('HART*','Profibus*','Bluetooth'), 'Fieldbus protocols?'))),
 ('qc2', public.save_question(t.p(t.id('C2'), 'single_choice', 1, t.opts('PID*','PLC'), 'Which is a control algorithm?'))),
 ('qar', public.save_question(t.p(t.id('C1'), 'single_choice', 1, t.opts('Yes*','No'), 'Archived question?')));
select public.set_question_status(t.id('qa1'), 'active');
select public.set_question_status(t.id('qar'), 'active');
select public.set_question_status(t.id('qar'), 'archived');
select t.as_(null);
select count(*) as questions_seeded from public.questions;
