-- 0016 Sales: ежедневная выручка точки и заработок сотрудника (решение владельца 13.10.2026).
-- Сотрудник вносит выручку за смену и видит свой процент; владелец/управляющий дозаполняет пропуски на отдельной вкладке;
-- месячный отчёт о выручке (роялти) заполняется из дневных записей.
-- Заработок — предварительный расчёт по ставке (информационно): не расчёт зарплаты и не выплата (раздел 3.3, HR-02).

insert into public.permission(code, description, is_financial) values
  ('sales.enter', 'Внесение собственной выручки за смену', false),
  ('sales.manage', 'Выручка точки: просмотр и дозаполнение за сотрудников', false),
  ('sales.read', 'Просмотр выручки точек', false);

insert into public.role_permission(role, permission) values
  ('location_staff', 'sales.enter'),
  ('location_manager', 'sales.enter'), ('location_manager', 'sales.manage'),
  ('partner_staff', 'sales.enter'),
  ('partner_owner', 'sales.enter'), ('partner_owner', 'sales.manage'),
  ('franchise_manager', 'sales.read'), ('finance', 'sales.read'), ('direction_head', 'sales.read'),
  ('founder', 'sales.read'), ('founder', 'sales.manage');

------------------------------------------------------------------------------
-- Ставки процента сотрудника: точка → партнёр → компания (обе ссылки пустые), по дате начала действия
------------------------------------------------------------------------------
create table public.commission_policy (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references public.partner(id),
  location_id uuid references public.location(id),
  rate_bp int not null check (rate_bp between 0 and 10000),
  effective_from date not null,
  note text,
  is_test boolean not null default false,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  unique nulls not distinct (partner_id, location_id, effective_from)
);

create function app_private.commission_rate(p_location uuid, p_day date) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select rate_bp from public.commission_policy where location_id = p_location and effective_from <= p_day order by effective_from desc limit 1),
    (select c.rate_bp from public.commission_policy c join public.location l on l.partner_id = c.partner_id
      where l.id = p_location and c.location_id is null and c.effective_from <= p_day order by c.effective_from desc limit 1),
    (select rate_bp from public.commission_policy where partner_id is null and location_id is null and effective_from <= p_day order by effective_from desc limit 1),
    0)
$$;

------------------------------------------------------------------------------
-- Выручка за день по сотруднику
------------------------------------------------------------------------------
create table public.daily_sale (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid references public.partner(id),
  day date not null,
  employee_id uuid not null references public.app_user(id),
  currency text not null references public.currency(code),
  revenue_minor bigint not null check (revenue_minor >= 0),
  returns_minor bigint not null default 0 check (returns_minor >= 0),
  services_count int not null default 0 check (services_count >= 0),
  comment text,
  source text not null check (source in ('self', 'manager')),
  entered_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  unique (location_id, day, employee_id),
  check (returns_minor <= revenue_minor)
);
create index on public.daily_sale (location_id, day);
create index on public.daily_sale (employee_id, day);

create table public.daily_sale_event (
  id bigint generated always as identity primary key,
  sale_id uuid not null references public.daily_sale(id),
  actor_id uuid,
  action text not null,
  detail jsonb,
  comment text,
  at timestamptz not null default now()
);

create function app_private.can_read_sale(s public.daily_sale) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select s.employee_id = auth.uid()
    or app_private.has_perm('sales.manage', s.partner_id, s.location_id)
    or app_private.has_perm('sales.read', s.partner_id, s.location_id)
$$;

-- Может ли пользователь работать на точке (вносить выручку): действующее назначение партнёра/точки с sales.enter/manage, покрывающее точку
create function app_private.user_can_sell_at(p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from public.role_assignment a
    join public.app_user u on u.id = a.user_id and u.status = 'active'
    join public.role_permission rp on rp.role = a.role and rp.permission in ('sales.enter', 'sales.manage')
    join public.location l on l.id = p_location
    where a.user_id = p_user and a.revoked_at is null and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
      -- работают на точке только назначенные на партнёра или точку; руководство компании видит, но смен не ведёт
      and a.scope_type in ('partner', 'location')
      and app_private.scope_covers(a.scope_type, a.scope_id, l.partner_id, l.id))
