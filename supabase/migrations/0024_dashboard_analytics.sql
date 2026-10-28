-- ===================================================================
-- 0024 — DASHBOARD ANALYTICS (Phase D2b-1, read-only)
--
-- ONE object: public.dashboard_analytics(p_from date, p_to date,
-- p_limit integer default 10) returns jsonb — the Super Admin
-- dashboard's grouped analytics for an India-time period and its
-- comparison period, in one round trip.
--
-- SECURITY
--   * SECURITY INVOKER: every table / view is read as the CALLER, so
--     the existing RLS policies apply unchanged (the same pattern as the
--     0009 test_best_results view). No SECURITY DEFINER, no
--     service-role path, no writes (STABLE), no dynamic SQL.
--   * set search_path = '' and fully qualified names.
--   * The caller must be an active Super Admin (public.is_super_admin(),
--     which uses current_app_role(): active accounts only) — otherwise
--     SQLSTATE 42501. No second authorization system.
--   * EXECUTE: revoked from public and anon; granted to authenticated.
--   * Output: figures plus ids, codes and names only (students: id,
--     student_code, full_name). No email, phone or account data.
--
-- PERIOD (product decision Q1, as in the D2a application utilities)
--   [p_from, p_to] are India calendar dates; the comparison period is
--   the same number of days immediately before. p_to may not be after
--   today in India; at most 200 days; p_limit 1..50.
--   Trend buckets: ISO weeks (Monday) for periods of 31 days or fewer,
--   calendar months otherwise; bucket starts are clipped to p_from.
--
-- DEFINITIONS
--   Results     best released result per student × test (same ordering
--               as test_best_results, 0009), released = effective status
--               'closed' (test_effective_status, 0008), dated by
--               available_until in India time. Known limitation: there is
--               no closed_at, so a test closed early is dated by its
--               scheduled available_until.
--   Attendance  present + late = attended, absent = not attended,
--               excused excluded; only classes dated up to India today
--               and not cancelled; no attendance record = not counted.
--   Assignments returned submissions with a score, score / max_score,
--               dated by due_at (India date) or else the class date.
--   Waiting     status 'submitted', reviewed_at null, submitted more than
--               7 India calendar days ago (current state).
--   Evidence    batch / course / health figures need 5 results,
--               5 attendance records or 5 scored submissions (counts are
--               always returned; below the minimum the figure is null).
--               Students: 3 results to be ranked, 3 attendance records
--               for the below-75 % count. Topics: 5 graded answers.
--   Trend       results sorted by release time; earlier half vs later
--               half (odd count: middle excluded); change = later avg −
--               earlier avg; improving >= +5, declining <= −5 points.
--   Delivery    upcoming/ongoing batches, non-cancelled classes: delivered
--               = completed status, or dated up to today with attendance;
--               overdue = before today, not delivered.
--   Enrolment   upcoming/ongoing/completed batches (current state):
--               completed enrolments vs non-withdrawn enrolments.
--   No division without NULLIF: no data is NULL, never 0 %.
--
-- Creates one function only. No table, view, index, enum, policy or
-- grant on any table is created or changed. Requires 0023.
-- Rollback: drop function public.dashboard_analytics(date, date, integer);
-- ===================================================================

begin;

do $$
begin
  if position('student_not_available' in pg_get_functiondef('public.admin_set_enrollment(uuid, uuid, public.enrollment_status, text)'::regprocedure)) = 0 then
    raise exception 'Preflight failed: 0023 must be applied first.';
  end if;
  if to_regprocedure('public.dashboard_analytics(date, date, integer)') is not null then
    raise exception 'Preflight failed: 0024 already applied?';
  end if;
end
$$;

