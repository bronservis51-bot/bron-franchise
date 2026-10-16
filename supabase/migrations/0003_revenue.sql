-- 0003 Выручка и план: франчайзи вносит итог дня по точке (наличные + карта), менеджер ставит план на месяц по точке.
-- День — по местному времени точки. Франчайзи правит текущий месяц и прошлый до 5-го числа; менеджер — любой день.

create table public.daily_revenue (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid not null references public.partner(id),
  day date not null,
  currency text not null references public.currency(code),
  cash_minor bigint not null default 0 check (cash_minor >= 0),
  card_minor bigint not null default 0 check (card_minor >= 0),
  total_minor bigint generated always as (cash_minor + card_minor) stored,
  comment text,
  entered_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  unique (location_id, day)
);
create index on public.daily_revenue (partner_id, day);

create table public.revenue_plan (
  location_id uuid not null references public.location(id),
  month date not null check (extract(day from month) = 1),
  amount_minor bigint not null check (amount_minor > 0),
  set_by uuid references public.app_user(id),
  updated_at timestamptz not null default now(),
  primary key (location_id, month)
);

create function app_private.local_today(p_location uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from public.location where id = p_location), 'Europe/Moscow'))::date
$$;

-- Можно ли текущему пользователю менять выручку дня (права проверяются отдельно).
create function app_private.revenue_day_open(p_location uuid, p_day date) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.is_manager() or (
    p_day >= date_trunc('month', app_private.local_today(p_location))::date
    or (p_day >= (date_trunc('month', app_private.local_today(p_location)) - interval '1 month')::date
        and extract(day from app_private.local_today(p_location)) <= 5))
$$;

create function app_private.revenue_location(p_location uuid, p_perm text) returns public.location
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm(p_perm, l.partner_id);
  return l;
end $$;

create function public.revenue_save(p_location uuid, p_day date, p_cash bigint, p_card bigint, p_comment text default null)
returns public.daily_revenue
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; r public.daily_revenue;
begin
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if l.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
  if p_day is null or p_day > app_private.local_today(p_location) then
    perform app_private.fail('validation', 'Нельзя внести выручку за будущий день', 'day');
  end if;
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('period-locked', 'Этот месяц уже закрыт. Прошлый месяц можно поправить до 5-го числа — обратитесь к менеджеру', 'day');
  end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_card, 0) < 0 then perform app_private.fail('validation', 'Сумма не может быть отрицательной', 'cash'); end if;
  if coalesce(p_cash, 0) + coalesce(p_card, 0) > 100000000000 then perform app_private.fail('validation', 'Слишком большая сумма', 'cash'); end if;
  insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor, card_minor, comment, entered_by)
  values (p_location, l.partner_id, p_day, l.currency, coalesce(p_cash, 0), coalesce(p_card, 0), nullif(trim(p_comment), ''), v_user)
  on conflict (location_id, day) do update set cash_minor = excluded.cash_minor, card_minor = excluded.card_minor,
    comment = excluded.comment, entered_by = excluded.entered_by, updated_at = now(), revision = public.daily_revenue.revision + 1
  returning * into r;
  perform app_private.audit('revenue.save', 'daily_revenue', r.id, l.partner_id,
    jsonb_build_object('day', p_day, 'cash', r.cash_minor, 'card', r.card_minor));
  return r;
end $$;

create function public.revenue_delete(p_location uuid, p_day date) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_id uuid;
begin
  perform app_private.require_user();
  l := app_private.revenue_location(p_location, 'revenue.enter');
  if not app_private.revenue_day_open(p_location, p_day) then
    perform app_private.fail('period-locked', 'Этот месяц уже закрыт — обратитесь к менеджеру', 'day');
  end if;
  delete from public.daily_revenue where location_id = p_location and day = p_day returning id into v_id;
  if v_id is null then perform app_private.fail('not-found', 'За этот день выручка не внесена'); end if;
  perform app_private.audit('revenue.delete', 'daily_revenue', v_id, l.partner_id, jsonb_build_object('day', p_day));
end $$;

-- План на месяц по точке; сумма 0 или пусто — снять план.
create function public.revenue_plan_set(p_location uuid, p_month date, p_amount bigint) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; v_month date := date_trunc('month', p_month)::date;
begin
  l := app_private.revenue_location(p_location, 'plan.manage');
  if coalesce(p_amount, 0) < 0 then perform app_private.fail('validation', 'План не может быть отрицательным', 'amount'); end if;
  if coalesce(p_amount, 0) = 0 then
    delete from public.revenue_plan where location_id = p_location and month = v_month;
  else
    insert into public.revenue_plan(location_id, month, amount_minor, set_by) values (p_location, v_month, p_amount, v_user)
    on conflict (location_id, month) do update set amount_minor = excluded.amount_minor, set_by = excluded.set_by, updated_at = now();
  end if;
  perform app_private.audit('plan.set', 'location', p_location, l.partner_id, jsonb_build_object('month', v_month, 'amount', p_amount));
end $$;

