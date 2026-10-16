-- 0025 Выручка в рублях для руководства (решение владельца 14.10.2026): каждая смена переводится в рубли по курсу дня смены,
-- курс сохраняется в записи и потом не меняется. Курсы — рубли за 1 единицу валюты (как у ЦБ РФ).
-- В демо курсы условные (source = 'demo'); в рабочем контуре их загружает ежедневный обмен с ЦБ РФ.

create table public.fx_rate (
  currency text not null references public.currency(code),
  day date not null,
  rate numeric(14, 6) not null check (rate > 0),
  source text not null default 'demo' check (source in ('demo', 'cbr', 'manual')),
  set_by uuid references public.app_user(id),
  set_at timestamptz not null default now(),
  primary key (currency, day)
);

-- Курс на дату: рубль = 1; иначе последний известный на эту дату, а если истории ещё нет — ближайший следующий
create function app_private.fx_rub(p_currency text, p_day date) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_currency = 'RUB' then 1::numeric else coalesce(
    (select rate from public.fx_rate where currency = p_currency and day <= p_day order by day desc limit 1),
    (select rate from public.fx_rate where currency = p_currency and day > p_day order by day limit 1)) end
$$;

alter table public.daily_sale add column fx_rate numeric(14, 6), add column rub_minor bigint;

-- Курс фиксируется при занесении: правка суммы той же смены считается по тому же курсу
create function app_private.daily_sale_rub() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.currency is distinct from old.currency or new.day is distinct from old.day or old.fx_rate is null then
    new.fx_rate := app_private.fx_rub(new.currency, new.day);
  end if;
  new.rub_minor := case when new.fx_rate is null then null else round(new.revenue_minor * new.fx_rate)::bigint end;
  return new;
end $$;
create trigger daily_sale_rub before insert or update on public.daily_sale for each row execute function app_private.daily_sale_rub();

-- Демо-курсы на 200 дней назад и неделю вперёд: тенге ≈ 0,16 ₽, лира ≈ 2,2 ₽ с небольшими колебаниями
insert into public.fx_rate(currency, day, rate, source)
select v.cur, d::date, round((v.base * (1 + 0.03 * sin(extract(doy from d) / 9.0) + 0.01 * cos(extract(doy from d) / 3.0)))::numeric, 6), 'demo'
from (values ('KZT', 0.162), ('TRY', 2.21)) v(cur, base)
cross join generate_series(current_date - 200, current_date + 7, interval '1 day') d
where exists (select 1 from public.currency where code = v.cur)
on conflict do nothing;
update public.daily_sale set fx_rate = null where fx_rate is null; -- пересчёт триггером по курсу дня смены

-- Курс вручную (финансы), если обмен с ЦБ временно недоступен; уже занесённые смены не пересчитываются
create function public.fx_rate_set(p_currency text, p_day date, p_rate numeric) returns public.fx_rate
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.fx_rate;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('contract.manage') then perform app_private.fail('forbidden', 'Курсы задают финансы'); end if;
  if p_currency = 'RUB' or not exists (select 1 from public.currency where code = p_currency) then perform app_private.fail('validation', 'Неизвестная валюта', 'currency'); end if;
  if p_rate is null or p_rate <= 0 then perform app_private.fail('validation', 'Курс больше нуля', 'rate'); end if;
  insert into public.fx_rate(currency, day, rate, source, set_by) values (p_currency, coalesce(p_day, current_date), p_rate, 'manual', auth.uid())
  on conflict (currency, day) do update set rate = excluded.rate, source = 'manual', set_by = excluded.set_by, set_at = now()
  returning * into r;
  perform app_private.audit('fx.set', 'fx_rate', null, null, to_jsonb(r));
  return r;
