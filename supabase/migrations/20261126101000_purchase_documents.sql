-- Private source records. No row is added to expenses, receipts or the order workflow.
create table app_private.procurement_document_snapshot (
  month date primary key check (extract(day from month)=1),
  fetched_at timestamptz not null
);
create table app_private.procurement_document (
  kind text not null check (kind in ('demand','salesreturn','supply','purchasereturn')),
  id uuid not null,
  organization uuid not null,
  month date not null references app_private.procurement_document_snapshot,
  day date not null check (date_trunc('month', day)::date=month),
  name text not null check (length(name) between 1 and 2000),
  counterparty uuid not null,
  counterparty_name text not null check(length(counterparty_name) between 1 and 2000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check(total_minor >= 0),
  primary key(kind,id)
);
create index procurement_document_month on app_private.procurement_document(month);
create table app_private.procurement_document_position (
  kind text not null, document_id uuid not null, id uuid not null, product_id uuid not null,
  product text not null check(length(product) between 1 and 2000),
  quantity numeric not null check(quantity>0 and quantity<'Infinity'::numeric),
  amount_minor bigint not null check(amount_minor>=0),
  price_minor numeric not null check(price_minor>=0 and price_minor<'Infinity'::numeric),
  discount numeric not null check(discount<=100), vat numeric not null check(vat>=0), vat_included boolean not null,
  cost_minor bigint check(cost_minor>=0),
  cost_currency text check(cost_currency ~ '^[A-Z]{3}$'),
  check ((cost_minor is null)=(cost_currency is null)),
  primary key(kind, document_id,id),
  foreign key(kind,document_id) references app_private.procurement_document on delete cascade
);
create table app_private.procurement_document_mapping (
  counterparty uuid not null,
  effective_from date not null,
  partner_id uuid not null references public.partner(id),
  location_id uuid references public.location(id),
  primary key(counterparty,effective_from)
);
alter table app_private.procurement_document_snapshot enable row level security;
alter table app_private.procurement_document enable row level security;
alter table app_private.procurement_document_position enable row level security;
alter table app_private.procurement_document_mapping enable row level security;
revoke all on app_private.procurement_document_snapshot,app_private.procurement_document,
  app_private.procurement_document_position,app_private.procurement_document_mapping from public,anon,authenticated;

create function app_private.purchase_documents_store(p_month date,p_fetched_at timestamptz,p_docs jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,app_private,pg_temp as $$
declare d jsonb; k text; did uuid; source_month date;
begin
  if jsonb_typeof(p_docs) is distinct from 'array' or p_month is null or p_fetched_at is null then
    raise exception 'Invalid document snapshot';
  end if;
  perform pg_advisory_xact_lock(86261786);
  if exists(select 1 from procurement_document_snapshot where month=p_month and fetched_at>=p_fetched_at) then return; end if;
  insert into procurement_document_snapshot values(p_month,p_fetched_at)
    on conflict(month) do update set fetched_at=excluded.fetched_at;
  delete from procurement_document where month=p_month;
  for d in select value from jsonb_array_elements(p_docs) loop
    k:=d->>'kind'; did:=(d->>'id')::uuid;
    if jsonb_typeof(d->'lines') is distinct from 'array' then raise exception 'Missing document positions'; end if;
    -- Handle an edit moving a document across a month boundary. A newer read wins.
    select month into source_month from procurement_document where kind=k and id=did;
    if source_month is not null and source_month<>p_month then
      if exists(select 1 from procurement_document_snapshot where month=source_month and fetched_at>p_fetched_at)
        then raise exception 'Newer source month snapshot'; end if;
      delete from procurement_document where kind=k and id=did;
    end if;
    insert into procurement_document(kind,id,organization,month,day,name,counterparty,counterparty_name,currency,total_minor)
    values(k,did,(d->>'organization')::uuid,p_month,(d->>'day')::date,d->>'name',(d->>'counterparty')::uuid,
      d->>'counterparty_name',d->>'currency',(d->>'total_minor')::bigint);
    insert into procurement_document_position
    select k,did,l.* from jsonb_to_recordset(d->'lines') as l(id uuid,product_id uuid,product text,
      quantity numeric,amount_minor bigint,price_minor numeric,discount numeric,vat numeric,vat_included boolean,
      cost_minor bigint,cost_currency text);
    if (select coalesce(sum(amount_minor),0) from procurement_document_position where kind=k and document_id=did)
      <> (d->>'total_minor')::bigint then raise exception 'Document total mismatch'; end if;
  end loop;
end $$;
revoke all on function app_private.purchase_documents_store(date,timestamptz,jsonb) from public,anon,authenticated;

create function public.manager_purchase_mapping(p_counterparty uuid,p_partner uuid,p_location uuid,p_effective_from date)
returns void language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare previous app_private.procurement_document_mapping;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if p_effective_from is null or not exists(select 1 from app_private.procurement_document where
      counterparty=p_counterparty and kind in ('demand','salesreturn'))
    or not exists(select 1 from public.partner where id=p_partner)
    or (p_location is not null and not exists(select 1 from public.location where id=p_location and partner_id=p_partner)) then
    perform app_private.fail('validation','Проверьте контрагента, дату, франчайзи и точку');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_counterparty::text,29));
  select * into previous from app_private.procurement_document_mapping where counterparty=p_counterparty order by effective_from desc limit 1;
  if previous.effective_from=p_effective_from and previous.partner_id=p_partner and previous.location_id is not distinct from p_location then return; end if;
  if previous.effective_from>=p_effective_from then perform app_private.fail('version-conflict','Дата должна быть позже предыдущей привязки'); end if;
  insert into app_private.procurement_document_mapping values(p_counterparty,p_effective_from,p_partner,p_location);
  perform app_private.audit('purchase_documents.map','partner',p_partner,p_partner,jsonb_build_object(
    'counterparty',p_counterparty,'effective_from',p_effective_from,'location',p_location));
