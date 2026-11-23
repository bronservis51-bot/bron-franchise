-- A commercial pause/closure is independent of credentials and roles. Historical
-- reads stay authorized. Explicit account administration remains available.
create function app_private.require_partner_operational(p_partner uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare commercial_status text;
begin
  if auth.uid() is null or app_private.is_manager() then return; end if;
  select status into commercial_status from public.partner where id = p_partner for share;
  if commercial_status is distinct from 'active' then
    perform app_private.fail('forbidden', 'Работа франчайзи приостановлена. История и отчёты доступны для просмотра');
  end if;
end $$;

create function app_private.guard_partner_operational_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid;
begin
  if tg_table_name = 'revenue_day_off' then
    select partner_id into v_partner from public.location
    where id = case when tg_op = 'DELETE' then old.location_id else new.location_id end;
  elsif tg_op = 'DELETE' then
    v_partner := old.partner_id;
  else
    v_partner := new.partner_id;
  end if;
  perform app_private.require_partner_operational(v_partner);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger partner_operational_write before insert or update or delete on public.daily_revenue
  for each row execute function app_private.guard_partner_operational_write();
create trigger partner_operational_write before insert or update or delete on public.work_shift
  for each row execute function app_private.guard_partner_operational_write();
create trigger partner_operational_write before insert or update or delete on public.expense
  for each row execute function app_private.guard_partner_operational_write();
create trigger partner_operational_write before insert or update or delete on app_private.revenue_day_off
  for each row execute function app_private.guard_partner_operational_write();
create trigger partner_operational_write before insert or update or delete on app_private.procurement_request
  for each row execute function app_private.guard_partner_operational_write();

-- Catalog and own order history resolve access independently of a commercial
-- pause. Operational changes are guarded by the request table trigger.
create or replace function app_private.procurement_partner() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
    where a.scope_type = 'partner' and (a.role = 'franchisee' or exists (
      select 1 from public.staff_member s where s.user_id = a.user_id and s.partner_id = a.scope_id and s.active
        and s.checked_access @> '{"procurement": true}'::jsonb
        and a.role in ('franchisee_staff', 'franchisee_manager')));
  if coalesce(cardinality(ids), 0) <> 1 then
    perform app_private.fail('forbidden', 'Для закупки нужен доступ к одной карточке франчайзи');
  end if;
  return ids[1];
end $$;

create or replace function public.order_link() returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
    where a.scope_type = 'partner' and app_private.has_perm('procurement.order', a.scope_id);
  if coalesce(cardinality(ids), 0) = 0 then perform app_private.fail('forbidden', 'Нет доступа к заказу материалов'); end if;
  if cardinality(ids) <> 1 then perform app_private.fail('validation', 'Для заказа нужен доступ к одному франчайзи'); end if;
  perform app_private.require_partner_operational(ids[1]);
  return (select jsonb_build_object('url', order_url, 'assignment_id', order_url_assignment_id) from public.partner where id = ids[1]);
end $$;

revoke all on function app_private.require_partner_operational(uuid), app_private.guard_partner_operational_write()
  from public, anon, authenticated, service_role;

do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres', 'supabase_admin') loop
    execute format('grant execute on function app_private.require_partner_operational(uuid) to %I', trusted);
  end loop;
end $acl$;
