-- 0022 Удобное и честное заполнение выручки (решение владельца 14.10.2026):
--   • «Точка не работала» — день закрывается с причиной и не считается пропуском (выходные, ремонт ТЦ);
--   • все подсчёты пропусков используют один признак «день закрыт» (есть выручка или отмечен нерабочим);
--   • «Сегодня» для франчайзи и управляющего: сводка по своим точкам.

create table public.sales_day_off (
  location_id uuid not null references public.location(id),
  day date not null,
  reason text not null check (length(trim(reason)) > 0),
  set_by uuid not null references public.app_user(id),
  set_at timestamptz not null default now(),
  primary key (location_id, day)
);

create function app_private.sales_day_covered(p_location uuid, p_day date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.daily_sale s where s.location_id = p_location and s.day = p_day)
      or exists (select 1 from public.sales_day_off o where o.location_id = p_location and o.day = p_day)
$$;

create function public.sales_day_off_set(p_location uuid, p_day date, p_off boolean, p_reason text) returns boolean
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('sales.manage', l.partner_id, l.id);
  if p_day is null or p_day > (now() at time zone l.timezone)::date then perform app_private.fail('validation', 'Нельзя отметить будущий день', 'day'); end if;
  if app_private.sales_period_locked(l.id, p_day) then perform app_private.fail('transition-not-allowed', 'Месяц уже сдан отчётом'); end if;
  if p_off then
    if exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = p_day) then
      perform app_private.fail('validation', 'За этот день уже есть выручка — сначала удалите её', 'day');
    end if;
    if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину: выходной, ремонт, болезнь…', 'reason'); end if;
    insert into public.sales_day_off(location_id, day, reason, set_by) values (l.id, p_day, trim(p_reason), v_user)
    on conflict (location_id, day) do update set reason = excluded.reason, set_by = excluded.set_by, set_at = now();
  else
    delete from public.sales_day_off where location_id = l.id and day = p_day;
  end if;
  perform app_private.audit('sales.day_off', 'location', l.id, l.partner_id, jsonb_build_object('day', p_day, 'off', p_off), p_reason);
  return p_off;
end $$;

-- Внесённая выручка снимает отметку «не работала»
create function app_private.sales_clear_day_off() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.sales_day_off where location_id = new.location_id and day = new.day;
  return new;
end $$;
create trigger daily_sale_clear_day_off after insert on public.daily_sale for each row execute function app_private.sales_clear_day_off();

