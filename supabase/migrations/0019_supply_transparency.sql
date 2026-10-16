-- 0019 Оперативность поставок (ключевая проблема франчайзи, 13.10.2026): партнёр видит, что плёнка закончилась, когда
-- ожидается и что пришло; может подписаться «Сообщить о поступлении»; снабжение планирует поступления, отмечает приход
-- и объявляет новинки — партнёры получают уведомления автоматически.
-- Прозрачность выручки: сверка заявленных услуг с закупленной плёнкой (сколько телефонов можно оклеить купленным).

alter table public.catalog_item
  add column published_at timestamptz,
  add column phones_per_unit numeric(10, 2); -- сколько телефонов оклеивается единицей товара (лист на 6 → 6); оценка для сверки

create table public.stock_incoming (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.catalog_item(id),
  qty numeric(12, 3) not null check (qty > 0),
  expected_on date not null,
  status text not null default 'planned' check (status in ('planned', 'arrived', 'cancelled')),
  note text,
  arrived_qty numeric(12, 3),
  arrived_at timestamptz,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index on public.stock_incoming (item_id, status);

create table public.stock_subscription (
  user_id uuid not null references public.app_user(id),
  item_id uuid not null references public.catalog_item(id),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, item_id)
);

-- Кому сообщать о новинках и поступлениях: все, кто может заказывать (франчайзи, управляющие собственных точек)
create function app_private.buyers() returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select distinct a.user_id from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  join public.role_permission rp on rp.role = a.role and rp.permission = 'order.create'
  where a.revoked_at is null and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
$$;

create function app_private.stock_total(p_item uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(available_qty), 0) from public.stock_projection where item_id = p_item
$$;

-- Остаток стал положительным (приход, синхронизация склада) — подписчикам уходит уведомление
create function app_private.stock_notify_arrival() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare i public.catalog_item; v_before numeric;
begin
  v_before := app_private.stock_total(new.item_id) - new.available_qty + coalesce(case when tg_op = 'UPDATE' then old.available_qty end, 0);
  if v_before > 0 or app_private.stock_total(new.item_id) <= 0 then return new; end if;
  select * into i from public.catalog_item where id = new.item_id;
  perform app_private.notify(s.user_id, 'stock.arrived', 'Поступила плёнка: ' || i.name,
    'Снова в наличии — можно заказывать', 'catalog_item', i.id, '/catalog', 'arrived:' || i.id || ':' || to_char(now(), 'YYYYMMDDHH24'), false)
  from public.stock_subscription s where s.item_id = i.id;
  update public.stock_subscription set notified_at = now() where item_id = i.id;
  return new;
end $$;
create trigger stock_projection_arrival after insert or update of available_qty on public.stock_projection
  for each row execute function app_private.stock_notify_arrival();

------------------------------------------------------------------------------
-- Команды снабжения
------------------------------------------------------------------------------
create function public.stock_incoming_plan(p_item uuid, p_qty numeric, p_expected_on date, p_note text) returns public.stock_incoming
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); i public.catalog_item; r public.stock_incoming;
begin
  perform app_private.require_perm('catalog.manage');
  select * into i from public.catalog_item where id = p_item;
  if not found then perform app_private.fail('not-found', 'Товар не найден'); end if;
  if p_qty is null or p_qty <= 0 then perform app_private.fail('validation', 'Укажите количество', 'qty'); end if;
  if p_expected_on is null or p_expected_on < current_date then perform app_private.fail('validation', 'Дата поступления не в прошлом', 'expected_on'); end if;
  insert into public.stock_incoming(item_id, qty, expected_on, note, created_by) values (i.id, p_qty, p_expected_on, nullif(trim(p_note), ''), v_user)
  returning * into r;
  -- Подписчики и все, кто ждёт этот товар, узнают дату
  perform app_private.notify(s.user_id, 'stock.expected', 'Ожидается: ' || i.name, 'Поступление к ' || to_char(p_expected_on, 'DD.MM.YYYY'),
    'catalog_item', i.id, '/catalog', 'expected:' || r.id)
  from public.stock_subscription s where s.item_id = i.id;
  perform app_private.audit('stock.incoming.plan', 'stock_incoming', r.id, null, to_jsonb(r));
  return r;
end $$;

