-- 0018 Решения владельца 13.10.2026 (вторая итерация):
--   • роли: франчайзи и менеджер продаж; без руководителя направления и склада — их очереди уходят руководителю компании,
--     отгрузку ведёт снабжение;
--   • процент менеджера продаж задаёт франчайзи или управляющий (по сотруднику или для всей точки), базовый — 20 %;
--   • смена: «Начать смену» → «Закрыть смену» с выручкой (из неё по карте), фото кассового отчёта;
--   • прозрачность выручки: уменьшение чужой смены только с причиной и с отметкой; сверка отчёта роялти с ежедневной выручкой.

------------------------------------------------------------------------------
-- Роли
------------------------------------------------------------------------------
update public.role set name = 'Франчайзи', description = 'Владелец франшизы: точки, заказы, выручка, отчёты и роялти' where code = 'partner_owner';
update public.role set name = 'Менеджер продаж', description = 'Работает на точке франчайзи: смены, выручка, свой процент' where code = 'partner_staff';
update public.role set name = 'Менеджер продаж', description = 'Работает на собственной точке: смены, выручка, свой процент' where code = 'location_staff';
update public.role set description = 'Не используется: задачи и эскалации получает руководитель компании' where code in ('direction_head', 'warehouse');

-- Отгрузку и приёмку со стороны компании ведёт снабжение
insert into public.role_permission(role, permission) values ('procurement', 'order.fulfill') on conflict do nothing;

-- Очередь роли без людей (руководитель направления, склад) получает руководитель компании — задачи и эскалации не теряются
create or replace function app_private.queue_members(p_role text, p_partner uuid, p_location uuid) returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with direct as (
    select distinct a.user_id from public.role_assignment a
    join public.app_user u on u.id = a.user_id and u.status = 'active'
    where a.role = p_role and a.revoked_at is null
      and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
      and app_private.scope_covers(a.scope_type, a.scope_id, p_partner, p_location))
  select user_id from direct
  union
  select distinct a.user_id from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  where p_role in ('direction_head', 'warehouse') and not exists (select 1 from direct)
    and a.role = 'founder' and a.revoked_at is null and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
$$;

------------------------------------------------------------------------------
-- Процент менеджера продаж: сотрудник на точке → точка → партнёр → компания
------------------------------------------------------------------------------
alter table public.commission_policy add column employee_id uuid references public.app_user(id);
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.commission_policy'::regclass and contype = 'u';
  execute format('alter table public.commission_policy drop constraint %I', c);
end $$;
alter table public.commission_policy add constraint commission_policy_scope_key unique nulls not distinct (partner_id, location_id, employee_id, effective_from);
alter table public.commission_policy add check (employee_id is null or location_id is not null);

create function app_private.commission_rate(p_location uuid, p_day date, p_employee uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select rate_bp from public.commission_policy where p_employee is not null and employee_id = p_employee and location_id = p_location
       and effective_from <= p_day order by effective_from desc limit 1),
    app_private.commission_rate(p_location, p_day))
$$;

-- Прежняя функция (точка/партнёр/компания) больше не видит персональные ставки
create or replace function app_private.commission_rate(p_location uuid, p_day date) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select rate_bp from public.commission_policy where location_id = p_location and employee_id is null and effective_from <= p_day order by effective_from desc limit 1),
    (select c.rate_bp from public.commission_policy c join public.location l on l.partner_id = c.partner_id
      where l.id = p_location and c.location_id is null and c.employee_id is null and c.effective_from <= p_day order by c.effective_from desc limit 1),
    (select rate_bp from public.commission_policy where partner_id is null and location_id is null and employee_id is null and effective_from <= p_day order by effective_from desc limit 1),
    0)
$$;