end $$;

create function app_private.purchase_document_rows(p_month date,p_partner uuid,p_location uuid,p_manager boolean)
returns jsonb language sql stable set search_path=pg_catalog,app_private,pg_temp as $$
  select jsonb_build_object('fetched_at',(select fetched_at from procurement_document_snapshot where month=p_month),
    'rows',coalesce(jsonb_agg(jsonb_build_object('kind',d.kind,'document_id',d.id,'name',d.name,'day',d.day,'id',l.id,
      'product',l.product,'quantity',l.quantity,'price_minor',l.price_minor::text,'discount',l.discount,
      'vat',l.vat,'vat_included',l.vat_included,'amount_minor',l.amount_minor::text,'currency',d.currency,'location_id',m.location_id)
      || case when p_manager then jsonb_build_object('cost_minor',l.cost_minor::text,'cost_currency',l.cost_currency,
        'counterparty',d.counterparty,'counterparty_name',d.counterparty_name,'partner_id',m.partner_id) else '{}'::jsonb end
      order by d.day desc,d.kind,d.id,l.id),'[]'::jsonb))
  from procurement_document d join procurement_document_position l on l.kind=d.kind and l.document_id=d.id
  left join lateral (select * from procurement_document_mapping where counterparty=d.counterparty and effective_from<=d.day
    order by effective_from desc limit 1) m on d.kind in ('demand','salesreturn')
  where d.month=p_month and (p_manager or (m.partner_id=p_partner and (p_location is null or m.location_id=p_location)))
$$;
revoke all on function app_private.purchase_document_rows(date,uuid,uuid,boolean) from public,anon,authenticated;

create function public.purchase_documents_my(p_month date,p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare partner uuid; partners uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into partners from app_private.active_assignments() where role='franchisee' and scope_id is not null;
  if cardinality(partners)>1 then perform app_private.fail('validation','К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  partner:=partners[1];
  if partner is null then perform app_private.fail('forbidden','Закупки видит франчайзи'); end if;
  perform app_private.require_perm('revenue.read',partner);
  if p_location is not null and not exists(select 1 from public.location where id=p_location and partner_id=partner)
    then perform app_private.fail('not-found','Точка не найдена'); end if;
  return app_private.purchase_document_rows(date_trunc('month',p_month)::date,partner,p_location,false);
end $$;
create function public.manager_purchase_documents(p_month date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return app_private.purchase_document_rows(date_trunc('month',p_month)::date,null,null,true)
    || jsonb_build_object('partners',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,
      'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name) order by l.name),'[]'::jsonb)
        from public.location l where l.partner_id=p.id)) order by p.name),'[]'::jsonb) from public.partner p));
end $$;
revoke all on function public.purchase_documents_my(date,uuid),public.manager_purchase_documents(date),
  public.manager_purchase_mapping(uuid,uuid,uuid,date) from public,anon;
grant execute on function public.purchase_documents_my(date,uuid),public.manager_purchase_documents(date),
  public.manager_purchase_mapping(uuid,uuid,uuid,date) to authenticated;
insert into app_private.client_command(fn) values ('public.purchase_documents_my(date,uuid)'),
  ('public.manager_purchase_documents(date)'),('public.manager_purchase_mapping(uuid,uuid,uuid,date)');