create function public.stock_incoming_arrive(p_incoming uuid, p_qty numeric) returns public.stock_incoming
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.stock_incoming; v_qty numeric;
begin
  perform app_private.require_user();
  perform app_private.require_perm('catalog.manage');
  select * into r from public.stock_incoming where id = p_incoming for update;
  if not found then perform app_private.fail('not-found', 'Поступление не найдено'); end if;
  if r.status <> 'planned' then perform app_private.fail('transition-not-allowed', 'Поступление уже отмечено'); end if;
  v_qty := coalesce(p_qty, r.qty);
  if v_qty <= 0 then perform app_private.fail('validation', 'Количество больше нуля', 'qty'); end if;
  -- Демо-проекция остатка: в реальном контуре остаток обновит синхронизация «МойСклад», уведомление сработает так же
  insert into public.stock_projection(item_id, warehouse, available_qty, source, refreshed_at)
  values (r.item_id, 'Основной склад (демо)', v_qty, 'demo', now())
  on conflict (item_id, warehouse) do update set available_qty = public.stock_projection.available_qty + excluded.available_qty, refreshed_at = now();
  update public.stock_incoming set status = 'arrived', arrived_qty = v_qty, arrived_at = now() where id = r.id returning * into r;
  perform app_private.audit('stock.incoming.arrive', 'stock_incoming', r.id, null, to_jsonb(r));
  return r;
end $$;

create function public.stock_incoming_cancel(p_incoming uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.stock_incoming; i public.catalog_item;
begin
  perform app_private.require_user();
  perform app_private.require_perm('catalog.manage');
  select * into r from public.stock_incoming where id = p_incoming for update;
  if not found or r.status <> 'planned' then perform app_private.fail('not-found', 'Ожидаемое поступление не найдено'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину — её увидят партнёры, которые ждут товар', 'reason'); end if;
  select * into i from public.catalog_item where id = r.item_id;
  update public.stock_incoming set status = 'cancelled', note = trim(p_reason) where id = r.id;
  perform app_private.notify(s.user_id, 'stock.expected', 'Поступление перенесено: ' || i.name, trim(p_reason), 'catalog_item', i.id, '/catalog', 'cancel:' || r.id)
  from public.stock_subscription s where s.item_id = i.id;
end $$;

-- Новинка: появляется в магазине с отметкой «Новинка», всем, кто заказывает, — уведомление
create function public.catalog_item_announce(p_item uuid, p_message text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare i public.catalog_item;
begin
  perform app_private.require_user();
  perform app_private.require_perm('catalog.manage');
  select * into i from public.catalog_item where id = p_item for update;
  if not found or not i.active then perform app_private.fail('not-found', 'Товар не найден'); end if;
  update public.catalog_item set published_at = now(), updated_at = now() where id = i.id;
  perform app_private.notify(b, 'catalog.new', 'Новинка в магазине: ' || i.name,
    coalesce(nullif(trim(p_message), ''), coalesce(i.subtitle, i.category)), 'catalog_item', i.id, '/catalog', 'new:' || i.id || ':' || to_char(now(), 'YYYYMMDD'))
  from app_private.buyers() b;
  perform app_private.audit('catalog.announce', 'catalog_item', i.id, null, jsonb_build_object('message', p_message));
end $$;

create function public.stock_subscribe(p_item uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user();
begin
  if not app_private.has_perm_anywhere('catalog.read') then perform app_private.fail('forbidden', 'Нет доступа к каталогу'); end if;
  if not exists (select 1 from public.catalog_item where id = p_item and active) then perform app_private.fail('not-found', 'Товар не найден'); end if;
  if p_on then
    insert into public.stock_subscription(user_id, item_id) values (v_user, p_item) on conflict (user_id, item_id) do update set notified_at = null;
  else
    delete from public.stock_subscription where user_id = v_user and item_id = p_item;
  end if;
  return p_on;
end $$;

-- Доска снабжения: остатки, ожидаемые поступления, сколько партнёров ждут, сколько заказано, но не подтверждено
create function public.stock_board() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('catalog.manage');
  return coalesce((select jsonb_agg(x order by x.available_qty > 0, x.waiting desc, x.sort, x.name) from (
    select i.id, i.sku, i.article_no, i.name, i.category, i.subtitle, i.unit, i.sort, i.visual, i.published_at,
      app_private.stock_total(i.id) as available_qty,
      (select count(*) from public.stock_subscription s where s.item_id = i.id) as waiting,
      (select coalesce(sum(ol.qty_ordered - ol.qty_confirmed - ol.qty_cancelled), 0) from public.order_line ol join public.sales_order o on o.id = ol.order_id
        where ol.item_id = i.id and o.status in ('submitted', 'confirmed', 'in_fulfillment')) as backlog_qty,
      coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'qty', r.qty, 'expected_on', r.expected_on, 'note', r.note) order by r.expected_on)
        from public.stock_incoming r where r.item_id = i.id and r.status = 'planned'), '[]'::jsonb) as incoming,
      (select max(r.arrived_at) from public.stock_incoming r where r.item_id = i.id and r.status = 'arrived') as last_arrival
    from public.catalog_item i where i.active) x), '[]'::jsonb);
