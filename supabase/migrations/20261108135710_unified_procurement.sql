-- Unified procurement: approval records and read-only projections, never a second stock ledger.
create table app_private.procurement_catalog (
  singleton boolean primary key default true check(singleton), store_id uuid not null,
  rows jsonb not null check(jsonb_typeof(rows)='array'), fetched_at timestamptz not null
);
create table app_private.procurement_request (
  id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
  partner_id uuid not null references public.partner(id), created_by uuid not null references public.app_user(id),
  status text not null default 'submitted' check(status in ('submitted','offered','accepted','declined','cancelled','completed')),
  version integer not null default 1, shipment_mode text not null check(shipment_mode in ('partial','together')),
  currency text references public.currency(code), note text not null default '', offer_note text not null default '',
  items jsonb not null check(jsonb_typeof(items)='array'), counterparty_id uuid,
  snapshot_at timestamptz, offered_at timestamptz, accepted_at timestamptz, valid_until timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index procurement_request_partner_created on app_private.procurement_request(partner_id,created_at desc);
create index procurement_request_status on app_private.procurement_request(status);
create table app_private.procurement_event (
  id bigint generated always as identity primary key,
  request_id uuid not null references app_private.procurement_request(id), version integer not null,
  actor_id uuid not null references public.app_user(id), action text not null, note text not null default '',
  data jsonb not null default '{}', at timestamptz not null default now(), unique(request_id,version)
);
alter table app_private.procurement_catalog enable row level security;
alter table app_private.procurement_request enable row level security;
alter table app_private.procurement_event enable row level security;
revoke all on app_private.procurement_catalog,app_private.procurement_request,app_private.procurement_event from public,anon,authenticated;
revoke all on sequence app_private.procurement_request_number_seq,app_private.procurement_event_id_seq from public,anon,authenticated;

-- Confirmed inbound is a manager attestation, separate from an inventory projection.
-- Quantity is the unreceived remainder of the referenced МойСклад purchase order, not sellable stock.
create table app_private.procurement_incoming (
  product_id uuid not null, purchase_order_id uuid not null, quantity numeric not null check(quantity>=0 and quantity<=100000),
  eta date not null, note text not null, version integer not null default 1,
  updated_at timestamptz not null default now(), updated_by uuid not null references public.app_user(id),
  primary key(product_id,purchase_order_id)
);
alter table app_private.procurement_incoming enable row level security;
revoke all on app_private.procurement_incoming from public,anon,authenticated;

create function public.procurement_incoming_set(p_data jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid; receipt app_private.operation_receipt; pid uuid; po uuid; qty numeric; arrival date; v_note text; rev integer;
  old app_private.procurement_incoming; answer jsonb;
begin
  uid:=app_private.require_user(); perform app_private.require_perm('org.manage');
  if p_operation is null or jsonb_typeof(p_data) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_data) x where x not in ('product_id','purchase_order_id','quantity','eta','note','expected_version')) then perform app_private.fail('validation','Неверное подтверждение поставки'); end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into receipt from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if receipt.command<>'procurement_incoming_set' or receipt.payload<>p_data then perform app_private.fail('idempotency-conflict','Повтор содержит другую поставку'); end if;
    return receipt.result;
  end if;
  pid:=(p_data->>'product_id')::uuid; po:=(p_data->>'purchase_order_id')::uuid; qty:=(p_data->>'quantity')::numeric;
  arrival:=(p_data->>'eta')::date; v_note:=trim(coalesce(p_data->>'note','')); rev:=(p_data->>'expected_version')::integer;
  if pid is null or po is null or qty is null or qty<0 or qty>100000 or qty<>round(qty,3)
    or arrival is null or (qty>0 and arrival<current_date) or arrival>current_date+366 or rev is null or rev<0
    or length(v_note) not between 1 and 2000 then perform app_private.fail('validation','Укажите товар, документ МойСклад, остаток поставки, дату и основание'); end if;
  if not exists(select 1 from app_private.procurement_catalog c cross join lateral jsonb_array_elements(c.rows) i where i->>'product_id'=pid::text) then
    perform app_private.fail('validation','Товар отсутствует в каталоге'); end if;
  perform pg_advisory_xact_lock(hashtextextended(pid::text||po::text,0));
  select * into old from app_private.procurement_incoming where product_id=pid and purchase_order_id=po for update;
  if coalesce(old.version,0)<>rev then perform app_private.fail('version-conflict','Подтверждение поставки изменено. Обновите каталог'); end if;
  insert into app_private.procurement_incoming(product_id,purchase_order_id,quantity,eta,note,updated_by)
    values(pid,po,qty,arrival,v_note,uid)
  on conflict(product_id,purchase_order_id) do update set quantity=excluded.quantity,eta=excluded.eta,note=excluded.note,
    updated_by=excluded.updated_by,updated_at=now(),version=app_private.procurement_incoming.version+1;
  select to_jsonb(i)-'updated_by' into answer from app_private.procurement_incoming i where product_id=pid and purchase_order_id=po;
  perform app_private.audit('procurement.incoming','product',pid,null,jsonb_build_object('before',to_jsonb(old)-'updated_by','after',answer),v_note);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'procurement_incoming_set',p_data,answer);
  return answer;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  perform app_private.fail('validation','Проверьте идентификаторы, дату и количество поставки');