-- sales_month
create or replace function public.sales_month(p_location uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_from date := date_trunc('month', p_month)::date; v_to date; v_today date; v_manage boolean;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_manage := app_private.has_perm('sales.manage', l.partner_id, l.id);
  if not (v_manage or app_private.has_perm('sales.read', l.partner_id, l.id)) then perform app_private.fail('forbidden', 'Нет доступа к выручке точки'); end if;
  v_today := (now() at time zone l.timezone)::date;
  v_to := least((v_from + interval '1 month' - interval '1 day')::date, v_today);
  return jsonb_build_object(
    'location', jsonb_build_object('id', l.id, 'name', l.name, 'currency', l.currency, 'timezone', l.timezone),
    'month', v_from, 'today', v_today, 'can_manage', v_manage, 'locked', app_private.sales_period_locked(l.id, v_from),
    'rate_bp', app_private.commission_rate(l.id, least(v_to, v_today)),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name,
        'rate_bp', app_private.commission_rate(l.id, v_today, u.id),
        'personal_rate', exists (select 1 from public.commission_policy c where c.location_id = l.id and c.employee_id = u.id and c.effective_from <= v_today),
        'can_sell', app_private.user_can_sell_at(u.id, l.id),
        'on_shift_since', (select w.opened_at from public.work_shift w where w.location_id = l.id and w.employee_id = u.id and w.status = 'open' and w.day = v_today)
      ) order by u.full_name)
      from public.app_user u where app_private.user_can_sell_at(u.id, l.id)
         or exists (select 1 from public.daily_sale s where s.location_id = l.id and s.employee_id = u.id and s.day between v_from and v_to)), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'day', s.day, 'employee_id', s.employee_id, 'revenue_minor', s.revenue_minor,
        'returns_minor', s.returns_minor, 'card_minor', s.card_minor, 'services_count', s.services_count, 'source', s.source, 'revision', s.revision,
        'comment', s.comment, 'reduced_by_manager', s.reduced_by_manager,
        'rate_bp', app_private.commission_rate(s.location_id, s.day, s.employee_id),
        'files', (select count(*) from public.attachment_link a where a.entity_type = 'daily_sale' and a.entity_id = s.id)) order by s.day)
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'employee_id', c.employee_id, 'rate_bp', c.rate_bp, 'effective_from', c.effective_from,
        'note', c.note) order by c.effective_from desc)
      from public.commission_policy c where c.location_id = l.id), '[]'::jsonb),
    'days_off', coalesce((select jsonb_agg(jsonb_build_object('day', o.day, 'reason', o.reason) order by o.day) from public.sales_day_off o
      where o.location_id = l.id and o.day between v_from and v_to), '[]'::jsonb),
    'missing_days', coalesce((select jsonb_agg(d::date order by d) from generate_series(v_from, v_to, interval '1 day') d
      where not app_private.sales_day_covered(l.id, d::date)), '[]'::jsonb),
    'totals', (select jsonb_build_object('revenue_minor', coalesce(sum(revenue_minor), 0)::bigint, 'returns_minor', coalesce(sum(returns_minor), 0)::bigint,
        'card_minor', coalesce(sum(card_minor), 0)::bigint, 'services', coalesce(sum(services_count), 0)::bigint, 'days_with_data', count(distinct day),
        'earnings_minor', coalesce(sum(round((revenue_minor - returns_minor)::numeric * app_private.commission_rate(location_id, day, employee_id) / 10000)), 0)::bigint)
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to),
    'days_in_period', (v_to - v_from + 1)
  );
end $$;

-- sales_for_report
create or replace function public.sales_for_report(p_contract uuid, p_period date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare c public.contract; v_from date := date_trunc('month', p_period)::date; v_to date := (date_trunc('month', p_period) + interval '1 month' - interval '1 day')::date;
begin
  perform app_private.require_user();
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.can_read_royalty(c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  return jsonb_build_object('period', v_from, 'days_in_period', v_to - v_from + 1, 'locations', coalesce((
    select jsonb_agg(jsonb_build_object('location_id', cl.location_id, 'location_name', l.name,
      'gross_minor', coalesce((select sum(revenue_minor) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to), 0)::bigint,
      'returns_minor', coalesce((select sum(returns_minor) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to), 0)::bigint,
      'days_with_data', (select count(distinct day) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to),
      'missing_days', coalesce((select jsonb_agg(d::date order by d) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), v_to, interval '1 day') d
        where not app_private.sales_day_covered(cl.location_id, d::date)), '[]'::jsonb)) order by l.name)
    from public.contract_location cl join public.location l on l.id = cl.location_id
    where cl.contract_id = c.id and cl.valid_from <= v_to and (cl.valid_to is null or cl.valid_to >= v_from)), '[]'::jsonb));
end $$;