$$;

-- Период закрыт для правок, если месячный отчёт о выручке по точке уже отправлен (дальше — только корректировки роялти)
create function app_private.sales_period_locked(p_location uuid, p_day date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.revenue_report r
    join public.contract_location cl on cl.contract_id = r.contract_id and cl.location_id = p_location
    where r.period = date_trunc('month', p_day)::date and r.status not in ('draft', 'needs_correction'))
$$;

create function public.sale_save(p_location uuid, p_day date, p_employee uuid, p_revenue bigint, p_returns bigint,
  p_services int, p_comment text, p_expected_revision int default null) returns public.daily_sale
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; v_emp uuid := coalesce(p_employee, v_user);
  v_today date; s public.daily_sale; v_old public.daily_sale; v_manager boolean;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_manager := app_private.has_perm('sales.manage', l.partner_id, l.id);
  if v_emp <> v_user and not v_manager then
    perform app_private.fail('forbidden', 'Вносить выручку за других может владелец или управляющий точки');
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

  select * into v_old from public.daily_sale where location_id = l.id and day = p_day and employee_id = v_emp for update;
  if found and p_expected_revision is not null and v_old.revision <> p_expected_revision then
    perform app_private.fail('version-conflict', 'Запись уже изменили. Обновите страницу', v_old.revision::text);
  end if;
  insert into public.daily_sale(location_id, partner_id, day, employee_id, currency, revenue_minor, returns_minor, services_count, comment, source, entered_by)
  values (l.id, l.partner_id, p_day, v_emp, l.currency, p_revenue, coalesce(p_returns, 0), coalesce(p_services, 0), nullif(trim(p_comment), ''),
          case when v_emp = v_user then 'self' else 'manager' end, v_user)
  on conflict (location_id, day, employee_id) do update set revenue_minor = excluded.revenue_minor, returns_minor = excluded.returns_minor,
    services_count = excluded.services_count, comment = excluded.comment, source = excluded.source, entered_by = excluded.entered_by,
    updated_at = now(), revision = public.daily_sale.revision + 1
  returning * into s;
  insert into public.daily_sale_event(sale_id, actor_id, action, detail)
  values (s.id, v_user, case when v_old.id is null then 'created' else 'updated' end,
    jsonb_build_object('revenue_minor', s.revenue_minor, 'returns_minor', s.returns_minor, 'old_revenue_minor', v_old.revenue_minor));
  if v_old.id is not null or v_emp <> v_user then
    perform app_private.audit('sales.save', 'daily_sale', s.id, l.partner_id,
      jsonb_build_object('day', p_day, 'employee', v_emp, 'revenue_minor', s.revenue_minor, 'old_revenue_minor', v_old.revenue_minor));
  end if;
  return s;
end $$;

create function public.sale_delete(p_sale uuid, p_reason text) returns void
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
  delete from public.daily_sale_event where sale_id = s.id;
  delete from public.daily_sale where id = s.id;
end $$;

-- Месяц точки для владельца/управляющего: дни × сотрудники, пропуски, итоги (вкладка «Отчёт точки»)
create function public.sales_month(p_location uuid, p_month date) returns jsonb
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
    'employees', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name) order by u.full_name)
      from public.app_user u where app_private.user_can_sell_at(u.id, l.id)
         or exists (select 1 from public.daily_sale s where s.location_id = l.id and s.employee_id = u.id and s.day between v_from and v_to)), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'day', s.day, 'employee_id', s.employee_id, 'revenue_minor', s.revenue_minor,
        'returns_minor', s.returns_minor, 'services_count', s.services_count, 'source', s.source, 'revision', s.revision, 'comment', s.comment) order by s.day)
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to), '[]'::jsonb),
    'missing_days', coalesce((select jsonb_agg(d::date order by d) from generate_series(v_from, v_to, interval '1 day') d
      where not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = d::date)), '[]'::jsonb),
    'totals', (select jsonb_build_object('revenue_minor', coalesce(sum(revenue_minor), 0)::bigint, 'returns_minor', coalesce(sum(returns_minor), 0)::bigint,
        'services', coalesce(sum(services_count), 0)::bigint, 'days_with_data', count(distinct day))
      from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to),
    'days_in_period', (v_to - v_from + 1)
  );
