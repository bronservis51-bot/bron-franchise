-- An unassigned interval is a dated fact. Keep its start and the assignment it supersedes.
alter table app_private.procurement_document_mapping alter column partner_id drop not null;
alter table app_private.procurement_document_mapping add check(partner_id is not null or location_id is null);

create or replace function public.manager_purchase_mapping(p_counterparty uuid,p_partner uuid,p_location uuid,p_effective_from date)
returns void language plpgsql security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare previous app_private.procurement_document_mapping;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if p_counterparty is null or p_effective_from is null then
    perform app_private.fail('validation','Укажите контрагента и дату изменения');
  end if;
  if p_partner is null and p_location is not null then
    perform app_private.fail('validation','Для снятия привязки точка должна быть пустой');
  end if;
  if p_partner is not null and not exists(select 1 from public.partner where id=p_partner)
    or p_location is not null and not exists(select 1 from public.location where id=p_location and partner_id=p_partner) then
    perform app_private.fail('validation','Проверьте франчайзи и выбранную точку');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_counterparty::text,29));
  if exists(select 1 from app_private.procurement_document_mapping where counterparty=p_counterparty and effective_from=p_effective_from
     and partner_id is not distinct from p_partner and location_id is not distinct from p_location) then return; end if;
  select * into previous from app_private.procurement_document_mapping where counterparty=p_counterparty order by effective_from desc limit 1;
  if previous.effective_from>=p_effective_from then perform app_private.fail('version-conflict','Дата должна быть позже предыдущего изменения'); end if;
  if previous.effective_from is null and not exists(select 1 from app_private.procurement_document
    where counterparty=p_counterparty and kind in ('demand','salesreturn')) then
    perform app_private.fail('validation','Контрагент не найден в импортированных отгрузках и возвратах');
  end if;
  if p_partner is null and previous.partner_id is null then
    perform app_private.fail('validation','У контрагента нет привязки, которую можно снять');
  end if;
  insert into app_private.procurement_document_mapping values(p_counterparty,p_effective_from,p_partner,p_location);
  perform app_private.audit(case when p_partner is null then 'purchase_documents.unmap' else 'purchase_documents.map' end,
    'counterparty',p_counterparty,coalesce(p_partner,previous.partner_id),jsonb_build_object(
      'previous_partner',previous.partner_id,'partner',p_partner,'effective_from',p_effective_from,'location',p_location));
end $$;

create index procurement_document_counterparty_day on app_private.procurement_document(counterparty,day desc,id)
  where kind in ('demand','salesreturn');

-- Include known counterparties so a manager can close a relationship before the next shipment arrives.
create or replace function public.manager_purchase_documents(p_month date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return app_private.purchase_document_rows(date_trunc('month',p_month)::date,null,null,true)
    || jsonb_build_object('partners',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,
      'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name) order by l.name),'[]'::jsonb)
        from public.location l where l.partner_id=p.id)) order by p.name),'[]'::jsonb) from public.partner p),
      'known_counterparties',(select coalesce(jsonb_agg(jsonb_build_object('id',cp.counterparty,'name',label.counterparty_name)
        order by label.counterparty_name nulls last,cp.counterparty),'[]'::jsonb)
        from (select distinct counterparty from app_private.procurement_document_mapping) cp left join lateral (
          select counterparty_name from app_private.procurement_document where counterparty=cp.counterparty and kind in ('demand','salesreturn')
          order by day desc,id limit 1) label on true));
end $$;
