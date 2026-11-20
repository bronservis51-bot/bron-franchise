-- Explicit calendar exceptions never create or replace a financial entry.
create table app_private.revenue_day_off (
  location_id uuid not null references public.location(id),
  day date not null,
  marked_by uuid not null references public.app_user(id),
  marked_at timestamptz not null default now(),
  primary key (location_id, day)
);

alter table app_private.revenue_day_off enable row level security;
revoke all on app_private.revenue_day_off from public, anon, authenticated;

create function public.revenue_day_off_set(p_location uuid, p_day date, p_day_off boolean) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  v_user uuid := app_private.require_user();
  l public.location;
begin
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if p_day_off and l.status <> 'active' then
    perform app_private.fail('validation', 'Точка закрыта');
  end if;
  if p_day_off is null or p_day is null or not isfinite(p_day) or p_day > app_private.local_today(l.id) then
    perform app_private.fail('validation', 'Выберите дату не позднее сегодняшнего дня', 'day');
  end if;
  if not app_private.revenue_day_open(l.id, p_day) then
    perform app_private.fail('period-locked', 'Этот месяц уже закрыт. Прошлый месяц можно поправить до 5-го числа — обратитесь к менеджеру', 'day');
  end if;
  if p_day_off and p_day < l.opened_on then
    perform app_private.fail('validation', 'Точка ещё не была открыта в этот день', 'day');
  end if;

  perform app_private.revenue_day_lock(l.id, p_day);
  if p_day_off then
    if exists (select 1 from public.daily_revenue r where r.location_id = l.id and r.day = p_day) then
      perform app_private.fail('validation', 'За этот день уже внесена выручка', 'day');
    end if;
    if exists (select 1 from public.work_shift w where w.partner_id = l.partner_id and w.location_id = l.id and w.day = p_day) then
      perform app_private.fail('validation', 'На эту дату уже есть смена', 'day');
    end if;
    insert into app_private.revenue_day_off(location_id, day, marked_by) values (l.id, p_day, v_user)
    on conflict (location_id, day) do nothing;
  else
    delete from app_private.revenue_day_off where location_id = l.id and day = p_day;
  end if;
  if found then
    perform app_private.audit('revenue.day_off', 'location', l.id, l.partner_id, jsonb_build_object('day', p_day, 'day_off', p_day_off));
  end if;
end $$;

-- Serialize every writer for this day, including older clients and imports.
create function app_private.revenue_day_off_guard() returns trigger
language plpgsql set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.revenue_day_lock(new.location_id, new.day);
  if exists (select 1 from app_private.revenue_day_off d where d.location_id = new.location_id and d.day = new.day) then
    perform app_private.fail('validation', 'Дата отмечена как выходной. Сначала снимите отметку в выручке точки', 'day');
  end if;
  return new;
end $$;

create trigger revenue_day_off_guard before insert or update of location_id, day on public.daily_revenue
  for each row execute function app_private.revenue_day_off_guard();
create trigger revenue_day_off_guard before insert or update of location_id, day on public.work_shift
  for each row execute function app_private.revenue_day_off_guard();

-- Shared projection for owner and network manager. Keep financial aggregates intact.
create or replace function app_private.location_month(l public.location, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_today date := app_private.local_today(l.id);
  v_from date := greatest(v_month, coalesce(l.opened_on, v_month));
  v_plan bigint; v_fact bigint; v_cash bigint; v_card bigint; v_missing date[]; v_days_off date[]; v_left int; v_last date;
begin
  select amount_minor into v_plan from public.revenue_plan where location_id = l.id and month = v_month;
  select coalesce(sum(total_minor), 0), coalesce(sum(cash_minor), 0), coalesce(sum(card_minor), 0), max(day)
    into v_fact, v_cash, v_card, v_last
  from public.daily_revenue where location_id = l.id and day between v_month and v_end;
  select coalesce(array_agg(day order by day), '{}') into v_days_off
    from app_private.revenue_day_off where location_id = l.id and day between v_month and v_end;
  select coalesce(array_agg(d::date order by d), '{}') into v_missing
  from generate_series(v_from, least(v_end, v_today - 1), interval '1 day') d
  where l.status = 'active' and not (d::date = any(v_days_off))
    and not exists (select 1 from public.daily_revenue r where r.location_id = l.id and r.day = d::date);
  v_left := case when v_today between v_month and v_end then (v_end - v_today + 1) else 0 end;
  return jsonb_build_object(
    'location_id', l.id, 'location_name', l.name, 'city', l.city, 'currency', l.currency, 'status', l.status, 'opened_on', l.opened_on,
    'partner_id', l.partner_id, 'partner_name', (select name from public.partner where id = l.partner_id),
    'month', v_month, 'today', v_today, 'plan_minor', v_plan, 'fact_minor', v_fact, 'cash_minor', v_cash, 'card_minor', v_card,
    'pct', case when coalesce(v_plan, 0) > 0 then round(v_fact * 100.0 / v_plan, 1) end,
    'days_in_month', extract(day from v_end)::int,
    'days_left', v_left,
    'need_per_day_minor', case when v_plan is not null and v_left > 0 and v_plan > v_fact then (ceil((v_plan - v_fact)::numeric / v_left / 100) * 100)::bigint end,
    'missing_days', to_jsonb(v_missing), 'days_off', to_jsonb(v_days_off),
    'last_day', v_last,
    'fx_rub', app_private.fx_rub(l.currency, least(v_end, v_today)));
end $$;

-- Exclude days off only from reporting completeness. Keep forecasts and ranking formulas intact.
create or replace function public.rating(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date))::date; v_rows jsonb; v_my uuid;
  v_fx_day date := least((date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date)) + interval '1 month - 1 day')::date,
                         (now() at time zone 'Europe/Moscow')::date);