create function public.commission_set(p_location uuid, p_employee uuid, p_rate_bp int, p_effective_from date, p_note text)
returns public.commission_policy
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; v_from date; v_old int; r public.commission_policy;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('sales.manage', l.partner_id, l.id);
  if p_rate_bp is null or p_rate_bp < 0 or p_rate_bp > 10000 then perform app_private.fail('validation', 'Процент от 0 до 100', 'rate'); end if;
  if p_employee is not null and not app_private.user_can_sell_at(p_employee, l.id) then
    perform app_private.fail('validation', 'Сотрудник не работает на этой точке', 'employee');
  end if;
  v_from := coalesce(p_effective_from, (now() at time zone l.timezone)::date);
  if app_private.sales_period_locked(l.id, v_from) then
    perform app_private.fail('transition-not-allowed', 'Месяц уже сдан отчётом — новый процент можно ввести со следующего месяца', 'effective_from');
  end if;
  v_old := app_private.commission_rate(l.id, v_from, p_employee);
  insert into public.commission_policy(partner_id, location_id, employee_id, rate_bp, effective_from, note, created_by)
  values (l.partner_id, l.id, p_employee, p_rate_bp, v_from, nullif(trim(p_note), ''), v_user)
  on conflict (partner_id, location_id, employee_id, effective_from) do update set rate_bp = excluded.rate_bp, note = excluded.note,
    created_by = excluded.created_by, created_at = now()
  returning * into r;
  perform app_private.audit('sales.commission', 'commission_policy', r.id, l.partner_id,
    jsonb_build_object('location', l.id, 'employee', p_employee, 'rate_bp', p_rate_bp, 'old_rate_bp', v_old, 'effective_from', v_from), p_note);
  if p_employee is not null and v_old is distinct from p_rate_bp then
    perform app_private.notify(p_employee, 'sales.commission', 'Ваш процент: ' || trim(to_char(p_rate_bp / 100.0, 'FM990.##')) || '%',
      'Точка «' || l.name || '», с ' || to_char(v_from, 'DD.MM.YYYY') || '. Было ' || trim(to_char(v_old / 100.0, 'FM990.##')) || '%',
      'commission_policy', r.id, '/sales', 'commission:' || r.id || ':' || p_rate_bp);
  end if;
  return r;
end $$;

------------------------------------------------------------------------------
-- Выручка: из неё по карте (проверяется выпиской эквайринга), фото кассового отчёта, отметка уменьшения
------------------------------------------------------------------------------
alter table public.daily_sale
  add column card_minor bigint check (card_minor >= 0),
  add column reduced_by_manager boolean not null default false;
alter table public.daily_sale add check (card_minor is null or card_minor <= revenue_minor);

create table public.work_shift (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid references public.partner(id),
  employee_id uuid not null references public.app_user(id),
  day date not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  sale_id uuid references public.daily_sale(id),
  status text not null default 'open' check (status in ('open', 'closed')),
  unique (location_id, employee_id, day)
);
create index on public.work_shift (employee_id, status);

