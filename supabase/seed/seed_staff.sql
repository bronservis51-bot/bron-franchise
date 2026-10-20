-- Демо: сотрудница франчайзи Виктора, её смены, вопросы в базу знаний, неудачные поиски. Выполнять после scripts/seed-users.mjs.

do $$
declare v_dina uuid := (select id from public.app_user where email = '79000000011@staff.bron.local');
  v_alpha uuid := (select id from public.partner where code = 'ALPHA');
  v_l1 public.location := (select l from public.location l where code = 'ALPHA-1');
  v_l2 public.location := (select l from public.location l where code = 'ALPHA-2');
  v_owner uuid := (select id from public.app_user where email = 'alpha.owner@demo.example.com');
begin
  if v_dina is null then return; end if;
  -- Дина — сотрудник Виктора на двух точках: 1 000 ₽ за выход + 15 % от выручки смены
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by)
  select v_dina, 'franchisee_staff', 'partner', v_alpha, v_owner
  where not exists (select 1 from public.role_assignment where user_id = v_dina and revoked_at is null);
  insert into public.staff_member(user_id, partner_id, phone, location_ids, rate_bp, shift_fee_minor, created_by)
  values (v_dina, v_alpha, '79000000011', array[v_l1.id, v_l2.id], 1500, 100000, v_owner)
  on conflict (user_id) do nothing;
  -- Последние три недели «Волгоград Европа» работала Дина: выручка дня — её смены
  insert into public.work_shift(partner_id, location_id, employee_id, day, status, opened_at, closed_at, cash_minor, card_minor, rate_bp, shift_fee_minor, earned_minor)
  select r.partner_id, r.location_id, v_dina, r.day, 'closed',
    (r.day + time '10:00') at time zone v_l1.timezone, (r.day + time '22:05') at time zone v_l1.timezone,
    r.cash_minor, r.card_minor, 1500, 100000, app_private.shift_pay(r.total_minor, 1500, 100000)
  from public.daily_revenue r
  where r.location_id = v_l1.id and r.employee_id is null and r.day >= (now() at time zone v_l1.timezone)::date - 21
  on conflict do nothing;
  update public.daily_revenue r set employee_id = v_dina, entered_by = v_dina
  where r.location_id = v_l1.id and r.employee_id is null and r.day >= (now() at time zone v_l1.timezone)::date - 21;
  -- Сегодня Дина на смене в «Ворошиловском»
  insert into public.work_shift(partner_id, location_id, employee_id, day, opened_at)
  select v_alpha, v_l2.id, v_dina, (now() at time zone v_l2.timezone)::date, now() - interval '3 hours'
  where not exists (select 1 from public.work_shift where employee_id = v_dina and status = 'open');
end $$;

-- Вопросы в базу знаний: один с ответом, один ждёт ответа
insert into public.kb_question(user_id, partner_id, question, answer, answered_by, answered_at, created_at)
select u.id, (select id from public.partner where code = 'ALPHA'), 'Можно ли клеить плёнку на изогнутые края экрана?',
  'Да, но только эластичную плёнку и с прогревом феном до 40–50 °C. Края прикатывайте ракелем от центра. Подробно — в «Стандарте оклейки».',
  (select id from public.app_user where email = 'fm@demo.example.com'), now() - interval '1 day', now() - interval '2 days'
from public.app_user u where u.email = 'alpha.owner@demo.example.com';
insert into public.kb_question(user_id, partner_id, question, created_at)
select u.id, (select id from public.partner where code = 'BETA'), 'Где взять лекало для Samsung Galaxy S25 Ultra? В библиотеке плоттера его нет.', now() - interval '5 hours'
from public.app_user u where u.email = 'beta.owner@demo.example.com';

-- Что искали и не нашли
insert into public.kb_search_log(user_id, query, results, at)
select u.id, q, 0, now() - (n || ' hours')::interval
from public.app_user u, (values ('возврат денег клиенту', 30), ('возврат денег клиенту', 8), ('скидка постоянным клиентам', 20),
  ('как оформить продавца', 50), ('реклама в соцсетях', 70)) v(q, n)
where u.email = 'beta.owner@demo.example.com';
