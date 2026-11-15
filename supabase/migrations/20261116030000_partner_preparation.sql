-- Preparation is independent of operating/access status. No forced sequence and
-- no reclassification of existing partners; old clients retain partner_save.
alter table public.partner add column preparation_stage text
  check (preparation_stage in ('contract_signed', 'location_search', 'opening_preparation'));

create function public.partner_save_preparation(p_id uuid, p_name text, p_country text,
  p_contact_name text, p_contact_phone text, p_contact_email text, p_status text,
  p_preparation_stage text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid; v_before text; v_stage text := nullif(trim(p_preparation_stage), '');
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if v_stage is not null and v_stage not in ('contract_signed', 'location_search', 'opening_preparation') then
    perform app_private.fail('validation', 'Выберите этап подготовки', 'preparation_stage');
  end if;
  if p_id is not null then
    select preparation_stage into v_before from public.partner where id = p_id for update;
  end if;
  v_id := public.partner_save(p_id, p_name, p_country, p_contact_name, p_contact_phone, p_contact_email, p_status);
  update public.partner set preparation_stage = v_stage where id = v_id;
  if v_before is distinct from v_stage then
    perform app_private.audit('partner.preparation_change', 'partner', v_id, v_id,
      jsonb_build_object('before', v_before, 'after', v_stage));
  end if;
  return v_id;
end $$;

insert into app_private.client_command(fn) values
  ('public.partner_save_preparation(uuid,text,text,text,text,text,text,text)');
select app_private.apply_grants();
