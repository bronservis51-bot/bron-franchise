-- 0006 Рейтинг франчайзи, расчёт плана на следующий месяц, роялти для франчайзи в реальном времени, проверка «база жива».

------------------------------------------------------------------------------
-- Рейтинг: франчайзи соревнуются по прогнозу выполнения плана; суммы выручки в рейтинге не показываются
------------------------------------------------------------------------------
-- Показатели точки за месяц: прошедшие дни (по вчера), заполненные дни, факт за прошедшие дни, тот же период прошлого месяца.
create function app_private.loc_progress(l public.location, p_month date) returns table (
  active_days int, elapsed_days int, filled_days int, fact_minor bigint, plan_minor bigint, prev_same_minor bigint, fact_same_minor bigint)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with b as (
    select p_month as m, (p_month + interval '1 month - 1 day')::date as e, app_private.local_today(l.id) as today,
      greatest(p_month, coalesce(l.opened_on, p_month)) as start
  ), w as (
    select b.*, least(b.e, b.today - 1) as upto from b
  )
  select
    greatest(0, (w.e - w.start) + 1)::int,
    greatest(0, (w.upto - w.start) + 1)::int,
    (select count(distinct r.day) from public.daily_revenue r where r.location_id = l.id and r.day between w.start and w.upto)::int,
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id and r.day between w.m and w.upto)::bigint,
    (select amount_minor from public.revenue_plan where location_id = l.id and month = w.m),
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id
       and r.day >= (w.m - interval '1 month')::date and r.day < (w.m - interval '1 month')::date + greatest(0, (w.upto - w.m) + 1))::bigint,
    (select coalesce(sum(r.total_minor), 0) from public.daily_revenue r where r.location_id = l.id and r.day between w.m and w.upto)::bigint
  from w
$$;

create function public.rating(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date))::date; v_rows jsonb; v_my uuid;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('rating.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  select scope_id into v_my from app_private.active_assignments() where scope_type = 'partner' limit 1;
  with per_loc as (
    select l.partner_id, x.*,
      -- прогноз факта за месяц по темпу прошедших дней (для закрытого месяца — сам факт)
      case when x.elapsed_days > 0 then x.fact_minor::numeric / x.elapsed_days * x.active_days end as forecast_minor
    from public.location l join public.partner p on p.id = l.partner_id
    cross join lateral app_private.loc_progress(l, v_month) x
    where p.status = 'active' and l.status = 'active' and x.active_days > 0
  ), per_partner as (
    select p.id, p.name,
      (select string_agg(distinct l.city, ', ') from public.location l where l.partner_id = p.id and l.status = 'active') as cities,
      sum(g.forecast_minor) filter (where g.plan_minor is not null) as forecast_planned,
      sum(g.plan_minor) as plan_minor,
      sum(g.fact_minor) filter (where g.plan_minor is not null) as fact_planned,
      sum(g.elapsed_days) as elapsed, sum(g.filled_days) as filled,
      sum(g.fact_same_minor) as same, sum(g.prev_same_minor) as prev_same
    from public.partner p join per_loc g on g.partner_id = p.id group by p.id, p.name
  ), scored as (
    select *,
      case when plan_minor > 0 and elapsed > 0 then round(forecast_planned * 100.0 / plan_minor, 1) end as forecast_pct,
      case when plan_minor > 0 then round(coalesce(fact_planned, 0) * 100.0 / plan_minor, 1) end as pct_to_date,
      case when elapsed > 0 then round(filled * 100.0 / elapsed) end as fill_pct,
      case when prev_same > 0 then round((same - prev_same) * 100.0 / prev_same, 1) end as growth_pct
    from per_partner
  ), ranked as (
    select *, row_number() over (order by forecast_pct desc nulls last, fill_pct desc nulls last, name) as rank from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rank, 'partner_id', id, 'partner_name', name, 'cities', cities, 'is_me', id = v_my,
      'forecast_pct', forecast_pct, 'pct_to_date', pct_to_date, 'fill_pct', fill_pct, 'growth_pct', growth_pct,
      'badges', to_jsonb(array_remove(array[
        case when rank = 1 and forecast_pct is not null then 'leader' end,
        case when forecast_pct >= 100 then 'plan' end,
        case when fill_pct = 100 and elapsed >= 3 then 'no_gaps' end,
        case when growth_pct >= 10 then 'growth' end], null))
    ) order by rank), '[]'::jsonb) into v_rows
  from ranked;
  return jsonb_build_object('month', v_month, 'rows', v_rows);
