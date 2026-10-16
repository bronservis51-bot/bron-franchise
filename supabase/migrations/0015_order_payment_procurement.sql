-- 0015 Оплату заказа подтверждает снабжение (решение владельца 13.10.2026), а не руководитель и не финансы.
-- Оплаты роялти по-прежнему подтверждают финансы (payment.confirm).

insert into public.permission(code, description, is_financial)
values ('order.payment.confirm', 'Подтверждение оплаты заказа расходников', true);
insert into public.role_permission(role, permission) values ('procurement', 'order.payment.confirm');

create or replace function public.order_payment_confirm(p_order uuid, p_reference text) returns public.sales_order
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); o public.sales_order;
begin
  o := app_private.order_load(p_order);
  perform app_private.require_perm('order.payment.confirm', o.partner_id, o.location_id);
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

-- Уведомление «ожидается оплата заказа» — снабжению
create or replace function public.order_submit(p_order uuid, p_key text) returns jsonb
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
    perform app_private.notify_queue('procurement', o.partner_id, o.location_id, 'order.payment', 'Ожидается оплата заказа ' || o.number,
      null, 'sales_order', o.id, '/orders/' || o.id, 'order.payment:' || o.id);
  end if;
  perform app_private.order_release(p_order);
  select * into o from public.sales_order where id = p_order;
  v_result := jsonb_build_object('order_id', o.id, 'number', o.number, 'status', o.status, 'total_minor', o.total_minor,
    'currency', o.currency, 'approval_status', o.approval_status, 'payment_status', o.payment_status, 'transfer_status', o.transfer_status);
  return app_private.idem_finish('order_submit', p_key, v_result);
end $$;
