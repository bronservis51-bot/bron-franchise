-- Демо-данные v5 (14.10.2026): заметки к точкам с напоминаниями. Идемпотентно.
insert into public.location_note(location_id, partner_id, author_id, body, internal, remind_on, created_at)
select l.id, l.partner_id, u.id, v.body, v.internal, case when v.remind is null then null else current_date + v.remind end, now() - make_interval(days => v.ago)
from (values
  ('BETA-1', 'fm@demo.example.com', 'Марсель жалуется на слабый трафик в ТЦ — обещал прислать план акции до 20-го. После этого созвонимся и разберём отчёт за сентябрь.', true, 0, 2),
  ('ALPHA-3', 'fm@demo.example.com', 'Ждём от арендодателя подключение электричества (обещали к 25-му). Без этого дату открытия не подтверждаем.', true, 6, 1),
  ('ALPHA-1', 'founder@demo.example.com', 'Лучшая точка сети по выручке на смену. Предложить Виктору третью точку в Волгограде.', true, null, 3),
  ('ALPHA-1', 'alpha.owner@demo.example.com', 'Дина просит выходной 18-го — поставить Виктора на смену.', false, 3, 0)
) v(code, email, body, internal, remind, ago)
join public.location l on l.code = v.code join public.app_user u on u.email = v.email
where not exists (select 1 from public.location_note n where n.location_id = l.id and n.body = v.body);

-- Прошлый месяц менеджеров продаж — для цели «побить прошлый месяц»
insert into public.daily_sale(location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, source, entered_by, card_minor)
select l.id, l.partner_id, d::date, u.id, l.currency, v.base + abs(hashtext(v.email || d::text)) % v.spread, 0, 6 + abs(hashtext(d::text || v.email)) % 8, 'self', u.id,
  (v.base + abs(hashtext(v.email || d::text)) % v.spread) * 6 / 10
from (values ('ALPHA-1', 'alpha.staff@demo.example.com', 1500000, 700000), ('OWN-NORTH', 'staff.north@demo.example.com', 1700000, 800000)) v(code, email, base, spread)
join public.location l on l.code = v.code join public.app_user u on u.email = v.email
cross join lateral generate_series((date_trunc('month', now()) - interval '1 month')::date, (date_trunc('month', now()) - interval '1 day')::date, interval '1 day') d
where extract(isodow from d) <> 1
on conflict (location_id, day, employee_id) do nothing;