end $$;

create function app_private.procurement_partner() returns uuid
language plpgsql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into ids from app_private.active_assignments() where role='franchisee' and scope_type='partner';
  if coalesce(cardinality(ids),0)<>1 then perform app_private.fail('forbidden','Для закупки нужен однозначный доступ к партнёру'); end if;
  if not exists(select 1 from public.partner where id=ids[1] and status='active') then
    perform app_private.fail('forbidden','Партнёр неактивен');
  end if;
  return ids[1];
end $$;

-- Trusted importer only: whitelist prevents cost, price and credential fields entering the projection.
create function app_private.procurement_catalog_store(p_rows jsonb,p_store_id uuid,p_fetched_at timestamptz)
returns void language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
declare r jsonb; pid uuid; seen uuid[]:='{}'; normalized jsonb:='[]'; n numeric; k text;
begin
  if p_store_id is null or p_fetched_at is null or p_fetched_at>now()+interval '5 minutes'
    or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>10000 then
    raise exception 'Invalid procurement snapshot';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r)<>'object' or exists(select 1 from jsonb_object_keys(r) x where x not in
      ('product_id','entity_type','name','code','uom','category','image_url','stock','reserve','in_transit','unallocated_reserve','confirmed_incoming_qty','confirmed_eta','purchase_order_id')) then
      raise exception 'Unexpected procurement snapshot fields';
    end if;
    pid:=(r->>'product_id')::uuid;
    if coalesce(r->>'entity_type','product') not in ('product','variant') then raise exception 'Invalid assortment type'; end if;
    if pid is null or pid=any(seen) or coalesce(length(trim(r->>'name')),0) not between 1 and 500
      or coalesce(length(trim(r->>'uom')),0) not between 1 and 30
      or coalesce(length(r->>'code'),0)>255 or coalesce(length(r->>'category'),0)>500 then
      raise exception 'Invalid or duplicate procurement product';
    end if;
    if r->>'image_url' is not null and (r->>'image_url' !~ '^https://[^[:space:]]+$' or length(r->>'image_url')>2000) then
      raise exception 'Invalid product image URL';
    end if;
    foreach k in array array['stock','reserve','in_transit','unallocated_reserve','confirmed_incoming_qty'] loop
      if r->>k is not null then
        if jsonb_typeof(r->k)<>'number' then raise exception 'Invalid stock number'; end if;
        n:=(r->>k)::numeric;
        if abs(n)>100000000 or (k<>'stock' and n<0) then raise exception 'Invalid stock number'; end if;
      end if;
    end loop;
    if coalesce((r->>'confirmed_incoming_qty')::numeric,0)>0 and
      (nullif(r->>'confirmed_eta','') is null or nullif(r->>'purchase_order_id','') is null) then
      raise exception 'Confirmed incoming requires date and purchase order';
    end if;
    -- Explicit casts validate IDs/dates even for a zero confirmed amount.
    perform (r->>'confirmed_eta')::date,(r->>'purchase_order_id')::uuid;
    normalized:=normalized||jsonb_build_array(jsonb_build_object(
      'product_id',pid,'entity_type',coalesce(r->>'entity_type','product'),'name',trim(r->>'name'),'code',coalesce(r->>'code',''),'uom',trim(r->>'uom'),
      'category',coalesce(r->>'category',''),'image_url',r->>'image_url',
      'stock',(r->>'stock')::numeric,'reserve',(r->>'reserve')::numeric,'in_transit',(r->>'in_transit')::numeric,
      'unallocated_reserve',(r->>'unallocated_reserve')::numeric,
      'confirmed_incoming_qty',coalesce((r->>'confirmed_incoming_qty')::numeric,0),
      'confirmed_eta',(r->>'confirmed_eta')::date,'purchase_order_id',(r->>'purchase_order_id')::uuid));
    seen:=array_append(seen,pid);
  end loop;
  insert into app_private.procurement_catalog(singleton,store_id,rows,fetched_at)
    values(true,p_store_id,normalized,p_fetched_at)
  on conflict(singleton) do update set store_id=excluded.store_id,rows=excluded.rows,fetched_at=excluded.fetched_at
    where excluded.fetched_at>=app_private.procurement_catalog.fetched_at;
