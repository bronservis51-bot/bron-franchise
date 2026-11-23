-- Повтор отправки одной формы возвращает уже созданного партнёра.
create function public.partner_create_checked(p_name text, p_country text,
  p_contact_name text, p_contact_phone text, p_contact_email text, p_status text,
  p_preparation_stage text, p_operation uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  receipt app_private.operation_receipt;
  payload jsonb;
  partner_id uuid;
begin
  perform app_private.require_perm('org.manage');
  if p_operation is null then
    perform app_private.fail('validation', 'Обновите приложение перед созданием франчайзи');
  end if;
  -- Сохраняем отпечаток анкеты без копии контактных данных.
  payload := to_jsonb(encode(sha256(convert_to(jsonb_build_array(p_name, p_country,
    p_contact_name, p_contact_phone, p_contact_email, p_status, p_preparation_stage)::text, 'UTF8')), 'hex'));
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'partner_create_checked' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict', 'Повторите сохранение с исходными данными формы');
    end if;
    return (receipt.result->>'id')::uuid;
  end if;

  partner_id := public.partner_save_preparation(null, p_name, p_country, p_contact_name,
    p_contact_phone, p_contact_email, p_status, p_preparation_stage);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
  values (actor, p_operation, 'partner_create_checked', payload, jsonb_build_object('id', partner_id));
  return partner_id;
end $$;

revoke execute on function public.partner_create_checked(text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_create_checked(text,text,text,text,text,text,text,uuid) to authenticated;
insert into app_private.client_command(fn) values ('public.partner_create_checked(text,text,text,text,text,text,text,uuid)');
