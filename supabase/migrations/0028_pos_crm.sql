-- 0028 CRM продаж на точке (решение владельца 14.10.2026): каждая продажа — клиент (телефон), что оклеили, модель, цена, оплата.
-- Клиент узнаётся по телефону: история, устройства, гарантия. Список «вернуть клиентов» — для повторных продаж.
-- Базу клиентов видят только люди своей сети (франчайзи — свою, собственные точки — свою); компания видит продажи без телефонов.

insert into public.permission(code, description, is_financial) values ('pos.sell', 'Продажи на точке: запись продаж и база клиентов', false);
insert into public.role_permission(role, permission) values
  ('location_staff', 'pos.sell'), ('partner_staff', 'pos.sell'), ('location_manager', 'pos.sell'), ('partner_owner', 'pos.sell');

create table public.pos_client (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references public.partner(id), -- null — клиенты собственных точек компании
  phone text not null,
  phone_digits text not null,
  name text,
  note text,
  first_location_id uuid references public.location(id),
  visits int not null default 0,
  total_minor bigint not null default 0,
  last_visit_at timestamptz,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create unique index pos_client_phone on public.pos_client (coalesce(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_digits);

create table public.pos_sale (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid references public.partner(id),
  employee_id uuid not null references public.app_user(id),
  client_id uuid references public.pos_client(id),
  sold_at timestamptz not null default now(),
  day date not null,
  currency text not null references public.currency(code),
  total_minor bigint not null check (total_minor >= 0),
  payment text not null check (payment in ('cash', 'card', 'transfer', 'mixed')),
  card_minor bigint not null default 0 check (card_minor >= 0),
  warranty_until date,
  comment text,
  status text not null default 'done' check (status in ('done', 'returned')),
  return_reason text,
  returned_at timestamptz,
  op_key text unique,
  check (card_minor <= total_minor)
);
create index on public.pos_sale (location_id, day);
create index on public.pos_sale (client_id, sold_at desc);
create index on public.pos_sale (employee_id, day);

create table public.pos_sale_line (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.pos_sale(id),
  service text not null check (service in ('back', 'screen', 'full', 'camera', 'laptop', 'watch', 'tablet', 'goods', 'other')),
  device text,
  qty int not null default 1 check (qty between 1 and 100),
  price_minor bigint not null check (price_minor >= 0)
);
create index on public.pos_sale_line (sale_id);

-- Видит ли пользователь клиентов этой сети: есть право продаж на какой-либо точке этого владельца
create function app_private.pos_can_see_clients(p_partner uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from public.location l where l.partner_id is not distinct from p_partner and l.status <> 'closed'
    and app_private.has_perm('pos.sell', l.partner_id, l.id))
$$;

-- Телефон в единый вид: только цифры; российская «8XXXXXXXXXX» = «7XXXXXXXXXX»
create function app_private.pos_phone(p text) returns text
language sql immutable as $$
  select case when d ~ '^8[0-9]{10}$' then '7' || substr(d, 2) else nullif(d, '') end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create function app_private.pos_can_read_sale(s public.pos_sale) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select s.employee_id = auth.uid() or app_private.has_perm('sales.manage', s.partner_id, s.location_id)
    or app_private.has_perm('sales.read', s.partner_id, s.location_id) or app_private.has_perm('pos.sell', s.partner_id, s.location_id)
$$;

create function public.pos_sale_create(p_location uuid, p_phone text, p_name text, p_lines jsonb, p_payment text, p_card bigint, p_comment text, p_key text)
returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; s public.pos_sale; c public.pos_client; v_total bigint := 0; v_digits text;
  v_day date; v_card bigint; v_warranty int; e jsonb;
begin
  if p_key is not null then
    select * into s from public.pos_sale where op_key = p_key;
    if found then return jsonb_build_object('sale', to_jsonb(s), 'replayed', true); end if;
  end if;
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  if not app_private.has_perm('pos.sell', l.partner_id, l.id) or not app_private.user_can_sell_at(v_user, l.id) then
    perform app_private.fail('forbidden', 'Записывать продажи могут те, кто работает на точке');
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then perform app_private.fail('validation', 'Что оклеили?', 'lines'); end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    if (e ->> 'service') is null or (e ->> 'service') not in ('back', 'screen', 'full', 'camera', 'laptop', 'watch', 'tablet', 'goods', 'other') then
      perform app_private.fail('validation', 'Выберите услугу', 'lines');
    end if;
    if coalesce((e ->> 'price_minor')::bigint, -1) < 0 then perform app_private.fail('validation', 'Укажите цену', 'price'); end if;
    v_total := v_total + (e ->> 'price_minor')::bigint * coalesce((e ->> 'qty')::int, 1);
  end loop;
  if v_total <= 0 then perform app_private.fail('validation', 'Сумма продажи больше нуля', 'price'); end if;
  if p_payment not in ('cash', 'card', 'transfer', 'mixed') then perform app_private.fail('validation', 'Как оплатили?', 'payment'); end if;
  v_card := case p_payment when 'card' then v_total when 'mixed' then coalesce(p_card, 0) else 0 end;
  if v_card < 0 or v_card > v_total then perform app_private.fail('validation', 'Сумма по карте не больше общей', 'card'); end if;
  v_day := (now() at time zone l.timezone)::date;
  -- Клиент по телефону (необязательно, но без телефона нет гарантии по номеру и повторных продаж)
  v_digits := app_private.pos_phone(p_phone);
  if v_digits is not null then
    if length(v_digits) < 7 then perform app_private.fail('validation', 'Проверьте номер телефона', 'phone'); end if;
    insert into public.pos_client(partner_id, phone, phone_digits, name, first_location_id, created_by)
    values (l.partner_id, trim(p_phone), v_digits, nullif(trim(p_name), ''), l.id, v_user)
    on conflict (coalesce(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_digits)
      do update set name = coalesce(nullif(trim(excluded.name), ''), public.pos_client.name)
    returning * into c;
  end if;
  select coalesce(d.warranty_days, 45) into v_warranty from public.direction d where d.id = l.direction_id;
  insert into public.pos_sale(location_id, partner_id, employee_id, client_id, day, currency, total_minor, payment, card_minor, warranty_until, comment, op_key)
  values (l.id, l.partner_id, v_user, c.id, v_day, l.currency, v_total, p_payment, v_card, v_day + coalesce(v_warranty, 45), nullif(trim(p_comment), ''), p_key)
  returning * into s;
  insert into public.pos_sale_line(sale_id, service, device, qty, price_minor)
  select s.id, x ->> 'service', nullif(trim(x ->> 'device'), ''), coalesce((x ->> 'qty')::int, 1), (x ->> 'price_minor')::bigint
  from jsonb_array_elements(p_lines) x;
  if c.id is not null then
    update public.pos_client set visits = visits + 1, total_minor = total_minor + v_total, last_visit_at = now() where id = c.id returning * into c;
  end if;
  return jsonb_build_object('sale', to_jsonb(s), 'client', to_jsonb(c));
end $$;

create function public.pos_sale_return(p_sale uuid, p_reason text) returns public.pos_sale
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.pos_sale;
begin
  select * into s from public.pos_sale where id = p_sale for update;
  if not found or not app_private.pos_can_read_sale(s) then perform app_private.fail('not-found', 'Продажа не найдена'); end if;
  if s.status = 'returned' then perform app_private.fail('transition-not-allowed', 'Уже оформлен возврат'); end if;
  if not (app_private.has_perm('sales.manage', s.partner_id, s.location_id) or (s.employee_id = v_user and s.day = (select (now() at time zone timezone)::date from public.location where id = s.location_id))) then
    perform app_private.fail('forbidden', 'Возврат прошлых дней оформляет франчайзи или управляющий');
  end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Причина возврата', 'reason'); end if;
  update public.pos_sale set status = 'returned', return_reason = trim(p_reason), returned_at = now() where id = s.id returning * into s;
  if s.client_id is not null then update public.pos_client set total_minor = greatest(0, total_minor - s.total_minor) where id = s.client_id; end if;
  perform app_private.audit('pos.return', 'pos_sale', s.id, s.partner_id, jsonb_build_object('total_minor', s.total_minor), p_reason);
  return s;
end $$;

create function app_private.pos_sale_json(s public.pos_sale) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) || jsonb_build_object(
    'employee_name', (select full_name from public.app_user where id = s.employee_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('service', x.service, 'device', x.device, 'qty', x.qty, 'price_minor', x.price_minor)) from public.pos_sale_line x where x.sale_id = s.id), '[]'::jsonb))