-- Общее ядро записи выручки (форма «Выручка», закрытие смены, дозаполнение управляющим)
create function app_private.sale_upsert(p_location uuid, p_day date, p_employee uuid, p_revenue bigint, p_returns bigint,
  p_services int, p_comment text, p_expected_revision int, p_card bigint) returns public.daily_sale
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; v_emp uuid := coalesce(p_employee, v_user);
  v_today date; s public.daily_sale; v_old public.daily_sale; v_manager boolean; v_reduced boolean := false;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_manager := app_private.has_perm('sales.manage', l.partner_id, l.id);
  if v_emp <> v_user and not v_manager then
    perform app_private.fail('forbidden', 'Вносить выручку за других может франчайзи или управляющий точки');
  end if;
  if v_emp = v_user and not (v_manager or app_private.has_perm('sales.enter', l.partner_id, l.id)) then
    perform app_private.fail('forbidden', 'Нет права вносить выручку на этой точке');
  end if;
  if not app_private.user_can_sell_at(v_emp, l.id) then
    perform app_private.fail('validation', 'Сотрудник не работает на этой точке', 'employee');
  end if;
  v_today := (now() at time zone l.timezone)::date;
  if p_day is null or p_day > v_today then perform app_private.fail('validation', 'Нельзя вносить выручку за будущий день', 'day'); end if;
  if not v_manager and p_day < v_today - 2 then
    perform app_private.fail('validation', 'Сотрудник вносит выручку за последние 3 дня; более ранние дни дозаполняет управляющий', 'day');
  end if;
  if app_private.sales_period_locked(l.id, p_day) then
    perform app_private.fail('transition-not-allowed', 'Отчёт о выручке за этот месяц уже отправлен; исправление — через финансы');
  end if;
  if p_revenue is null or p_revenue < 0 then perform app_private.fail('validation', 'Укажите выручку', 'revenue'); end if;
  if coalesce(p_returns, 0) < 0 or coalesce(p_returns, 0) > p_revenue then perform app_private.fail('validation', 'Возвраты не больше выручки', 'returns'); end if;
  if p_card is not null and (p_card < 0 or p_card > p_revenue) then perform app_private.fail('validation', 'Оплата картой не больше выручки', 'card'); end if;

  select * into v_old from public.daily_sale where location_id = l.id and day = p_day and employee_id = v_emp for update;
  if found and p_expected_revision is not null and v_old.revision <> p_expected_revision then
    perform app_private.fail('version-conflict', 'Запись уже изменили. Обновите страницу', v_old.revision::text);
  end if;
  -- Прозрачность: смену, которую сотрудник внёс сам, другой человек может уменьшить только с причиной; это видно компании
  if v_old.id is not null and v_old.source = 'self' and v_old.employee_id <> v_user and p_revenue < v_old.revenue_minor then
    if coalesce(trim(p_comment), '') = '' or trim(p_comment) = coalesce(trim(v_old.comment), '') then
      perform app_private.fail('validation', 'Сотрудник сам внёс эту смену. Чтобы уменьшить сумму, укажите причину в комментарии', 'comment');
    end if;
    v_reduced := true;
  end if;
  insert into public.daily_sale(location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, comment, source,
    entered_by, card_minor, reduced_by_manager)
  values (l.id, l.partner_id, p_day, v_emp, l.currency, p_revenue, coalesce(p_returns, 0), coalesce(p_services, 0), nullif(trim(p_comment), ''),
          case when v_emp = v_user then 'self' else 'manager' end, v_user, p_card, v_reduced)
  on conflict (location_id, day, employee_id) do update set revenue_minor = excluded.revenue_minor, returns_minor = excluded.returns_minor,
    services_count = excluded.services_count, comment = excluded.comment,
    -- источник «сам» сохраняется, если сотрудник внёс смену, а управляющий только поправил её
    source = case when public.daily_sale.source = 'self' and excluded.source = 'manager' then 'self' else excluded.source end,
    entered_by = excluded.entered_by, card_minor = coalesce(excluded.card_minor, case when public.daily_sale.card_minor <= excluded.revenue_minor then public.daily_sale.card_minor end),
    reduced_by_manager = public.daily_sale.reduced_by_manager or excluded.reduced_by_manager,
    updated_at = now(), revision = public.daily_sale.revision + 1
  returning * into s;
  insert into public.daily_sale_event(sale_id, actor_id, action, detail)
  values (s.id, v_user, case when v_old.id is null then 'created' when v_reduced then 'reduced' else 'updated' end,
    jsonb_build_object('revenue_minor', s.revenue_minor, 'returns_minor', s.returns_minor, 'card_minor', s.card_minor,
      'old_revenue_minor', v_old.revenue_minor, 'reason', case when v_reduced then trim(p_comment) end));
  if v_old.id is not null or v_emp <> v_user then
    perform app_private.audit('sales.save', 'daily_sale', s.id, l.partner_id,
      jsonb_build_object('day', p_day, 'employee', v_emp, 'revenue_minor', s.revenue_minor, 'old_revenue_minor', v_old.revenue_minor), p_comment);
  end if;
  if v_reduced then
    perform app_private.notify(v_emp, 'sales.reduced', 'Вашу смену за ' || to_char(p_day, 'DD.MM') || ' изменили',
      'Было ' || v_old.revenue_minor / 100 || ', стало ' || s.revenue_minor / 100 || '. Причина: ' || trim(p_comment),
      'daily_sale', s.id, '/sales', 'reduced:' || s.id || ':' || s.revision);
  end if;
  return s;
