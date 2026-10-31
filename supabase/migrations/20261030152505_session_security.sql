-- Reject revoked Auth sessions even while an already issued JWT has not expired.
-- Anonymous lead_submit remains public and performs its own input validation.
create function app_private.session_is_current() returns boolean
language plpgsql stable security definer set search_path = pg_catalog, auth, public, pg_temp as $$
declare v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_sid text := v_claims ->> 'session_id';
begin
  if auth.uid() is null then return false; end if;
  -- A trusted direct SQL administrator can run diagnostics/test transactions.
  -- PostgREST connects as authenticator, never as these database owners.
  if v_sid is null then return session_user in ('postgres', 'supabase_admin'); end if;
  return exists (select 1 from auth.sessions s where s.id::text = v_sid and s.user_id = auth.uid());
end $$;

create or replace function app_private.active_assignments() returns setof public.role_assignment
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select a.* from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  where a.user_id = auth.uid() and a.revoked_at is null and app_private.session_is_current()
$$;

create or replace function app_private.require_user() returns uuid
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null or not app_private.session_is_current() then
    perform app_private.fail('unauthenticated', 'Сессия завершена. Войдите снова');
  end if;
  if not exists (select 1 from public.app_user where id = v and status = 'active') then
    perform app_private.fail('forbidden', 'Учётная запись неактивна');
  end if;
  return v;
end $$;

insert into app_private.policy_helper(fn) values ('app_private.session_is_current()');
grant execute on function app_private.session_is_current() to authenticated;

-- Restrictive policies also cover the direct reads whose ownership policy uses auth.uid().
do $$ declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r', 'p') and c.relrowsecurity loop
    execute format('create policy valid_auth_session on public.%I as restrictive for all to authenticated using (app_private.session_is_current()) with check (app_private.session_is_current())', r.relname);
  end loop;
end $$;
create policy valid_auth_session on storage.objects as restrictive for all to authenticated
  using (app_private.session_is_current()) with check (app_private.session_is_current());

-- Password resets revoke existing refresh sessions as well as access to the data API.
create or replace function public.user_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, app_private, extensions, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.can_manage_user(p_user) then perform app_private.fail('forbidden', 'Нельзя менять пароль этому пользователю'); end if;
  perform app_private.check_password(p_password);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)), updated_at = now() where id = p_user;
  delete from auth.sessions where user_id = p_user;
  perform app_private.audit('user.password', 'app_user', p_user, (select partner_id from public.staff_member where user_id = p_user));
end $$;

-- Do not change app_private.apply_grants() here: preserve the existing anonymous
-- grant and the request/response contract of public.lead_submit(jsonb).

create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'is_demo', u.is_demo)
             from public.app_user u where u.id = auth.uid() and u.status = 'active' and app_private.session_is_current()),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'role', a.role, 'role_name', r.name, 'scope_type', a.scope_type, 'scope_id', a.scope_id,
        'scope_name', case when a.scope_type = 'company' then 'Вся сеть' else (select name from public.partner where id = a.scope_id) end,
        'permissions', (select jsonb_agg(rp.permission order by rp.permission) from public.role_permission rp
          where rp.role = a.role
            and not (rp.permission = 'rating.read' and a.scope_type = 'partner'
                     and coalesce((select country from public.partner where id = a.scope_id), 'RU') <> 'RU'))
      ) order by r.name)
      from app_private.active_assignments() a join public.role r on r.code = a.role), '[]'::jsonb)
  )
$$;

