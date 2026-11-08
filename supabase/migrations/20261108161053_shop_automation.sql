-- Server-only order bridge. No HTTP writes or stock reservations occur in SQL.
alter table app_private.procurement_request add column source text not null default 'request' check(source in ('request','checkout'));
create table app_private.procurement_shop_settings (
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  version integer not null default 1, organization_id uuid, store_id uuid, folder_ids uuid[] not null default '{}',
  enabled_since timestamptz, verified_by uuid references public.app_user(id), verification_note text not null default '',
  worker_status text not null default 'unknown' check(worker_status in ('unknown','ok','error','disabled')),
  last_heartbeat_at timestamptz, last_success_at timestamptz, error_code text,
  check(not enabled or (organization_id is not null and store_id is not null and cardinality(folder_ids)>0 and verified_by is not null and length(trim(verification_note))>0))
);
insert into app_private.procurement_shop_settings(singleton) values(true);
create table app_private.procurement_shop_partner (
  partner_id uuid primary key references public.partner(id), enabled boolean not null default false,
  config_version integer not null default 1, counterparty_id uuid not null references app_private.supply_counterparty(counterparty_id),
  price_type_id uuid not null, currency text not null references public.currency(code), currency_id uuid not null,
  allowed_folder_ids uuid[] not null default '{}', allowed_product_ids uuid[] not null default '{}',
  pricing_policy text not null default 'price_type_only_verified' check(pricing_policy='price_type_only_verified'),
  discounts_verified_absent boolean not null default false, vat_enabled boolean not null, vat_included boolean not null,
  verified_by uuid references public.app_user(id), verified_at timestamptz, verification_note text not null default '',
  updated_at timestamptz not null default now(),
  check(not vat_enabled or vat_included),
  check(not enabled or (discounts_verified_absent and cardinality(allowed_folder_ids)>0 and cardinality(allowed_product_ids)>0
    and verified_by is not null and verified_at is not null and length(trim(verification_note))>0))
);
create table app_private.procurement_price_snapshot (
  partner_id uuid primary key references app_private.procurement_shop_partner(partner_id), version uuid not null,
  config_version integer not null, settings_version integer not null, fetched_at timestamptz not null,
  currency text not null references public.currency(code), currency_id uuid not null, rate numeric not null check(rate>0 and rate<=1000000),
  rows jsonb not null check(jsonb_typeof(rows)='array')
);
create table app_private.procurement_order_outbox (
  id uuid primary key default gen_random_uuid(), request_id uuid not null unique references app_private.procurement_request(id),
  partner_id uuid not null references public.partner(id), actor_id uuid not null references public.app_user(id),
  sync_id uuid not null unique default gen_random_uuid(), kind text not null check(kind in ('stock_checkout','accepted_offer')),
  settings_version integer not null, config_version integer not null, request_version integer not null,
  payload jsonb not null, validation jsonb not null, quote_fetched_at timestamptz,
  status text not null default 'queued' check(status in ('queued','processing','retry','reconciling','created','blocked')),
  attempts integer not null default 0, ambiguous_attempts integer not null default 0, reconciliation_required boolean not null default false,
  lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(),
  order_id uuid unique, error_code text, last_result_token uuid, last_result jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(status<>'created' or order_id is not null)
);
create index procurement_order_outbox_due on app_private.procurement_order_outbox(status,next_attempt_at);
create table app_private.procurement_worker_auth (
  singleton boolean primary key default true check(singleton), key_hash bytea not null check(octet_length(key_hash)=32), updated_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['procurement_shop_settings','procurement_shop_partner','procurement_price_snapshot','procurement_order_outbox','procurement_worker_auth'] loop
    execute format('alter table app_private.%I enable row level security',t);
    execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;

create function app_private.procurement_shop_config_guard() returns trigger
language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  if tg_table_name='procurement_shop_partner' then
    if not exists(select 1 from app_private.supply_counterparty where counterparty_id=new.counterparty_id and partner_id=new.partner_id) then
      raise exception 'Counterparty does not belong to the configured partner'; end if;
    if tg_op='UPDATE' and (to_jsonb(new)-'config_version'-'updated_at') is distinct from (to_jsonb(old)-'config_version'-'updated_at') then
      new.config_version:=old.config_version+1; new.updated_at:=now();
    end if;
  elsif tg_op='UPDATE' then
    if (to_jsonb(new)-array['version','worker_status','last_heartbeat_at','last_success_at','error_code','enabled_since']) is distinct from
      (to_jsonb(old)-array['version','worker_status','last_heartbeat_at','last_success_at','error_code','enabled_since']) then
      new.version:=old.version+1; new.last_success_at:=null;
    end if;
    if new.enabled and not old.enabled then new.enabled_since:=now(); end if;
  end if;
  return new;
end $$;
create trigger procurement_shop_partner_config before insert or update on app_private.procurement_shop_partner for each row execute function app_private.procurement_shop_config_guard();
create trigger procurement_shop_settings_config before update on app_private.procurement_shop_settings for each row execute function app_private.procurement_shop_config_guard();

create function app_private.procurement_shop_error(p_code text) returns text
language sql immutable set search_path=pg_catalog,pg_temp as $$
 select case when p_code=any(array['missing-token','disabled','unauthorized','rate-limit','network','upstream','validation','mapping-mismatch','price-policy',
 'price-changed','stock-stale','lease-expired','ambiguous','multiple-matches','payload-mismatch','attempts-exhausted','actor-revoked','unknown']) then p_code else 'unknown' end
$$;
create function public.shop_worker_authorize(p_key text) returns boolean
language sql stable security definer set search_path=pg_catalog,app_private,extensions,pg_temp as $$
 select length(p_key) between 32 and 512 and exists(select 1 from app_private.procurement_worker_auth where singleton and key_hash=extensions.digest(p_key,'sha256'))
$$;
create function public.shop_worker_heartbeat(p_status text,p_error_code text default null) returns void
language plpgsql security definer set search_path=pg_catalog,app_private,pg_temp as $$
begin
  if p_status not in ('ok','error','disabled') or p_status is null then raise exception 'Invalid worker status'; end if;
  update app_private.procurement_shop_settings set worker_status=p_status,last_heartbeat_at=now(),error_code=case when p_error_code is null then null else app_private.procurement_shop_error(p_error_code) end where singleton;
end $$;
create function public.shop_worker_context() returns jsonb
language sql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
 select jsonb_build_object('enabled',s.enabled,'settings_version',s.version,'organization_id',s.organization_id,'store_id',s.store_id,'folder_ids',s.folder_ids,
 'worker_status',s.worker_status,'last_heartbeat_at',s.last_heartbeat_at,'last_success_at',s.last_success_at,'error_code',s.error_code,
 'catalog_products',coalesce((select rows from app_private.procurement_catalog where singleton),'[]'::jsonb),
 'partners',coalesce((select jsonb_agg((to_jsonb(p)-array['verification_note','verified_by','updated_at'])||jsonb_build_object('currency_minor_unit',c.minor_unit) order by p.partner_id)
 from app_private.procurement_shop_partner p join public.currency c on c.code=p.currency join public.partner b on b.id=p.partner_id and b.status='active'
 where p.enabled),'[]'::jsonb)) from app_private.procurement_shop_settings s where singleton
$$;
create function public.shop_worker_import(p_data jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare s app_private.procurement_shop_settings; cfg app_private.procurement_shop_partner; p jsonb; line jsonb; seen uuid[]:='{}'; products uuid[]; pid uuid; v_rows jsonb; price numeric; tax numeric; fetched timestamptz;
begin
  select * into s from app_private.procurement_shop_settings where singleton for share;
  if not s.enabled or (p_data->>'settings_version')::integer is distinct from s.version or (p_data#>>'{catalog,store_id}')::uuid is distinct from s.store_id then raise exception 'Shop configuration changed'; end if;
  if jsonb_typeof(p_data->'prices') is distinct from 'array' then raise exception 'Invalid personal price snapshots'; end if;
  perform app_private.procurement_catalog_store(p_data#>'{catalog,rows}',s.store_id,(p_data#>>'{catalog,fetched_at}')::timestamptz);
  for p in select value from jsonb_array_elements(p_data->'prices') loop
    pid:=(p->>'partner_id')::uuid;
    select * into cfg from app_private.procurement_shop_partner where partner_id=pid and enabled for share;
    if cfg.partner_id is null or pid=any(seen) or cfg.config_version is distinct from (p->>'config_version')::integer
      or cfg.currency is distinct from p->>'currency' or cfg.currency_id is distinct from (p->>'currency_id')::uuid
      or not cfg.discounts_verified_absent or jsonb_typeof(p->'rows') is distinct from 'array' then raise exception 'Unverified personal price configuration'; end if;
    fetched:=(p->>'fetched_at')::timestamptz;
    if fetched is null or fetched>now()+interval '30 seconds' or fetched<now()-interval '5 minutes' or (p->>'version')::uuid is null
      or (p->>'rate')::numeric is null or (p->>'rate')::numeric<=0 or (p->>'rate')::numeric>1000000 then raise exception 'Invalid price timestamp or currency rate'; end if;
    products:='{}'; v_rows:='[]';
    for line in select value from jsonb_array_elements(p->'rows') loop
      if jsonb_typeof(line)<>'object' or exists(select 1 from jsonb_object_keys(line) k where k not in ('product_id','price_minor','vat','vat_enabled')) then raise exception 'Unexpected price fields'; end if;
      if (line->>'product_id')::uuid is null or not ((line->>'product_id')::uuid=any(cfg.allowed_product_ids)) or (line->>'product_id')::uuid=any(products)
        or not exists(select 1 from app_private.procurement_catalog c cross join lateral jsonb_array_elements(c.rows) x where x->>'product_id'=line->>'product_id') then raise exception 'Product outside verified assortment'; end if;
      price:=(line->>'price_minor')::numeric; tax:=(line->>'vat')::numeric;
      if not (line ? 'price_minor') or (line->>'price_minor' is not null and (jsonb_typeof(line->'price_minor') is distinct from 'number' or price<=0 or price<>trunc(price) or price>100000000000))
        or ((line->>'vat_enabled')::boolean and not cfg.vat_enabled) or tax is null or tax<0 or tax>100 or jsonb_typeof(line->'vat_enabled') is distinct from 'boolean' then raise exception 'Invalid final sale price or VAT'; end if;
      v_rows:=v_rows||jsonb_build_array(jsonb_build_object('product_id',(line->>'product_id')::uuid,'price_minor',price,'vat',tax,'vat_enabled',(line->>'vat_enabled')::boolean));
      products:=array_append(products,(line->>'product_id')::uuid);
    end loop;
    insert into app_private.procurement_price_snapshot(partner_id,version,config_version,settings_version,fetched_at,currency,currency_id,rate,rows)
      values(pid,(p->>'version')::uuid,cfg.config_version,s.version,fetched,cfg.currency,cfg.currency_id,(p->>'rate')::numeric,v_rows)
    on conflict(partner_id) do update set version=excluded.version,config_version=excluded.config_version,settings_version=excluded.settings_version,
      fetched_at=excluded.fetched_at,currency=excluded.currency,currency_id=excluded.currency_id,rate=excluded.rate,rows=excluded.rows
    where excluded.fetched_at>=app_private.procurement_price_snapshot.fetched_at;
    seen:=array_append(seen,pid);
  end loop;
  if exists(select 1 from app_private.procurement_shop_partner p join public.partner b on b.id=p.partner_id and b.status='active' where p.enabled and not(p.partner_id=any(seen))) then raise exception 'Incomplete partner price snapshot'; end if;
  update app_private.procurement_shop_settings set worker_status='ok',last_heartbeat_at=now(),last_success_at=now(),error_code=null where singleton;
end $$;

-- One canonical document body per approved request; retries never regenerate syncId or prices.
create function app_private.procurement_shop_enqueue(p_request uuid,p_actor uuid) returns void
language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
declare r app_private.procurement_request; s app_private.procurement_shop_settings; cfg app_private.procurement_shop_partner; prices app_private.procurement_price_snapshot;
  sid uuid:=gen_random_uuid(); doc jsonb; positions jsonb:='[]'; required jsonb:='[]'; expected_units jsonb:='[]'; v_description text; latest_eta date; line jsonb; product jsonb; priced jsonb; qty numeric; amount numeric; part text; problem text;
begin
  select * into r from app_private.procurement_request where id=p_request;
  select * into s from app_private.procurement_shop_settings where singleton;
  select * into cfg from app_private.procurement_shop_partner where partner_id=r.partner_id;
  if not s.enabled or not coalesce(cfg.enabled,false) then return; end if;
  if exists(select 1 from app_private.procurement_order_outbox where request_id=p_request) then return; end if;
  select * into prices from app_private.procurement_price_snapshot where partner_id=r.partner_id;
  if r.counterparty_id is distinct from cfg.counterparty_id or r.currency is distinct from cfg.currency or not exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=cfg.counterparty_id and c.partner_id=r.partner_id) then problem:='mapping-mismatch'; end if;
  if prices.partner_id is null or prices.config_version<>cfg.config_version or prices.settings_version<>s.version or prices.currency_id<>cfg.currency_id then problem:='price-policy'; end if;
  for line in select value from jsonb_array_elements(r.items) loop
    if (line->>'now_qty')::numeric+(line->>'later_qty')::numeric=0 then continue; end if;
    select value into product from app_private.procurement_catalog c cross join lateral jsonb_array_elements(c.rows) where value->>'product_id'=line->>'product_id';
    select value into priced from jsonb_array_elements(coalesce(prices.rows,'[]')) where value->>'product_id'=line->>'product_id';
    if product is null or priced is null or not((line->>'product_id')::uuid=any(cfg.allowed_product_ids)) then problem:='mapping-mismatch'; continue; end if;
    expected_units:=expected_units||jsonb_build_array(jsonb_build_object('product_id',line->>'product_id','uom',line->>'uom'));
    foreach part in array array['now','later'] loop
      qty:=(line->>(part||'_qty'))::numeric; amount:=(line->>(part||'_price_minor'))::numeric;
      if qty>0 then
        positions:=positions||jsonb_build_array(jsonb_build_object('quantity',qty,'price',amount,'discount',0,'reserve',0,
          'vat',(priced->>'vat')::numeric,'vatEnabled',(priced->>'vat_enabled')::boolean,
          'assortment',jsonb_build_object('meta',jsonb_build_object('href','https://api.moysklad.ru/api/remap/1.2/entity/'||coalesce(product->>'entity_type','product')||'/'||(line->>'product_id'),'type',coalesce(product->>'entity_type','product'),'mediaType','application/json'))));
      end if;
    end loop;
    if (line->>'now_qty')::numeric>0 then required:=required||jsonb_build_array(jsonb_build_object('product_id',line->>'product_id','quantity',(line->>'now_qty')::numeric)); end if;
  end loop;
  select string_agg((i->>'name')||' ['||(i->>'code')||']: сейчас '||(i->>'now_qty')||', под заказ '||(i->>'later_qty')||', отказ '||(i->>'refused_qty')||' '||(i->>'uom')||case when i->>'eta' is not null then ', срок '||(i->>'eta') else '' end||case when coalesce(i->>'refusal_reason','')<>'' then ', причина: '||(i->>'refusal_reason') else '' end,E'\n' order by ord),max(nullif(i->>'eta','')::date) into v_description,latest_eta from jsonb_array_elements(r.items) with ordinality x(i,ord);
  v_description:='Бронь Сервис. Заявка №'||r.number||'. Отправка: '||case r.shipment_mode when 'partial' then 'частями' else 'одной поставкой' end||'. Наличие требует подтверждения.'||E'\n'||coalesce(v_description,'')||case when r.note<>'' then E'\nПартнёр: '||r.note else '' end||case when r.offer_note<>'' then E'\nСогласованные условия: '||r.offer_note else '' end;
  if length(v_description)>4096 then problem:='validation'; end if;
  doc:=jsonb_build_object('syncId',sid,'description',v_description,
    'applicable',true,'vatEnabled',cfg.vat_enabled,'vatIncluded',cfg.vat_included,
    'organization',jsonb_build_object('meta',jsonb_build_object('href','https://api.moysklad.ru/api/remap/1.2/entity/organization/'||s.organization_id,'type','organization','mediaType','application/json')),
    'agent',jsonb_build_object('meta',jsonb_build_object('href','https://api.moysklad.ru/api/remap/1.2/entity/counterparty/'||cfg.counterparty_id,'type','counterparty','mediaType','application/json')),
    'store',jsonb_build_object('meta',jsonb_build_object('href','https://api.moysklad.ru/api/remap/1.2/entity/store/'||s.store_id,'type','store','mediaType','application/json')),
    'rate',jsonb_build_object('currency',jsonb_build_object('meta',jsonb_build_object('href','https://api.moysklad.ru/api/remap/1.2/entity/currency/'||cfg.currency_id,'type','currency','mediaType','application/json')),'value',prices.rate),
    'positions',positions);
  if latest_eta is not null then doc:=doc||jsonb_build_object('deliveryPlannedMoment',to_char(latest_eta::timestamp,'YYYY-MM-DD HH24:MI:SS.MS')); end if;
  insert into app_private.procurement_order_outbox(request_id,partner_id,actor_id,sync_id,kind,settings_version,config_version,request_version,payload,validation,quote_fetched_at,status,error_code)
    values(r.id,r.partner_id,p_actor,sid,case r.source when 'checkout' then 'stock_checkout' else 'accepted_offer' end,s.version,cfg.config_version,r.version,doc,
      jsonb_build_object('stock_required',required,'expected_units',expected_units),prices.fetched_at,case when problem is null then 'queued' else 'blocked' end,problem);
end $$;
create function app_private.procurement_shop_accept_trigger() returns trigger
language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  if new.status='accepted' and old.status is distinct from 'accepted' then perform app_private.procurement_shop_enqueue(new.id,auth.uid()); end if;
  return new;
end $$;
create trigger procurement_enqueue_accepted after update of status on app_private.procurement_request for each row execute function app_private.procurement_shop_accept_trigger();

-- Existing scoped request readers gain safe integration status, never the frozen provider payload.
alter function app_private.procurement_request_json(uuid) rename to procurement_request_json_base;
create function app_private.procurement_request_json(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
 select app_private.procurement_request_json_base(p_id)||jsonb_build_object('integration',
  (select jsonb_build_object('status',j.status,'order_id',j.order_id,'updated_at',j.updated_at,'error_code',j.error_code) from app_private.procurement_order_outbox j where j.request_id=p_id))
$$;

create function app_private.procurement_catalog_base() returns jsonb
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

create or replace function public.procurement_catalog() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare result jsonb; s app_private.procurement_shop_settings; cfg app_private.procurement_shop_partner; prices app_private.procurement_price_snapshot;
  partner uuid; manager boolean; reason text; valid_prices boolean; minor integer;
begin
  perform app_private.require_user(); manager:=app_private.has_perm('org.manage'); result:=app_private.procurement_catalog_base();
  select * into s from app_private.procurement_shop_settings where singleton;
  if not manager then
    partner:=app_private.procurement_partner();
    select * into cfg from app_private.procurement_shop_partner where partner_id=partner;
    select * into prices from app_private.procurement_price_snapshot where partner_id=partner;
    select minor_unit into minor from public.currency where code=cfg.currency;
  end if;
  valid_prices:=coalesce(s.enabled and cfg.enabled and exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=cfg.counterparty_id and c.partner_id=partner) and prices.partner_id is not null and prices.config_version=cfg.config_version and prices.settings_version=s.version
    and prices.fetched_at>=now()-interval '5 minutes' and prices.currency=cfg.currency and prices.currency_id=cfg.currency_id,false);
  reason:=case when manager then 'manager' when not s.enabled then 'disabled'
    when cfg.partner_id is null or not cfg.enabled or not exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=cfg.counterparty_id and c.partner_id=partner) then 'unconfigured'
    when s.worker_status<>'ok' or s.last_heartbeat_at is null or s.last_heartbeat_at<now()-interval '5 minutes' or s.last_success_at is null or s.last_success_at<now()-interval '5 minutes' then 'worker-unavailable'
    when not valid_prices then 'prices-stale'
    when (result->>'stale')::boolean or (result->>'store_id')::uuid is distinct from s.store_id then 'stock-stale' else null end;
  result:=jsonb_set(result,'{items}',coalesce((select jsonb_agg(i||jsonb_build_object('price_minor',
    case when valid_prices then (select (p->>'price_minor')::numeric from jsonb_array_elements(prices.rows) p where p->>'product_id'=i->>'product_id') else null end) order by i->>'name')
    from jsonb_array_elements(result->'items') i where manager or cfg.partner_id is null or (i->>'product_id')::uuid=any(cfg.allowed_product_ids)),'[]'));
  return result||jsonb_build_object('shop',jsonb_build_object('enabled',reason is null,'reason',reason,'price_version',prices.version,'price_fetched_at',prices.fetched_at,
    'currency',cfg.currency,'currency_minor_unit',minor,'worker_status',s.worker_status,'last_heartbeat_at',s.last_heartbeat_at,'last_success_at',s.last_success_at,'error_code',s.error_code));
end $$;

create function public.procurement_checkout(p_operation uuid,p_items jsonb,p_price_version uuid,p_shipment_mode text,p_note text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare uid uuid; partner uuid; receipt app_private.operation_receipt; body jsonb; s app_private.procurement_shop_settings; cfg app_private.procurement_shop_partner;
  prices app_private.procurement_price_snapshot; snap app_private.procurement_catalog; item jsonb; product jsonb; price jsonb; qty numeric; available numeric;
  seen uuid[]:='{}'; pid uuid; lines jsonb:='[]'; rid uuid; answer jsonb;
begin
  uid:=app_private.require_user(); partner:=app_private.procurement_partner();
  if p_operation is null or p_price_version is null or p_shipment_mode is null or p_shipment_mode not in ('partial','together')
    or coalesce(length(p_note),0)>2000 or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    perform app_private.fail('validation','Проверьте корзину, цену и способ отправки'); end if;
  body:=jsonb_build_object('partner',partner,'items',p_items,'price_version',p_price_version,'shipment_mode',p_shipment_mode,'note',coalesce(p_note,''));
  perform pg_advisory_xact_lock(hashtextextended(uid::text||p_operation::text,0));
  select * into receipt from app_private.operation_receipt where user_id=uid and operation_id=p_operation;
  if found then
    if receipt.command<>'procurement_checkout' or receipt.payload<>body then perform app_private.fail('idempotency-conflict','Повтор содержит другую корзину или цену'); end if;
    return receipt.result;
  end if;
  select * into s from app_private.procurement_shop_settings where singleton for share;
  -- Match importer lock order: catalog before personal snapshots to avoid a sync/checkout deadlock.
  select * into snap from app_private.procurement_catalog where singleton for share;
  select * into cfg from app_private.procurement_shop_partner where partner_id=partner for share;
  select * into prices from app_private.procurement_price_snapshot where partner_id=partner for share;
  if not s.enabled or not coalesce(cfg.enabled,false) or s.worker_status<>'ok' or s.last_heartbeat_at is null or s.last_heartbeat_at<now()-interval '5 minutes'
    or s.last_success_at is null or s.last_success_at<now()-interval '5 minutes' then
    perform app_private.fail('integration-pending','Оформление временно недоступно. Можно отправить запрос менеджеру'); end if;
  if not exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=cfg.counterparty_id and c.partner_id=partner) then
    perform app_private.fail('integration-pending','Привязка контрагента требует проверки'); end if;
  if prices.partner_id is null or prices.version<>p_price_version or prices.config_version<>cfg.config_version or prices.settings_version<>s.version
    or prices.fetched_at<now()-interval '5 minutes' or prices.currency<>cfg.currency or prices.currency_id<>cfg.currency_id then
    perform app_private.fail('version-conflict','Цена обновилась или устарела. Обновите каталог и проверьте сумму'); end if;
  if snap.fetched_at is null or snap.fetched_at<now()-interval '5 minutes' or snap.store_id<>s.store_id then
    perform app_private.fail('external-unavailable','Остатки устарели. Обновите каталог или отправьте запрос менеджеру'); end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('product_id','quantity','price_minor'))
      or jsonb_typeof(item->'quantity') is distinct from 'number' or jsonb_typeof(item->'price_minor') is distinct from 'number' then
      perform app_private.fail('validation','Неверная строка корзины'); end if;
    pid:=(item->>'product_id')::uuid; qty:=(item->>'quantity')::numeric;
    if pid is null or pid=any(seen) or not(pid=any(cfg.allowed_product_ids)) or qty is null or qty<=0 or qty>100000 or qty<>round(qty,3) then
      perform app_private.fail('validation','Товар или количество недоступны для заказа'); end if;
    select value into product from jsonb_array_elements(snap.rows) where value->>'product_id'=pid::text;
    select value into price from jsonb_array_elements(prices.rows) where value->>'product_id'=pid::text;
    if product is null or price is null or price->>'price_minor' is null then perform app_private.fail('validation','Товар требует отдельного согласования'); end if;
    if (price->>'price_minor')::numeric is distinct from (item->>'price_minor')::numeric then
      perform app_private.fail('version-conflict','Цена изменилась. Проверьте обновлённую сумму'); end if;
    available:=case when product->>'stock' is null or product->>'reserve' is null or product->>'unallocated_reserve' is null then null else
      greatest((product->>'stock')::numeric-(product->>'reserve')::numeric-(product->>'unallocated_reserve')::numeric,0) end;
    if available is null or qty>available then perform app_private.fail('validation','Количество требует согласования: отправьте одну заявку на весь объём'); end if;
    lines:=lines||jsonb_build_array(jsonb_build_object('product_id',pid,'name',product->>'name','code',product->>'code','uom',product->>'uom',
      'quantity',qty,'requested_now',qty,'requested_later',0,'now_qty',qty,'later_qty',0,'refused_qty',0,
      'now_price_minor',(price->>'price_minor')::numeric,'later_price_minor',null,'eta',null,'refusal_reason','',
      'purchased_qty',0,'reserved_qty',0,'shipped_qty',0,'received_qty',0));
    seen:=array_append(seen,pid);
  end loop;
  insert into app_private.procurement_request(partner_id,created_by,source,shipment_mode,currency,counterparty_id,note,items,snapshot_at,accepted_at)
    values(partner,uid,'checkout',p_shipment_mode,cfg.currency,cfg.counterparty_id,coalesce(p_note,''),lines,snap.fetched_at,now()) returning id into rid;
  update app_private.procurement_request set status='accepted' where id=rid;
  insert into app_private.procurement_event(request_id,version,actor_id,action,note,data)
    values(rid,1,uid,'checkout','Партнёр подтвердил состав и цену; наличие ожидает подтверждения МойСклад',jsonb_build_object('price_version',p_price_version,'shipment_mode',p_shipment_mode));
  answer:=app_private.procurement_request_json(rid);
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result) values(uid,p_operation,'procurement_checkout',body,answer);
  return answer;
