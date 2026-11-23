-- Keep compatibility for existing clients. Current manager forms must present
-- the row version they opened before changing commercial status or opening dates.
create function public.partner_save_preparation_checked(p_id uuid, p_name text, p_country text,
  p_contact_name text, p_contact_phone text, p_contact_email text, p_status text,
  p_preparation_stage text, p_expected_updated_at timestamptz) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_updated_at timestamptz;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if p_id is not null then
    select p.updated_at into v_updated_at from public.partner p where p.id = p_id for update;
    if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
    if v_updated_at is distinct from p_expected_updated_at then
      perform app_private.fail('version-conflict', 'Карточка франчайзи уже изменилась. Скопируйте правки и откройте форму заново');
    end if;
  end if;
  return public.partner_save_preparation(p_id, p_name, p_country, p_contact_name,
    p_contact_phone, p_contact_email, p_status, p_preparation_stage);
end $$;

create function public.location_save_checked(p_id uuid, p_partner uuid, p_name text, p_city text,
  p_address text, p_status text, p_opened_on date, p_expected_updated_at timestamptz) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_updated_at timestamptz;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if p_opened_on is not null and not isfinite(p_opened_on) then
    perform app_private.fail('validation', 'Укажите дату открытия или оставьте поле пустым', 'opened_on');
  end if;
  if p_id is not null then
    select l.updated_at into v_updated_at from public.location l
      where l.id = p_id and l.partner_id = p_partner for update;
    if not found then perform app_private.fail('not-found', 'Торговая точка не найдена у этого партнёра'); end if;
    if v_updated_at is distinct from p_expected_updated_at then
      perform app_private.fail('version-conflict', 'Точка уже изменилась. Скопируйте правки и откройте форму заново');
    end if;
  end if;
  return public.location_save(p_id, p_partner, p_name, p_city, p_address, p_status, p_opened_on);
end $$;

revoke execute on function
  public.partner_save_preparation_checked(uuid,text,text,text,text,text,text,text,timestamptz),
  public.location_save_checked(uuid,uuid,text,text,text,text,date,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function
  public.partner_save_preparation_checked(uuid,text,text,text,text,text,text,text,timestamptz),
  public.location_save_checked(uuid,uuid,text,text,text,text,date,timestamptz)
  to authenticated;
insert into app_private.client_command(fn) values
  ('public.partner_save_preparation_checked(uuid,text,text,text,text,text,text,text,timestamptz)'),
  ('public.location_save_checked(uuid,uuid,text,text,text,text,date,timestamptz)');
