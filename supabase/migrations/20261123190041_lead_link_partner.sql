alter table public.franchise_lead add column partner_id uuid references public.partner(id);
create index franchise_lead_partner_id on public.franchise_lead(partner_id) where partner_id is not null;

alter table public.partner
  add column contact_city text check (contact_city is null or length(contact_city) between 2 and 80),
  add column contact_instagram text
    check (contact_instagram is null or contact_instagram ~ '^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$');

-- Явно создаём или связываем франчайзи. Эта же транзакция сохраняет связь с заявкой.
create function public.lead_link_partner(p_id uuid,p_partner uuid,p_create jsonb,
  p_expected_updated_at timestamptz,p_operation uuid) returns uuid
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare
  actor uuid := app_private.require_user();
  receipt app_private.operation_receipt;
  payload jsonb;
  l public.franchise_lead;
  v_partner_id uuid := p_partner;
  v_contact_city text := nullif(trim(p_create->>'contact_city'), '');
  v_contact_instagram text := nullif(trim(p_create->>'contact_instagram'), '');
begin
  perform app_private.require_perm('org.manage');
  if p_id is null or p_operation is null or (p_partner is null) = (p_create is null)
    or (p_create is not null and jsonb_typeof(p_create) <> 'object') then
    perform app_private.fail('validation','Выберите создание или привязку франчайзи');
  end if;
  -- Квитанция сравнивает повторные запросы и не хранит копии контактных данных.
  payload := to_jsonb(encode(sha256(convert_to(jsonb_build_array(p_id,p_partner,p_create,p_expected_updated_at)::text,'UTF8')),'hex'));
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id=actor and operation_id=p_operation;
  if found then
    if receipt.command <> 'lead_link_partner' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict','Повторите сохранение с исходными данными формы');
    end if;
    return (receipt.result->>'id')::uuid;
  end if;

  select * into l from public.franchise_lead where id=p_id for update;
  if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
  if l.partner_id is not null then
    if l.partner_id = p_partner then return l.partner_id; end if;
    perform app_private.fail('transition-not-allowed','Франчайзи уже связан с этой заявкой. Обновите список');
  end if;
  if p_expected_updated_at is null or l.updated_at is distinct from p_expected_updated_at then
    perform app_private.fail('version-conflict','Заявка уже изменилась. Обновите список и откройте её заново');
  end if;
  if l.deleted_at is not null or l.status <> 'won' then
    perform app_private.fail('transition-not-allowed','Связать франчайзи можно в активной заявке в колонке «Договор»');
  end if;

  if p_partner is null then
    if v_contact_city is not null and length(v_contact_city) not between 2 and 80 then
      perform app_private.fail('validation','Проверьте город','contact_city');
    end if;
    if v_contact_instagram is not null and v_contact_instagram !~ '^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$' then
      perform app_private.fail('validation','Проверьте ник Instagram','contact_instagram');
    end if;
    v_partner_id := public.partner_save_preparation(null,p_create->>'name',p_create->>'country',
      p_create->>'contact_name',p_create->>'contact_phone',p_create->>'contact_email','active',p_create->>'preparation_stage');
    update public.partner set contact_city=v_contact_city, contact_instagram=v_contact_instagram where id=v_partner_id;
  elsif not exists (select 1 from public.partner where id=p_partner) then
    perform app_private.fail('not-found','Франчайзи не найден');
  end if;

  update public.franchise_lead set partner_id=v_partner_id,updated_by=actor,updated_at=clock_timestamp() where id=p_id;
  perform app_private.audit('lead.link_partner','franchise_lead',p_id,v_partner_id,jsonb_build_object('created',p_partner is null));
  insert into app_private.operation_receipt(user_id,operation_id,command,payload,result)
    values(actor,p_operation,'lead_link_partner',payload,jsonb_build_object('id',v_partner_id));
  return v_partner_id;
end $$;

revoke execute on function public.lead_link_partner(uuid,uuid,jsonb,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.lead_link_partner(uuid,uuid,jsonb,timestamptz,uuid) to authenticated;
insert into app_private.client_command(fn) values ('public.lead_link_partner(uuid,uuid,jsonb,timestamptz,uuid)');