end $$;

-- Новая подпись команды: + оплата картой
delete from app_private.client_command where fn = 'public.sale_save(uuid, date, uuid, bigint, bigint, int, text, int)'::regprocedure;
drop function public.sale_save(uuid, date, uuid, bigint, bigint, int, text, int);
create function public.sale_save(p_location uuid, p_day date, p_employee uuid, p_revenue bigint, p_returns bigint,
  p_services int, p_comment text, p_expected_revision int default null, p_card bigint default null) returns public.daily_sale
language sql security definer set search_path = public, app_private, pg_temp as $$
  select app_private.sale_upsert(p_location, p_day, p_employee, p_revenue, p_returns, p_services, p_comment, p_expected_revision, p_card)
$$;

-- Удаление: история остаётся в журнале аудита; смена, связанная с записью, снова открывается
create or replace function public.sale_delete(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.daily_sale;
begin
  perform app_private.require_user();
  select * into s from public.daily_sale where id = p_sale for update;
  if not found or not app_private.can_read_sale(s) then perform app_private.fail('not-found', 'Запись не найдена'); end if;
  perform app_private.require_perm('sales.manage', s.partner_id, s.location_id);
  if app_private.sales_period_locked(s.location_id, s.day) then perform app_private.fail('transition-not-allowed', 'Месяц закрыт отправленным отчётом'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  perform app_private.audit('sales.delete', 'daily_sale', s.id, s.partner_id, to_jsonb(s), p_reason);
  update public.work_shift set sale_id = null, status = 'open', closed_at = null where sale_id = s.id;
  delete from public.daily_sale_event where sale_id = s.id;
  delete from public.daily_sale where id = s.id;
  if s.source = 'self' and s.employee_id <> auth.uid() then
    perform app_private.notify(s.employee_id, 'sales.reduced', 'Вашу смену за ' || to_char(s.day, 'DD.MM') || ' удалили', 'Причина: ' || trim(p_reason),
      null, null, '/sales', 'deleted:' || s.id);
  end if;
end $$;

-- Фото кассового (Z-)отчёта или чека терминала к смене: видят сотрудник, франчайзи и компания
create function public.sale_attach_prepare(p_sale uuid, p_name text, p_mime text, p_size bigint, p_checksum text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare s public.daily_sale;
begin
  perform app_private.require_user();
  select * into s from public.daily_sale where id = p_sale;
  if not found or not app_private.can_read_sale(s) then perform app_private.fail('not-found', 'Запись не найдена'); end if;
  if not (s.employee_id = auth.uid() or app_private.has_perm('sales.manage', s.partner_id, s.location_id)) then
    perform app_private.fail('forbidden', 'Приложить фото может сотрудник смены или управляющий');
  end if;
  return app_private.file_prepare(case when s.employee_id = auth.uid() then 'sales.enter' else 'sales.manage' end, s.partner_id, s.location_id, 'scope',
    p_name, p_mime, p_size, p_checksum, 'daily_sale', s.id);
end $$;

------------------------------------------------------------------------------
-- Смена: «Начать смену» → «Закрыть смену»
------------------------------------------------------------------------------
create function public.shift_open(p_location uuid) returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; v_day date; w public.work_shift;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  if not (app_private.has_perm('sales.enter', l.partner_id, l.id) or app_private.has_perm('sales.manage', l.partner_id, l.id))
     or not app_private.user_can_sell_at(v_user, l.id) then
    perform app_private.fail('forbidden', 'Вы не работаете на этой точке');
  end if;
  if exists (select 1 from public.work_shift where employee_id = v_user and status = 'open' and location_id <> l.id) then
    perform app_private.fail('transition-not-allowed', 'Сначала закройте смену на другой точке');
  end if;
  v_day := (now() at time zone l.timezone)::date;
  select * into w from public.work_shift where location_id = l.id and employee_id = v_user and day = v_day;
  if found then
    if w.status = 'closed' then perform app_private.fail('transition-not-allowed', 'Смена за сегодня уже закрыта. Исправить сумму можно в разделе «Выручка»'); end if;
    return w;
  end if;
  if exists (select 1 from public.daily_sale where location_id = l.id and employee_id = v_user and day = v_day) then
    perform app_private.fail('transition-not-allowed', 'Выручка за сегодня уже внесена. Исправить её можно в разделе «Выручка»');
  end if;
  insert into public.work_shift(location_id, partner_id, employee_id, day) values (l.id, l.partner_id, v_user, v_day) returning * into w;
  return w;
end $$;

create function public.shift_close(p_shift uuid, p_revenue bigint, p_card bigint, p_returns bigint, p_services int, p_comment text)
returns public.daily_sale
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); w public.work_shift; s public.daily_sale;
begin
  select * into w from public.work_shift where id = p_shift for update;
  if not found or w.employee_id <> v_user then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  if w.status = 'closed' then perform app_private.fail('transition-not-allowed', 'Смена уже закрыта'); end if;
  s := app_private.sale_upsert(w.location_id, w.day, v_user, p_revenue, p_returns, p_services, p_comment, null, p_card);
  update public.work_shift set status = 'closed', closed_at = now(), sale_id = s.id where id = w.id;
  return s;
end $$;

-- Смена открыта по ошибке: отменить можно, пока она пустая
create function public.shift_cancel(p_shift uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare w public.work_shift;
begin
  perform app_private.require_user();
  select * into w from public.work_shift where id = p_shift for update;
  if not found or w.employee_id <> auth.uid() then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  if w.status <> 'open' then perform app_private.fail('transition-not-allowed', 'Закрытую смену отменить нельзя'); end if;
  delete from public.work_shift where id = w.id;
end $$;

------------------------------------------------------------------------------
-- Чтение: мой заработок (с открытой сменой и личной ставкой) и месяц точки (ставки сотрудников, кто на смене)
------------------------------------------------------------------------------
create or replace function public.my_earnings(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_from date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to date := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month' - interval '1 day')::date;
begin
  return jsonb_build_object(
    'month', v_from,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'currency', l.currency, 'timezone', l.timezone,
        'today', (now() at time zone l.timezone)::date,
        'rate_bp', app_private.commission_rate(l.id, (now() at time zone l.timezone)::date, v_user),
        'can_manage', app_private.has_perm('sales.manage', l.partner_id, l.id),
        'today_done', exists (select 1 from public.daily_sale s where s.location_id = l.id and s.employee_id = v_user and s.day = (now() at time zone l.timezone)::date))
        order by l.status <> 'active', l.name)
      from public.location l where app_private.user_can_sell_at(v_user, l.id) and l.status in ('active', 'opening')), '[]'::jsonb),
    'open_shift', (select jsonb_build_object('id', w.id, 'location_id', w.location_id, 'location_name', l.name, 'day', w.day, 'opened_at', w.opened_at,
        'currency', l.currency, 'rate_bp', app_private.commission_rate(l.id, w.day, v_user), 'timezone', l.timezone)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'open' order by w.opened_at desc limit 1),
    'days', coalesce((select jsonb_agg(x order by x.day desc) from (
      select s.id, s.day, s.location_id, l.name as location_name, s.currency, s.revenue_minor, s.returns_minor, s.card_minor, s.services_count, s.source,
        s.revision, s.comment, s.reduced_by_manager,
        app_private.commission_rate(s.location_id, s.day, s.employee_id) as rate_bp,
        round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day, s.employee_id) / 10000)::bigint as earnings_minor,
        app_private.sales_period_locked(s.location_id, s.day) as locked,
        (select count(*) from public.attachment_link a where a.entity_type = 'daily_sale' and a.entity_id = s.id) as files
      from public.daily_sale s join public.location l on l.id = s.location_id
      where s.employee_id = v_user and s.day between v_from and v_to) x), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'revenue_minor', rev, 'net_minor', net, 'earnings_minor', earn, 'shifts', n)) from (
      select s.currency, sum(s.revenue_minor)::bigint as rev, sum(s.revenue_minor - s.returns_minor)::bigint as net, count(*) as n,
        sum(round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day, s.employee_id) / 10000))::bigint as earn
      from public.daily_sale s where s.employee_id = v_user and s.day between v_from and v_to group by s.currency) t), '[]'::jsonb)
  );