-- Сводка месяца по точке: дни, факт, план, выполнение, сколько нужно в день до плана.
create function app_private.location_month(l public.location, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_today date := app_private.local_today(l.id);
  v_from date := greatest(v_month, coalesce(l.opened_on, v_month));
  v_plan bigint; v_fact bigint; v_cash bigint; v_card bigint; v_missing date[]; v_left int; v_last date;
begin
  select amount_minor into v_plan from public.revenue_plan where location_id = l.id and month = v_month;
  select coalesce(sum(total_minor), 0), coalesce(sum(cash_minor), 0), coalesce(sum(card_minor), 0), max(day)
    into v_fact, v_cash, v_card, v_last
  from public.daily_revenue where location_id = l.id and day between v_month and v_end;
  -- Пропущенные дни: с начала месяца (или открытия) до вчера включительно
  select coalesce(array_agg(d::date order by d), '{}') into v_missing
  from generate_series(v_from, least(v_end, v_today - 1), interval '1 day') d
  where l.status = 'active' and not exists (select 1 from public.daily_revenue r where r.location_id = l.id and r.day = d::date);
  v_left := case when v_today between v_month and v_end then (v_end - v_today + 1) else 0 end;
  return jsonb_build_object(
    'location_id', l.id, 'location_name', l.name, 'city', l.city, 'currency', l.currency, 'status', l.status,
    'partner_id', l.partner_id, 'partner_name', (select name from public.partner where id = l.partner_id),
    'month', v_month, 'today', v_today, 'plan_minor', v_plan, 'fact_minor', v_fact, 'cash_minor', v_cash, 'card_minor', v_card,
    'pct', case when coalesce(v_plan, 0) > 0 then round(v_fact * 100.0 / v_plan, 1) end,
    'days_in_month', extract(day from v_end)::int,
    'days_left', v_left,
    -- до целых: «около 12 095 ₽ в день»
    'need_per_day_minor', case when v_plan is not null and v_left > 0 and v_plan > v_fact then (ceil((v_plan - v_fact)::numeric / v_left / 100) * 100)::bigint end,
    'missing_days', to_jsonb(v_missing),
    'last_day', v_last,
    'fx_rub', app_private.fx_rub(l.currency, least(v_end, v_today)));
end $$;

create function public.revenue_month(p_location uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_month date := date_trunc('month', p_month)::date;
begin
  perform app_private.require_user();
  l := app_private.revenue_location(p_location, 'revenue.read');
  return app_private.location_month(l, v_month) || jsonb_build_object(
    'editable_from', case when app_private.is_manager() then null
      when extract(day from app_private.local_today(l.id)) <= 5 then (date_trunc('month', app_private.local_today(l.id)) - interval '1 month')::date
      else date_trunc('month', app_private.local_today(l.id))::date end,
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', r.day, 'cash_minor', r.cash_minor, 'card_minor', r.card_minor,
        'total_minor', r.total_minor, 'comment', r.comment, 'updated_at', r.updated_at) order by r.day desc)
      from public.daily_revenue r where r.location_id = l.id and r.day between v_month and (v_month + interval '1 month - 1 day')::date), '[]'::jsonb));
end $$;

-- Все точки в области пользователя за месяц: франчайзи — свои, менеджеру — вся сеть с итогами в рублях.
create function public.revenue_overview(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_rows jsonb;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('revenue.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  select coalesce(jsonb_agg(app_private.location_month(l, p_month) order by p.name, l.name), '[]'::jsonb) into v_rows
  from public.location l join public.partner p on p.id = l.partner_id
  where app_private.in_scope(l.partner_id) and (l.status = 'active' or exists (
    select 1 from public.daily_revenue r where r.location_id = l.id and r.day >= date_trunc('month', p_month)::date
      and r.day < (date_trunc('month', p_month) + interval '1 month')::date));
  return jsonb_build_object(
    'month', date_trunc('month', p_month)::date,
    'rows', v_rows,
    'fact_rub_minor', (select round(sum((x ->> 'fact_minor')::numeric * (x ->> 'fx_rub')::numeric)) from jsonb_array_elements(v_rows) x),
    'plan_rub_minor', (select round(sum((x ->> 'plan_minor')::numeric * (x ->> 'fx_rub')::numeric)) from jsonb_array_elements(v_rows) x),
    'missing_fx', (select coalesce(jsonb_agg(distinct x ->> 'currency'), '[]'::jsonb) from jsonb_array_elements(v_rows) x where x ->> 'fx_rub' is null));
end $$;

alter table public.daily_revenue enable row level security;
alter table public.revenue_plan enable row level security;
create policy read_scope on public.daily_revenue for select to authenticated
  using (app_private.has_perm('revenue.read', partner_id));
create policy read_scope on public.revenue_plan for select to authenticated
  using (exists (select 1 from public.location l where l.id = location_id and app_private.has_perm('revenue.read', l.partner_id)));

insert into app_private.client_table(tbl) values ('public.daily_revenue'), ('public.revenue_plan');
insert into app_private.client_command(fn) values
  ('public.revenue_save(uuid, date, bigint, bigint, text)'), ('public.revenue_delete(uuid, date)'),
  ('public.revenue_plan_set(uuid, date, bigint)'), ('public.revenue_month(uuid, date)'), ('public.revenue_overview(date)');
select app_private.apply_grants();
