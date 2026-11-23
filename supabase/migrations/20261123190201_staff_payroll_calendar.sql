-- The displayed payroll month and payment-day shortcut use the same business date.
create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date; v_today date;
begin
  s := app_private.my_staff();
  v_today := app_private.local_today(s.location_ids[1]);
  v_month := date_trunc('month', coalesce(p_month, v_today))::date;
  return jsonb_build_object(
    'month', v_month, 'today', v_today,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation, 'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,v_today),
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency, 'pay_policy',app_private.pay_at_point(v_user,l.id,w.day,w.pay_policy))
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    -- Reminders describe the assigned point; correction links contain only this employee’s shifts.
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'currency', l.currency,
        'today', app_private.local_today(l.id), 'opened_on', least(l.opened_on,l.first_opened_on),
        'awaiting_opening_date', app_private.point_awaits_opening_date(l, app_private.local_today(l.id)),
        'missing_count', gaps.days, 'missing_periods', gaps.periods,
        'recent_corrections', coalesce((select jsonb_agg(to_jsonb(w) order by w.closed_at desc)
          from public.work_shift w where w.employee_id=v_user and w.location_id=l.id and w.status='closed'
            and w.day < calendar.today - 1 and w.closed_at > now() - interval '5 minutes'), '[]'::jsonb),
        'days_off', coalesce((select jsonb_agg(unavailable.day order by unavailable.day) from (
          select d.day from app_private.revenue_day_off d where d.location_id = l.id
            and (d.day between calendar.today - 1 and calendar.today
              or (d.day >= v_month and d.day < v_month + interval '1 month'))
          union
          select day::date from unnest(l.closed_days * datemultirange(
              daterange(v_month,(v_month + interval '1 month')::date),
              daterange(calendar.today - 1,calendar.today + 1))) closure
            cross join lateral generate_series(lower(closure),upper(closure) - 1,interval '1 day') day
        ) unavailable), '[]'::jsonb),
        'pay_today', app_private.pay_at_point(v_user,l.id,app_private.local_today(l.id),app_private.staff_pay_policy(v_user, app_private.local_today(l.id))),
        'pay_yesterday', app_private.pay_at_point(v_user,l.id,app_private.local_today(l.id) - 1,app_private.staff_pay_policy(v_user, app_private.local_today(l.id) - 1)),
        'my_today', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id)),
        'my_yesterday', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id) - 1))
        order by l.name)
      from public.location l
      cross join lateral (select app_private.local_today(l.id) as today) calendar
      cross join lateral (
        -- For an undated legacy point use recorded activity and the current reporting month.
        select case when app_private.point_awaits_opening_date(l, calendar.today) then calendar.today
          else least(calendar.today, coalesce(least(l.opened_on,l.first_opened_on), least(date_trunc('month', calendar.today)::date,
            (select min(r.day) from public.daily_revenue r where r.location_id=l.id),
            (select min(w.day) from public.work_shift w where w.location_id=l.id)))) end as start_day
      ) bounds
      cross join lateral (
        -- Subtract reported and explicitly closed dates as ranges. Large gaps stay compact.
        select datemultirange(daterange(bounds.start_day, calendar.today, '[)'))
          - coalesce(range_agg(daterange(reported.day, reported.day + 1, '[)')), '{}'::datemultirange) as missing
        from (
          select r.day from public.daily_revenue r where r.location_id=l.id and r.day >= bounds.start_day and r.day < calendar.today
          union all
          select d.day from app_private.revenue_day_off d where d.location_id=l.id and d.day >= bounds.start_day and d.day < calendar.today
        ) reported
      ) outstanding
      cross join lateral (
        select coalesce(sum(upper(gap) - lower(gap)),0) as days,
          coalesce(jsonb_agg(jsonb_build_object('from',lower(gap),'until',upper(gap) - 1) order by lower(gap)), '[]'::jsonb) as periods
        from unnest(outstanding.missing - l.closed_days) gap
      ) gaps
      where l.partner_id=s.partner_id and l.id = any(s.location_ids) and l.status = 'active'), '[]'::jsonb),
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) filter (where counts_as_exit) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;
