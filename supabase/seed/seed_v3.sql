-- Демо-данные v3 (13.10.2026): роли по решению владельца, базовый процент 20 %, смена «на смене», прозрачность выручки
-- (закупленная плёнка, доля оплат картой, отчёт с расхождением) и поставки (ожидаемые поступления, подписки, новинки).
-- Идемпотентно. Все суммы и люди синтетические.

create or replace function pg_temp.act_as(p_email text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from public.app_user where email = p_email), 'role', 'authenticated')::text, false);
$$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from public.app_user where email = p_email $$;
create or replace function pg_temp.loc(p_code text) returns uuid language sql as $$ select id from public.location where code = p_code $$;

------------------------------------------------------------------------------
-- Роли: руководителя направления, склада и второго финансиста больше нет (на установленных стендах — отключаются)
------------------------------------------------------------------------------
update public.role_assignment set revoked_at = now(), revoke_reason = 'Роль упразднена решением владельца'
where revoked_at is null and user_id in (select id from public.app_user where email in ('head@demo.example.com', 'warehouse@demo.example.com', 'finance2@demo.example.com'));
update public.app_user set status = 'offboarded'
where email in ('head@demo.example.com', 'warehouse@demo.example.com', 'finance2@demo.example.com') and status <> 'offboarded';

update public.app_user u set full_name = v.name from (values
  ('finance1@demo.example.com', 'Финансист Демо'), ('manager.north@demo.example.com', 'Сергей Демо'), ('staff.north@demo.example.com', 'Илья Демо'),
  ('alpha.owner@demo.example.com', 'Артём Демо'), ('alpha.staff@demo.example.com', 'Дина Демо'), ('beta.owner@demo.example.com', 'Бекзат Демо'),
  ('gamma.owner@demo.example.com', 'Gökhan Demo')) v(email, name)
where u.email = v.email and u.full_name <> v.name;

------------------------------------------------------------------------------
-- Процент: базовый 20 %; франчайзи Альфа поднял Дине до 25 % с начала месяца
------------------------------------------------------------------------------
update public.commission_policy set rate_bp = 2000, note = 'Базовый процент менеджера продаж', is_test = false
where partner_id is null and location_id is null and employee_id is null;
delete from public.commission_policy where is_test and partner_id = (select id from public.partner where code = 'ALPHA') and location_id is null;
insert into public.commission_policy(partner_id, location_id, employee_id, rate_bp, effective_from, note, created_by)
select l.partner_id, l.id, pg_temp.uid('alpha.staff@demo.example.com'), 2500, date_trunc('month', now() at time zone l.timezone)::date,
  'Лучший менеджер прошлого месяца', pg_temp.uid('alpha.owner@demo.example.com')
from public.location l where l.code = 'ALPHA-1' and pg_temp.uid('alpha.staff@demo.example.com') is not null
on conflict (partner_id, location_id, employee_id, effective_from) do nothing;

------------------------------------------------------------------------------
-- Наличные / карта: у Альфы и своей точки ~65 % по карте, у Беты ~20 % (много наличных — сигнал для проверки)
------------------------------------------------------------------------------
update public.daily_sale s set card_minor = (s.revenue_minor * case l.code when 'BETA-1' then (15 + abs(hashtext(s.id::text)) % 10)
    else (55 + abs(hashtext(s.id::text)) % 20) end / 100)::bigint
from public.location l where l.id = s.location_id and s.card_minor is null;

------------------------------------------------------------------------------
-- Закупки плёнки за 2 месяца (для сверки «услуги ↔ плёнка»): сколько телефонов можно оклеить купленным
------------------------------------------------------------------------------
update public.catalog_item set phones_per_unit = case
  when subtitle like 'Лист на 6%' then 6 when subtitle like 'Лист на 3%' then 3 when subtitle like 'Лист на 1%' then 1
  when sku in ('PU-GL-300', 'PU-MT-300', 'PU-PR-300') then 120 when sku = 'PU-WT-SH' then 10 end
where phones_per_unit is null;

insert into public.sales_order(number, kind, partner_id, location_id, status, payment_status, transfer_status, currency, total_minor, submitted_at, created_by, created_at)
select v.num, case when l.kind = 'own' then 'supply_request' else 'partner_order' end, l.partner_id, l.id, 'completed',
  case when l.kind = 'own' then 'not_required' else 'confirmed' end, 'sent', l.currency, 0,
  now() - make_interval(days => v.days_ago), coalesce(pg_temp.uid(v.buyer), pg_temp.uid('founder@demo.example.com')), now() - make_interval(days => v.days_ago)
from (values
  ('ЗК-ДЕМО-9001', 'ALPHA-1', 'alpha.owner@demo.example.com', 50), ('ЗК-ДЕМО-9002', 'ALPHA-1', 'alpha.owner@demo.example.com', 20),
  ('ЗК-ДЕМО-9003', 'BETA-1', 'beta.owner@demo.example.com', 55), ('ЗК-ДЕМО-9004', 'BETA-1', 'beta.owner@demo.example.com', 25),
  ('ЗК-ДЕМО-9005', 'GAMMA-1', 'gamma.owner@demo.example.com', 30), ('ЗК-ДЕМО-9006', 'OWN-NORTH', 'manager.north@demo.example.com', 35)
) v(num, code, buyer, days_ago)
join public.location l on l.code = v.code
on conflict (number) do nothing;