-- sales_control
create or replace function public.sales_control(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := date_trunc('month', coalesce(p_month, current_date))::date; v_to date;
begin
  perform app_private.require_user();
  if not app_private.is_staff() or not app_private.has_perm_anywhere('sales.read') then
    perform app_private.fail('forbidden', 'Контроль выручки доступен сотрудникам компании');
  end if;
  v_to := least((v_from + interval '1 month' - interval '1 day')::date, current_date);
  return jsonb_build_object('month', v_from, 'days_in_period', v_to - v_from + 1, 'locations', coalesce((
    select jsonb_agg(x order by x.risk desc, x.partner_name, x.location_name) from (
      select y.*,
        (case when y.film_phones_60d > 0 and y.services_est_60d < y.film_phones_60d * 0.6 then 2 else 0 end
         + case when y.missing_days > 2 then 1 else 0 end
         + case when y.reductions > 0 then 2 else 0 end
         + case when y.report_diff_minor < 0 then 3 else 0 end
         + case when y.card_share is not null and y.card_share < 0.35 then 1 else 0 end) as risk
      from (
        select l.id as location_id, l.name as location_name, l.kind, l.currency, p.id as partner_id, coalesce(p.name, 'Собственная точка') as partner_name,
          coalesce(m.revenue, 0) as revenue_minor, coalesce(m.services, 0) as services, coalesce(m.days, 0) as days_with_data,
          (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), v_to, interval '1 day') g
             where not app_private.sales_day_covered(l.id, g::date))::int as missing_days,
          case when coalesce(m.services, 0) > 0 then (m.revenue / m.services)::bigint end as avg_check_minor,
          case when coalesce(m.revenue, 0) > 0 and m.card_known > 0 then round(m.card::numeric / m.card_known, 2) end as card_share,
          coalesce((select sum(ol.qty_ordered * i.phones_per_unit) from public.order_line ol join public.sales_order o on o.id = ol.order_id
             join public.catalog_item i on i.id = ol.item_id
             where o.location_id = l.id and o.status not in ('draft', 'cancelled') and i.phones_per_unit is not null
               and coalesce(o.submitted_at, o.created_at) >= v_to - 60), 0)::int as film_phones_60d,
          coalesce((select sum(s.services_count) from public.daily_sale s where s.location_id = l.id and s.day > v_to - 60 and s.day <= v_to), 0)::int as services_60d,
          -- Оценка оклеек за те же 60 дней по среднему за день со сменами (смены могли вестись меньше 60 дней)
          coalesce((select round(sum(s.services_count) * 60.0 / greatest(count(distinct s.day), 1)) from public.daily_sale s
             where s.location_id = l.id and s.day > v_to - 60 and s.day <= v_to), 0)::int as services_est_60d,
          (select count(*) from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to and s.reduced_by_manager)::int as reductions,
          (select count(*) from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to and s.source = 'manager')::int as manager_entries,
          coalesce((select (d->>'reported_minor')::bigint - (d->>'daily_minor')::bigint from public.report_sales_check c
             cross join lateral jsonb_array_elements(c.detail) d where c.partner_id = l.partner_id and (d->>'location_id')::uuid = l.id
             order by c.period desc limit 1), 0) as report_diff_minor,
          (select c.period from public.report_sales_check c cross join lateral jsonb_array_elements(c.detail) d
             where c.partner_id = l.partner_id and (d->>'location_id')::uuid = l.id order by c.period desc limit 1) as report_period
        from public.location l left join public.partner p on p.id = l.partner_id
        left join lateral (select sum(s.revenue_minor)::bigint as revenue, sum(s.services_count)::bigint as services, count(distinct s.day) as days,
            sum(s.card_minor) filter (where s.card_minor is not null) as card, sum(s.revenue_minor) filter (where s.card_minor is not null) as card_known
          from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to) m on true
        where l.status = 'active' and app_private.has_perm('sales.read', l.partner_id, l.id)
      ) y) x), '[]'::jsonb));
end $$;