end $$;

create function app_private.procurement_request_json(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  select (to_jsonb(r)-'created_by')||jsonb_build_object('partner_name',p.name,
    'counterparties',coalesce((select jsonb_agg(jsonb_build_object('id',c.counterparty_id,'name',coalesce((select x->>'name' from app_private.supply_snapshot ss cross join lateral jsonb_array_elements(ss.rows) x where x->>'counterparty_id'=c.counterparty_id::text order by ss.fetched_at desc limit 1),p.name)) order by c.counterparty_id)
      from app_private.supply_counterparty c where c.partner_id=r.partner_id),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(jsonb_build_object('at',e.at,'actor_name',u.full_name,'action',e.action,
      'note',e.note,'data',e.data,'version',e.version) order by e.version)
      from app_private.procurement_event e join public.app_user u on u.id=e.actor_id where e.request_id=r.id),'[]'::jsonb))
  from app_private.procurement_request r join public.partner p on p.id=r.partner_id where r.id=p_id
$$;

create function public.procurement_catalog() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare snap app_private.procurement_catalog; stale boolean; manager boolean;
begin
  perform app_private.require_user(); manager:=app_private.has_perm('org.manage');
  if not manager then perform app_private.procurement_partner(); end if;
  select * into snap from app_private.procurement_catalog where singleton;
  stale:=snap.fetched_at is null or snap.fetched_at<now()-interval '5 minutes';
  return jsonb_build_object('fetched_at',snap.fetched_at,'store_id',snap.store_id,'stale',stale,
    'items',coalesce((select jsonb_agg((r-'unallocated_reserve')||jsonb_build_object('free_now',
      case when not stale and r->>'stock' is not null and r->>'reserve' is not null and r->>'unallocated_reserve' is not null
      then greatest((r->>'stock')::numeric-(r->>'reserve')::numeric-(r->>'unallocated_reserve')::numeric,0) else null end,
      'confirmed_incoming_qty',coalesce(inc.qty,0),'confirmed_eta',inc.eta,'purchase_order_id',inc.po,'confirmed_updated_at',inc.verified_at,'incoming_lots',coalesce(inc.lots,'[]'::jsonb))
      order by r->>'name') from jsonb_array_elements(coalesce(snap.rows,'[]')) r
      left join lateral (select sum(i.quantity) qty,max(i.eta) eta,max(i.updated_at) verified_at,
        jsonb_agg(jsonb_build_object('quantity',i.quantity,'eta',i.eta,'updated_at',i.updated_at) order by i.eta,i.purchase_order_id) lots,
        case when count(*)=1 then min(i.purchase_order_id::text) else null end po
        from app_private.procurement_incoming i where i.product_id=(r->>'product_id')::uuid and i.quantity>0 and i.eta>=current_date) inc on true),'[]'::jsonb),
    'incoming',case when manager then coalesce((select jsonb_agg(to_jsonb(i)-'updated_by' order by i.eta,i.product_id)
      from app_private.procurement_incoming i),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.procurement_list() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare manager boolean; partner uuid;
begin
  perform app_private.require_user(); manager:=app_private.has_perm('org.manage');
  if not manager then partner:=app_private.procurement_partner(); end if;
  return jsonb_build_object('is_manager',manager,'partner_id',partner,
    'requests',coalesce((select jsonb_agg(app_private.procurement_request_json(id) order by created_at desc)
      from (select id,created_at from app_private.procurement_request where manager or partner_id=partner order by created_at desc limit 200) q),'[]'::jsonb),
    'total', (select count(*) from app_private.procurement_request where manager or partner_id=partner),
    'demand',case when manager then coalesce((select jsonb_agg(to_jsonb(d) order by d.name) from (
      select i->>'product_id' product_id,min(i->>'name') name,min(i->>'uom') uom,
        sum((i->>'later_qty')::numeric-(i->>'purchased_qty')::numeric) quantity,count(distinct r.id) request_count
      from app_private.procurement_request r cross join lateral jsonb_array_elements(r.items) i
      where r.status='accepted' and (i->>'later_qty')::numeric>(i->>'purchased_qty')::numeric
      group by i->>'product_id') d),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.procurement_submit(p_operation uuid,p_items jsonb,p_shipment_mode text,p_note text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid; partner uuid; payload jsonb; receipt app_private.operation_receipt; snap app_private.procurement_catalog;
  r jsonb; product jsonb; qty numeric; available numeric; fresh boolean; seen uuid[]:='{}'; pid uuid; lines jsonb:='[]'; rid uuid; answer jsonb;
begin
  uid:=app_private.require_user(); partner:=app_private.procurement_partner();
  if p_operation is null or p_shipment_mode is null or p_shipment_mode not in ('partial','together')
    or coalesce(length(p_note),0)>2000 or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    perform app_private.fail('validation','Проверьте корзину и способ отправки');
  end if;
  payload:=jsonb_build_object('items',p_items,'shipment_mode',p_shipment_mode,'note',coalesce(p_note,''),'partner',partner);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into receipt from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if receipt.command<>'procurement_submit' or receipt.payload<>payload then perform app_private.fail('idempotency-conflict','Повтор содержит другую корзину'); end if;
    return receipt.result;
  end if;
  select * into snap from app_private.procurement_catalog where singleton;
  fresh:=snap.fetched_at>=now()-interval '5 minutes';
  for r in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(r)<>'object' or exists(select 1 from jsonb_object_keys(r) x where x not in ('product_id','quantity'))
      or jsonb_typeof(r->'quantity') is distinct from 'number' then perform app_private.fail('validation','Неверная строка корзины'); end if;
    pid:=(r->>'product_id')::uuid; qty:=(r->>'quantity')::numeric;
    if pid is null or pid=any(seen) or qty is null or qty<=0 or qty>100000 or qty<>round(qty,3) then
      perform app_private.fail('validation','Неверное количество или повтор товара');
    end if;
    select value into product from jsonb_array_elements(coalesce(snap.rows,'[]')) where value->>'product_id'=pid::text;
    if product is null then perform app_private.fail('validation','Товар отсутствует в текущем каталоге'); end if;
    available:=case when fresh and product->>'stock' is not null and product->>'reserve' is not null and product->>'unallocated_reserve' is not null
      then least(qty,greatest((product->>'stock')::numeric-(product->>'reserve')::numeric-(product->>'unallocated_reserve')::numeric,0)) else null end;
    lines:=lines||jsonb_build_array(jsonb_build_object('product_id',pid,'name',product->>'name','code',product->>'code','uom',product->>'uom',
      'quantity',qty,'requested_now',available,'requested_later',case when available is null then null else qty-available end,
      'now_qty',0,'later_qty',0,'refused_qty',0,'now_price_minor',null,'later_price_minor',null,'eta',null,'refusal_reason','',
      'purchased_qty',0,'reserved_qty',0,'shipped_qty',0,'received_qty',0));
    seen:=array_append(seen,pid);
  end loop;
  insert into app_private.procurement_request(partner_id,created_by,shipment_mode,note,items,snapshot_at)
    values(partner,uid,p_shipment_mode,coalesce(p_note,''),lines,snap.fetched_at) returning id into rid;
  insert into app_private.procurement_event(request_id,version,actor_id,action,data) values(rid,1,uid,'submit',jsonb_build_object('shipment_mode',p_shipment_mode));
  answer:=app_private.procurement_request_json(rid);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'procurement_submit',payload,answer);
  return answer;
exception when invalid_text_representation or numeric_value_out_of_range then
  perform app_private.fail('validation','Неверный идентификатор или количество');
end $$;

create function public.procurement_action(p_id uuid,p_expected_version integer,p_action text,p_data jsonb,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid; manager boolean; partner uuid; req app_private.procurement_request; receipt app_private.operation_receipt;
  payload jsonb; answer jsonb; line jsonb; incoming jsonb; lines jsonb:='[]'; seen uuid[]:='{}'; pid uuid; qty numeric;
  nowq numeric; laterq numeric; refusedq numeric; nowprice numeric; laterprice numeric; eta date; v_note text; curr text; cp uuid;
  newstatus text; mode text; deadline timestamptz; field text; maxqty numeric; doc uuid; all_done boolean;
begin
  uid:=app_private.require_user(); manager:=app_private.has_perm('org.manage');
  if not manager then partner:=app_private.procurement_partner(); end if;
  if p_operation is null or p_id is null or p_expected_version is null or p_action is null
    or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>100000 then
    perform app_private.fail('validation','Проверьте параметры действия');
  end if;
  if exists(select 1 from jsonb_object_keys(p_data) x where x not in ('items','currency','shipment_mode','valid_until','note','counterparty_id','document_id')) then
    perform app_private.fail('validation','Неизвестное поле действия'); end if;
  payload:=jsonb_build_object('id',p_id,'version',p_expected_version,'action',p_action,'data',p_data);
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  -- Scope checked before returning a receipt, so revoked partner assignments cannot replay access.
  select * into req from app_private.procurement_request where id=p_id for update;
  if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
  if not manager and req.partner_id<>partner then perform app_private.fail('forbidden','Чужая заявка недоступна'); end if;
  select * into receipt from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if receipt.command<>'procurement_action' or receipt.payload<>payload then perform app_private.fail('idempotency-conflict','Повтор содержит другие условия'); end if;
    return receipt.result;
  end if;
  if req.version<>p_expected_version then perform app_private.fail('version-conflict','Заявка изменена. Обновите её и проверьте условия'); end if;
  v_note:=coalesce(p_data->>'note','');
  if length(v_note)>2000 then perform app_private.fail('validation','Комментарий слишком длинный'); end if;
  newstatus:=req.status; lines:=req.items;
  if p_action='offer' then
    if not manager then perform app_private.fail('forbidden','Предложение готовит менеджер'); end if;
    if trim(v_note)='' then perform app_private.fail('validation','Укажите основание подтверждения цены, наличия и срока'); end if;
    if req.status not in ('submitted','offered') then perform app_private.fail('transition-not-allowed','Нельзя менять принятое или завершённое предложение'); end if;
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items')<>jsonb_array_length(req.items) then
      perform app_private.fail('validation','Предложение должно содержать все строки');
    end if;
    curr:=p_data->>'currency'; mode:=p_data->>'shipment_mode'; cp:=(p_data->>'counterparty_id')::uuid;
    deadline:=(p_data->>'valid_until')::timestamptz;
    if curr is null or not exists(select 1 from public.currency where code=curr) or mode is null or mode not in ('partial','together')
      or deadline is null or deadline<=now() or deadline>now()+interval '30 days' then
      perform app_private.fail('validation','Укажите валюту, отправку и действующий срок предложения (до 30 дней)');
    end if;
    if cp is null or not exists(select 1 from app_private.supply_counterparty where partner_id=req.partner_id and counterparty_id=cp) then
      perform app_private.fail('validation','Контрагент не подтверждён для этого партнёра');
    end if;
    lines:='[]';
    for incoming in select value from jsonb_array_elements(p_data->'items') loop
      if jsonb_typeof(incoming)<>'object' or exists(select 1 from jsonb_object_keys(incoming) x where x not in ('product_id','now_qty','later_qty','refused_qty','now_price_minor','later_price_minor','eta','refusal_reason')) then
        perform app_private.fail('validation','Неизвестное поле предложения'); end if;
      pid:=(incoming->>'product_id')::uuid;
      select value into line from jsonb_array_elements(req.items) where value->>'product_id'=pid::text;
      if pid is null or pid=any(seen) or line is null then perform app_private.fail('validation','Неизвестная или повторная строка'); end if;
      nowq:=(incoming->>'now_qty')::numeric; laterq:=(incoming->>'later_qty')::numeric; refusedq:=(incoming->>'refused_qty')::numeric;
      if nowq is null or laterq is null or refusedq is null or least(nowq,laterq,refusedq)<0
        or nowq<>round(nowq,3) or laterq<>round(laterq,3) or refusedq<>round(refusedq,3)
        or nowq+laterq+refusedq<>(line->>'quantity')::numeric then
        perform app_private.fail('validation','Наличие, под заказ и отказ должны давать запрошенное количество');
      end if;
      nowprice:=(incoming->>'now_price_minor')::numeric; laterprice:=(incoming->>'later_price_minor')::numeric; eta:=nullif(incoming->>'eta','')::date;
      if (nowq>0 and (nowprice is null or nowprice<=0 or nowprice<>trunc(nowprice) or nowprice>100000000000))
        or (laterq>0 and (laterprice is null or laterprice<=0 or laterprice<>trunc(laterprice) or laterprice>100000000000 or eta is null or eta<current_date))
        or (refusedq>0 and coalesce(length(trim(incoming->>'refusal_reason')),0)=0)
        or coalesce(length(incoming->>'refusal_reason'),0)>1000 then
        perform app_private.fail('validation','Укажите цену, срок отсутствующего товара и причину отказа');
      end if;
      lines:=lines||jsonb_build_array(line||jsonb_build_object('now_qty',nowq,'later_qty',laterq,'refused_qty',refusedq,
        'now_price_minor',case when nowq>0 then nowprice else null end,'later_price_minor',case when laterq>0 then laterprice else null end,
        'eta',case when laterq>0 then eta else null end,'refusal_reason',coalesce(incoming->>'refusal_reason','')));
      seen:=array_append(seen,pid);
    end loop;
    update app_private.procurement_request set currency=curr,shipment_mode=mode,counterparty_id=cp,valid_until=deadline,offer_note=v_note,offered_at=now() where id=p_id;
    newstatus:='offered';
  elsif p_action='accept' then
    if manager then perform app_private.fail('forbidden','Условия принимает сам партнёр'); end if;
    if req.status<>'offered' then perform app_private.fail('transition-not-allowed','Нет предложения для принятия'); end if;
    if req.valid_until<=now() then perform app_private.fail('version-conflict','Срок предложения истёк. Менеджер должен обновить условия'); end if;
    if not exists(select 1 from jsonb_array_elements(req.items) i where (i->>'now_qty')::numeric+(i->>'later_qty')::numeric>0) then
      perform app_private.fail('validation','Все позиции отклонены: нет товара для подтверждения');
    end if;
    update app_private.procurement_request set accepted_at=now() where id=p_id; newstatus:='accepted';
  elsif p_action in ('decline','cancel') then
    if req.status not in ('submitted','offered') or (not manager and p_action='decline' and req.status<>'offered') then
      perform app_private.fail('transition-not-allowed','Заявка уже принята или закрыта');
    end if;
    if trim(v_note)='' then perform app_private.fail('validation','Укажите причину'); end if;
    newstatus:=case when p_action='decline' then 'declined' else 'cancelled' end;
  elsif p_action in ('purchase','reserve','ship','receive') then
    if req.status<>'accepted' then perform app_private.fail('transition-not-allowed','Сначала партнёр должен принять условия'); end if;
    if p_action='receive' then
      if manager then perform app_private.fail('forbidden','Получение подтверждает партнёр'); end if;
    elsif not manager then perform app_private.fail('forbidden','Действие выполняет менеджер после проверки МойСклад'); end if;
    if trim(v_note)='' then perform app_private.fail('validation','Укажите результат проверки или комментарий'); end if;
    if p_action<>'receive' then
      doc:=(p_data->>'document_id')::uuid;
      if doc is null then perform app_private.fail('validation','Укажите UUID документа МойСклад'); end if;
    end if;
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 100 then
      perform app_private.fail('validation','Выберите позиции и количество');
    end if;
    if p_action='ship' and req.shipment_mode='together' and exists(select 1 from jsonb_array_elements(req.items) i
      where (i->>'reserved_qty')::numeric<(i->>'now_qty')::numeric+(i->>'later_qty')::numeric) then
      perform app_private.fail('policy-split-required','Согласована одна отправка: сначала подготовьте весь заказ');
    end if;
    lines:=req.items;
    for incoming in select value from jsonb_array_elements(p_data->'items') loop
      if jsonb_typeof(incoming)<>'object' or exists(select 1 from jsonb_object_keys(incoming) x where x not in ('product_id','quantity')) then
        perform app_private.fail('validation','Неизвестное поле количества'); end if;
      pid:=(incoming->>'product_id')::uuid; qty:=(incoming->>'quantity')::numeric;
      select value into line from jsonb_array_elements(lines) where value->>'product_id'=pid::text;
      if pid is null or pid=any(seen) or line is null or qty is null or qty<=0 or qty>100000 or qty<>round(qty,3) then
        perform app_private.fail('validation','Неверная строка или количество');
      end if;
      field:=case p_action when 'purchase' then 'purchased_qty' when 'reserve' then 'reserved_qty' when 'ship' then 'shipped_qty' else 'received_qty' end;
      maxqty:=case p_action when 'purchase' then (line->>'later_qty')::numeric
        when 'reserve' then (line->>'now_qty')::numeric+(line->>'purchased_qty')::numeric
        when 'ship' then (line->>'reserved_qty')::numeric else (line->>'shipped_qty')::numeric end;
      if (line->>field)::numeric+qty>maxqty then perform app_private.fail('validation','Количество превышает согласованное или подготовленное'); end if;
      if p_action='ship' and req.shipment_mode='together' and qty<>maxqty-(line->>'shipped_qty')::numeric then
        perform app_private.fail('policy-split-required','Для одной отправки требуется всё согласованное количество');
      end if;
      select jsonb_agg(case when i->>'product_id'=pid::text then i||jsonb_build_object(field,(i->>field)::numeric+qty) else i end order by ord)
        into lines from jsonb_array_elements(lines) with ordinality x(i,ord);
      seen:=array_append(seen,pid);
    end loop;
    if p_action='ship' and req.shipment_mode='together' and exists(select 1 from jsonb_array_elements(lines) i
      where (i->>'shipped_qty')::numeric<(i->>'now_qty')::numeric+(i->>'later_qty')::numeric) then
      perform app_private.fail('policy-split-required','Одна отправка должна включать все согласованные позиции');
    end if;
    if p_action='receive' and not exists(select 1 from jsonb_array_elements(lines) i
      where (i->>'received_qty')::numeric<(i->>'now_qty')::numeric+(i->>'later_qty')::numeric) then newstatus:='completed'; end if;
  else perform app_private.fail('validation','Неизвестное действие'); end if;
  update app_private.procurement_request set items=lines,status=newstatus,version=version+1,updated_at=now() where id=p_id;
  insert into app_private.procurement_event(request_id,version,actor_id,action,note,data)
    values(p_id,req.version+1,uid,p_action,v_note,p_data);
  answer:=app_private.procurement_request_json(p_id);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'procurement_action',payload,answer);
  return answer;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
  perform app_private.fail('validation','Проверьте идентификатор, количество, цену и дату');
end $$;

insert into app_private.client_command(fn) values ('public.procurement_catalog()'),('public.procurement_list()'),
  ('public.procurement_incoming_set(jsonb,uuid)'),('public.procurement_submit(uuid,jsonb,text,text)'),('public.procurement_action(uuid,integer,text,jsonb,uuid)');
select app_private.apply_grants();
