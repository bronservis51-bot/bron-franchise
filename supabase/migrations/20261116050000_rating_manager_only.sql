-- Owner decision 16.11.2026: the network ranking is for franchise_manager only.
-- Keep partner revenue/finance permissions unchanged; no assignment/user edits.
delete from public.role_permission where permission='rating.read' and role<>'franchise_manager';
insert into public.role_permission(role,permission) values('franchise_manager','rating.read') on conflict do nothing;

create or replace function app_private.rating_allowed() returns boolean
language sql stable security definer set search_path=public,app_private,pg_temp as $$
 select exists(select 1 from app_private.active_assignments() a
  where a.role='franchise_manager' and a.scope_type='company')
$$;

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
      sum(g.elapsed_days) as elapsed, sum(g.filled_days) as filled,
      sum(g.fact_same_minor) as same, sum(g.prev_same_minor) as prev_same
    from public.partner p join per_loc g on g.partner_id = p.id group by p.id, p.name, p.currency
  ), scored as (
    select *,
      case when plan_minor > 0 and elapsed > 0 then round(forecast_planned * 100.0 / plan_minor, 1) end as forecast_pct,
      case when plan_minor > 0 then round(coalesce(fact_planned, 0) * 100.0 / plan_minor, 1) end as pct_to_date,
      case when elapsed > 0 then round(filled * 100.0 / elapsed) end as fill_pct,
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
        case when fill_pct = 100 and elapsed >= 3 then 'no_gaps' end,
        case when growth_pct >= 10 then 'growth' end], null))
    ) order by rank), '[]'::jsonb) into v_rows
  from ranked;
  return jsonb_build_object('month', v_month, 'rows', v_rows);
end $$;