end $$;

------------------------------------------------------------------------------
-- План на месяц: прогноз по истории точки + цель роста
-- 1) уровень дня — взвешенное среднее последних недель (свежие недели важнее), очищенное от эффекта дня недели;
-- 2) профиль недели — медиана выручки по каждому дню недели за 12 недель (устойчива к выбросам);
-- 3) тренд — наклон недельных уровней за 12 недель, приглушённый вдвое и ограниченный ±10 % в месяц;
-- 4) сезонность — как этот месяц прошлого года отличался от недель перед ним (у точки, иначе по сети);
-- 5) календарь — сумма по дням нужного месяца с учётом количества выходных;
-- 6) план = прогноз × (1 + цель роста), но в коридоре 85–130 % от факта прошлого месяца.
------------------------------------------------------------------------------
create function app_private.daily_totals(p_location uuid, p_from date, p_to date) returns table (day date, total numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.day, sum(r.total_minor)::numeric from public.daily_revenue r
  where (p_location is null or r.location_id = p_location) and r.day >= p_from and r.day < p_to group by r.day
$$;

-- Сезонный коэффициент: средний день месяца M-12 к среднему дню 8 недель перед ним.
create function app_private.season_factor(p_location uuid, p_month date) returns numeric
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with ly as (select (p_month - interval '1 year')::date as m),
  a as (select avg(total) v, count(*) n from ly, app_private.daily_totals(p_location, ly.m, (ly.m + interval '1 month')::date)),
  b as (select avg(total) v, count(*) n from ly, app_private.daily_totals(p_location, ly.m - 56, ly.m))
  select case when a.n >= 20 and b.n >= 40 and b.v > 0 then greatest(0.7, least(1.4, a.v / b.v)) end from a, b
$$;

create function app_private.plan_forecast(l public.location, p_month date, p_stretch_bp int default 500) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_cut date := least(app_private.local_today(l.id), v_month);
  v_n int; v_avg numeric; v_overall numeric; v_f numeric[] := array[1,1,1,1,1,1,1]; d int; v_med numeric;
  v_level numeric; v_slope numeric; v_weeks int; v_g numeric := 0; v_h numeric; v_trend numeric := 1;
  v_season numeric; v_season_src text := 'нет'; v_forecast numeric := 0; v_day date; v_plan numeric; v_guard text := null;
  v_last numeric; v_last_days int; v_weekend int := 0; v_method text := 'full';
begin
  select count(*), avg(total) into v_n, v_avg from app_private.daily_totals(l.id, v_cut - 182, v_cut);
  if v_n = 0 then
    return jsonb_build_object('location_id', l.id, 'method', 'none', 'reason', 'Нет выручки — план нужно поставить вручную');
  end if;
  -- профиль недели: медиана по дню недели / средняя медиана
  if v_n >= 14 then
    for d in 1..7 loop
      select percentile_cont(0.5) within group (order by total) into v_med
      from app_private.daily_totals(l.id, v_cut - 84, v_cut) t where extract(isodow from t.day) = d;
      v_f[d] := v_med;
    end loop;
    select avg(x) into v_overall from unnest(v_f) x where x is not null;
    for d in 1..7 loop v_f[d] := coalesce(v_f[d] / nullif(v_overall, 0), 1); end loop;
  else
    v_method := 'short';
  end if;
  -- недельные уровни, очищенные от дня недели (k = 0 — последняя неделя)
  with t as (
    select floor((v_cut - 1 - day) / 7)::int as k, total / v_f[extract(isodow from day)::int] as x
    from app_private.daily_totals(l.id, v_cut - 84, v_cut)
  ), w as (select k, avg(x) as lvl from t group by k)
  select count(*), regr_slope(lvl, -k) into v_weeks, v_slope from w;
  -- уровень: экспоненциальное сглаживание (α = 0,35) от старых недель к новым
  select lvl into v_level from (
    with t as (
      select floor((v_cut - 1 - day) / 7)::int as k, total / v_f[extract(isodow from day)::int] as x
      from app_private.daily_totals(l.id, v_cut - 84, v_cut)
    ) select k, avg(x) as lvl from t group by k order by k desc limit 1) z;
  declare r record; begin
    for r in with t as (
        select floor((v_cut - 1 - day) / 7)::int as k, total / v_f[extract(isodow from day)::int] as x
        from app_private.daily_totals(l.id, v_cut - 84, v_cut)
      ) select k, avg(x) as lvl from t group by k order by k desc loop
      v_level := 0.35 * r.lvl + 0.65 * v_level;
    end loop;
  end;
  if v_level is null then v_level := v_avg; end if;
  -- тренд: только при 6+ неделях истории
  if v_weeks >= 6 and v_slope is not null and v_level > 0 then
    v_g := greatest(-0.10, least(0.10, (v_slope / 7.0 * 30.4 / v_level) * 0.5));
    v_h := greatest(0, ((v_month + 15) - (v_cut - 4))::numeric / 30.4);
    v_trend := power(1 + v_g, v_h);
  end if;
  -- сезонность: точка, иначе вся сеть
  v_season := app_private.season_factor(l.id, v_month);
  if v_season is not null then v_season_src := 'точка'; else
    v_season := app_private.season_factor(null, v_month);
    if v_season is not null then v_season_src := 'сеть'; else v_season := 1; end if;
  end if;
  -- календарь нужного месяца (с даты открытия, если точка открывается в этом месяце)
  v_day := greatest(v_month, coalesce(l.opened_on, v_month));
  while v_day <= v_end loop
    v_forecast := v_forecast + v_level * v_f[extract(isodow from v_day)::int] * v_trend * v_season;
    if extract(isodow from v_day) in (6, 7) then v_weekend := v_weekend + 1; end if;
    v_day := v_day + 1;
  end loop;
  v_plan := v_forecast * (1 + p_stretch_bp / 10000.0);
  -- коридор относительно прошлого полного месяца (пересчёт на число дней)
  select sum(total), count(*) into v_last, v_last_days
  from app_private.daily_totals(l.id, (v_month - interval '1 month')::date, v_month);
  if v_last_days >= 20 and v_last > 0 then
    v_last := v_last / v_last_days * ((v_end - greatest(v_month, coalesce(l.opened_on, v_month))) + 1);
    if v_plan < v_last * 0.85 then v_plan := v_last * 0.85; v_guard := 'не ниже 85 % прошлого месяца'; end if;
    if v_plan > v_last * 1.30 then v_plan := v_last * 1.30; v_guard := 'не выше 130 % прошлого месяца'; end if;
  else
    v_last := null;
  end if;
  return jsonb_build_object(
    'location_id', l.id, 'method', v_method,
    'forecast_minor', round(v_forecast)::bigint,
    -- до тысячи единиц валюты
    'proposed_minor', (round(v_plan / 100000) * 100000)::bigint,
    'level_day_minor', round(v_level)::bigint,
    'weekday_factors', to_jsonb(v_f),
    'trend_month_pct', round(v_g * 100, 1),
    'season_factor', round(v_season, 3), 'season_source', v_season_src,
    'days', (v_end - greatest(v_month, coalesce(l.opened_on, v_month))) + 1, 'weekend_days', v_weekend,
    'stretch_pct', p_stretch_bp / 100.0,
    'last_month_scaled_minor', round(v_last)::bigint,
    'guard', v_guard,
    'history_days', v_n);
end $$;

create function public.plan_suggest(p_month date, p_stretch_bp int default 500) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('plan.manage');
  if p_stretch_bp is null or p_stretch_bp < -2000 or p_stretch_bp > 5000 then perform app_private.fail('validation', 'Цель роста — от −20 до +50 %', 'stretch'); end if;
  return coalesce((
    select jsonb_agg(app_private.plan_forecast(l, p_month, p_stretch_bp) || jsonb_build_object(
      'location_name', l.name, 'partner_id', l.partner_id, 'partner_name', p.name, 'currency', l.currency,
      'current_plan_minor', (select amount_minor from public.revenue_plan where location_id = l.id and month = date_trunc('month', p_month)::date))
      order by p.name, l.name)
    from public.location l join public.partner p on p.id = l.partner_id
    where l.status = 'active' and p.status = 'active'), '[]'::jsonb);
end $$;

------------------------------------------------------------------------------
-- Роялти для франчайзи: всё, как у менеджера, плюс текущий месяц в реальном времени
------------------------------------------------------------------------------
create function public.royalty_my() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; p public.partner; v_cur date := app_private.current_month(); v_open record; v_elapsed int; v_days int;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Роялти видит франчайзи'); end if;
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select * into v_open from app_private.royalty_ledger(v_partner) g where g.month = v_cur;
  v_days := extract(day from (v_cur + interval '1 month - 1 day'))::int;
  v_elapsed := greatest(1, extract(day from (now() at time zone 'Europe/Moscow'))::int - 1);
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, v_cur),
    'debt_minor', (select coalesce(sum(debt_minor), 0) from app_private.royalty_ledger(v_partner) g where not g.is_open),
    'live', jsonb_build_object('month', v_cur,
      'revenue_minor', coalesce(v_open.revenue_minor, 0), 'accrued_minor', coalesce(v_open.accrued_minor, 0),
      -- прогноз на конец месяца по темпу прошедших дней
      'projected_accrual_minor', round(coalesce(v_open.accrued_minor, 0)::numeric / v_elapsed * v_days)::bigint,
      'paid_minor', coalesce(v_open.paid_minor, 0)),
    'months', coalesce((select jsonb_agg(to_jsonb(g) order by g.month desc) from app_private.royalty_ledger(v_partner) g), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on, 'note', r.note)
      order by r.paid_on desc) from public.royalty_payment r where r.partner_id = v_partner), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------