end $$;

create or replace function public.sales_month(p_location uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_from date := date_trunc('month', p_month)::date; v_to date; v_today date; v_manage boolean;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_manage := app_private.has_perm('sales.manage', l.partner_id, l.id);
  if not (v_manage or app_private.has_perm('sales.read', l.partner_id, l.id)) then perform app_private.fail('forbidden', 'Нет доступа к выручке точки'); end if;
  v_today := (now() at time zone l.timezone)::date;
  v_to := least((v_from + interval '1 month' - interval '1 day')::date, v_today);
  return jsonb_build_object(
    'location', jsonb_build_object('id', l.id, 'name', l.name, 'currency', l.currency, 'timezone', l.timezone),
    'month', v_from, 'today', v_today, 'can_manage', v_manage, 'locked', app_private.sales_period_locked(l.id, v_from),
    'rate_bp', app_private.commission_rate(l.id, least(v_to, v_today)),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name,
        'rate_bp', app_private.commission_rate(l.id, v_today, u.id),
        'personal_rate', exists (select 1 from public.commission_policy c where c.location_id = l.id and c.employee_id = u.id and c.effective_from <= v_today),
        'can_sell', app_private.user_can_sell_at(u.id, l.id),
        'on_shift_since', (select w.opened_at from public.work_shift w where w.location_id = l.id and w.employee_id = u.id and w.status = 'open' and w.day = v_today)
      ) order by u.full_name)
      from public.app_user u where app_private.user_can_sell_at(u.id, l.id)
         or exists (select 1 from public.daily_sale s where s.location_id = l.id and s.employee_id = u.id and s.day between v_from and v_to)), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'day', s.day, 'employee_id', s.employee_id, 'revenue_minor', s.revenue_minor,
        'returns_minor', s.returns_minor, 'card_minor', s.card_minor, 'services_count', s.services_count, 'source', s.source, 'revision', s.revision,
        'comment', s.comment, 'reduced_by_manager', s.reduced_by_manager,
        'rate_bp', app_private.commission_rate(s.location_id, s.day, s.employee_id),
        'files', (select count(*) from public.attachment_link a where a.entity_type = 'daily_sale' and a.entity_id = s.id)) order by s.day)
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'employee_id', c.employee_id, 'rate_bp', c.rate_bp, 'effective_from', c.effective_from,
        'note', c.note) order by c.effective_from desc)
      from public.commission_policy c where c.location_id = l.id), '[]'::jsonb),
    'missing_days', coalesce((select jsonb_agg(d::date order by d) from generate_series(v_from, v_to, interval '1 day') d
      where not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = d::date)), '[]'::jsonb),
    'totals', (select jsonb_build_object('revenue_minor', coalesce(sum(revenue_minor), 0)::bigint, 'returns_minor', coalesce(sum(returns_minor), 0)::bigint,
        'card_minor', coalesce(sum(card_minor), 0)::bigint, 'services', coalesce(sum(services_count), 0)::bigint, 'days_with_data', count(distinct day),
        'earnings_minor', coalesce(sum(round((revenue_minor - returns_minor)::numeric * app_private.commission_rate(location_id, day, employee_id) / 10000)), 0)::bigint)
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to),
    'days_in_period', (v_to - v_from + 1)
  );