end $$;

------------------------------------------------------------------------------
-- Каталог для точки: + ожидаемое поступление, новинка, недавний приход, подписка
------------------------------------------------------------------------------
delete from app_private.client_command where fn = 'public.catalog_for_location(uuid)'::regprocedure;
drop function public.catalog_for_location(uuid);
create function public.catalog_for_location(p_location uuid)
returns table (item_id uuid, sku text, article_no int, name text, category text, subtitle text, description text, unit text,
  pack_multiple numeric, min_qty numeric, lead_time_days int, price_minor bigint, currency text, available_qty numeric,
  stock_source text, stock_refreshed_at timestamptz, visual jsonb, image_url text,
  incoming_on date, incoming_qty numeric, is_new boolean, arrived_at timestamptz, subscribed boolean)
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
#variable_conflict use_column
declare l public.location; v_list uuid; v_cur text; v_user uuid := auth.uid();
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('catalog.read', l.partner_id, l.id);
  v_list := app_private.price_list_for(l.id, case when l.kind = 'own' then 'supply_request' else 'partner_order' end);
  select currency into v_cur from public.price_list where id = v_list;
  return query
    select i.id, i.sku, i.article_no, i.name, i.category, i.subtitle, i.description, i.unit, i.pack_multiple, i.min_qty, i.lead_time_days,
      app_private.current_price(v_list, i.id), v_cur,
      (select sum(s.available_qty) from public.stock_projection s where s.item_id = i.id),
      (select max(s.source) from public.stock_projection s where s.item_id = i.id),
      (select max(s.refreshed_at) from public.stock_projection s where s.item_id = i.id),
      i.visual, i.image_url,
      (select min(r.expected_on) from public.stock_incoming r where r.item_id = i.id and r.status = 'planned'),
      (select sum(r.qty) from public.stock_incoming r where r.item_id = i.id and r.status = 'planned'
         and r.expected_on = (select min(r2.expected_on) from public.stock_incoming r2 where r2.item_id = i.id and r2.status = 'planned')),
      coalesce(i.published_at > now() - interval '14 days', false),
      (select max(r.arrived_at) from public.stock_incoming r where r.item_id = i.id and r.status = 'arrived' and r.arrived_at > now() - interval '7 days'),
      exists (select 1 from public.stock_subscription s where s.item_id = i.id and s.user_id = v_user)
    from public.catalog_item i
    where i.active and (i.direction_id is null or i.direction_id = l.direction_id)
      and app_private.current_price(v_list, i.id) is not null
    order by i.sort, i.article_no nulls last, i.name;
end $$;