exception when invalid_text_representation or numeric_value_out_of_range then perform app_private.fail('validation','Проверьте товар, количество и цену');
end $$;

create function app_private.procurement_outbox_immutable() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if (to_jsonb(new)-array['status','attempts','ambiguous_attempts','reconciliation_required','lease_token','lease_until','next_attempt_at','order_id','error_code','updated_at','last_result_token','last_result']) is distinct from
    (to_jsonb(old)-array['status','attempts','ambiguous_attempts','reconciliation_required','lease_token','lease_until','next_attempt_at','order_id','error_code','updated_at','last_result_token','last_result']) then
    raise exception 'Frozen order payload and identifiers cannot be changed'; end if;
  return new;
end $$;
create trigger procurement_outbox_frozen before update on app_private.procurement_order_outbox for each row execute function app_private.procurement_outbox_immutable();

create function public.shop_worker_claim() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare s app_private.procurement_shop_settings; cfg app_private.procurement_shop_partner; job app_private.procurement_order_outbox; v_mode text; problem text; token uuid;
begin
  select * into s from app_private.procurement_shop_settings where singleton;
  if not s.enabled then return null; end if;
  select * into job from app_private.procurement_order_outbox where
    (status in ('queued','retry','reconciling') and next_attempt_at<=now()) or (status='processing' and lease_until<now())
    order by (reconciliation_required or status in ('processing','reconciling')) desc,created_at,id for update skip locked limit 1;
  if job.id is null then return null; end if;
  v_mode:=case when job.reconciliation_required or job.status in ('processing','reconciling') then 'reconcile' else 'create' end;
  if v_mode='create' and (s.worker_status<>'ok' or s.last_success_at is null or s.last_success_at<now()-interval '5 minutes') then return null; end if;
  select * into cfg from app_private.procurement_shop_partner where partner_id=job.partner_id;
  if not coalesce(cfg.enabled,false) or cfg.config_version<>job.config_version or s.version<>job.settings_version or
    not exists(select 1 from app_private.supply_counterparty c where c.counterparty_id=cfg.counterparty_id and c.partner_id=job.partner_id) then problem:='mapping-mismatch'; end if;
  if not exists(select 1 from public.app_user u join public.role_assignment a on a.user_id=u.id and a.revoked_at is null
    join public.partner p on p.id=job.partner_id and p.status='active'
    where u.id=job.actor_id and u.status='active' and a.role='franchisee' and a.scope_id=job.partner_id) then problem:='actor-revoked'; end if;
  if job.attempts>=8 or job.ambiguous_attempts>=3 then problem:='attempts-exhausted'; end if;
  if problem is not null and (v_mode='create' or problem='attempts-exhausted') then
    update app_private.procurement_order_outbox set status='blocked',error_code=problem,lease_token=null,lease_until=null,updated_at=now() where id=job.id;
    return null;
  end if;
  token:=gen_random_uuid();
  update app_private.procurement_order_outbox set status='processing',lease_token=token,lease_until=now()+interval '120 seconds',attempts=attempts+1,reconciliation_required=reconciliation_required or v_mode='reconcile',updated_at=now() where id=job.id;
  return jsonb_build_object('id',job.id,'lease_token',token,'sync_id',job.sync_id,'attempts',job.attempts+1,'mode',v_mode,'payload',job.payload,
    'reconcile_only',v_mode='reconcile','block_reason',problem,'kind',job.kind,'partner_id',job.partner_id,'request_id',job.request_id,'request_version',job.request_version,'settings_version',job.settings_version,
    'config_version',job.config_version,'quote_fetched_at',job.quote_fetched_at,'validation',job.validation);
