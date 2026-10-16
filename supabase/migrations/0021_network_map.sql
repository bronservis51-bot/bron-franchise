-- 0021 Карта сети для руководства (решение владельца 13.10.2026): все точки — собственные и франшизы — на карте мира,
-- по нажатию сводка: выручка месяца, смены, заполненность, обращения, открытие, долг франчайзи, сигналы контроля выручки.

alter table public.location add column lat numeric(9, 6), add column lng numeric(9, 6);

-- Координаты городов (центр города). Точный адрес точки можно задать в lat/lng самой точки
create table public.city_geo (
  country text not null references public.country(code),
  city text not null,
  lat numeric(9, 6) not null,
  lng numeric(9, 6) not null,
  primary key (country, city)
);
insert into public.city_geo(country, city, lat, lng)
select v.country, v.city, v.lat, v.lng from (values
  ('RU', 'Москва', 55.7558, 37.6173), ('RU', 'Санкт-Петербург', 59.9343, 30.3351), ('RU', 'Казань', 55.7961, 49.1064),
  ('RU', 'Набережные Челны', 55.7436, 52.3958), ('RU', 'Екатеринбург', 56.8389, 60.6057), ('RU', 'Новосибирск', 55.0084, 82.9357),
  ('RU', 'Нижний Новгород', 56.2965, 43.9361), ('RU', 'Самара', 53.1959, 50.1002), ('RU', 'Уфа', 54.7388, 55.9721),
  ('RU', 'Краснодар', 45.0355, 38.9753), ('RU', 'Ростов-на-Дону', 47.2357, 39.7015), ('RU', 'Челябинск', 55.1644, 61.4368),
  ('RU', 'Омск', 54.9885, 73.3242), ('RU', 'Пермь', 58.0105, 56.2502), ('RU', 'Воронеж', 51.6720, 39.1843),
  ('RU', 'Волгоград', 48.7080, 44.5133), ('RU', 'Красноярск', 56.0153, 92.8932), ('RU', 'Тюмень', 57.1530, 65.5343),
  ('RU', 'Сочи', 43.5855, 39.7231), ('RU', 'Владивосток', 43.1155, 131.8855), ('RU', 'Ижевск', 56.8526, 53.2045),
  ('KZ', 'Алматы', 43.2380, 76.9450), ('KZ', 'Астана', 51.1694, 71.4491), ('KZ', 'Шымкент', 42.3417, 69.5901),
  ('KZ', 'Караганда', 49.8019, 73.1021), ('KZ', 'Актобе', 50.2839, 57.1670),
  ('TR', 'İstanbul', 41.0082, 28.9784), ('TR', 'Стамбул', 41.0082, 28.9784), ('TR', 'Ankara', 39.9334, 32.8597), ('TR', 'İzmir', 38.4237, 27.1428),
  ('TR', 'Antalya', 36.8969, 30.7133)
) v(country, city, lat, lng)
where exists (select 1 from public.country c where c.code = v.country)
on conflict do nothing;

alter table public.city_geo enable row level security;
create policy read_all on public.city_geo for select to authenticated using (true);

-- Сводка по точке для карты: только сотрудники компании с доступом к показателям; партнёры карту не видят
create function public.network_map() returns jsonb
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
        where not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = d::date))::int as missing_days,
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

insert into app_private.client_table(tbl) values ('public.city_geo');
insert into app_private.client_command(fn) values ('public.network_map()');
select app_private.apply_grants();