end $$;

------------------------------------------------------------------------------
-- Сверка отчёта роялти с ежедневной выручкой: фиксируется при отправке, видна финансам и франчайзи
------------------------------------------------------------------------------
create table public.report_sales_check (
  report_id uuid primary key references public.revenue_report(id),
  partner_id uuid not null references public.partner(id),
  period date not null,
  reported_gross_minor bigint not null,
  daily_gross_minor bigint not null,
  diff_minor bigint not null,
  missing_days int not null,
  detail jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);

create function app_private.sales_check_report() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := new.period; v_to date := (new.period + interval '1 month' - interval '1 day')::date;
  v_detail jsonb; v_rep bigint; v_daily bigint; v_missing int;
begin
  if new.status <> 'submitted' or old.status = new.status then return new; end if;
  select coalesce(jsonb_agg(jsonb_build_object('location_id', rl.location_id, 'location_name', l.name, 'reported_minor', rl.gross_minor,
      'daily_minor', d.gross, 'missing_days', d.missing)), '[]'::jsonb),
    coalesce(sum(rl.gross_minor), 0), coalesce(sum(d.gross), 0), coalesce(sum(d.missing), 0)
  into v_detail, v_rep, v_daily, v_missing
  from public.report_line rl join public.location l on l.id = rl.location_id
  cross join lateral (select coalesce((select sum(revenue_minor) from public.daily_sale s where s.location_id = rl.location_id and s.day between v_from and v_to), 0)::bigint as gross,
      (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), least(v_to, current_date), interval '1 day') g
        where not exists (select 1 from public.daily_sale s where s.location_id = rl.location_id and s.day = g::date))::int as missing) d
  where rl.revision_id = new.current_revision_id;
  insert into public.report_sales_check(report_id, partner_id, period, reported_gross_minor, daily_gross_minor, diff_minor, missing_days, detail)
  values (new.id, new.partner_id, new.period, v_rep, v_daily, v_rep - v_daily, v_missing, v_detail)
  on conflict (report_id) do update set reported_gross_minor = excluded.reported_gross_minor, daily_gross_minor = excluded.daily_gross_minor,
    diff_minor = excluded.diff_minor, missing_days = excluded.missing_days, detail = excluded.detail, checked_at = now();
  -- Отчёт меньше ежедневной выручки больше чем на 1 % — сигнал финансам и менеджеру франшизы
  if v_daily > 0 and v_rep < v_daily * 0.99 then
    perform app_private.notify_queue('finance', new.partner_id, null, 'sales.mismatch', 'Отчёт меньше ежедневной выручки: ' || new.number,
      'В отчёте ' || v_rep / 100 || ', по сменам ' || v_daily / 100 || ' (разница ' || (v_daily - v_rep) / 100 || ')',
      'revenue_report', new.id, '/royalties/reports/' || new.id, 'mismatch:' || new.id || ':' || new.current_revision_id, true);
    perform app_private.notify_queue('franchise_manager', new.partner_id, null, 'sales.mismatch', 'Отчёт меньше ежедневной выручки: ' || new.number,
      'В отчёте ' || v_rep / 100 || ', по сменам ' || v_daily / 100, 'revenue_report', new.id, '/royalties/reports/' || new.id,
      'mismatch:' || new.id || ':' || new.current_revision_id);
  end if;
  return new;
end $$;
create trigger revenue_report_sales_check after update of status on public.revenue_report
  for each row execute function app_private.sales_check_report();

------------------------------------------------------------------------------
-- RLS и реестр
------------------------------------------------------------------------------
alter table public.work_shift enable row level security;
alter table public.report_sales_check enable row level security;
create policy read_shift on public.work_shift for select to authenticated
  using (employee_id = auth.uid() or app_private.has_perm('sales.manage', partner_id, location_id) or app_private.has_perm('sales.read', partner_id, location_id));
create policy read_check on public.report_sales_check for select to authenticated using (app_private.can_read_royalty(partner_id));

insert into app_private.client_table(tbl) values ('public.work_shift'), ('public.report_sales_check');
insert into app_private.client_command(fn) values
  ('public.sale_save(uuid, date, uuid, bigint, bigint, int, text, int, bigint)'),
  ('public.commission_set(uuid, uuid, int, date, text)'),
  ('public.sale_attach_prepare(uuid, text, text, bigint, text)'),
  ('public.shift_open(uuid)'), ('public.shift_close(uuid, bigint, bigint, bigint, int, text)'), ('public.shift_cancel(uuid)');
select app_private.apply_grants();