end $$;

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
      m.revenue_minor, m.revenue_rub_minor, m.days_with_data, prev.revenue_minor as prev_revenue_minor,
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
    left join lateral (select coalesce(sum(s.revenue_minor), 0)::bigint as revenue_minor, coalesce(sum(s.rub_minor), 0)::bigint as revenue_rub_minor, count(distinct s.day)::int as days_with_data
      from public.daily_sale s where s.location_id = l.id and s.day >= date_trunc('month', now() at time zone l.timezone)::date) m on true
    left join lateral (select coalesce(sum(s.revenue_minor), 0)::bigint as revenue_minor from public.daily_sale s where s.location_id = l.id
      and s.day >= (date_trunc('month', now() at time zone l.timezone) - interval '1 month')::date
      and s.day < date_trunc('month', now() at time zone l.timezone)::date) prev on true
    where l.status <> 'closed' and app_private.in_scope(l.partner_id, l.id)
  ) x), '[]'::jsonb));
end $$;

create or replace function public.network_sales(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to date := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month' - interval '1 day')::date;
  v_prev date := (date_trunc('month', coalesce(p_month, current_date)) - interval '1 month')::date;
begin
  perform app_private.require_user();
  if not (app_private.is_staff() and app_private.has_perm_anywhere('sales.read')) then
    perform app_private.fail('forbidden', 'Выручка сети доступна сотрудникам компании');
  end if;
  return jsonb_build_object('month', v_from, 'days_in_month', v_to - v_from + 1, 'today', current_date, 'locations', coalesce((
    select jsonb_agg(x order by x.revenue_minor desc, x.name) from (
      select l.id, l.code, l.name, l.kind, l.status, l.country, c.name as country_name, l.city, l.currency, l.opened_on,
        p.id as partner_id, p.name as partner_name,
        coalesce(m.revenue, 0)::bigint as revenue_minor, coalesce(m.returns, 0)::bigint as returns_minor, coalesce(m.services, 0)::int as services,
        coalesce(m.card, 0)::bigint as card_minor, coalesce(m.card_known, 0)::bigint as card_known_minor, coalesce(m.earn, 0)::bigint as earnings_minor,
        coalesce(m.days, 0)::int as days_with_data,
        coalesce(m.rub, 0)::bigint as revenue_rub_minor,
        (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= v_prev and s.day < v_from)::bigint as prev_revenue_minor,
        (select coalesce(sum(s.rub_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= v_prev
          and s.day <= least(v_prev + (least(v_to, (now() at time zone l.timezone)::date) - v_from), v_from - 1))::bigint as prev_to_date_rub_minor,
        -- прошлый месяц на то же число — честное сравнение незаконченного месяца
        (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= v_prev
          and s.day <= least(v_prev + (least(v_to, (now() at time zone l.timezone)::date) - v_from), v_from - 1))::bigint as prev_to_date_minor,
        case when l.status = 'active' then (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)),
            least(v_to, (now() at time zone l.timezone)::date - 1), interval '1 day') d
          where not app_private.sales_day_covered(l.id, d::date))::int else 0 end as missing_days,
        coalesce((select jsonb_agg(jsonb_build_array(g.day, g.rev, g.rub) order by g.day) from (
          select s.day, sum(s.revenue_minor)::bigint as rev, sum(s.rub_minor)::bigint as rub from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to group by s.day) g), '[]'::jsonb) as daily
      from public.location l
      join public.country c on c.code = l.country
      left join public.partner p on p.id = l.partner_id
      left join lateral (select sum(s.revenue_minor) as revenue, sum(s.rub_minor) as rub, sum(s.returns_minor) as returns, sum(s.services_count) as services,
          sum(s.card_minor) filter (where s.card_minor is not null) as card, sum(s.revenue_minor) filter (where s.card_minor is not null) as card_known,
          sum(round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day, s.employee_id) / 10000)) as earn,
          count(distinct s.day) as days
        from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to) m on true
      where l.status <> 'closed' and app_private.has_perm('sales.read', l.partner_id, l.id)
    ) x), '[]'::jsonb));
end $$;

alter table public.fx_rate enable row level security;
create policy read_all on public.fx_rate for select to authenticated using (true);
insert into app_private.client_table(tbl) values ('public.fx_rate');
insert into app_private.client_command(fn) values ('public.fx_rate_set(text, date, numeric)');
select app_private.apply_grants();