end $$;

-- Мой заработок за месяц: дни, ставка, предварительный расчёт; точки, где можно вносить выручку
create function public.my_earnings(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_from date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to date := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month' - interval '1 day')::date;
begin
  return jsonb_build_object(
    'month', v_from,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'currency', l.currency, 'timezone', l.timezone,
        'today', (now() at time zone l.timezone)::date, 'rate_bp', app_private.commission_rate(l.id, (now() at time zone l.timezone)::date),
        'can_manage', app_private.has_perm('sales.manage', l.partner_id, l.id)) order by l.status <> 'active', l.name)
      from public.location l where app_private.user_can_sell_at(v_user, l.id) and l.status in ('active', 'opening')), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(x order by x.day desc) from (
      select s.id, s.day, s.location_id, l.name as location_name, s.currency, s.revenue_minor, s.returns_minor, s.services_count, s.source, s.revision, s.comment,
        app_private.commission_rate(s.location_id, s.day) as rate_bp,
        round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day) / 10000)::bigint as earnings_minor,
        app_private.sales_period_locked(s.location_id, s.day) as locked
      from public.daily_sale s join public.location l on l.id = s.location_id
      where s.employee_id = v_user and s.day between v_from and v_to) x), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'revenue_minor', rev, 'net_minor', net, 'earnings_minor', earn, 'shifts', n)) from (
      select s.currency, sum(s.revenue_minor)::bigint as rev, sum(s.revenue_minor - s.returns_minor)::bigint as net, count(*) as n,
        sum(round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day) / 10000))::bigint as earn
      from public.daily_sale s where s.employee_id = v_user and s.day between v_from and v_to group by s.currency) t), '[]'::jsonb)
  );
end $$;

-- Данные для месячного отчёта о выручке (роялти): суммы по точкам договора и полнота дней
create function public.sales_for_report(p_contract uuid, p_period date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare c public.contract; v_from date := date_trunc('month', p_period)::date; v_to date := (date_trunc('month', p_period) + interval '1 month' - interval '1 day')::date;
begin
  perform app_private.require_user();
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.can_read_royalty(c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  return jsonb_build_object('period', v_from, 'days_in_period', v_to - v_from + 1, 'locations', coalesce((
    select jsonb_agg(jsonb_build_object('location_id', cl.location_id, 'location_name', l.name,
      'gross_minor', coalesce((select sum(revenue_minor) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to), 0)::bigint,
      'returns_minor', coalesce((select sum(returns_minor) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to), 0)::bigint,
      'days_with_data', (select count(distinct day) from public.daily_sale s where s.location_id = cl.location_id and s.day between v_from and v_to),
      'missing_days', coalesce((select jsonb_agg(d::date order by d) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), v_to, interval '1 day') d
        where not exists (select 1 from public.daily_sale s where s.location_id = cl.location_id and s.day = d::date)), '[]'::jsonb)) order by l.name)
    from public.contract_location cl join public.location l on l.id = cl.location_id
    where cl.contract_id = c.id and cl.valid_from <= v_to and (cl.valid_to is null or cl.valid_to >= v_from)), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.commission_policy enable row level security;
alter table public.daily_sale enable row level security;
alter table public.daily_sale_event enable row level security;
create policy read_scope on public.commission_policy for select to authenticated
  using ((partner_id is null and location_id is null) or app_private.in_scope(partner_id, location_id));
create policy read_sale on public.daily_sale for select to authenticated using (app_private.can_read_sale(daily_sale));
create policy read_sale on public.daily_sale_event for select to authenticated
  using (exists (select 1 from public.daily_sale s where s.id = sale_id and app_private.can_read_sale(s)));

insert into app_private.client_table(tbl) values ('public.commission_policy'), ('public.daily_sale'), ('public.daily_sale_event');
insert into app_private.client_command(fn) values
  ('public.sale_save(uuid, date, uuid, bigint, bigint, int, text, int)'), ('public.sale_delete(uuid, text)'),
  ('public.sales_month(uuid, date)'), ('public.my_earnings(date)'), ('public.sales_for_report(uuid, date)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_sale(public.daily_sale)');
select app_private.apply_grants();
