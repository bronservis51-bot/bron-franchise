-- 0009
-- 1) Расходы франчайзи по месяцам (аренда, интернет, материалы…): по точке или общие. Входят в «Финансы»: остаток = выручка − зарплата − роялти − расходы.
-- 2) Рейтинг открыт по выручке: каждый видит выручку и план других франчайзи (в их валюте и в рублях по курсу).

------------------------------------------------------------------------------
-- 1. Расходы
------------------------------------------------------------------------------
create table public.expense (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  location_id uuid references public.location(id),            -- null — общий расход на всех точках
  month date not null check (month = date_trunc('month', month)::date),
  category text not null check (length(trim(category)) between 1 and 60),
  amount_minor bigint not null check (amount_minor > 0),
  note text check (length(note) <= 500),
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.expense (partner_id, month);

alter table public.expense enable row level security;
create policy read_scope on public.expense for select to authenticated using (app_private.has_perm('revenue.read', partner_id));

-- Франчайзи текущего пользователя, который ведёт расходы.
create function app_private.expense_partner() returns uuid
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Расходы ведёт франчайзи'); end if;
  perform app_private.require_perm('revenue.enter', v_partner);
  return v_partner;
end $$;

create function public.expense_save(p_id uuid, p_month date, p_location uuid, p_category text, p_amount bigint, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date; v_id uuid;
begin
  if v_month is null or v_month > app_private.current_month() then perform app_private.fail('validation', 'Нельзя внести расход за будущий месяц', 'month'); end if;
  if coalesce(trim(p_category), '') = '' then perform app_private.fail('validation', 'Выберите или напишите категорию', 'category'); end if;
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Сумма должна быть больше нуля', 'amount'); end if;
  if p_location is not null and not exists (select 1 from public.location where id = p_location and partner_id = v_partner) then
    perform app_private.fail('not-found', 'Точка не найдена', 'location');
  end if;
  if p_id is null then
    insert into public.expense(partner_id, location_id, month, category, amount_minor, note, created_by)
    values (v_partner, p_location, v_month, left(trim(p_category), 60), p_amount, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
    perform app_private.audit('expense.add', 'expense', v_id, v_partner, jsonb_build_object('month', v_month, 'category', p_category, 'amount', p_amount));
  else
    update public.expense set location_id = p_location, month = v_month, category = left(trim(p_category), 60), amount_minor = p_amount,
      note = nullif(trim(p_note), ''), updated_at = now()
    where id = p_id and partner_id = v_partner returning id into v_id;
    if v_id is null then perform app_private.fail('not-found', 'Расход не найден'); end if;
    perform app_private.audit('expense.update', 'expense', v_id, v_partner, jsonb_build_object('month', v_month, 'category', p_category, 'amount', p_amount));
  end if;
  return v_id;
end $$;

create function public.expense_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); e public.expense;
begin
  delete from public.expense where id = p_id and partner_id = v_partner returning * into e;
  if e.id is null then perform app_private.fail('not-found', 'Расход не найден'); end if;
  perform app_private.audit('expense.delete', 'expense', p_id, v_partner, to_jsonb(e));
end $$;

-- Повторить расходы прошлого месяца (аренда, интернет — обычно одинаковые). Уже внесённые в этом месяце категории не дублируются.
create function public.expense_repeat(p_month date) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid := app_private.expense_partner(); v_month date := date_trunc('month', p_month)::date; n int;
begin
  if v_month > app_private.current_month() then perform app_private.fail('validation', 'Нельзя внести расход за будущий месяц', 'month'); end if;
  insert into public.expense(partner_id, location_id, month, category, amount_minor, note, created_by)
  select e.partner_id, e.location_id, v_month, e.category, e.amount_minor, e.note, auth.uid()
  from public.expense e
  where e.partner_id = v_partner and e.month = (v_month - interval '1 month')::date
    and not exists (select 1 from public.expense x where x.partner_id = v_partner and x.month = v_month
      and x.category = e.category and x.location_id is not distinct from e.location_id);
  get diagnostics n = row_count;
  if n > 0 then perform app_private.audit('expense.repeat', 'partner', v_partner, v_partner, jsonb_build_object('month', v_month, 'count', n)); end if;
  return n;
end $$;

-- Расходы набора точек за месяц: по этим точкам и общие — только если выбраны все точки франчайзи.
create function app_private.expense_rows(p_partner uuid, p_locations uuid[], p_month date) returns setof public.expense
language sql stable security definer set search_path = public, pg_temp as $$
  select e.* from public.expense e
  where e.partner_id = p_partner and e.month = p_month
    and (e.location_id = any(p_locations)
         or (e.location_id is null and not exists (select 1 from public.location l where l.partner_id = p_partner and not (l.id = any(p_locations)))))
$$;

create or replace function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date) returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, count(*)::int n from public.work_shift
    where location_id = any(p_locations) and status = 'closed' and day >= p_month and day < (p_month + interval '1 month')::date
  ), p as (
    select sum(amount_minor)::bigint v from public.revenue_plan where location_id = any(p_locations) and month = p_month
  ), x as (
    select coalesce(sum(amount_minor), 0)::bigint v from app_private.expense_rows(p_partner, p_locations, p_month)
  ), q as (
    select round(r.t * app_private.rate_bp(p_partner, p_month) / 10000.0)::bigint v from r
  )
  select jsonb_build_object(
    'month', p_month, 'revenue_minor', r.t, 'cash_minor', r.c, 'card_minor', r.k, 'plan_minor', p.v,
    'pct', case when p.v > 0 then round(r.t * 100.0 / p.v, 1) end,
    'payroll_minor', w.e, 'shifts', w.n,
    'rate_bp', app_private.rate_bp(p_partner, p_month),
    'royalty_minor', q.v,
    'expenses_minor', x.v,
    'net_minor', r.t - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

create or replace function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select array_agg(id order by name) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when p_location is null then v_all else array[p_location] end;
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.fin_month(v_partner, v_locs, m));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.fin_month(v_partner, v_locs, v_month),
    'months', v_months,
    'by_location', case when p_location is null then coalesce((select jsonb_agg(app_private.fin_month(v_partner, array[l.id], v_month)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e)
        order by x.e desc)
      from (select employee_id, count(*)::int n, sum(total_minor)::bigint t, sum(earned_minor)::bigint e from public.work_shift
            where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month' group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'month', e.month, 'location_id', e.location_id, 'location_name', l.name,
        'category', e.category, 'amount_minor', e.amount_minor, 'note', e.note) order by e.category, l.name nulls first)
      from app_private.expense_rows(v_partner, v_locs, v_month) e left join public.location l on l.id = e.location_id), '[]'::jsonb),
    -- свои категории франчайзи (кроме стандартных) — для быстрых кнопок
    'expense_categories', coalesce((select jsonb_agg(c order by n desc, c) from (
        select category c, count(*) n from public.expense where partner_id = v_partner group by category) t), '[]'::jsonb),
    'prev_expenses_count', (select count(*) from public.expense where partner_id = v_partner and month = (v_month - interval '1 month')::date),
    'royalty', case when p_location is null then public.royalty_my() end);
