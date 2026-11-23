create or replace function public.access_grant(p_partner uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_email text := lower(trim(p_email)); v_user uuid; v_id uuid;
begin
  perform app_private.require_perm('org.manage');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform app_private.fail('validation', 'Неверный email', 'email'); end if;
  if not exists (select 1 from public.partner where id = p_partner) then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  select id into v_user from public.app_user where lower(email) = v_email;
  if v_user = v_actor then perform app_private.fail('forbidden', 'Нельзя менять собственный доступ'); end if;
  if v_user is null then
    insert into public.pending_assignment(email, role, partner_id, created_by) values (v_email, 'franchisee', p_partner, v_actor)
    on conflict do nothing;
    perform app_private.audit('access.invite', 'partner', p_partner, p_partner, jsonb_build_object('email', v_email));
    return jsonb_build_object('status', 'pending');
  end if;
  -- Serialize only overlapping grants for the same user and partner.
  perform pg_advisory_xact_lock(hashtextextended('partner-access-grant:' || p_partner::text || ':' || v_user::text, 0));
  if exists (select 1 from public.role_assignment where user_id = v_user and role = 'franchisee' and scope_id = p_partner and revoked_at is null) then
    return jsonb_build_object('status', 'exists');
  end if;
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by)
  values (v_user, 'franchisee', 'partner', p_partner, v_actor) returning id into v_id;
  perform app_private.audit('access.grant', 'role_assignment', v_id, p_partner, jsonb_build_object('user', v_user));
  return jsonb_build_object('status', 'granted', 'assignment_id', v_id);
end $$;
