-- Match the existing password and phone commands when displaying access rows.
-- An earlier company assignment protects the account after that role is revoked.
create or replace function public.partner_access(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'assignment_id', a.id, 'user_id', u.id, 'full_name', u.full_name, 'email', u.email,
        'phone', u.phone, 'since', a.created_at,
        'can_manage', app_private.can_manage_user(u.id) and not exists (
          select 1 from public.role_assignment protected
          where protected.user_id = u.id and protected.scope_type = 'company'
        )
      ) order by u.full_name)
      from public.role_assignment a
      join public.app_user u on u.id = a.user_id
      where a.scope_id = p_partner and a.revoked_at is null
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'created_at', i.created_at) order by i.created_at)
      from public.pending_assignment i
      where i.partner_id = p_partner
    ), '[]'::jsonb)
  );
end $$;
