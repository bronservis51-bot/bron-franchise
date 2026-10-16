-- Демо-данные v2 (13.10.2026): каталог в стиле магазина плёнок, ставки процента сотрудников, ежедневная выручка.
-- Идемпотентно: можно выполнить повторно. Все цены и ставки — тестовые.

------------------------------------------------------------------------------
-- Каталог: листы с дизайнами (как на bronserviceshop), рулоны для плоттера, аксессуары
------------------------------------------------------------------------------
insert into public.catalog_item(sku, article_no, name, category, subtitle, description, unit, pack_multiple, min_qty, lead_time_days, direction_id, source, visual, sort)
select v.sku, v.art, v.name, v.cat, v.sub, v.descr, 'sheet', 1, 1, v.lead, d.id, 'demo', v.visual::jsonb, v.sort
from (values
  ('SH-GL-6', 1, 'Глянцевый полиуретан', 'Базовые', 'Лист на 6 телефонов', 'Прозрачная глянцевая защита задней панели', 20, '{"kind":"glossy"}', 10),
  ('SH-MT-6', 2, 'Матовый полиуретан', 'Базовые', 'Лист на 6 телефонов', 'Матовая поверхность без отпечатков', 20, '{"kind":"matte"}', 11),
  ('SH-PR-6', 3, 'Антишпион', 'Базовые', 'Лист на 6 телефонов', 'Для экрана: ограничивает угол обзора', 20, '{"kind":"privacy"}', 12),
  ('SH-CL-01', 4, 'Круговая композиция', 'Каллиграфия', 'Лист на 3 телефона', 'Каллиграфический орнамент по кругу', 25, '{"kind":"radial","colors":["#121214","#c9a24a","#efe3c4"]}', 20),
  ('SH-CL-02', 5, 'Каллиграфия с золотом', 'Каллиграфия', 'Лист на 3 телефона', 'Мазки кисти с золотом', 25, '{"kind":"brush","colors":["#141416","#c9a24a","#9a9a9e"]}', 21),
  ('SH-TX-01', 6, 'Карбон', 'Текстурные', 'Лист на 3 телефона', 'Фактура углеволокна', 25, '{"kind":"carbon","colors":["#1a1a1d","#2e2e33"]}', 30),
  ('SH-TX-02', 7, 'Мрамор белый', 'Текстурные', 'Лист на 3 телефона', 'Светлый мрамор с прожилками', 25, '{"kind":"marble","colors":["#f3f3f4","#b4b5ba"]}', 31),
  ('SH-TX-03', 8, 'Кожа коричневая', 'Текстурные', 'Лист на 3 телефона', 'Фактура натуральной кожи', 25, '{"kind":"leather","colors":["#6b4128","#8b5a3a"]}', 32),
  ('SH-CM-01', 9, 'Камуфляж лесной', 'Камуфляж', 'Лист на 3 телефона', 'Классический лесной камуфляж', 25, '{"kind":"camo","colors":["#59622e","#3f4622","#7f8445","#2c3018"]}', 40),
  ('SH-CM-02', 10, 'Камуфляж городской', 'Камуфляж', 'Лист на 3 телефона', 'Серый городской камуфляж', 25, '{"kind":"camo","colors":["#8f9297","#5d6066","#c4c6ca","#34363b"]}', 41),
  ('SH-NT-01', 11, 'Орнамент', 'Национальные', 'Лист на 3 телефона', 'Восточный орнамент с золотом', 25, '{"kind":"ornament","colors":["#0f3d2e","#d4af37"]}', 50),
  ('SH-SP-01', 12, 'Гоночные полосы', 'Спорт', 'Лист на 3 телефона', 'Две полосы по центру', 25, '{"kind":"stripes","colors":["#121214","#e5383b","#fefefe"]}', 60),
  ('SH-KD-01', 13, 'Космос', 'Детские', 'Лист на 3 телефона', 'Звёздное небо', 25, '{"kind":"stars","colors":["#19123f","#3b2f8f","#fefefe"]}', 70),
  ('SH-NB-01', 14, 'Матовая плёнка на ноутбук', 'Ноутбуки', 'Лист на 1 ноутбук до 16"', 'Защита крышки ноутбука', 25, '{"kind":"laptop","colors":["#d9dadc"]}', 80)
) as v(sku, art, name, cat, sub, descr, lead, visual, sort)
cross join public.direction d where d.code = 'gadgets'
on conflict (sku) do update set article_no = excluded.article_no, name = excluded.name, category = excluded.category, subtitle = excluded.subtitle,
  description = excluded.description, visual = excluded.visual, sort = excluded.sort;

-- Прежние позиции: рулоны для плоттера и аксессуары
update public.catalog_item set category = 'Рулоны для плоттера', visual = '{"kind":"roll"}', sort = 90,
  subtitle = case unit when 'roll' then 'Рулон' when 'sheet' then 'Упаковка 10 листов' else 'Метраж' end,
  article_no = case sku when 'PU-GL-300' then 15 when 'PU-MT-300' then 16 when 'PU-PR-300' then 17 when 'PU-WT-SH' then 18 when 'PU-DS-M' then 19 end
where sku in ('PU-GL-300', 'PU-MT-300', 'PU-PR-300', 'PU-WT-SH', 'PU-DS-M');
update public.catalog_item set category = 'Аксессуары', sort = 100,
  visual = case sku when 'BLD-45' then '{"kind":"tool","tool":"blade"}' when 'KIT-CLN' then '{"kind":"tool","tool":"kit"}' else '{"kind":"tool","tool":"squeegee"}' end::jsonb,
  subtitle = case sku when 'BLD-45' then 'Штука' when 'KIT-CLN' then 'Набор' else 'Штука' end,
  article_no = case sku when 'BLD-45' then 20 when 'KIT-CLN' then 21 else 22 end
