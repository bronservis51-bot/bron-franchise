-- 0007 Procurement: каталог, прайс-листы, корзина, заказы, строки, отгрузки, приёмка (BUY-01…08).
-- Остатки и фактические отгрузки — проекция внешнего склада («МойСклад»); PWA не ведёт складской учёт (BUY-10).

create function app_private.has_perm_partner_any(p_perm text, p_partner uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm(p_perm, p_partner, null)
      or exists (select 1 from public.location l where l.partner_id = p_partner and app_private.has_perm(p_perm, p_partner, l.id))
$$;

create table public.catalog_item (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  category text not null,
  description text,
  unit text not null check (unit in ('roll', 'sheet', 'meter', 'piece', 'cut', 'pack')),
  pack_multiple numeric(12, 3) not null default 1 check (pack_multiple > 0),
  min_qty numeric(12, 3) not null default 1 check (min_qty > 0),
  lead_time_days int,
  direction_id uuid references public.direction(id),
  active boolean not null default true,
  source text not null default 'demo' check (source in ('demo', 'moysklad', 'manual')),
  updated_at timestamptz not null default now()
);

create table public.price_list (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  currency text not null references public.currency(code)
);

create table public.price_list_item (
  price_list_id uuid not null references public.price_list(id),
  item_id uuid not null references public.catalog_item(id),
  price_minor bigint not null check (price_minor >= 0),
  valid_from date not null,
  primary key (price_list_id, item_id, valid_from)
);

create table public.partner_price_list (
  partner_id uuid not null references public.partner(id),
  price_list_id uuid not null references public.price_list(id),
  valid_from date not null,
  primary key (partner_id, valid_from)
);

create table public.stock_projection (
  item_id uuid not null references public.catalog_item(id),
  warehouse text not null,
  available_qty numeric(12, 3) not null,
  source text not null default 'demo',
  refreshed_at timestamptz not null default now(),
  primary key (item_id, warehouse)
);

create table public.order_kind_policy (
  kind text primary key check (kind in ('partner_order', 'supply_request')),
  title text not null,
  approval_threshold_minor bigint, -- null = согласование не требуется
  threshold_currency text references public.currency(code),
  payment_policy text not null check (payment_policy in ('none', 'prepay')),
  default_price_list_id uuid references public.price_list(id),
  is_test boolean not null default false
);

create table public.sales_order (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  kind text not null references public.order_kind_policy(kind),
  partner_id uuid references public.partner(id),
  location_id uuid not null references public.location(id),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'confirmed', 'in_fulfillment',
    'partially_shipped', 'shipped', 'delivered', 'completed', 'cancelled')),
  approval_status text not null default 'not_required' check (approval_status in ('not_required', 'pending', 'approved', 'rejected')),
  payment_status text not null default 'not_required' check (payment_status in ('not_required', 'required', 'reported', 'confirmed')),
  transfer_status text not null default 'not_sent' check (transfer_status in ('not_sent', 'pending', 'sent', 'failed', 'needs_reconciliation')),
  currency text not null references public.currency(code),
  price_list_id uuid references public.price_list(id),
  total_minor bigint not null default 0,
  delivery_address text,
  contact text,
  comment text,
  submit_key text,
  repeated_from uuid references public.sales_order(id),
  submitted_at timestamptz,
  created_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1
);
create index on public.sales_order (location_id, status);
create index on public.sales_order (created_by) where status = 'draft';

create table public.order_line (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_order(id),
  item_id uuid not null references public.catalog_item(id),
  sku text not null,
  name text not null,
  unit text not null,
  price_minor bigint not null default 0,
  qty_ordered numeric(12, 3) not null check (qty_ordered > 0),
  qty_confirmed numeric(12, 3) not null default 0,
  qty_shipped numeric(12, 3) not null default 0,
  qty_received numeric(12, 3) not null default 0,
  qty_cancelled numeric(12, 3) not null default 0,
  line_total_minor bigint not null default 0,
  unique (order_id, item_id),
  check (qty_confirmed >= 0 and qty_shipped >= 0 and qty_received >= 0 and qty_cancelled >= 0),
  check (qty_confirmed + qty_cancelled <= qty_ordered),
  check (qty_shipped <= qty_confirmed),
  check (qty_received <= qty_shipped)
);

