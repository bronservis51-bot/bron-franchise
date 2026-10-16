-- 0010 Integrations: обработка outbox/inbox, demo-адаптеры, действия оператора, фоновые задания (ARCH-04/05, INT-01…05).
-- Все адаптеры этой миграции — DEMO: они эмулируют внешнюю систему таблицей demo_external_doc и не обращаются к сети.

create table public.demo_external_doc (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  doc_type text not null,
  external_code text not null, -- наш идентификатор, переданный во внешнюю систему (externalCode)
  external_id text not null default 'DEMO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (provider, doc_type, external_code)
);

create function app_private.connection(p_provider text) returns public.integration_connection
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.integration_connection where provider = p_provider
$$;

create function app_private.map_external(p_provider text, p_entity text, p_internal uuid, p_external text) returns void
language sql security definer set search_path = public, app_private, pg_temp as $$
  insert into public.integration_mapping(connection_id, entity_type, internal_id, external_id)
  values ((app_private.connection(p_provider)).id, p_entity, p_internal, p_external)
  on conflict do nothing
$$;

------------------------------------------------------------------------------
-- Demo-адаптер склада («МойСклад»): создание и отмена заказа
------------------------------------------------------------------------------
create function app_private.adapter_warehouse(o public.outbox) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.integration_connection := app_private.connection('moysklad'); d public.demo_external_doc; v_order uuid := (o.payload ->> 'order_id')::uuid;
begin
  if c.mode = 'disabled' then return jsonb_build_object('status', 'failed', 'error', 'Подключение отключено'); end if;
  if c.mode = 'live' then return jsonb_build_object('status', 'failed', 'error', 'Реальный адаптер не подключён в прототипе'); end if;
  -- Сначала сверка: документ мог быть создан при потерянном ответе (BUY-06, AT-05)
  select * into d from public.demo_external_doc where provider = 'moysklad' and doc_type = 'customerorder' and external_code = v_order::text;
  if o.topic = 'warehouse.create_order' then
    if d.id is not null then
      return jsonb_build_object('status', 'done', 'external_id', d.external_id, 'reconciled', true);
    end if;
    if c.demo_behavior = 'fail' then
      return jsonb_build_object('status', 'failed', 'error', 'Склад недоступен (демо: HTTP 503)');
    end if;
    insert into public.demo_external_doc(provider, doc_type, external_code, payload)
    values ('moysklad', 'customerorder', v_order::text,
            (select jsonb_build_object('number', number, 'lines', (select jsonb_agg(jsonb_build_object('sku', sku, 'qty', qty_ordered)) from public.order_line where order_id = v_order))
             from public.sales_order where id = v_order))
    returning * into d;
    if c.demo_behavior = 'lost_response' then
      return jsonb_build_object('status', 'unknown', 'error', 'Ответ склада потерян (демо: тайм-аут после создания документа)');
    end if;
    return jsonb_build_object('status', 'done', 'external_id', d.external_id);
  elsif o.topic = 'warehouse.cancel_order' then
    if c.demo_behavior = 'fail' then return jsonb_build_object('status', 'failed', 'error', 'Склад недоступен (демо: HTTP 503)'); end if;
    update public.demo_external_doc set status = 'cancelled' where id = d.id;
    return jsonb_build_object('status', 'done', 'external_id', d.external_id);
  end if;
  return jsonb_build_object('status', 'failed', 'error', 'Неизвестная команда');
end $$;

-- Demo-адаптер Drive: корпоративная копия опубликованной редакции (KB-10, KB-14).
create function app_private.adapter_drive_export(o public.outbox) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.integration_connection := app_private.connection('google_drive'); v_rev uuid := (o.payload ->> 'revision_id')::uuid; d public.demo_external_doc;
begin
  if c.mode <> 'demo' then return jsonb_build_object('status', 'failed', 'error', 'Реальный адаптер не подключён в прототипе'); end if;
  select * into d from public.demo_external_doc where provider = 'google_drive' and doc_type = 'export' and external_code = v_rev::text;
  if d.id is not null then return jsonb_build_object('status', 'done', 'external_id', d.external_id, 'reconciled', true); end if;
  if c.demo_behavior = 'fail' then return jsonb_build_object('status', 'failed', 'error', 'Нет доступа к папке экспорта (демо)'); end if;
  insert into public.demo_external_doc(provider, doc_type, external_code, payload)
  values ('google_drive', 'export', v_rev::text, (select jsonb_build_object('title', title, 'rev_no', rev_no) from public.article_revision where id = v_rev))
  returning * into d;
  if c.demo_behavior = 'lost_response' then return jsonb_build_object('status', 'unknown', 'error', 'Ответ Drive потерян (демо)'); end if;
  return jsonb_build_object('status', 'done', 'external_id', d.external_id);
