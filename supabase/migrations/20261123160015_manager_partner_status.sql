create function public.manager_partner_status() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'partner_id', p.id,
      'working', app_private.partner_launch_has_working_point(p.id),
      'owner_access', case
        when exists (
          select 1
          from public.role_assignment a
          join public.app_user u on u.id = a.user_id and u.status = 'active'
          where a.scope_type = 'partner' and a.scope_id = p.id
            and a.role = 'franchisee' and a.revoked_at is null
        ) then 'granted'
        when exists (
          select 1 from public.pending_assignment i
          where i.partner_id = p.id and i.role = 'franchisee'
        ) then 'pending'
        else 'none'
      end
    ))
    from public.partner p
  ), '[]'::jsonb);
end $$;

revoke execute on function public.manager_partner_status() from public, anon, authenticated, service_role;
grant execute on function public.manager_partner_status() to authenticated;
insert into app_private.client_command(fn) values ('public.manager_partner_status()');