insert into public.order_line(order_id, item_id, sku, name, unit, price_minor, qty_ordered, qty_confirmed, qty_shipped, qty_received, line_total_minor)
select o.id, i.id, i.sku, i.name, i.unit, 0, v.qty, v.qty, v.qty, v.qty, 0
from (values
  ('ЗК-ДЕМО-9001', 'SH-GL-6', 10), ('ЗК-ДЕМО-9001', 'SH-CM-01', 10),
  ('ЗК-ДЕМО-9002', 'SH-GL-6', 8), ('ЗК-ДЕМО-9002', 'SH-TX-01', 6),
  ('ЗК-ДЕМО-9003', 'SH-GL-6', 120), ('ЗК-ДЕМО-9003', 'SH-MT-6', 60), ('ЗК-ДЕМО-9004', 'SH-GL-6', 90), ('ЗК-ДЕМО-9004', 'SH-PR-6', 40),
  ('ЗК-ДЕМО-9005', 'SH-GL-6', 12), ('ЗК-ДЕМО-9005', 'SH-NT-01', 10),
  ('ЗК-ДЕМО-9006', 'SH-GL-6', 14), ('ЗК-ДЕМО-9006', 'SH-MT-6', 6)
) v(num, sku, qty)
join public.sales_order o on o.number = v.num join public.catalog_item i on i.sku = v.sku
on conflict (order_id, item_id) do nothing;

------------------------------------------------------------------------------
-- Альфа Парк: франчайзи Артём сам работает на второй точке (выручка текущего месяца до вчера)
------------------------------------------------------------------------------
insert into public.daily_sale(location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, source, entered_by, card_minor)
select l.id, l.partner_id, d::date, u.id, l.currency, 1200000 + abs(hashtext('a2' || d::text)) % 700000, 0, 5 + abs(hashtext(d::text || 'a2')) % 7, 'self', u.id,
  (1200000 + abs(hashtext('a2' || d::text)) % 700000) * 6 / 10
from public.location l join public.app_user u on u.email = 'alpha.owner@demo.example.com'
cross join lateral generate_series(date_trunc('month', now() at time zone l.timezone)::date, (now() at time zone l.timezone)::date - 1, interval '1 day') d
where l.code = 'ALPHA-2'
on conflict (location_id, day, employee_id) do nothing;

------------------------------------------------------------------------------
-- Отчёт Беты за прошлый месяц: заявлено меньше, чем внесено в смены (сверка зафиксируется при отправке)
------------------------------------------------------------------------------
do $$
declare p1 date := (date_trunc('month', now()) - interval '1 month')::date; r public.revenue_report; v_daily bigint; c uuid;
begin
  select k.id into c from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'BETA';
  if c is null or exists (select 1 from public.revenue_report where contract_id = c and period = p1) then return; end if;
  select coalesce(sum(revenue_minor), 0) into v_daily from public.daily_sale where location_id = pg_temp.loc('BETA-1') and day >= p1 and day < p1 + interval '1 month';
  if v_daily = 0 then return; end if;
  perform pg_temp.act_as('beta.owner@demo.example.com');
  r := public.report_save_draft(c, p1, jsonb_build_array(
    jsonb_build_object('location_id', pg_temp.loc('BETA-1'), 'gross_minor', (v_daily * 0.78)::bigint, 'returns_minor', 0)), 'Сезон слабый', 'B-' || to_char(p1, 'YYYYMM'));
  perform public.report_submit(r.id, 'seed-submit-b1');
end $$;
select set_config('request.jwt.claims', '', false);

------------------------------------------------------------------------------
-- Смена: Дина сейчас на смене в Альфа Центр (если за сегодня выручки ещё нет)
------------------------------------------------------------------------------
insert into public.work_shift(location_id, partner_id, employee_id, day, opened_at)
select l.id, l.partner_id, u.id, (now() at time zone l.timezone)::date, least(now(), (date_trunc('day', now() at time zone l.timezone) + interval '10 hours') at time zone l.timezone)
from public.location l, public.app_user u
where l.code = 'ALPHA-1' and u.email = 'alpha.staff@demo.example.com'
  and not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.employee_id = u.id and s.day = (now() at time zone l.timezone)::date)
on conflict (location_id, employee_id, day) do nothing;

------------------------------------------------------------------------------
-- Поставки: новинки, закончившиеся позиции с датой поступления, подписки партнёров
------------------------------------------------------------------------------
update public.catalog_item set published_at = now() - interval '2 days' where sku in ('SH-SP-01', 'SH-KD-01') and published_at is null;
update public.stock_projection set available_qty = 0 where item_id = (select id from public.catalog_item where sku = 'SH-CL-02');

insert into public.stock_incoming(item_id, qty, expected_on, note, created_by)
select i.id, v.qty, current_date + v.days, v.note, pg_temp.uid('supply@demo.example.com')
from (values ('SH-TX-03', 60, 5, 'Партия кожи из Китая'), ('SH-CL-02', 40, 3, 'Допечатка каллиграфии'), ('SH-GL-6', 300, 9, 'Плановое пополнение')) v(sku, qty, days, note)
join public.catalog_item i on i.sku = v.sku
where not exists (select 1 from public.stock_incoming r where r.item_id = i.id and r.status = 'planned');

insert into public.stock_subscription(user_id, item_id)
select u.id, i.id from (values ('alpha.owner@demo.example.com', 'SH-TX-03'), ('beta.owner@demo.example.com', 'SH-TX-03'), ('alpha.owner@demo.example.com', 'SH-CL-02')) v(email, sku)
join public.app_user u on u.email = v.email join public.catalog_item i on i.sku = v.sku
on conflict do nothing;