end $$;

-- Применение результата к бизнес-объекту (статус для пользователя без технических деталей; UX-04).
create function app_private.outbox_apply_result(o public.outbox, p_result jsonb) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_status text := p_result ->> 'status';
begin
  if o.topic = 'warehouse.create_order' then
    if v_status = 'done' then
      perform app_private.map_external('moysklad', 'sales_order', o.aggregate_id, p_result ->> 'external_id');
    end if;
    perform app_private.order_transfer_result(o.aggregate_id, v_status, p_result);
  elsif o.topic = 'drive.export_article' then
    perform app_private.article_export_result(o.aggregate_id, (o.payload ->> 'revision_id')::uuid, v_status = 'done', p_result ->> 'error');
  end if;
end $$;

create function app_private.process_outbox(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.outbox; v_res jsonb; v_done int := 0; v_failed int := 0; v_status text; v_delay interval;
begin
  for o in select * from public.outbox where status in ('pending', 'failed', 'unknown') and next_attempt_at <= now()
           order by created_at limit p_limit for update skip locked loop
    begin
      v_res := case
        when o.topic like 'warehouse.%' then app_private.adapter_warehouse(o)
        when o.topic = 'drive.export_article' then app_private.adapter_drive_export(o)
        else jsonb_build_object('status', 'failed', 'error', 'Нет адаптера для ' || o.topic) end;
    exception when others then
      v_res := jsonb_build_object('status', 'failed', 'error', sqlerrm);
    end;
    v_status := v_res ->> 'status';
    if v_status = 'done' then
      update public.outbox set status = 'done', attempts = attempts + 1, result = v_res, last_error = null, updated_at = now() where id = o.id;
      v_done := v_done + 1;
    else
      -- экспоненциальная задержка с джиттером (INT-04)
      v_delay := make_interval(secs => least(3600, (30 * power(2, o.attempts))::int) + floor(random() * 15)::int);
      update public.outbox set attempts = attempts + 1, last_error = v_res ->> 'error', result = v_res, updated_at = now(),
        status = case when o.attempts + 1 >= o.max_attempts then 'dead' when v_status = 'unknown' then 'unknown' else 'failed' end,
        next_attempt_at = now() + v_delay
      where id = o.id returning * into o;
      v_failed := v_failed + 1;
      if o.status = 'dead' then
        perform app_private.task_create('integration_dead', 'Обмен остановлен: ' || o.topic, o.last_error, 'procurement', o.partner_id, null,
          o.aggregate_type, o.aggregate_id, now() + interval '4 hours', 'critical', false, 'outbox_dead:' || o.id);
      end if;
    end if;
    perform app_private.outbox_apply_result(o, v_res);
    update public.integration_connection set
      last_success_at = case when v_status = 'done' then now() else last_success_at end,
      last_error = case when v_status = 'done' then last_error else v_res ->> 'error' end,
      status = case when v_status = 'done' then 'ok' else 'degraded' end, updated_at = now()
    where provider = case when o.topic like 'warehouse.%' then 'moysklad' when o.topic like 'drive.%' then 'google_drive' end;
  end loop;
  return jsonb_build_object('done', v_done, 'failed', v_failed);
end $$;

------------------------------------------------------------------------------
-- Inbox: приём и обработка входящих событий (INT-03)
------------------------------------------------------------------------------
create function app_private.receive_event(p_source text, p_event_id text, p_type text, p_payload jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.inbox(source, event_id, event_type, payload) values (p_source, p_event_id, p_type, p_payload)
  on conflict (source, event_id) do nothing;
  if not found then return 'duplicate'; end if; -- повтор webhook не обрабатывается повторно
  return 'received';
end $$;

create function app_private.process_inbox(p_limit int default 50) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare e public.inbox; v_res text; n int := 0; v_manager uuid;
begin
  for e in select * from public.inbox where status = 'received' order by received_at limit p_limit for update skip locked loop
    begin
      if e.source = 'moysklad' then
        v_res := app_private.order_apply_warehouse_event(e.event_type, e.payload);
      elsif e.source = 'crm' and e.event_type = 'deal.won' then
        select m into v_manager from app_private.queue_members('franchise_manager', (e.payload ->> 'partner_id')::uuid, null) m limit 1;
        perform app_private.opening_create_internal((e.payload ->> 'partner_id')::uuid, null, e.payload ->> 'location_name', e.payload ->> 'city',
          e.payload ->> 'address', e.payload ->> 'format', (e.payload ->> 'planned_open')::date, v_manager, null, null, e.payload ->> 'deal_ref');
        v_res := 'processed';
      else
        v_res := 'ignored: нет обработчика';
      end if;
      update public.inbox set status = case when v_res = 'processed' then 'processed' else 'ignored' end, processed_at = now(),
        error = case when v_res = 'processed' then null else v_res end where id = e.id;
    exception when others then
      update public.inbox set status = 'failed', processed_at = now(), error = sqlerrm || ' ' || coalesce(nullif(pg_exception_detail(), ''), '') where id = e.id;
    end;
    n := n + 1;
  end loop;
  return n;
end $$;

------------------------------------------------------------------------------
-- Запуск фоновой обработки: pg_cron или кнопка оператора (ADR-0005)
------------------------------------------------------------------------------
create function app_private.run_jobs(p_trigger text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_run uuid; v_out jsonb; v_in int; v_timers int := 0;
begin
  insert into public.sync_run(trigger, started_by) values (p_trigger, auth.uid()) returning id into v_run;
  v_out := app_private.process_outbox(100);
  v_in := app_private.process_inbox(100);
  v_timers := v_timers + app_private.support_timers() + app_private.royalty_timers() + app_private.kb_timers();
  update public.sync_run set finished_at = now(), outbox_done = (v_out ->> 'done')::int, outbox_failed = (v_out ->> 'failed')::int,
    inbox_processed = v_in, timers_fired = v_timers where id = v_run;
  return v_out || jsonb_build_object('inbox', v_in, 'timers', v_timers, 'run_id', v_run);
end $$;

create function app_private.require_operator() returns void
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('integration.operate') then perform app_private.fail('forbidden', 'Нужны права оператора обмена'); end if;
end $$;

create function public.run_integration_jobs() returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_operator();
  return app_private.run_jobs('manual');
end $$;

create function public.outbox_retry(p_outbox uuid) returns public.outbox
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.outbox;
begin
  perform app_private.require_operator();
  update public.outbox set status = case when status = 'unknown' then 'unknown' else 'pending' end, next_attempt_at = now(),
    max_attempts = greatest(max_attempts, attempts + 3), updated_at = now()
  where id = p_outbox and status in ('failed', 'dead', 'unknown') returning * into o;
  -- повтор безопасен: адаптер сначала ищет уже созданный внешний документ и только потом создаёт новый
  if o.id is null then perform app_private.fail('transition-not-allowed', 'Повтор недоступен для этой записи'); end if;
  perform app_private.audit('integration.retry', 'outbox', o.id, o.partner_id);
  return o;
end $$;

create function public.outbox_resolve_manually(p_outbox uuid, p_reason text) returns public.outbox
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.outbox;
begin
  perform app_private.require_operator();
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Опишите, как решено вручную', 'reason'); end if;
  update public.outbox set status = 'resolved_manually', last_error = p_reason, updated_at = now()
  where id = p_outbox and status in ('failed', 'dead', 'unknown') returning * into o;
  if o.id is null then perform app_private.fail('transition-not-allowed', 'Запись нельзя закрыть вручную'); end if;
  perform app_private.audit('integration.resolve_manually', 'outbox', o.id, o.partner_id, null, p_reason);
  return o;
end $$;

------------------------------------------------------------------------------
-- Управление demo-режимом и демонстрационные события (явно помечены DEMO)
------------------------------------------------------------------------------
create function public.integration_set_demo_behavior(p_provider text, p_behavior text) returns public.integration_connection
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.integration_connection;
begin
  perform app_private.require_operator();
  update public.integration_connection set demo_behavior = p_behavior, updated_at = now()
  where provider = p_provider and mode = 'demo' returning * into c;
  if c.id is null then perform app_private.fail('not-found', 'Demo-подключение не найдено'); end if;
  perform app_private.audit('integration.demo_behavior', 'integration_connection', c.id, null, jsonb_build_object('behavior', p_behavior));
  return c;
end $$;

-- Событие склада по заказу; p_event_id можно повторить, чтобы показать дедупликацию.
create function public.demo_warehouse_event(p_order uuid, p_type text, p_mode text default 'full', p_event_id text default null) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare o public.sales_order; v_payload jsonb; v_event text; v_ship text; v_state text;
begin
  perform app_private.require_operator();
  select * into o from public.sales_order where id = p_order;
  if not found then perform app_private.fail('not-found', 'Заказ не найден'); end if;
  if o.transfer_status <> 'sent' then perform app_private.fail('transition-not-allowed', 'Заказ ещё не передан на склад', o.transfer_status); end if;
  v_ship := 'SHP-' || left(replace(o.id::text, '-', ''), 6) || '-' || (select count(*) + 1 from public.shipment where order_id = o.id);
  v_payload := case p_type
    when 'order.accepted' then jsonb_build_object('order_id', o.id, 'lines', (select jsonb_agg(jsonb_build_object('line_id', id,
        'qty_confirmed', case when p_mode = 'partial' then floor(qty_ordered / 2) else qty_ordered end)) from public.order_line where order_id = o.id))
    when 'shipment.created' then jsonb_build_object('order_id', o.id, 'shipment_ref', v_ship, 'carrier', 'Демо-перевозчик',
        'tracking', 'TRK' || floor(random() * 1e8)::text, 'eta_from', current_date + 3, 'eta_to', current_date + 6,
        'lines', (select jsonb_agg(jsonb_build_object('line_id', id, 'qty',
          case when p_mode = 'partial' then greatest(floor((qty_confirmed - qty_shipped) / 2), least(1, qty_confirmed - qty_shipped)) else qty_confirmed - qty_shipped end))
          from public.order_line where order_id = o.id and qty_confirmed > qty_shipped))
    when 'shipment.delayed' then jsonb_build_object('order_id', o.id,
        'shipment_ref', (select external_ref from public.shipment where order_id = o.id order by created_at desc limit 1),
        'eta_from', current_date + 8, 'eta_to', current_date + 12, 'reason', 'Отмена рейса перевозчиком (демо)')
    when 'shipment.delivered' then jsonb_build_object('order_id', o.id,
        'shipment_ref', (select external_ref from public.shipment where order_id = o.id and status <> 'delivered' order by created_at limit 1))
    else null end;
  if v_payload is null then perform app_private.fail('validation', 'Неизвестный тип события', p_type); end if;
  v_event := coalesce(nullif(trim(p_event_id), ''), 'demo-' || replace(gen_random_uuid()::text, '-', ''));
  v_state := app_private.receive_event('moysklad', v_event, p_type, v_payload);
  perform app_private.process_inbox(10);
  return jsonb_build_object('event_id', v_event, 'inbox', v_state, 'payload', v_payload);
end $$;

create function public.demo_crm_deal_won(p_partner uuid, p_deal_ref text, p_location_name text, p_city text, p_planned_open date) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_state text; v_project uuid;
begin
  perform app_private.require_user();
  if not (app_private.has_perm_anywhere('integration.operate') or app_private.has_perm('opening.manage', p_partner)) then
    perform app_private.fail('forbidden', 'Нет прав на демонстрацию CRM');
  end if;
  v_state := app_private.receive_event('crm', 'deal-won-' || p_deal_ref, 'deal.won', jsonb_build_object('partner_id', p_partner, 'deal_ref', p_deal_ref,
    'location_name', p_location_name, 'city', p_city, 'planned_open', p_planned_open));
  perform app_private.process_inbox(10);
  select id into v_project from public.opening_project where crm_deal_ref = p_deal_ref;
  return jsonb_build_object('inbox', v_state, 'project_id', v_project,
    'error', (select error from public.inbox where source = 'crm' and event_id = 'deal-won-' || p_deal_ref and status = 'failed'));
end $$;

alter table public.demo_external_doc enable row level security;
create policy read_operator on public.demo_external_doc for select to authenticated using (app_private.has_perm_anywhere('integration.operate'));

insert into app_private.client_table(tbl) values ('public.demo_external_doc');
insert into app_private.client_command(fn) values
  ('public.run_integration_jobs()'), ('public.outbox_retry(uuid)'), ('public.outbox_resolve_manually(uuid, text)'),
  ('public.integration_set_demo_behavior(text, text)'), ('public.demo_warehouse_event(uuid, text, text, text)'),
  ('public.demo_crm_deal_won(uuid, text, text, text, date)');
select app_private.apply_grants();

-- pg_cron: каждые 5 минут, если модуль Cron доступен в проекте (A-14). Иначе — кнопка «Обработать очередь».
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      execute 'create extension if not exists pg_cron with schema pg_catalog';
      execute $q$select cron.schedule('bron-jobs', '*/5 * * * *', $c$select app_private.run_jobs('cron')$c$)$q$;
    exception when others then
      raise notice 'pg_cron не настроен: %', sqlerrm;
    end;
  else
    raise notice 'pg_cron недоступен: используйте ручной запуск обработки';
  end if;
end $$;