end $$;
create function public.shop_worker_result(p_id uuid,p_lease_token uuid,p_status text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare job app_private.procurement_order_outbox; result_body jsonb; next_status text; error text; doc uuid; delay integer;
begin
  if p_status is null or p_status not in ('created','retry','ambiguous','blocked') or jsonb_typeof(p_data) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_data) k where k not in ('order_id','error_code')) then raise exception 'Invalid worker result'; end if;
  select * into job from app_private.procurement_order_outbox where id=p_id for update;
  if job.id is null then return jsonb_build_object('applied',false,'reason','not-found'); end if;
  result_body:=jsonb_build_object('status',p_status,'data',p_data);
  if job.last_result_token=p_lease_token then
    if job.last_result<>result_body then raise exception 'idempotency-conflict'; end if;
    return jsonb_build_object('applied',true,'status',job.status);
  end if;
  if p_lease_token is null or job.status<>'processing' or job.lease_token is distinct from p_lease_token or job.lease_until<=now() then
    return jsonb_build_object('applied',false,'reason','lease-expired'); end if;
  doc:=(p_data->>'order_id')::uuid;
  if p_status='created' and doc is null then raise exception 'Created order requires document UUID'; end if;
  if p_status<>'created' and doc is not null then raise exception 'Only reconciled creation can attach a document'; end if;
  next_status:=case p_status when 'ambiguous' then 'reconciling' else p_status end;
  error:=case when p_status='created' then null else app_private.procurement_shop_error(coalesce(p_data->>'error_code',p_status)) end;
  if p_status<>'created' and (job.attempts>=8 or (p_status='ambiguous' and job.ambiguous_attempts>=2)) then next_status:='blocked'; error:='attempts-exhausted'; end if;
  delay:=least(900,5*power(2,least(job.attempts,7))::integer);
  update app_private.procurement_order_outbox set status=next_status,order_id=doc,error_code=error,lease_until=null,reconciliation_required=reconciliation_required or p_status='ambiguous',
    ambiguous_attempts=ambiguous_attempts+case when p_status='ambiguous' then 1 else 0 end,next_attempt_at=now()+make_interval(secs=>delay),
    last_result_token=p_lease_token,last_result=result_body,updated_at=now() where id=p_id;
  return jsonb_build_object('applied',true,'status',next_status);
end $$;

insert into app_private.client_command(fn) values ('public.procurement_checkout(uuid,jsonb,uuid,text,text)');
select app_private.apply_grants();
-- Worker methods are deliberately absent from client_command and the generated frontend contract.
revoke all on function public.shop_worker_authorize(text),public.shop_worker_heartbeat(text,text),public.shop_worker_context(),
  public.shop_worker_import(jsonb),public.shop_worker_claim(),public.shop_worker_result(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.shop_worker_authorize(text),public.shop_worker_heartbeat(text,text),public.shop_worker_context(),
  public.shop_worker_import(jsonb),public.shop_worker_claim(),public.shop_worker_result(uuid,uuid,text,jsonb) to service_role;