begin
  perform app_private.require_user();
  if not app_private.has_perm('rating.read') or not app_private.rating_allowed() then
    perform app_private.fail('forbidden', 'Рейтинг доступен только менеджеру по франшизе');
  end if;
  select scope_id into v_my from app_private.active_assignments() where scope_type = 'partner' limit 1;
  with per_loc as (
    select l.partner_id, x.*,
      x.elapsed_days - (select count(*) from app_private.revenue_day_off d where d.location_id = l.id
        and d.day between greatest(v_month, coalesce(l.opened_on, v_month)) and least(
          (v_month + interval '1 month - 1 day')::date, app_private.local_today(l.id) - 1)) as working_days,
      case when x.elapsed_days > 0 then x.fact_minor::numeric / x.elapsed_days * x.active_days end as forecast_minor
    from public.location l join public.partner p on p.id = l.partner_id
    cross join lateral app_private.loc_progress(l, v_month) x
    where p.status = 'active' and p.country = 'RU' and l.status = 'active' and x.active_days > 0
  ), per_partner as (
    select p.id, p.name, p.currency,
      (select string_agg(distinct l.city, ', ') from public.location l where l.partner_id = p.id and l.status = 'active') as cities,
      count(*)::int as points,
      sum(g.forecast_minor) filter (where g.plan_minor is not null) as forecast_planned,
      case when count(g.plan_minor)=count(*) then sum(g.plan_minor) end as plan_minor,
      sum(g.fact_minor) filter (where g.plan_minor is not null) as fact_planned,
      sum(g.fact_minor) as fact_minor,
      sum(g.forecast_minor) as forecast_minor,
      sum(g.elapsed_days) as elapsed, sum(g.working_days) as working_days, sum(g.filled_days) as filled,
      sum(g.fact_same_minor) as same, sum(g.prev_same_minor) as prev_same
    from public.partner p join per_loc g on g.partner_id = p.id group by p.id, p.name, p.currency
  ), scored as (
    select *,
      case when plan_minor > 0 and elapsed > 0 then round(forecast_planned * 100.0 / plan_minor, 1) end as forecast_pct,
      case when plan_minor > 0 then round(coalesce(fact_planned, 0) * 100.0 / plan_minor, 1) end as pct_to_date,
      case when working_days > 0 then round(filled * 100.0 / working_days) end as fill_pct,
      case when prev_same > 0 then round((same - prev_same) * 100.0 / prev_same, 1) end as growth_pct,
      app_private.fx_rub(currency, v_fx_day) as fx
    from per_partner
  ), ranked as (
    select *, row_number() over (order by pct_to_date desc nulls last, fact_minor desc, name) as rank from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rank, 'partner_id', id, 'partner_name', name, 'cities', cities, 'is_me', id = v_my, 'points', points,
      'currency', currency, 'fact_minor', fact_minor, 'plan_minor', plan_minor, 'forecast_minor', round(forecast_minor)::bigint,
      'fact_rub_minor', round(fact_minor * fx)::bigint, 'forecast_rub_minor', round(forecast_minor * fx)::bigint,
      'forecast_pct', forecast_pct, 'pct_to_date', pct_to_date, 'fill_pct', fill_pct, 'growth_pct', growth_pct,
      'badges', to_jsonb(array_remove(array[
        case when rank = 1 and forecast_pct is not null then 'leader' end,
        case when forecast_pct >= 100 then 'plan' end,
        case when fill_pct = 100 and working_days >= 3 then 'no_gaps' end,
        case when growth_pct >= 10 then 'growth' end], null))
    ) order by rank), '[]'::jsonb) into v_rows
  from ranked;
  return jsonb_build_object('month', v_month, 'rows', v_rows);
end $$;

insert into app_private.client_command(fn) values ('public.revenue_day_off_set(uuid,date,boolean)');
revoke execute on function public.revenue_day_off_set(uuid, date, boolean) from public, anon, authenticated;
grant execute on function public.revenue_day_off_set(uuid, date, boolean) to authenticated;
revoke execute on function app_private.revenue_day_off_guard() from public, anon, authenticated;