end $$;

------------------------------------------------------------------------------
-- 2. Рейтинг с выручкой
------------------------------------------------------------------------------
create or replace function public.rating(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date))::date; v_rows jsonb; v_my uuid;
  v_fx_day date := least((date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date)) + interval '1 month - 1 day')::date,
                         (now() at time zone 'Europe/Moscow')::date);
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('rating.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  select scope_id into v_my from app_private.active_assignments() where scope_type = 'partner' limit 1;
  with per_loc as (
    select l.partner_id, x.*,
      case when x.elapsed_days > 0 then x.fact_minor::numeric / x.elapsed_days * x.active_days end as forecast_minor
    from public.location l join public.partner p on p.id = l.partner_id
    cross join lateral app_private.loc_progress(l, v_month) x
    where p.status = 'active' and l.status = 'active' and x.active_days > 0
  ), per_partner as (
    select p.id, p.name, p.currency,
      (select string_agg(distinct l.city, ', ') from public.location l where l.partner_id = p.id and l.status = 'active') as cities,
      count(*)::int as points,
      sum(g.forecast_minor) filter (where g.plan_minor is not null) as forecast_planned,
      sum(g.plan_minor) as plan_minor,
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
    select *, row_number() over (order by forecast_pct desc nulls last, fill_pct desc nulls last, name) as rank from scored
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

insert into app_private.client_command(fn) values
  ('public.expense_save(uuid, date, uuid, text, bigint, text)'), ('public.expense_delete(uuid)'), ('public.expense_repeat(date)');
select app_private.apply_grants();
