-- Production diagnostic: execute this WHOLE file in one trusted administrator SQL connection.
-- Existing active Auth sessions are used only as transaction-local authorization context.
-- No Auth/session/permission changes, outbound requests or real orders are created.
-- The nested block ALWAYS rolls back its fixtures. Outer transaction is also rolled back.
-- PostgreSQL identity sequences can have an unused number after a rolled-back INSERT.
begin isolation level repeatable read;
set local statement_timeout = '45s';
do $smoke$
declare
  owner_uid uuid; owner_sid uuid; owner_partner uuid; manager_uid uuid; manager_sid uuid;
  other_uid uuid; other_sid uuid; fake_product uuid:=gen_random_uuid(); fake_cp uuid:=gen_random_uuid();
  operation uuid:=gen_random_uuid(); fixture_rows jsonb; fixture_store uuid; fixture_time timestamptz;
  request jsonb; retry jsonb; cat jsonb; overview jsonb; data jsonb; before_counts jsonb; after_counts jsonb;
  checks jsonb:='{}'; caught boolean;
begin
  select s.user_id,s.id,a.scope_id into owner_uid,owner_sid,owner_partner
  from auth.sessions s join public.app_user u on u.id=s.user_id and u.status='active'
  join public.role_assignment a on a.user_id=u.id and a.role='franchisee' and a.revoked_at is null
  join public.partner p on p.id=a.scope_id and p.status='active'
  where a.scope_type='partner' and
    (select count(distinct x.scope_id) from public.role_assignment x where x.user_id=u.id and x.role='franchisee' and x.revoked_at is null)=1
  order by s.id limit 1;
  select s.user_id,s.id into manager_uid,manager_sid
  from auth.sessions s join public.app_user u on u.id=s.user_id and u.status='active'
  join public.role_assignment a on a.user_id=u.id and a.revoked_at is null and a.scope_type='company'
  join public.role_permission rp on rp.role=a.role and rp.permission='org.manage'
  order by s.id limit 1;
  select s.user_id,s.id into other_uid,other_sid
  from auth.sessions s join public.app_user u on u.id=s.user_id and u.status='active'
  join public.role_assignment a on a.user_id=u.id and a.role='franchisee' and a.revoked_at is null
  where a.scope_type='partner' and a.scope_id<>owner_partner and
    (select count(distinct x.scope_id) from public.role_assignment x where x.user_id=u.id and x.role='franchisee' and x.revoked_at is null)=1
  order by s.id limit 1;
  checks:=jsonb_build_object('owner_session_available',owner_uid is not null,'manager_session_available',manager_uid is not null,
    'other_partner_session_available',other_uid is not null,
    'anonymous_lead_submit_preserved',has_function_privilege('anon','public.lead_submit(jsonb)','execute'),
    'anonymous_lead_read_denied',not has_table_privilege('anon','public.franchise_lead','select'),
    'private_catalog_read_denied',not has_table_privilege('authenticated','app_private.procurement_catalog','select'));
  select jsonb_build_object('partners',(select count(*) from public.partner),'users',(select count(*) from public.app_user),
    'revenue',(select count(*) from public.daily_revenue),'leads',(select count(*) from public.franchise_lead),
    'requests',(select count(*) from app_private.procurement_request),'events',(select count(*) from app_private.procurement_event),
    'receipts',(select count(*) from app_private.operation_receipt),'incoming',(select count(*) from app_private.procurement_incoming),
    'mappings',(select count(*) from app_private.supply_counterparty),'audit',(select count(*) from public.audit_event)) into before_counts;
  if owner_uid is null or manager_uid is null then
    checks:=checks||jsonb_build_object('full_workflow_tested',false,'counts',before_counts);
    perform set_config('bron.procurement_smoke',checks::text,true);
    return;
  end if;
  begin
    -- Append one transaction-private product. Existing catalog rows remain unchanged.
    select rows,store_id,fetched_at into fixture_rows,fixture_store,fixture_time from app_private.procurement_catalog where singleton;
    fixture_rows:=coalesce(fixture_rows,'[]')||jsonb_build_array(jsonb_build_object('product_id',fake_product,'name','Диагностика — только откат',
      'code','TRANSACTION-ONLY','uom','Лист','category','Диагностика','stock',11,'reserve',2,'unallocated_reserve',1,'in_transit',50));
    perform app_private.procurement_catalog_store(fixture_rows,coalesce(fixture_store,gen_random_uuid()),greatest(now(),coalesce(fixture_time,now())));
    insert into app_private.supply_counterparty(counterparty_id,partner_id,note) values(fake_cp,owner_partner,'Только откатываемая проверка');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid,'role','authenticated','session_id',owner_sid)::text,true);
    execute 'set local role authenticated';
    cat:=public.procurement_catalog();
    if not exists(select 1 from jsonb_array_elements(cat->'items') i where i->>'product_id'=fake_product::text and (i->>'free_now')::numeric=8 and (i->>'in_transit')::numeric=50) then
      raise exception 'smoke: physical free stock calculation failed'; end if;
    request:=public.procurement_submit(operation,jsonb_build_array(jsonb_build_object('product_id',fake_product,'quantity',20)),'partial','Диагностика с откатом');
    retry:=public.procurement_submit(operation,jsonb_build_array(jsonb_build_object('product_id',fake_product,'quantity',20)),'partial','Диагностика с откатом');
    if request<>retry or (request#>>'{items,0,requested_now}')::numeric<>8 or (request#>>'{items,0,requested_later}')::numeric<>12 then
      raise exception 'smoke: split or idempotent submission failed'; end if;
    checks:=checks||jsonb_build_object('physical_free_stock',true,'split_8_12',true,'submit_idempotent',true);
    if other_uid is not null then
      perform set_config('request.jwt.claims',jsonb_build_object('sub',other_uid,'role','authenticated','session_id',other_sid)::text,true);
      caught:=false;
      begin
        perform public.procurement_action((request->>'id')::uuid,1,'cancel','{"note":"Диагностика"}',gen_random_uuid());
      exception when sqlstate 'P0001' then caught:=sqlerrm='forbidden'; end;
      if not caught then raise exception 'smoke: foreign partner was not denied'; end if;
      checks:=checks||jsonb_build_object('foreign_partner_denied',true);
    end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',manager_uid,'role','authenticated','session_id',manager_sid)::text,true);
    data:=jsonb_build_object('counterparty_id',fake_cp,'currency','RUB','shipment_mode','partial','valid_until',now()+interval '1 day',
      'note','Диагностика; никакой фактической поставки',
      'items',jsonb_build_array(jsonb_build_object('product_id',fake_product,'now_qty',8,'later_qty',12,'refused_qty',0,
        'now_price_minor',12300,'later_price_minor',12500,'eta',current_date+7,'refusal_reason','')));
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'offer',data,gen_random_uuid());
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid,'role','authenticated','session_id',owner_sid)::text,true);
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'accept','{}',gen_random_uuid());
    perform set_config('request.jwt.claims',jsonb_build_object('sub',manager_uid,'role','authenticated','session_id',manager_sid)::text,true);
    overview:=public.procurement_list();
    if not exists(select 1 from jsonb_array_elements(overview->'demand') d where d->>'product_id'=fake_product::text and (d->>'quantity')::numeric=12) then
      raise exception 'smoke: confirmed purchasing demand missing'; end if;
    data:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('product_id',fake_product,'quantity',8)),'document_id',gen_random_uuid(),'note','Диагностика с откатом');
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'reserve',data,gen_random_uuid());
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'ship',data,gen_random_uuid());
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid,'role','authenticated','session_id',owner_sid)::text,true);
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'receive',data,gen_random_uuid());
    perform set_config('request.jwt.claims',jsonb_build_object('sub',manager_uid,'role','authenticated','session_id',manager_sid)::text,true);
    data:=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('product_id',fake_product,'quantity',12)),'document_id',gen_random_uuid(),'note','Диагностика с откатом');
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'purchase',data,gen_random_uuid());
    overview:=public.procurement_list();
    if exists(select 1 from jsonb_array_elements(overview->'demand') d where d->>'product_id'=fake_product::text) then
      raise exception 'smoke: purchase demand not closed'; end if;
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'reserve',data,gen_random_uuid());
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'ship',data,gen_random_uuid());
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid,'role','authenticated','session_id',owner_sid)::text,true);
    request:=public.procurement_action((request->>'id')::uuid,(request->>'version')::integer,'receive',data,gen_random_uuid());
    if request->>'status'<>'completed' or (request#>>'{items,0,received_qty}')::numeric<>20 then
      raise exception 'smoke: fulfillment did not complete'; end if;
    cat:=public.procurement_catalog();
    if not exists(select 1 from jsonb_array_elements(cat->'items') i where i->>'product_id'=fake_product::text and (i->>'free_now')::numeric=8) then
      raise exception 'smoke: approval workflow modified stock'; end if;
    checks:=checks||jsonb_build_object('offer_accept',true,'purchase_demand',true,'partial_fulfillment_8_12',true,'stock_not_mutated',true);
    -- Use a nonexistent session id; do not change any Auth row.
    perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid,'role','authenticated','session_id',gen_random_uuid())::text,true);
    caught:=false;
    begin perform public.procurement_list(); exception when sqlstate 'P0001' then caught:=sqlerrm='unauthenticated'; end;
    if not caught then raise exception 'smoke: nonexistent session was not denied'; end if;
    checks:=checks||jsonb_build_object('revoked_session_denied',true,'full_workflow_tested',true);
    raise exception using errcode='P7701',message='rollback successful procurement probe';
  exception when sqlstate 'P7701' then
    -- The exception rolls back the entire nested block, including all fixtures and role changes.
    null;
  end;
  select jsonb_build_object('partners',(select count(*) from public.partner),'users',(select count(*) from public.app_user),
    'revenue',(select count(*) from public.daily_revenue),'leads',(select count(*) from public.franchise_lead),
    'requests',(select count(*) from app_private.procurement_request),'events',(select count(*) from app_private.procurement_event),
    'receipts',(select count(*) from app_private.operation_receipt),'incoming',(select count(*) from app_private.procurement_incoming),
    'mappings',(select count(*) from app_private.supply_counterparty),'audit',(select count(*) from public.audit_event)) into after_counts;
  if before_counts<>after_counts then raise exception 'smoke: transaction did not restore row counts'; end if;
  checks:=checks||jsonb_build_object('row_counts_unchanged',true,'counts',after_counts);
  perform set_config('bron.procurement_smoke',checks::text,true);
end $smoke$;
select current_setting('bron.procurement_smoke')::jsonb as procurement_smoke;
rollback;