$$;

-- День точки: продажи, итоги по оплате и сотрудникам, подсказки цен (медиана за 60 дней) и частые модели
create function public.pos_day(p_location uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_day date; v_clients boolean;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  if not (app_private.has_perm('pos.sell', l.partner_id, l.id) or app_private.has_perm('sales.read', l.partner_id, l.id)) then
    perform app_private.fail('forbidden', 'Нет доступа к продажам точки');
  end if;
  v_day := coalesce(p_day, (now() at time zone l.timezone)::date);
  v_clients := app_private.pos_can_see_clients(l.partner_id);
  return jsonb_build_object('location', jsonb_build_object('id', l.id, 'name', l.name, 'currency', l.currency), 'day', v_day,
    'today', (now() at time zone l.timezone)::date, 'can_sell', app_private.has_perm('pos.sell', l.partner_id, l.id) and app_private.user_can_sell_at(auth.uid(), l.id),
    'sales', coalesce((select jsonb_agg(app_private.pos_sale_json(s) || jsonb_build_object(
        'client_name', case when v_clients then c.name end, 'client_phone', case when v_clients then c.phone end, 'client_visits', c.visits) order by s.sold_at desc)
      from public.pos_sale s left join public.pos_client c on c.id = s.client_id where s.location_id = l.id and s.day = v_day), '[]'::jsonb),
    'price_hints', coalesce((select jsonb_object_agg(service, price) from (
        select x.service, percentile_disc(0.5) within group (order by x.price_minor) as price
        from public.pos_sale_line x join public.pos_sale s on s.id = x.sale_id
        where s.location_id = l.id and s.day > v_day - 60 and s.status = 'done' group by x.service) h), '{}'::jsonb),
    'devices', coalesce((select jsonb_agg(device) from (select x.device from public.pos_sale_line x join public.pos_sale s on s.id = x.sale_id
        where s.location_id = l.id and x.device is not null and s.day > v_day - 90 group by x.device order by count(*) desc limit 12) d), '[]'::jsonb));
end $$;

-- Поиск клиента по телефону или имени (только своей сети)
create function public.pos_client_search(p_location uuid, p_q text) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location; v_digits text := coalesce(app_private.pos_phone(p_q), ''); v_q text := lower(trim(coalesce(p_q, '')));
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.pos_can_see_clients(l.partner_id) then perform app_private.fail('forbidden', 'Нет доступа к базе клиентов'); end if;
  return coalesce((select jsonb_agg(x) from (
    select c.id, c.name, c.phone, c.visits, c.total_minor, c.last_visit_at,
      (select max(s.warranty_until) from public.pos_sale s where s.client_id = c.id and s.status = 'done') as warranty_until,
      (select x.device from public.pos_sale_line x join public.pos_sale s on s.id = x.sale_id where s.client_id = c.id and x.device is not null order by s.sold_at desc limit 1) as last_device
    from public.pos_client c
    where c.partner_id is not distinct from l.partner_id
      and (v_q = '' or (length(v_digits) >= 3 and c.phone_digits like '%' || v_digits || '%') or lower(coalesce(c.name, '')) like '%' || v_q || '%')
    order by c.last_visit_at desc nulls last limit 30) x), '[]'::jsonb);
end $$;

create function public.pos_client_card(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare c public.pos_client;
begin
  perform app_private.require_user();
  select * into c from public.pos_client where id = p_client;
  if not found or not app_private.pos_can_see_clients(c.partner_id) then perform app_private.fail('not-found', 'Клиент не найден'); end if;
  return to_jsonb(c) || jsonb_build_object('sales', coalesce((select jsonb_agg(app_private.pos_sale_json(s) || jsonb_build_object('location_name', l.name) order by s.sold_at desc)
    from public.pos_sale s join public.location l on l.id = s.location_id where s.client_id = c.id), '[]'::jsonb));
end $$;

create function public.pos_client_note(p_client uuid, p_name text, p_note text) returns public.pos_client
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.pos_client;
begin
  perform app_private.require_user();
  select * into c from public.pos_client where id = p_client for update;
  if not found or not app_private.pos_can_see_clients(c.partner_id) then perform app_private.fail('not-found', 'Клиент не найден'); end if;
  update public.pos_client set name = coalesce(nullif(trim(p_name), ''), name), note = nullif(trim(p_note), '') where id = c.id returning * into c;
  return c;
end $$;

-- Вернуть клиентов: давно не были (плёнка изнашивается ~за полгода) и гарантия заканчивается на этой неделе
create function public.pos_comeback(p_location uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare l public.location;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.pos_can_see_clients(l.partner_id) then perform app_private.fail('forbidden', 'Нет доступа к базе клиентов'); end if;
  return jsonb_build_object(
    'long_ago', coalesce((select jsonb_agg(x) from (
      select c.id, c.name, c.phone, c.visits, c.last_visit_at,
        (select x.device from public.pos_sale_line x join public.pos_sale s on s.id = x.sale_id where s.client_id = c.id and x.device is not null order by s.sold_at desc limit 1) as last_device
      from public.pos_client c where c.partner_id is not distinct from l.partner_id and c.last_visit_at between now() - interval '400 days' and now() - interval '150 days'
      order by c.visits desc, c.last_visit_at limit 30) x), '[]'::jsonb),
    'warranty_ending', coalesce((select jsonb_agg(x) from (
      select c.id, c.name, c.phone, s.warranty_until,
        (select x.device from public.pos_sale_line x where x.sale_id = s.id and x.device is not null limit 1) as last_device
      from public.pos_sale s join public.pos_client c on c.id = s.client_id
      where s.location_id = l.id and s.status = 'done' and s.warranty_until between current_date and current_date + 7
      order by s.warranty_until limit 30) x), '[]'::jsonb));
end $$;

alter table public.pos_client enable row level security;
alter table public.pos_sale enable row level security;
alter table public.pos_sale_line enable row level security;
create policy read_clients on public.pos_client for select to authenticated using (app_private.pos_can_see_clients(partner_id));
create policy read_sale on public.pos_sale for select to authenticated using (app_private.pos_can_read_sale(pos_sale));
create policy read_line on public.pos_sale_line for select to authenticated
  using (exists (select 1 from public.pos_sale s where s.id = sale_id and app_private.pos_can_read_sale(s)));
insert into app_private.client_table(tbl) values ('public.pos_client'), ('public.pos_sale'), ('public.pos_sale_line');
insert into app_private.client_command(fn) values
  ('public.pos_sale_create(uuid, text, text, jsonb, text, bigint, text, text)'), ('public.pos_sale_return(uuid, text)'), ('public.pos_day(uuid, date)'),
  ('public.pos_client_search(uuid, text)'), ('public.pos_client_card(uuid)'), ('public.pos_client_note(uuid, text, text)'), ('public.pos_comeback(uuid)');
insert into app_private.policy_helper(fn) values ('app_private.pos_can_read_sale(public.pos_sale)'), ('app_private.pos_can_see_clients(uuid)');
select app_private.apply_grants();