-- network_map
create or replace function public.network_map() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_control jsonb;
begin
  perform app_private.require_user();
  if not (app_private.is_staff() and app_private.has_perm_anywhere('metrics.read')) then
    perform app_private.fail('forbidden', 'Карта сети доступна руководству компании');
  end if;
  -- Сигналы контроля выручки (если есть право на выручку)
  v_control := case when app_private.has_perm_anywhere('sales.read') then public.sales_control(current_date) -> 'locations' else '[]'::jsonb end;
  return jsonb_build_object('generated_at', now(), 'locations', coalesce((select jsonb_agg(x order by x.kind, x.name) from (
    select l.id, l.code, l.name, l.kind, l.status, l.city, l.country, l.address, l.currency, l.opened_on,
      coalesce(l.lat, g.lat) as lat, coalesce(l.lng, g.lng) as lng,
      p.id as partner_id, p.name as partner_name,
      (now() at time zone l.timezone)::date as today,
      m.revenue_minor, m.days_with_data, prev.revenue_minor as prev_revenue_minor,
      (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day = (now() at time zone l.timezone)::date)::bigint as today_revenue_minor,
      ((now() at time zone l.timezone)::date - greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01')) ) as days_passed,
      (select count(*) from generate_series(greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01')),
          (now() at time zone l.timezone)::date - 1, interval '1 day') d
        where not app_private.sales_day_covered(l.id, d::date))::int as missing_days,
      coalesce((select jsonb_agg(jsonb_build_object('name', u.full_name, 'since', w.opened_at)) from public.work_shift w join public.app_user u on u.id = w.employee_id
        where w.location_id = l.id and w.status = 'open' and w.day = (now() at time zone l.timezone)::date), '[]'::jsonb) as on_shift,
      (select count(*) from public.ticket t where t.location_id = l.id and t.status not in ('resolved', 'closed'))::int as open_tickets,
      (select count(*) from public.ticket t where t.location_id = l.id and t.status not in ('resolved', 'closed') and t.urgency = 'stopped')::int as stopped_tickets,
      (select jsonb_build_object('id', o.id, 'planned_open_on', o.planned_open_on, 'status', o.status,
          'done', (select count(*) from public.task k where k.subject_id = o.id and k.status = 'done'),
          'total', (select count(*) from public.task k where k.subject_id = o.id and k.status <> 'cancelled'))
        from public.opening_project o where o.location_id = l.id and o.status in ('active', 'approved') order by o.created_at desc limit 1) as opening,
      case when p.id is not null then (select jsonb_build_object('outstanding_minor', coalesce(sum(b.outstanding_minor), 0), 'overdue_minor',
          coalesce(sum(b.outstanding_minor) filter (where b.due_on < current_date), 0), 'currency', max(b.currency))
        from public.v_accrual_balance b where b.partner_id = p.id and b.outstanding_minor > 0) end as debt,
      (select c from jsonb_array_elements(v_control) c where (c ->> 'location_id')::uuid = l.id) as control
    from public.location l
    left join public.partner p on p.id = l.partner_id
    left join public.city_geo g on g.country = l.country and g.city = l.city
    left join lateral (select coalesce(sum(s.revenue_minor), 0)::bigint as revenue_minor, count(distinct s.day)::int as days_with_data
      from public.daily_sale s where s.location_id = l.id and s.day >= date_trunc('month', now() at time zone l.timezone)::date) m on true
    left join lateral (select coalesce(sum(s.revenue_minor), 0)::bigint as revenue_minor from public.daily_sale s where s.location_id = l.id
      and s.day >= (date_trunc('month', now() at time zone l.timezone) - interval '1 month')::date
      and s.day < date_trunc('month', now() at time zone l.timezone)::date) prev on true
    where l.status <> 'closed' and app_private.in_scope(l.partner_id, l.id)
  ) x), '[]'::jsonb));
end $$;

-- sales_check_report
create or replace function app_private.sales_check_report() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := new.period; v_to date := (new.period + interval '1 month' - interval '1 day')::date;
  v_detail jsonb; v_rep bigint; v_daily bigint; v_missing int;
begin
  if new.status <> 'submitted' or old.status = new.status then return new; end if;
  select coalesce(jsonb_agg(jsonb_build_object('location_id', rl.location_id, 'location_name', l.name, 'reported_minor', rl.gross_minor,
      'daily_minor', d.gross, 'missing_days', d.missing)), '[]'::jsonb),
    coalesce(sum(rl.gross_minor), 0), coalesce(sum(d.gross), 0), coalesce(sum(d.missing), 0)
  into v_detail, v_rep, v_daily, v_missing
  from public.report_line rl join public.location l on l.id = rl.location_id
  cross join lateral (select coalesce((select sum(revenue_minor) from public.daily_sale s where s.location_id = rl.location_id and s.day between v_from and v_to), 0)::bigint as gross,
      (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), least(v_to, current_date), interval '1 day') g
        where not app_private.sales_day_covered(rl.location_id, g::date))::int as missing) d
  where rl.revision_id = new.current_revision_id;
  insert into public.report_sales_check(report_id, partner_id, period, reported_gross_minor, daily_gross_minor, diff_minor, missing_days, detail)
  values (new.id, new.partner_id, new.period, v_rep, v_daily, v_rep - v_daily, v_missing, v_detail)
  on conflict (report_id) do update set reported_gross_minor = excluded.reported_gross_minor, daily_gross_minor = excluded.daily_gross_minor,
    diff_minor = excluded.diff_minor, missing_days = excluded.missing_days, detail = excluded.detail, checked_at = now();
  -- Отчёт меньше ежедневной выручки больше чем на 1 % — сигнал финансам и менеджеру франшизы
  if v_daily > 0 and v_rep < v_daily * 0.99 then
    perform app_private.notify_queue('finance', new.partner_id, null, 'sales.mismatch', 'Отчёт меньше ежедневной выручки: ' || new.number,
      'В отчёте ' || v_rep / 100 || ', по сменам ' || v_daily / 100 || ' (разница ' || (v_daily - v_rep) / 100 || ')',
      'revenue_report', new.id, '/royalties/reports/' || new.id, 'mismatch:' || new.id || ':' || new.current_revision_id, true);
    perform app_private.notify_queue('franchise_manager', new.partner_id, null, 'sales.mismatch', 'Отчёт меньше ежедневной выручки: ' || new.number,
      'В отчёте ' || v_rep / 100 || ', по сменам ' || v_daily / 100, 'revenue_report', new.id, '/royalties/reports/' || new.id,
      'mismatch:' || new.id || ':' || new.current_revision_id);
  end if;
  return new;