where sku in ('BLD-45', 'KIT-CLN', 'SQG-PRO');

-- Цены листов (как в магазине: 490 ₽ за лист на 6 телефонов, 395 ₽ за лист на 3 телефона); KZT ×5.5, TRY ×0.4, свои точки ×0.85
insert into public.price_list_item(price_list_id, item_id, price_minor, valid_from)
select pl.id, i.id, round(v.price * case pl.code when 'PL-KZ' then 5.5 when 'PL-TR' then 0.4 when 'PL-OWN' then 0.85 else 1 end)::bigint, date '2024-01-01'
from (values ('SH-GL-6', 49000), ('SH-MT-6', 49000), ('SH-PR-6', 69000), ('SH-CL-01', 39500), ('SH-CL-02', 39500), ('SH-TX-01', 39500),
  ('SH-TX-02', 39500), ('SH-TX-03', 39500), ('SH-CM-01', 39500), ('SH-CM-02', 39500), ('SH-NT-01', 39500), ('SH-SP-01', 39500),
  ('SH-KD-01', 39500), ('SH-NB-01', 89000)) as v(sku, price)
join public.catalog_item i on i.sku = v.sku cross join public.price_list pl
on conflict (price_list_id, item_id, valid_from) do update set price_minor = excluded.price_minor;

insert into public.stock_projection(item_id, warehouse, available_qty, source, refreshed_at)
select i.id, 'Основной склад (демо)', v.qty, 'demo', now() - interval '20 minutes'
from (values ('SH-GL-6', 240), ('SH-MT-6', 180), ('SH-PR-6', 60), ('SH-CL-01', 35), ('SH-CL-02', 12), ('SH-TX-01', 80), ('SH-TX-02', 44),
  ('SH-TX-03', 0), ('SH-CM-01', 27), ('SH-CM-02', 31), ('SH-NT-01', 18), ('SH-SP-01', 52), ('SH-KD-01', 9), ('SH-NB-01', 40)) v(sku, qty)
join public.catalog_item i on i.sku = v.sku
on conflict (item_id, warehouse) do update set available_qty = excluded.available_qty, refreshed_at = excluded.refreshed_at;

------------------------------------------------------------------------------
-- Базовый процент менеджера продаж — 20 % (решение владельца); франчайзи меняет его для своих сотрудников
------------------------------------------------------------------------------
insert into public.commission_policy(partner_id, location_id, rate_bp, effective_from, note, is_test)
values (null, null, 2000, date '2024-01-01', 'Базовый процент менеджера продаж', false)
on conflict do nothing;

------------------------------------------------------------------------------
-- Ежедневная выручка: текущий месяц до вчера (с пропусками) и прошлый месяц для партнёра Бета (отчёт ещё не сдан)
------------------------------------------------------------------------------
with plan(code, email, base, spread, skip_mod, months_back) as (values
  ('OWN-NORTH', 'staff.north@demo.example.com', 1800000, 900000, 0, 0),
  ('OWN-NORTH', 'manager.north@demo.example.com', 900000, 600000, 3, 0),   -- управляющий работает каждый третий день
  ('ALPHA-1', 'alpha.staff@demo.example.com', 1600000, 800000, 0, 0),
  ('ALPHA-1', 'alpha.owner@demo.example.com', 700000, 400000, 7, 0),      -- владелец сам стоит на точке по выходным
  ('BETA-1', 'beta.owner@demo.example.com', 82000000, 25000000, 0, 1),     -- тенге
  ('BETA-1', 'beta.owner@demo.example.com', 82000000, 25000000, 0, 0),
  ('GAMMA-1', 'gamma.owner@demo.example.com', 320000, 120000, 0, 0)        -- лиры
), days as (
  select p.*, l.id as location_id, l.partner_id, l.currency, u.id as employee_id, d::date as day
  from plan p
  join public.location l on l.code = p.code
  join public.app_user u on u.email = p.email
  cross join lateral generate_series(
    (date_trunc('month', now() at time zone l.timezone) - make_interval(months => p.months_back))::date,
    case when p.months_back = 0 then (now() at time zone l.timezone)::date - 1
         else (date_trunc('month', now() at time zone l.timezone) - make_interval(months => p.months_back - 1) - interval '1 day')::date end,
    interval '1 day') d
)
insert into public.daily_sale(location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, source, entered_by)
select location_id, partner_id, day, employee_id, currency,
  base + (abs(hashtext(code || email || day::text)) % spread),
  case when abs(hashtext(day::text || email)) % 9 = 0 then (base / 20) else 0 end,
  6 + abs(hashtext(email || day::text)) % 9,
  'self', employee_id
from days
where (skip_mod = 0 or extract(day from day)::int % skip_mod = 0)
  -- намеренные пропуски: 4-е и 9-е число у Альфа Центр, 3-е, 11-е и 18-е у Бета (прошлый месяц) — их дозаполняет владелец
  and not (code = 'ALPHA-1' and extract(day from day)::int in (4, 9))
  and not (code = 'BETA-1' and months_back = 1 and extract(day from day)::int in (3, 11, 18))
  and not (code = 'OWN-NORTH' and email like 'staff%' and extract(day from day)::int = 6)
on conflict (location_id, day, employee_id) do nothing;