-- «База жива»: без входа, чтобы бесплатный проект Supabase не засыпал (вызывается расписанием GitHub)
------------------------------------------------------------------------------
create function public.ping() returns text language sql stable as $$ select 'ok'::text $$;

create table app_private.anon_command (fn regprocedure primary key);
insert into app_private.anon_command(fn) values ('public.ping()');

create or replace function app_private.apply_grants() returns void
language plpgsql as $$
declare r record;
begin
  execute 'revoke all on all tables in schema public from anon, authenticated';
  execute 'revoke all on all sequences in schema public from anon, authenticated';
  execute 'revoke execute on all functions in schema public from public, anon, authenticated';
  execute 'revoke execute on all functions in schema app_private from public, anon, authenticated';
  for r in select tbl, columns from app_private.client_table loop
    if r.columns is null then
      execute format('grant select on %s to authenticated', r.tbl);
    else
      execute format('grant select (%s) on %s to authenticated',
        (select string_agg(quote_ident(c), ', ') from unnest(r.columns) c), r.tbl);
    end if;
  end loop;
  for r in select fn from app_private.client_command loop
    execute format('grant execute on function %s to authenticated', r.fn);
  end loop;
  for r in select fn from app_private.policy_helper loop
    execute format('grant execute on function %s to authenticated', r.fn);
  end loop;
  for r in select fn from app_private.anon_command loop
    execute format('grant execute on function %s to anon, authenticated', r.fn);
  end loop;
end $$;

insert into app_private.client_command(fn) values
  ('public.rating(date)'), ('public.plan_suggest(date, int)'), ('public.royalty_my()');
select app_private.apply_grants();