------------------------------------------------------------------------------
-- Контроль выручки для компании: заявлено vs закупленная плёнка, пропуски, правки, сверка отчётов
------------------------------------------------------------------------------
create function public.sales_control(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := date_trunc('month', coalesce(p_month, current_date))::date; v_to date;
begin
  perform app_private.require_user();
  if not app_private.is_staff() or not app_private.has_perm_anywhere('sales.read') then
    perform app_private.fail('forbidden', 'Контроль выручки доступен сотрудникам компании');
  end if;
  v_to := least((v_from + interval '1 month' - interval '1 day')::date, current_date);
  return jsonb_build_object('month', v_from, 'days_in_period', v_to - v_from + 1, 'locations', coalesce((
    select jsonb_agg(x order by x.risk desc, x.partner_name, x.location_name) from (
      select y.*,
        (case when y.film_phones_60d > 0 and y.services_est_60d < y.film_phones_60d * 0.6 then 2 else 0 end
         + case when y.missing_days > 2 then 1 else 0 end
         + case when y.reductions > 0 then 2 else 0 end
         + case when y.report_diff_minor < 0 then 3 else 0 end
         + case when y.card_share is not null and y.card_share < 0.35 then 1 else 0 end) as risk
      from (
        select l.id as location_id, l.name as location_name, l.kind, l.currency, p.id as partner_id, coalesce(p.name, 'Собственная точка') as partner_name,
          coalesce(m.revenue, 0) as revenue_minor, coalesce(m.services, 0) as services, coalesce(m.days, 0) as days_with_data,
          (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)), v_to, interval '1 day') g
             where not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = g::date))::int as missing_days,
          case when coalesce(m.services, 0) > 0 then (m.revenue / m.services)::bigint end as avg_check_minor,
          case when coalesce(m.revenue, 0) > 0 and m.card_known > 0 then round(m.card::numeric / m.card_known, 2) end as card_share,
          coalesce((select sum(ol.qty_ordered * i.phones_per_unit) from public.order_line ol join public.sales_order o on o.id = ol.order_id
             join public.catalog_item i on i.id = ol.item_id
             where o.location_id = l.id and o.status not in ('draft', 'cancelled') and i.phones_per_unit is not null
               and coalesce(o.submitted_at, o.created_at) >= v_to - 60), 0)::int as film_phones_60d,
          coalesce((select sum(s.services_count) from public.daily_sale s where s.location_id = l.id and s.day > v_to - 60 and s.day <= v_to), 0)::int as services_60d,
          -- Оценка оклеек за те же 60 дней по среднему за день со сменами (смены могли вестись меньше 60 дней)
          coalesce((select round(sum(s.services_count) * 60.0 / greatest(count(distinct s.day), 1)) from public.daily_sale s
             where s.location_id = l.id and s.day > v_to - 60 and s.day <= v_to), 0)::int as services_est_60d,
          (select count(*) from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to and s.reduced_by_manager)::int as reductions,
          (select count(*) from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to and s.source = 'manager')::int as manager_entries,
          coalesce((select (d->>'reported_minor')::bigint - (d->>'daily_minor')::bigint from public.report_sales_check c
             cross join lateral jsonb_array_elements(c.detail) d where c.partner_id = l.partner_id and (d->>'location_id')::uuid = l.id
             order by c.period desc limit 1), 0) as report_diff_minor,
          (select c.period from public.report_sales_check c cross join lateral jsonb_array_elements(c.detail) d
             where c.partner_id = l.partner_id and (d->>'location_id')::uuid = l.id order by c.period desc limit 1) as report_period
        from public.location l left join public.partner p on p.id = l.partner_id
        left join lateral (select sum(s.revenue_minor)::bigint as revenue, sum(s.services_count)::bigint as services, count(distinct s.day) as days,
            sum(s.card_minor) filter (where s.card_minor is not null) as card, sum(s.revenue_minor) filter (where s.card_minor is not null) as card_known
          from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to) m on true
        where l.status = 'active' and app_private.has_perm('sales.read', l.partner_id, l.id)
      ) y) x), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------
-- RLS и реестр
------------------------------------------------------------------------------
alter table public.stock_incoming enable row level security;
alter table public.stock_subscription enable row level security;
create policy read_all on public.stock_incoming for select to authenticated using (app_private.has_perm_anywhere('catalog.read'));
create policy read_own on public.stock_subscription for select to authenticated using (user_id = auth.uid() or app_private.has_perm_anywhere('catalog.manage'));

insert into app_private.client_table(tbl) values ('public.stock_incoming'), ('public.stock_subscription');
insert into app_private.client_command(fn) values
  ('public.catalog_for_location(uuid)'), ('public.stock_incoming_plan(uuid, numeric, date, text)'), ('public.stock_incoming_arrive(uuid, numeric)'),
  ('public.stock_incoming_cancel(uuid, text)'), ('public.catalog_item_announce(uuid, text)'), ('public.stock_subscribe(uuid, boolean)'),
  ('public.stock_board()'), ('public.sales_control(date)');
select app_private.apply_grants();