create table public.order_event (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.sales_order(id),
  actor_id uuid,
  action text not null,
  detail jsonb,
  comment text,
  at timestamptz not null default now()
);

create table public.shipment (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_order(id),
  external_ref text not null,
  carrier text,
  tracking text,
  eta_from date,
  eta_to date,
  promised_on date, -- подтверждённое обещание хранится отдельно от прогноза (BUY-08)
  status text not null default 'in_transit' check (status in ('in_transit', 'delayed', 'delivered', 'lost')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, external_ref)
);

create table public.shipment_line (
  shipment_id uuid not null references public.shipment(id),
  line_id uuid not null references public.order_line(id),
  qty numeric(12, 3) not null check (qty > 0),
  primary key (shipment_id, line_id)
);

create function app_private.order_log(p_order uuid, p_action text, p_detail jsonb, p_comment text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.order_event(order_id, actor_id, action, detail, comment) values (p_order, auth.uid(), p_action, p_detail, p_comment)
$$;

create function app_private.can_read_order(o public.sales_order) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select o.created_by = auth.uid() or (o.status <> 'draft' and app_private.has_perm('order.read', o.partner_id, o.location_id))
$$;

create function app_private.can_read_price_list(p_list uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select (app_private.is_staff() and app_private.has_perm_anywhere('catalog.read'))
    or exists (select 1 from public.partner_price_list ppl where ppl.price_list_id = p_list
               and app_private.has_perm_partner_any('catalog.read', ppl.partner_id))
$$;

-- Действующий прайс-лист для точки: партнёрский или по виду заказа.
create function app_private.price_list_for(p_location uuid, p_kind text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select ppl.price_list_id from public.partner_price_list ppl join public.location l on l.partner_id = ppl.partner_id
     where l.id = p_location and ppl.valid_from <= current_date order by ppl.valid_from desc limit 1),
    (select default_price_list_id from public.order_kind_policy where kind = p_kind))
$$;

create function app_private.current_price(p_list uuid, p_item uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select price_minor from public.price_list_item where price_list_id = p_list and item_id = p_item and valid_from <= current_date
  order by valid_from desc limit 1
$$;

-- Каталог для точки с текущей ценой и проекцией остатка.
create function public.catalog_for_location(p_location uuid)
returns table (item_id uuid, sku text, name text, category text, description text, unit text, pack_multiple numeric, min_qty numeric,
  lead_time_days int, price_minor bigint, currency text, available_qty numeric, stock_source text, stock_refreshed_at timestamptz)
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
#variable_conflict use_column
declare l public.location; v_list uuid; v_cur text;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('catalog.read', l.partner_id, l.id);
  v_list := app_private.price_list_for(l.id, case when l.kind = 'own' then 'supply_request' else 'partner_order' end);
  select currency into v_cur from public.price_list where id = v_list;
  return query
    select i.id, i.sku, i.name, i.category, i.description, i.unit, i.pack_multiple, i.min_qty, i.lead_time_days,
      app_private.current_price(v_list, i.id), v_cur,
      (select sum(s.available_qty) from public.stock_projection s where s.item_id = i.id),
      (select max(s.source) from public.stock_projection s where s.item_id = i.id),
      (select max(s.refreshed_at) from public.stock_projection s where s.item_id = i.id)
    from public.catalog_item i
    where i.active and (i.direction_id is null or i.direction_id = l.direction_id)
      and app_private.current_price(v_list, i.id) is not null
    order by i.category, i.name;
end $$;

------------------------------------------------------------------------------
-- Корзина (черновик заказа хранится на сервере; BUY-02)
------------------------------------------------------------------------------
create function public.cart_open(p_location uuid) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; o public.sales_order; v_kind text; v_list uuid;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('order.create', l.partner_id, l.id);
  select * into o from public.sales_order where created_by = v_user and location_id = p_location and status = 'draft'
    order by created_at desc limit 1;
  if found then return o; end if;
  v_kind := case when l.kind = 'own' then 'supply_request' else 'partner_order' end;
  v_list := app_private.price_list_for(l.id, v_kind);
  if v_list is null then perform app_private.fail('validation', 'Для точки не назначен прайс-лист'); end if;
  insert into public.sales_order(kind, partner_id, location_id, currency, price_list_id, delivery_address, created_by)
  values (v_kind, l.partner_id, l.id, (select currency from public.price_list where id = v_list), v_list,
          concat_ws(', ', l.city, l.address), v_user)
  returning * into o;
  return o;
end $$;

create function app_private.draft_load(p_order uuid) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order;
begin
  select * into o from public.sales_order where id = p_order for update;
  if not found or o.created_by <> auth.uid() then perform app_private.fail('not-found', 'Корзина не найдена'); end if;
  if o.status <> 'draft' then perform app_private.fail('transition-not-allowed', 'Заказ уже отправлен; изменения — через редакцию'); end if;
  perform app_private.require_perm('order.create', o.partner_id, o.location_id);
  return o;
end $$;

create function public.cart_set_line(p_order uuid, p_item uuid, p_qty numeric) returns public.order_line
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order; i public.catalog_item; ln public.order_line; v_price bigint;
begin
  perform app_private.require_user();
  o := app_private.draft_load(p_order);
  select * into i from public.catalog_item where id = p_item and active;
  if not found then perform app_private.fail('not-found', 'Товар не найден'); end if;
  if p_qty is null or p_qty <= 0 then
    delete from public.order_line where order_id = p_order and item_id = p_item;
    update public.sales_order set updated_at = now(), revision = revision + 1 where id = p_order;
    return null;
  end if;
  v_price := app_private.current_price(o.price_list_id, p_item);
  if v_price is null then perform app_private.fail('validation', 'Товар недоступен в вашем прайс-листе', 'item'); end if;
  insert into public.order_line(order_id, item_id, sku, name, unit, price_minor, qty_ordered, line_total_minor)
  values (p_order, p_item, i.sku, i.name, i.unit, v_price, p_qty, round(v_price * p_qty)::bigint)
  on conflict (order_id, item_id) do update set qty_ordered = excluded.qty_ordered, price_minor = excluded.price_minor,
    line_total_minor = excluded.line_total_minor
  returning * into ln;
  update public.sales_order set total_minor = (select coalesce(sum(line_total_minor), 0) from public.order_line where order_id = p_order),
    updated_at = now(), revision = revision + 1 where id = p_order;
  return ln;
end $$;

create function public.cart_update(p_order uuid, p_address text, p_contact text, p_comment text) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order;
begin
  perform app_private.require_user();
  o := app_private.draft_load(p_order);
  update public.sales_order set delivery_address = p_address, contact = p_contact, comment = left(p_comment, 2000),
    updated_at = now(), revision = revision + 1 where id = p_order returning * into o;
  return o;
end $$;

-- Отпуск заказа на склад: только когда согласование и оплата не мешают. Создаёт команду outbox.
create function app_private.order_release(p_order uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order;
begin
  select * into o from public.sales_order where id = p_order for update;
  if o.approval_status in ('pending', 'rejected') or o.payment_status in ('required', 'reported') or o.transfer_status <> 'not_sent' then
    return;
  end if;
  update public.sales_order set transfer_status = 'pending', updated_at = now(), revision = revision + 1 where id = p_order;
  perform app_private.enqueue('warehouse.create_order', 'sales_order', o.id, o.partner_id,
    jsonb_build_object('order_id', o.id, 'number', o.number), 'warehouse.create_order:' || o.id);
  perform app_private.order_log(p_order, 'queued_for_warehouse', null, 'Заказ ожидает передачи на склад');
end $$;

create function public.order_submit(p_order uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_prev jsonb; o public.sales_order; pol public.order_kind_policy;
  ln record; v_errors jsonb := '[]'::jsonb; v_price bigint; v_total bigint := 0; v_result jsonb;
begin
  v_prev := app_private.idem_begin('order_submit', p_key, jsonb_build_object('order', p_order));
  if v_prev is not null then return v_prev; end if; -- двойное нажатие / повтор запроса (BUY-03, AT-05)
  o := app_private.draft_load(p_order);
  select * into pol from public.order_kind_policy where kind = o.kind;
  if not exists (select 1 from public.order_line where order_id = p_order) then
    perform app_private.fail('validation', 'Корзина пуста');
  end if;
  -- Сервер повторно проверяет цены, единицы, кратность и минимум; клиентские значения не используются.
  for ln in select l.*, i.active, i.unit as item_unit, i.pack_multiple, i.min_qty from public.order_line l
            join public.catalog_item i on i.id = l.item_id where l.order_id = p_order loop
    v_price := app_private.current_price(o.price_list_id, ln.item_id);
    if not ln.active or v_price is null then
      v_errors := v_errors || jsonb_build_object('sku', ln.sku, 'error', 'Товар больше недоступен');
    elsif ln.unit <> ln.item_unit then
      v_errors := v_errors || jsonb_build_object('sku', ln.sku, 'error', 'Единица измерения изменилась');
    elsif ln.qty_ordered < ln.min_qty then
      v_errors := v_errors || jsonb_build_object('sku', ln.sku, 'error', 'Меньше минимального количества ' || ln.min_qty);
    elsif mod(ln.qty_ordered, ln.pack_multiple) <> 0 then
      v_errors := v_errors || jsonb_build_object('sku', ln.sku, 'error', 'Количество должно быть кратно ' || ln.pack_multiple);
    else
      update public.order_line set price_minor = v_price, line_total_minor = round(v_price * ln.qty_ordered)::bigint where id = ln.id;
      v_total := v_total + round(v_price * ln.qty_ordered)::bigint;
    end if;
  end loop;
  if jsonb_array_length(v_errors) > 0 then
    -- исключение откатывает и запись command_log: ключ можно использовать снова после исправления
    perform app_private.fail('validation', 'Проверьте позиции корзины', v_errors::text);
  end if;

  update public.sales_order set number = app_private.next_number('ЗК'), status = 'submitted', submitted_at = now(),
    submit_key = p_key, total_minor = v_total,
    approval_status = case when pol.approval_threshold_minor is not null and v_total > pol.approval_threshold_minor then 'pending' else 'not_required' end,
    payment_status = case when pol.payment_policy = 'prepay' then 'required' else 'not_required' end,
    updated_at = now(), revision = revision + 1
  where id = p_order returning * into o;
  perform app_private.order_log(p_order, 'submitted', jsonb_build_object('total_minor', v_total, 'currency', o.currency), null);
  perform app_private.audit('order.submit', 'sales_order', o.id, o.partner_id, jsonb_build_object('total_minor', v_total, 'currency', o.currency));

  if o.approval_status = 'pending' then
    perform app_private.notify_queue('procurement', o.partner_id, o.location_id, 'order.approval', 'Согласуйте заявку ' || o.number,
      null, 'sales_order', o.id, '/orders/' || o.id, 'order.approval:' || o.id);
  end if;
  if o.payment_status = 'required' then
    perform app_private.notify_queue('finance', o.partner_id, o.location_id, 'order.payment', 'Ожидается оплата заказа ' || o.number,
      null, 'sales_order', o.id, '/orders/' || o.id, 'order.payment:' || o.id);
  end if;
  perform app_private.order_release(p_order);
  select * into o from public.sales_order where id = p_order;
  v_result := jsonb_build_object('order_id', o.id, 'number', o.number, 'status', o.status, 'total_minor', o.total_minor,
    'currency', o.currency, 'approval_status', o.approval_status, 'payment_status', o.payment_status, 'transfer_status', o.transfer_status);
  return app_private.idem_finish('order_submit', p_key, v_result);
end $$;

create function app_private.order_load(p_order uuid) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order;
begin
  select * into o from public.sales_order where id = p_order for update;
  if not found or not app_private.can_read_order(o) then perform app_private.fail('not-found', 'Заказ не найден'); end if;
  return o;
end $$;

create function public.order_approve(p_order uuid, p_comment text default null) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); o public.sales_order;
begin
  o := app_private.order_load(p_order);
  perform app_private.require_perm('order.approve', o.partner_id, o.location_id);
  if o.approval_status <> 'pending' then perform app_private.fail('transition-not-allowed', 'Заказ не ожидает согласования'); end if;
  if o.created_by = v_user then perform app_private.fail('forbidden', 'Нельзя согласовать собственную заявку'); end if;
  update public.sales_order set approval_status = 'approved', updated_at = now(), revision = revision + 1 where id = p_order;
  perform app_private.order_log(p_order, 'approved', null, p_comment);
  perform app_private.audit('order.approve', 'sales_order', p_order, o.partner_id, null, p_comment);
  perform app_private.order_release(p_order);
  perform app_private.notify(o.created_by, 'order.approved', 'Заявка согласована: ' || o.number, p_comment, 'sales_order', o.id,
    '/orders/' || o.id, 'order.approved:' || o.id);
  select * into o from public.sales_order where id = p_order;
  return o;
end $$;

create function public.order_reject(p_order uuid, p_reason text) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order;
begin
  perform app_private.require_user();
  o := app_private.order_load(p_order);
  perform app_private.require_perm('order.approve', o.partner_id, o.location_id);
  if o.approval_status <> 'pending' then perform app_private.fail('transition-not-allowed', 'Заказ не ожидает согласования'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  update public.sales_order set approval_status = 'rejected', status = 'cancelled', updated_at = now(), revision = revision + 1
  where id = p_order returning * into o;
  perform app_private.order_log(p_order, 'rejected', null, p_reason);
  perform app_private.notify(o.created_by, 'order.rejected', 'Заявка отклонена: ' || o.number, p_reason, 'sales_order', o.id,
    '/orders/' || o.id, 'order.rejected:' || o.id);
  return o;
end $$;

-- Подтверждение оплаты заказа финансами по доверенному источнику (не по скриншоту партнёра).
create function public.order_payment_confirm(p_order uuid, p_reference text) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); o public.sales_order;
begin
  o := app_private.order_load(p_order);
  perform app_private.require_perm('payment.confirm', o.partner_id, o.location_id);
  if o.payment_status not in ('required', 'reported') then perform app_private.fail('transition-not-allowed', 'Оплата не ожидается'); end if;
  if coalesce(trim(p_reference), '') = '' then perform app_private.fail('validation', 'Укажите документ зачисления', 'reference'); end if;
  if o.created_by = v_user then perform app_private.fail('forbidden', 'Нельзя подтвердить оплату собственного заказа'); end if;
  update public.sales_order set payment_status = 'confirmed', updated_at = now(), revision = revision + 1 where id = p_order;
  perform app_private.order_log(p_order, 'payment_confirmed', jsonb_build_object('reference', p_reference), null);
  perform app_private.audit('order.payment_confirm', 'sales_order', p_order, o.partner_id, jsonb_build_object('reference', p_reference));
  perform app_private.order_release(p_order);
  select * into o from public.sales_order where id = p_order;
  return o;
end $$;

create function public.order_cancel(p_order uuid, p_reason text) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); o public.sales_order;
begin
  o := app_private.order_load(p_order);
  if o.status not in ('submitted', 'confirmed') then perform app_private.fail('transition-not-allowed', 'Заказ нельзя отменить на этом этапе', o.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  if o.transfer_status in ('sent', 'needs_reconciliation') or o.status = 'confirmed' then
    perform app_private.require_perm('order.manage', o.partner_id, o.location_id);
    perform app_private.enqueue('warehouse.cancel_order', 'sales_order', o.id, o.partner_id, jsonb_build_object('order_id', o.id),
      'warehouse.cancel_order:' || o.id);
  elsif o.created_by <> v_user then
    perform app_private.require_perm('order.manage', o.partner_id, o.location_id);
  end if;
  -- ещё не переданная команда создания больше не нужна
  update public.outbox set status = 'resolved_manually', last_error = 'Заказ отменён', updated_at = now()
  where dedupe_key = 'warehouse.create_order:' || o.id and status in ('pending', 'failed');
  update public.sales_order set status = 'cancelled', updated_at = now(), revision = revision + 1 where id = p_order returning * into o;
  update public.order_line set qty_cancelled = qty_ordered - qty_shipped, qty_confirmed = least(qty_confirmed, qty_shipped) where order_id = p_order;
  perform app_private.order_log(p_order, 'cancelled', null, p_reason);
  perform app_private.audit('order.cancel', 'sales_order', p_order, o.partner_id, null, p_reason);
  return o;
end $$;

-- Повтор заказа: новая корзина с текущими ценами; исходный заказ не меняется (BUY-02).
create function public.order_repeat(p_order uuid) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); src public.sales_order; o public.sales_order; ln public.order_line;
begin
  src := app_private.order_load(p_order);
  o := public.cart_open(src.location_id);
  for ln in select * from public.order_line where order_id = p_order loop
    begin
      perform public.cart_set_line(o.id, ln.item_id, ln.qty_ordered);
    exception when others then null; -- позиция больше недоступна — пропускаем
    end;
  end loop;
  update public.sales_order set repeated_from = p_order where id = o.id returning * into o;
  return o;
end $$;

-- Пересчёт основного статуса по строкам и отгрузкам (BUY-07, AT-06).
create function app_private.order_recompute(p_order uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order; s record; v_new text;
begin
  select * into o from public.sales_order where id = p_order for update;
  if o.status in ('draft', 'cancelled') then return; end if;
  select sum(qty_ordered - qty_cancelled) as open_qty, sum(qty_confirmed) as conf, sum(qty_shipped) as shipped,
         sum(qty_received) as received, bool_and(qty_cancelled = qty_ordered) as all_cancelled
    into s from public.order_line where order_id = p_order;
  v_new := case
    when s.all_cancelled then 'cancelled'
    when s.received >= s.open_qty and s.open_qty > 0 then 'completed'
    when s.shipped >= s.open_qty and s.open_qty > 0 and not exists (
      select 1 from public.shipment where order_id = p_order and status <> 'delivered') then 'delivered'
    when s.shipped >= s.open_qty and s.open_qty > 0 then 'shipped'
    when s.shipped > 0 then 'partially_shipped'
    when s.conf > 0 then 'confirmed'
    else o.status end;
  if v_new <> o.status then
    update public.sales_order set status = v_new, updated_at = now(), revision = revision + 1 where id = p_order;
    perform app_private.order_log(p_order, 'status', jsonb_build_object('from', o.status, 'to', v_new), null);
    perform app_private.notify(o.created_by, 'order.status', 'Заказ ' || o.number || ': ' || v_new, null, 'sales_order', o.id,
      '/orders/' || o.id, 'order.status:' || o.id || ':' || v_new);
  end if;
end $$;

-- Приёмка получателем: фактически полученные количества (BUY-07).
create function public.order_receive(p_order uuid, p_lines jsonb, p_comment text default null) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order; r jsonb; ln public.order_line; v_qty numeric; v_short jsonb := '[]'::jsonb;
begin
  perform app_private.require_user();
  o := app_private.order_load(p_order);
  perform app_private.require_perm('order.create', o.partner_id, o.location_id);
  if o.status not in ('partially_shipped', 'shipped', 'delivered') then
    perform app_private.fail('transition-not-allowed', 'Нечего принимать: отгрузок нет', o.status);
  end if;
  for r in select * from jsonb_array_elements(p_lines) loop
    select * into ln from public.order_line where id = (r ->> 'line_id')::uuid and order_id = p_order for update;
    if not found then perform app_private.fail('validation', 'Строка не принадлежит заказу', r ->> 'line_id'); end if;
    v_qty := (r ->> 'qty_received')::numeric;
    if v_qty is null or v_qty < ln.qty_received or v_qty > ln.qty_shipped then
      perform app_private.fail('validation', 'Получено больше отгруженного или меньше уже принятого', ln.sku);
    end if;
    update public.order_line set qty_received = v_qty where id = ln.id;
    if v_qty < ln.qty_shipped and coalesce((r ->> 'final')::boolean, false) then
      v_short := v_short || jsonb_build_object('sku', ln.sku, 'shipped', ln.qty_shipped, 'received', v_qty);
    end if;
  end loop;
  perform app_private.order_log(p_order, 'received', p_lines, p_comment);
  if jsonb_array_length(v_short) > 0 then
    perform app_private.task_create('order_discrepancy', 'Расхождение при приёмке ' || o.number, v_short::text || coalesce(' ' || p_comment, ''),
      'procurement', o.partner_id, o.location_id, 'sales_order', o.id, now() + interval '2 days', 'high', true,
      'order_discrepancy:' || o.id || ':' || md5(v_short::text));
  end if;
  perform app_private.order_recompute(p_order);
  select * into o from public.sales_order where id = p_order;
  return o;
end $$;

-- Применение событий склада (вызывается обработчиком inbox; идемпотентность — уровнем inbox и external_ref).
create function app_private.order_apply_warehouse_event(p_type text, p jsonb) returns text
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order; r jsonb; v_ship uuid; ln public.order_line; v_qty numeric;
begin
  select * into o from public.sales_order where id = (p ->> 'order_id')::uuid for update;
  if not found then return 'ignored: заказ не найден'; end if;
  if p_type = 'order.accepted' then
    for r in select * from jsonb_array_elements(p -> 'lines') loop
      update public.order_line set qty_confirmed = least((r ->> 'qty_confirmed')::numeric, qty_ordered - qty_cancelled)
      where id = (r ->> 'line_id')::uuid and order_id = o.id;
      if (r ->> 'qty_confirmed')::numeric < (select qty_ordered from public.order_line where id = (r ->> 'line_id')::uuid) then
        -- дефицит: недоподтверждённое количество отменяется складом (BUY-07)
        update public.order_line set qty_cancelled = qty_ordered - qty_confirmed where id = (r ->> 'line_id')::uuid;
      end if;
    end loop;
    perform app_private.order_log(o.id, 'warehouse_accepted', p, 'Склад подтвердил количества');
  elsif p_type = 'shipment.created' then
    insert into public.shipment(order_id, external_ref, carrier, tracking, eta_from, eta_to)
    values (o.id, p ->> 'shipment_ref', p ->> 'carrier', p ->> 'tracking', (p ->> 'eta_from')::date, (p ->> 'eta_to')::date)
    on conflict (order_id, external_ref) do nothing returning id into v_ship;
    if v_ship is null then return 'duplicate shipment'; end if;
    for r in select * from jsonb_array_elements(p -> 'lines') loop
      select * into ln from public.order_line where id = (r ->> 'line_id')::uuid and order_id = o.id for update;
      v_qty := least((r ->> 'qty')::numeric, ln.qty_confirmed - ln.qty_shipped);
      if v_qty > 0 then
        insert into public.shipment_line(shipment_id, line_id, qty) values (v_ship, ln.id, v_qty);
        update public.order_line set qty_shipped = qty_shipped + v_qty where id = ln.id;
      end if;
    end loop;
    perform app_private.order_log(o.id, 'shipment', p, 'Отгрузка ' || (p ->> 'shipment_ref'));
  elsif p_type = 'shipment.delayed' then
    update public.shipment set status = 'delayed', eta_from = (p ->> 'eta_from')::date, eta_to = (p ->> 'eta_to')::date, updated_at = now()
    where order_id = o.id and external_ref = p ->> 'shipment_ref';
    perform app_private.order_log(o.id, 'shipment_delayed', p, coalesce(p ->> 'reason', 'Изменён прогноз доставки'));
    perform app_private.notify(o.created_by, 'order.delayed', 'Доставка заказа ' || o.number || ' переносится',
      coalesce(p ->> 'reason', 'Новый прогноз: ' || (p ->> 'eta_from') || '–' || (p ->> 'eta_to')), 'sales_order', o.id,
      '/orders/' || o.id, 'order.delayed:' || o.id || ':' || (p ->> 'shipment_ref') || ':' || (p ->> 'eta_to'), true);
  elsif p_type = 'shipment.delivered' then
    update public.shipment set status = 'delivered', updated_at = now() where order_id = o.id and external_ref = p ->> 'shipment_ref';
    perform app_private.order_log(o.id, 'shipment_delivered', p, 'Посылка доставлена');
  else
    return 'ignored: неизвестный тип';
  end if;
  perform app_private.order_recompute(o.id);
  return 'processed';
end $$;

-- Контракт для модуля Integrations: результат передачи заказа на склад (ARCH-02).
create function app_private.order_transfer_result(p_order uuid, p_status text, p_result jsonb) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  if p_status = 'done' then
    update public.sales_order set transfer_status = 'sent', updated_at = now(), revision = revision + 1 where id = p_order;
    perform app_private.order_log(p_order, 'sent_to_warehouse', p_result,
      case when (p_result ->> 'reconciled')::boolean then 'Документ найден при сверке — повтор не создавался' else 'Передан на склад' end);
  elsif p_status = 'unknown' then
    update public.sales_order set transfer_status = 'needs_reconciliation', updated_at = now(), revision = revision + 1 where id = p_order;
    perform app_private.order_log(p_order, 'transfer_unknown', p_result, 'Результат передачи неизвестен — будет сверка');
  else
    update public.sales_order set transfer_status = 'failed', updated_at = now(), revision = revision + 1 where id = p_order;
    perform app_private.order_log(p_order, 'transfer_failed', p_result, 'Склад недоступен — повтор автоматически');
  end if;
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.catalog_item enable row level security;
alter table public.price_list enable row level security;
alter table public.price_list_item enable row level security;
alter table public.partner_price_list enable row level security;
alter table public.stock_projection enable row level security;
alter table public.order_kind_policy enable row level security;
alter table public.sales_order enable row level security;
alter table public.order_line enable row level security;
alter table public.order_event enable row level security;
alter table public.shipment enable row level security;
alter table public.shipment_line enable row level security;

create policy read_catalog on public.catalog_item for select to authenticated using (app_private.has_perm_anywhere('catalog.read'));
create policy read_catalog on public.stock_projection for select to authenticated using (app_private.has_perm_anywhere('catalog.read'));
create policy read_price on public.price_list for select to authenticated using (app_private.can_read_price_list(id));
create policy read_price on public.price_list_item for select to authenticated using (app_private.can_read_price_list(price_list_id));
create policy read_price on public.partner_price_list for select to authenticated
  using (app_private.is_staff() or app_private.has_perm_partner_any('catalog.read', partner_id));
create policy read_all on public.order_kind_policy for select to authenticated using (true);
create policy read_order on public.sales_order for select to authenticated using (app_private.can_read_order(sales_order));
create policy read_order on public.order_line for select to authenticated
  using (exists (select 1 from public.sales_order o where o.id = order_id and app_private.can_read_order(o)));
create policy read_order on public.order_event for select to authenticated
  using (exists (select 1 from public.sales_order o where o.id = order_id and app_private.can_read_order(o)));
create policy read_order on public.shipment for select to authenticated
  using (exists (select 1 from public.sales_order o where o.id = order_id and app_private.can_read_order(o)));
create policy read_order on public.shipment_line for select to authenticated
  using (exists (select 1 from public.shipment s join public.sales_order o on o.id = s.order_id
                 where s.id = shipment_id and app_private.can_read_order(o)));

insert into app_private.client_table(tbl) values ('public.catalog_item'), ('public.price_list'), ('public.price_list_item'),
  ('public.partner_price_list'), ('public.stock_projection'), ('public.order_kind_policy'), ('public.sales_order'),
  ('public.order_line'), ('public.order_event'), ('public.shipment'), ('public.shipment_line');
insert into app_private.client_command(fn) values
  ('public.catalog_for_location(uuid)'), ('public.cart_open(uuid)'), ('public.cart_set_line(uuid, uuid, numeric)'),
  ('public.cart_update(uuid, text, text, text)'), ('public.order_submit(uuid, text)'), ('public.order_approve(uuid, text)'),
  ('public.order_reject(uuid, text)'), ('public.order_payment_confirm(uuid, text)'), ('public.order_cancel(uuid, text)'),
  ('public.order_repeat(uuid)'), ('public.order_receive(uuid, jsonb, text)');
insert into app_private.policy_helper(fn) values ('app_private.has_perm_partner_any(text, uuid)'),
  ('app_private.can_read_order(public.sales_order)'), ('app_private.can_read_price_list(uuid)');
select app_private.apply_grants();