create function public.dashboard_analytics(p_from date, p_to date, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_days      integer;
  v_prev_from date;
  v_prev_to   date;
  v_bucket    text;
begin
  if not public.is_super_admin() then
    raise exception 'You don''t have permission to do that.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null then
    raise exception 'A period start and end date are required.' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'The period must start on or before its end.' using errcode = '22023';
  end if;
  if p_to > v_today then
    raise exception 'The period cannot end after today (India time).' using errcode = '22023';
  end if;
  v_days := p_to - p_from + 1;
  if v_days > 200 then
    raise exception 'The period can be at most 200 days.' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'The list limit must be between 1 and 50.' using errcode = '22023';
  end if;
  v_prev_to   := p_from - 1;
  v_prev_from := v_prev_to - (v_days - 1);
  v_bucket    := case when v_days <= 31 then 'week' else 'month' end;

  return (
    with
    -- ---------------------------------------------------------- source rows (both windows, narrowed first)
    rel_tests as (            -- released tests whose result date is in [prev_from, p_to]
      select t.id, t.available_until as released_at, (t.available_until at time zone 'Asia/Kolkata')::date as d
        from public.tests t
       where t.available_until is not null
         and (t.available_until at time zone 'Asia/Kolkata')::date between v_prev_from and p_to
         and public.test_effective_status(t.status, t.available_from, t.available_until) = 'closed'
    ),
    results as (              -- best finished attempt per student × released test (test_best_results ordering)
      select distinct on (a.test_id, a.student_id)
             a.test_id, a.batch_id, a.student_id, a.id as best_attempt_id, a.percentage, a.passed,
             r.d, r.released_at, (r.d >= p_from) as cur
        from public.test_attempts a
        join rel_tests r on r.id = a.test_id
       where a.status <> 'in_progress'
       order by a.test_id, a.student_id, a.percentage desc, a.score desc, a.finalized_at asc
    ),
    att as (                  -- attendance records of held classes, both windows
      select c.batch_id, ca.student_id, c.class_date as d, (c.class_date >= p_from) as cur,
             (ca.status in ('present', 'late')) as attended
        from public.classes c
        join public.class_attendance ca on ca.class_id = c.id
       where c.class_date between v_prev_from and least(p_to, v_today)
         and c.status <> 'cancelled'
         and ca.status <> 'excused'
    ),
    asg as (                  -- scored returned submissions, both windows
      select x.batch_id, x.student_id, x.d, (x.d >= p_from) as cur, x.pct
        from (
          select s.batch_id, s.student_id,
                 coalesce((ca.due_at at time zone 'Asia/Kolkata')::date, c.class_date) as d,
                 (s.score / ca.max_score) * 100 as pct
            from public.assignment_submissions s
            join public.class_assignments ca on ca.id = s.assignment_id
            join public.classes c on c.id = ca.class_id
           where s.status = 'returned' and s.score is not null and ca.max_score > 0
        ) x
       where x.d between v_prev_from and p_to
    ),
    -- ---------------------------------------------------------- per batch, per window
    res_b as (
      select batch_id,
             count(*) filter (where cur) as n, avg(percentage) filter (where cur) as avg_pct,
             count(*) filter (where cur and passed) as passed_n,
             count(*) filter (where not cur) as prev_n, avg(percentage) filter (where not cur) as prev_avg
        from results group by batch_id
    ),
    att_b as (
      select batch_id,
             count(*) filter (where cur) as n, count(*) filter (where cur and attended) as yes,
             count(*) filter (where not cur) as prev_n, count(*) filter (where not cur and attended) as prev_yes
        from att group by batch_id
    ),
    asg_b as (
      select batch_id, count(*) filter (where cur) as n, avg(pct) filter (where cur) as avg_pct
        from asg group by batch_id
    ),
    enr_b as (                -- current state
      select batch_id,
             count(*) filter (where enrollment_status <> 'withdrawn') as active,
             count(*) filter (where enrollment_status = 'completed') as completed
        from public.batch_students group by batch_id
    ),
    batch_scope as (          -- activity in the period, plus every ongoing batch
      select batch_id as id from results where cur
      union select batch_id from att where cur
      union select batch_id from asg where cur
      union select b.id from public.batches b where b.status = 'ongoing'
    ),
    batch_rows as (
      select b.id, b.batch_code, b.name, b.course_id, co.title as course,
             coalesce(e.active, 0) as students, e.completed, e.active,
             coalesce(r.n, 0) as results_n, r.avg_pct, r.passed_n, coalesce(r.prev_n, 0) as prev_results_n, r.prev_avg,
             coalesce(a.n, 0) as attendance_n, a.yes, coalesce(a.prev_n, 0) as prev_attendance_n, a.prev_yes,
             coalesce(s.n, 0) as assignments_n, s.avg_pct as asg_avg
        from batch_scope bs
        join public.batches b on b.id = bs.id
        join public.courses co on co.id = b.course_id
        left join res_b r on r.batch_id = b.id
        left join att_b a on a.batch_id = b.id
        left join asg_b s on s.batch_id = b.id
        left join enr_b e on e.batch_id = b.id
    ),
    -- ---------------------------------------------------------- per course (from the same rows, never per-batch averages)
    res_c as (
      select b.course_id,
             count(*) filter (where r.cur) as n, avg(r.percentage) filter (where r.cur) as avg_pct,
             count(*) filter (where r.cur and r.passed) as passed_n,
             count(*) filter (where not r.cur) as prev_n, avg(r.percentage) filter (where not r.cur) as prev_avg
        from results r join public.batches b on b.id = r.batch_id group by b.course_id
    ),
    att_c as (
      select b.course_id, count(*) filter (where x.cur) as n, count(*) filter (where x.cur and x.attended) as yes
        from att x join public.batches b on b.id = x.batch_id group by b.course_id
    ),
    asg_c as (
      select b.course_id, count(*) filter (where x.cur) as n, avg(x.pct) filter (where x.cur) as avg_pct
        from asg x join public.batches b on b.id = x.batch_id group by b.course_id
    ),
    course_rows as (          -- the courses of the batches in scope; figures over all of each course's records
      select co.id, co.course_code, co.title,
             coalesce(r.n, 0) as results_n, r.avg_pct, r.passed_n, coalesce(r.prev_n, 0) as prev_results_n, r.prev_avg,
             coalesce(a.n, 0) as attendance_n, a.yes,
             coalesce(s.n, 0) as assignments_n, s.avg_pct as asg_avg
        from public.courses co
        left join res_c r on r.course_id = co.id
        left join att_c a on a.course_id = co.id
        left join asg_c s on s.course_id = co.id
       where co.id in (select course_id from batch_rows)
    ),
    -- ---------------------------------------------------------- students (current period, >= 3 results)
    s_ranked as (
      select student_id, percentage,
             row_number() over (partition by student_id order by released_at, test_id) as rn,
             count(*) over (partition by student_id) as n
        from results where cur and percentage is not null
    ),
    s_stats as (
      select st.id, st.student_code, st.full_name, x.n, x.avg_all, x.earlier, x.later, x.later - x.earlier as change
        from (
          select student_id, n, avg(percentage) as avg_all,
                 avg(percentage) filter (where rn <= n / 2) as earlier,
                 avg(percentage) filter (where rn > n - n / 2) as later
            from s_ranked group by student_id, n having n >= 3
        ) x
        join public.students st on st.id = x.student_id
    ),
    -- ---------------------------------------------------------- weak topics (current period; narrowed to its best attempts first)
    -- Graded answers of the period's best attempts are totalled per test question FIRST, so the
    -- test_questions / questions policies are evaluated once per question, not once per answer.
    -- Same result as joining every answer: earned = Σ marks_awarded; available = Σ marks over the
    -- answers = marks × answer count; answers = the count.
    topic_answers as (
      select ans.test_question_id, sum(ans.marks_awarded) as earned, count(*) as answers
        from results r
        join public.test_attempt_answers ans on ans.attempt_id = r.best_attempt_id
       where r.cur and ans.marks_awarded is not null
       group by ans.test_question_id
    ),
    topic_rows as (
      select q.module_id, sum(ta.earned) as earned, sum(tq.marks * ta.answers) as available, sum(ta.answers) as answers
        from topic_answers ta
        join public.test_questions tq on tq.id = ta.test_question_id
        join public.questions q on q.id = tq.source_question_id
       where q.module_id is not null
       group by q.module_id
    ),
    topics as (
      select t.module_id, m.title, round(t.earned / nullif(t.available, 0) * 100, 2) as percent, t.answers
        from topic_rows t join public.modules m on m.id = t.module_id
       where t.answers >= 5 and t.available > 0
    ),
    -- ---------------------------------------------------------- course progress (current state)
    delivery as (
      select b.course_id, count(*) as planned,
             count(*) filter (where cl.status = 'completed' or (cl.class_date <= v_today and ev.has_att)) as delivered,
             count(*) filter (where cl.class_date < v_today and cl.status <> 'completed' and not ev.has_att) as overdue
        from public.classes cl
        join public.batches b on b.id = cl.batch_id
        cross join lateral (select exists (select 1 from public.class_attendance x where x.class_id = cl.id) as has_att) ev
       where b.status in ('upcoming', 'ongoing') and cl.status <> 'cancelled'
       group by b.course_id
    ),
    enrolment as (
      select b.course_id,
             count(*) filter (where bs.enrollment_status = 'completed') as completed,
             count(*) filter (where bs.enrollment_status <> 'withdrawn') as active
        from public.batch_students bs
        join public.batches b on b.id = bs.batch_id
       where b.status in ('upcoming', 'ongoing', 'completed')
       group by b.course_id
    ),
    -- ---------------------------------------------------------- students' current-period attendance (enrolled now)
    st_att as (
      select a.student_id, count(*) as n, count(*) filter (where a.attended) as yes
        from att a
        join public.batch_students bs on bs.batch_id = a.batch_id and bs.student_id = a.student_id and bs.enrollment_status = 'enrolled'
       where a.cur
       group by a.student_id
    ),
    -- ---------------------------------------------------------- trend buckets
    buckets as (
      select greatest(g::date, p_from) as b_from,
             least((g + case when v_bucket = 'week' then interval '1 week' else interval '1 month' end - interval '1 day')::date, p_to) as b_to
        from generate_series(date_trunc(v_bucket, p_from::timestamp),
                             p_to::timestamp,
                             case when v_bucket = 'week' then interval '1 week' else interval '1 month' end) g
    )
    select jsonb_build_object(
      'period', jsonb_build_object('from', p_from, 'to', p_to, 'prev_from', v_prev_from, 'prev_to', v_prev_to, 'bucket', v_bucket, 'days', v_days),

      'trend', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'bucket_start', k.b_from, 'bucket_end', k.b_to,
                 'test_avg', (select round(avg(r.percentage), 2) from results r where r.d between k.b_from and k.b_to),
                 'pass_rate', (select round(100.0 * count(*) filter (where r.passed) / nullif(count(*), 0), 2) from results r where r.d between k.b_from and k.b_to),
                 'results', (select count(*) from results r where r.d between k.b_from and k.b_to),
                 'attendance_pct', (select round(100.0 * count(*) filter (where x.attended) / nullif(count(*), 0), 2) from att x where x.d between k.b_from and k.b_to),
                 'attendance_marked', (select count(*) from att x where x.d between k.b_from and k.b_to),
                 'assignment_avg', (select round(avg(x.pct), 2) from asg x where x.d between k.b_from and k.b_to),
                 'assignments_scored', (select count(*) from asg x where x.d between k.b_from and k.b_to)
               ) order by k.b_from)
          from buckets k), '[]'::jsonb),

      'totals', jsonb_build_object(
        'current', (select jsonb_build_object(
            'test_avg', (select round(avg(percentage), 2) from results where cur),
            'pass_rate', (select round(100.0 * count(*) filter (where passed) / nullif(count(*), 0), 2) from results where cur),
            'results', (select count(*) from results where cur),
            'attendance_pct', (select round(100.0 * count(*) filter (where attended) / nullif(count(*), 0), 2) from att where cur),
            'attendance_marked', (select count(*) from att where cur),
            'assignment_avg', (select round(avg(pct), 2) from asg where cur),
            'assignments_scored', (select count(*) from asg where cur))),
        'previous', (select jsonb_build_object(
            'test_avg', (select round(avg(percentage), 2) from results where not cur),
            'pass_rate', (select round(100.0 * count(*) filter (where passed) / nullif(count(*), 0), 2) from results where not cur),
            'results', (select count(*) from results where not cur),
            'attendance_pct', (select round(100.0 * count(*) filter (where attended) / nullif(count(*), 0), 2) from att where not cur),
            'attendance_marked', (select count(*) from att where not cur),
            'assignment_avg', (select round(avg(pct), 2) from asg where not cur),
            'assignments_scored', (select count(*) from asg where not cur)))),

      'batches', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'code', x.batch_code, 'name', x.name, 'course_id', x.course_id, 'course', x.course,
                 'students', x.students,
                 'attendance_pct', case when x.attendance_n >= 5 then round(100.0 * x.yes / x.attendance_n, 2) end,
                 'attendance_n', x.attendance_n,
                 'test_avg', case when x.results_n >= 5 then round(x.avg_pct, 2) end,
                 'pass_rate', case when x.results_n >= 5 then round(100.0 * x.passed_n / x.results_n, 2) end,
                 'results_n', x.results_n,
                 'assignment_avg', case when x.assignments_n >= 5 then round(x.asg_avg, 2) end,
                 'assignments_n', x.assignments_n,
                 'completion_pct', round(100.0 * x.completed / nullif(x.active, 0), 2),
                 'prev_test_avg', case when x.prev_results_n >= 5 then round(x.prev_avg, 2) end,
                 'prev_results_n', x.prev_results_n,
                 'prev_attendance_pct', case when x.prev_attendance_n >= 5 then round(100.0 * x.prev_yes / x.prev_attendance_n, 2) end,
                 'prev_attendance_n', x.prev_attendance_n
               ) order by x.name, x.id)
          from (select * from batch_rows order by name, id limit p_limit) x), '[]'::jsonb),
      'batches_total', (select count(*) from batch_rows),

      'courses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', x.id, 'code', x.course_code, 'title', x.title,
                 'test_avg', case when x.results_n >= 5 then round(x.avg_pct, 2) end,
                 'pass_rate', case when x.results_n >= 5 then round(100.0 * x.passed_n / x.results_n, 2) end,
                 'results_n', x.results_n,
                 'attendance_pct', case when x.attendance_n >= 5 then round(100.0 * x.yes / x.attendance_n, 2) end,
                 'attendance_n', x.attendance_n,
                 'assignment_avg', case when x.assignments_n >= 5 then round(x.asg_avg, 2) end,
                 'assignments_n', x.assignments_n,
                 'prev_test_avg', case when x.prev_results_n >= 5 then round(x.prev_avg, 2) end,
                 'prev_results_n', x.prev_results_n
               ) order by x.title, x.id)
          from (select * from course_rows order by title, id limit p_limit) x), '[]'::jsonb),
      'courses_total', (select count(*) from course_rows),

      'students', jsonb_build_object(
        'top', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.student_code, 'name', x.full_name,
                                                             'average', round(x.avg_all, 2), 'results', x.n) order by x.avg_all desc, x.n desc, x.full_name, x.id)
                           from (select * from s_stats order by avg_all desc, n desc, full_name, id limit p_limit) x), '[]'::jsonb),
        'improving', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.student_code, 'name', x.full_name,
                                                                   'earlier_avg', round(x.earlier, 2), 'later_avg', round(x.later, 2),
                                                                   'change', round(x.change, 2), 'results', x.n) order by x.change desc, x.full_name, x.id)
                                 from (select * from s_stats where change >= 5 order by change desc, full_name, id limit p_limit) x), '[]'::jsonb),
        'declining', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.student_code, 'name', x.full_name,
                                                                   'earlier_avg', round(x.earlier, 2), 'later_avg', round(x.later, 2),
                                                                   'change', round(x.change, 2), 'results', x.n) order by x.change asc, x.full_name, x.id)
                                 from (select * from s_stats where change <= -5 order by change asc, full_name, id limit p_limit) x), '[]'::jsonb),
        'ranked', (select count(*) from s_stats)),

      'topics', coalesce((
        select jsonb_agg(jsonb_build_object('module_id', x.module_id, 'title', x.title, 'percent', x.percent, 'answers', x.answers,
                                            'band', case when x.percent >= 80 then 'healthy' when x.percent >= 65 then 'watch' else 'attention' end)
                         order by x.percent, x.answers desc, x.title)
          from (select * from topics order by percent, answers desc, title limit least(5, p_limit)) x), '[]'::jsonb),

      'delivery', coalesce((
        select jsonb_agg(jsonb_build_object('course_id', x.course_id, 'course', x.title, 'planned', x.planned,
                                            'delivered', x.delivered, 'overdue', x.overdue) order by x.title, x.course_id)
          from (select d.*, co.title from delivery d join public.courses co on co.id = d.course_id order by co.title, d.course_id limit p_limit) x), '[]'::jsonb),
      'delivery_total', (select count(*) from delivery),

      'enrolment', coalesce((
        select jsonb_agg(jsonb_build_object('course_id', x.course_id, 'course', x.title, 'completed', x.completed,
                                            'active', x.active) order by x.title, x.course_id)
          from (select e.*, co.title from enrolment e join public.courses co on co.id = e.course_id order by co.title, e.course_id limit p_limit) x), '[]'::jsonb),
      'enrolment_total', (select count(*) from enrolment),

      'health', jsonb_build_object(
        'attendance_n', (select count(*) from att where cur),
        'attendance_pct', (select case when count(*) >= 5 then round(100.0 * count(*) filter (where attended) / count(*), 2) end from att where cur),
        'results_n', (select count(*) from results where cur),
        'test_avg', (select case when count(*) >= 5 then round(avg(percentage), 2) end from results where cur),
        'assignments_n', (select count(*) from asg where cur),
        'assignment_avg', (select case when count(*) >= 5 then round(avg(pct), 2) end from asg where cur),
        'students_assessed', (select count(*) from st_att where n >= 3),
        'students_below_75', (select count(*) from st_att where n >= 3 and 100.0 * yes / n < 75),
        'reviews_waiting_over_7d', (select count(*) from public.assignment_submissions s
                                     where s.status = 'submitted' and s.reviewed_at is null
                                       and (s.submitted_at at time zone 'Asia/Kolkata')::date < v_today - 7))
    )
  );
end;
$$;

comment on function public.dashboard_analytics(date, date, integer) is
  '0024: Super Admin dashboard analytics for an India-time period and its comparison period (read-only, SECURITY INVOKER: the caller''s RLS applies).';

revoke all on function public.dashboard_analytics(date, date, integer) from public, anon;
grant execute on function public.dashboard_analytics(date, date, integer) to authenticated;

commit;