end $$;

-- today
create or replace function public.today(p_partner uuid default null, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v jsonb := '{}'::jsonb;
begin
  -- Мои задачи: ближайшие сроки первыми
  v := v || jsonb_build_object('my_tasks', coalesce((select jsonb_agg(x order by x.due_at nulls last, x.priority_order) from (
    select t.id, t.number, t.title, t.status, t.due_at, t.priority, t.is_critical, t.kind, t.subject_type, t.subject_id,
      (select name from public.location where id = t.location_id) as location_name,
      (select name from public.partner where id = t.partner_id) as partner_name,
      case t.priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end as priority_order,
      t.status_reason
    from public.task t
    where t.assignee_id = v_user and t.status not in ('done', 'cancelled', 'planned')
      and (p_partner is null or t.partner_id = p_partner) and (p_location is null or t.location_id = p_location)
    order by t.due_at nulls last limit 30) x), '[]'::jsonb));

  -- Очередь: задачи моих ролей без исполнителя
  v := v || jsonb_build_object('queue_tasks', coalesce((select jsonb_agg(x order by x.due_at nulls last) from (
    select t.id, t.number, t.title, t.status, t.due_at, t.priority, t.queue_role,
      (select name from public.role where code = t.queue_role) as queue_name,
      (select name from public.location where id = t.location_id) as location_name,
      (select name from public.partner where id = t.partner_id) as partner_name
    from public.task t
    where t.assignee_id is null and t.status in ('ready', 'in_review')
      and app_private.user_in_queue(v_user, t.queue_role, t.partner_id, t.location_id)
      and app_private.can_read_task(t)
      and (p_partner is null or t.partner_id = p_partner) and (p_location is null or t.location_id = p_location)
    order by t.due_at nulls last limit 30) x), '[]'::jsonb));

  -- Обращения: мои как исполнителя или автора; новые в моих очередях
  v := v || jsonb_build_object('tickets', coalesce((select jsonb_agg(x order by x.urgent desc, x.resolve_due) from (
    select k.id, k.number, k.subject, k.status, k.urgency, k.resolve_due, k.first_response_due, k.first_response_at,
      (k.urgency = 'stopped') as urgent, (select name from public.location where id = k.location_id) as location_name,
      case when k.created_by = v_user then 'author' when k.assignee_id = v_user then 'assignee' else 'queue' end as relation
    from public.ticket k
    where k.status not in ('closed')
      and (k.created_by = v_user or k.assignee_id = v_user
           or (k.assignee_id is null and k.status = 'new' and app_private.user_in_queue(v_user, k.queue_role, k.partner_id, k.location_id)))
      and (k.status <> 'resolved' or k.created_by = v_user)
      and (p_partner is null or k.partner_id = p_partner) and (p_location is null or k.location_id = p_location)
    limit 30) x), '[]'::jsonb));

  -- Согласования и подтверждения по моим разрешениям
  v := v || jsonb_build_object('approvals', coalesce((select jsonb_agg(x) from (
    select 'order' as kind, o.id, o.number as number, 'Согласовать заявку' as title, o.total_minor as amount_minor, o.currency, o.submitted_at as at,
      '/orders/' || o.id as link
    from public.sales_order o where o.approval_status = 'pending' and o.created_by <> v_user
      and app_private.has_perm('order.approve', o.partner_id, o.location_id)
    union all
    select 'order_payment', o.id, o.number, 'Подтвердить оплату заказа', o.total_minor, o.currency, o.submitted_at, '/orders/' || o.id
    from public.sales_order o where o.payment_status in ('required', 'reported') and o.status <> 'cancelled'
      and app_private.has_perm('order.payment.confirm', o.partner_id, o.location_id) and o.created_by <> v_user
    union all
    select 'report', r.id, r.number, 'Проверить отчёт о выручке', null, null, r.updated_at, '/royalties/reports/' || r.id
    from public.revenue_report r where r.status in ('submitted', 'in_review') and app_private.has_perm('royalty.review', r.partner_id)
    union all
    select 'accrual', r.id, r.number, 'Опубликовать начисление', null, null, r.updated_at, '/royalties/reports/' || r.id
    from public.revenue_report r where r.status = 'approved' and app_private.has_perm('royalty.publish', r.partner_id)
      and not exists (select 1 from public.accrual a where a.contract_id = r.contract_id and a.period = r.period and a.status = 'published')
    union all
    select 'payment', p.id, p.number, case p.status when 'reported' then 'Проверить сообщение об оплате' else 'Подтвердить зачисление' end,
      p.amount_minor, p.currency, p.created_at, '/royalties/payments/' || p.id
    from public.payment p where p.status in ('reported', 'registered') and app_private.has_perm('payment.confirm', p.partner_id)
      and (p.status = 'reported' or p.registered_by is distinct from v_user)
    union all
    select 'article', a.id, r.title, 'Согласовать статью', null, null, r.submitted_at, '/kb/articles/' || a.id || '/review'
    from public.article_revision r join public.article a on a.id = r.article_id
    where r.status = 'in_review' and app_private.has_perm_anywhere('kb.publish') and r.author_id is distinct from v_user
    union all
    select 'opening', p.id, p.number, 'Выдать разрешение на открытие', null, null, p.updated_at, '/openings/' || p.id
    from public.opening_project p where p.status = 'active' and app_private.has_perm('opening.approve', p.partner_id, p.location_id)
      and not exists (select 1 from public.opening_blockers(p.id))
    order by 7 limit 40) x), '[]'::jsonb));

  -- Обязательное обучение (ознакомления)
  v := v || jsonb_build_object('acks', coalesce((select jsonb_agg(x order by x.due_on) from (
    select k.id, k.article_id, k.revision_id, k.due_on, r.title
    from public.ack_assignment k join public.article_revision r on r.id = k.revision_id
    join public.article a on a.id = k.article_id and a.published_revision_id = k.revision_id
    where k.user_id = v_user and k.completed_at is null limit 20) x), '[]'::jsonb));

  -- Незавершённые черновики
  v := v || jsonb_build_object('drafts', coalesce((select jsonb_agg(x) from (
    select 'cart' as kind, o.id, 'Корзина: ' || (select name from public.location where id = o.location_id) as title, o.updated_at,
      '/catalog?order=' || o.id as link, (select count(*) from public.order_line where order_id = o.id) as items
    from public.sales_order o where o.created_by = v_user and o.status = 'draft' and exists (select 1 from public.order_line where order_id = o.id)
    union all
    select 'report', r.id, 'Отчёт ' || r.number || ' за ' || to_char(r.period, 'MM.YYYY'), r.updated_at, '/royalties/reports/' || r.id, null
    from public.revenue_report r where r.status in ('draft', 'needs_correction') and app_private.has_perm('royalty.report.submit', r.partner_id)
    union all
    select 'article', a.id, 'Черновик: ' || v2.title, v2.updated_at, '/kb/articles/' || a.id || '/edit', null
    from public.article_revision v2 join public.article a on a.id = v2.article_id
    where v2.author_id = v_user and v2.status in ('draft', 'rejected')
    limit 20) x), '[]'::jsonb));

  -- Критические события: срочные непрочитанные уведомления
  v := v || jsonb_build_object('critical', coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select n.id, n.title, n.body, n.link, n.created_at, n.kind from public.notification n
    where n.user_id = v_user and n.critical and n.read_at is null and n.kind <> 'kb.ack' -- ознакомления показаны отдельным блоком
    order by n.created_at desc limit 10) x), '[]'::jsonb));

  -- Сводка для открытия проектов партнёра/менеджера
  v := v || jsonb_build_object('openings', coalesce((select jsonb_agg(x order by x.planned_open_on) from (
    select p.id, p.number, p.status, p.planned_open_on, l.name as location_name, g.done_tasks, g.total_tasks, g.critical_open,
      g.overdue_tasks, g.date_at_risk
    from public.opening_project p join public.location l on l.id = p.location_id
    join public.v_opening_progress g on g.project_id = p.id
    where p.status in ('active', 'approved', 'opened') and app_private.has_perm('opening.read', p.partner_id, p.location_id)
      and (p_partner is null or p.partner_id = p_partner) limit 10) x), '[]'::jsonb));

  -- Финансы партнёра: открытые начисления
  v := v || jsonb_build_object('balances', coalesce((select jsonb_agg(x order by x.due_on) from (
    select b.accrual_id, b.number, b.period, b.currency, b.outstanding_minor, b.due_on, (b.due_on < current_date) as overdue
    from public.accrual a join public.v_accrual_balance b on b.accrual_id = a.id
    where b.outstanding_minor > 0 and app_private.has_perm('royalty.read', a.partner_id)
      and not app_private.has_perm('royalty.publish', a.partner_id)
      and (p_partner is null or a.partner_id = p_partner) limit 10) x), '[]'::jsonb));
  -- Выручка: моя смена и пропуски на точках, которыми я управляю
  v := v || jsonb_build_object('sales', jsonb_build_object(
    'my', case when exists (select 1 from public.location l where app_private.user_can_sell_at(v_user, l.id)) then public.my_earnings(current_date) end,
    'missing', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'days', m.n)) from public.location l
      cross join lateral (select count(*) as n from generate_series(date_trunc('month', now() at time zone l.timezone)::date,
          ((now() at time zone l.timezone)::date - 1), interval '1 day') d
        where not app_private.sales_day_covered(l.id, d::date)) m
      where l.status = 'active' and m.n > 0 and app_private.has_perm('sales.manage', l.partner_id, l.id) and l.partner_id is not distinct from coalesce(p_partner, l.partner_id)
        and (p_location is null or l.id = p_location) and not app_private.has_perm('sales.manage', null, null)), '[]'::jsonb),
    'on_shift', coalesce((select jsonb_agg(jsonb_build_object('location_name', l.name, 'name', u.full_name, 'opened_at', w.opened_at) order by w.opened_at)
      from public.work_shift w join public.location l on l.id = w.location_id join public.app_user u on u.id = w.employee_id
      where w.status = 'open' and w.employee_id <> v_user and app_private.has_perm('sales.manage', l.partner_id, l.id)
        and not app_private.has_perm('sales.manage', null, null)
        and (p_partner is null or l.partner_id = p_partner) and (p_location is null or l.id = p_location)), '[]'::jsonb)));
  -- Точки, которыми я управляю (франчайзи, управляющий): выручка месяца, заполненность, кто на смене
  v := v || jsonb_build_object('points', coalesce((select jsonb_agg(x order by x.status <> 'active', x.name) from (
    select l.id, l.name, l.status, l.currency,
      (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= date_trunc('month', now() at time zone l.timezone)::date)::bigint as revenue_minor,
      (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day = (now() at time zone l.timezone)::date)::bigint as today_minor,
      greatest(0, (now() at time zone l.timezone)::date - greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01'::date)))::int as days_passed,
      case when l.status = 'active' then (select count(*) from generate_series(greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01'::date)),
          (now() at time zone l.timezone)::date - 1, interval '1 day') d where not app_private.sales_day_covered(l.id, d::date))::int else 0 end as missing,
      coalesce((select jsonb_agg(u.full_name) from public.work_shift w join public.app_user u on u.id = w.employee_id
        where w.location_id = l.id and w.status = 'open' and w.day = (now() at time zone l.timezone)::date), '[]'::jsonb) as on_shift
    from public.location l
    where l.status in ('active', 'opening') and app_private.has_perm('sales.manage', l.partner_id, l.id) and not app_private.has_perm('sales.manage', null, null)
      and (p_partner is null or l.partner_id = p_partner) and (p_location is null or l.id = p_location)) x), '[]'::jsonb));
  -- Поставки: только тем, кто заказывает
  if app_private.has_perm_anywhere('order.create') then
    v := v || jsonb_build_object('supply', jsonb_build_object(
      'new_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'subtitle', i.subtitle, 'visual', i.visual, 'sku', i.sku) order by i.published_at desc)
        from public.catalog_item i where i.active and i.published_at > now() - interval '14 days'), '[]'::jsonb),
      'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'available', app_private.stock_total(i.id) > 0,
          'expected_on', (select min(r.expected_on) from public.stock_incoming r where r.item_id = i.id and r.status = 'planned')) order by i.name)
        from public.stock_subscription s join public.catalog_item i on i.id = s.item_id where s.user_id = v_user), '[]'::jsonb)));
  end if;
  return v;
end $$;

alter table public.sales_day_off enable row level security;
create policy read_scope on public.sales_day_off for select to authenticated
  using (exists (select 1 from public.location l where l.id = location_id
    and (app_private.has_perm('sales.manage', l.partner_id, l.id) or app_private.has_perm('sales.read', l.partner_id, l.id))));
insert into app_private.client_table(tbl) values ('public.sales_day_off');
insert into app_private.client_command(fn) values ('public.sales_day_off_set(uuid, date, boolean, text)');
select app_private.apply_grants();
