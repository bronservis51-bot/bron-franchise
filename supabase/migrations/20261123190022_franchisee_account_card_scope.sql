-- A franchisee card can have several logins. Every newly granted franchisee
-- login belongs to one card, independently of staff roles and historic grants.
create or replace function public.access_grant(p_partner uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_email text := lower(trim(p_email)); v_user uuid; v_id uuid;
begin
  perform app_private.require_perm('org.manage');
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app_private.fail('validation', 'Неверный email', 'email');
  end if;
  if not exists (select 1 from public.partner where id = p_partner) then
    perform app_private.fail('not-found', 'Франчайзи не найден');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('franchisee-access:' || v_email, 0));
  select id into v_user from public.app_user where lower(email) = v_email;
  if v_user = v_actor then perform app_private.fail('forbidden', 'Нельзя менять собственный доступ'); end if;
  if exists (select 1 from public.role_assignment where user_id = v_user and role = 'franchisee'
      and scope_type = 'partner' and scope_id = p_partner and revoked_at is null) then
    return jsonb_build_object('status', 'exists');
  end if;
  if exists (select 1 from public.role_assignment where user_id = v_user and role = 'franchisee'
      and scope_type = 'partner' and scope_id <> p_partner and revoked_at is null)
    or exists (select 1 from public.pending_assignment where lower(email) = v_email
      and role = 'franchisee' and partner_id <> p_partner) then
    perform app_private.fail('validation', 'Этот email уже связан с другой карточкой франчайзи', 'email');
  end if;
  if v_user is null then
    insert into public.pending_assignment(email, role, partner_id, created_by)
    values (v_email, 'franchisee', p_partner, v_actor) on conflict do nothing;
    if found then
      perform app_private.audit('access.invite', 'partner', p_partner, p_partner, jsonb_build_object('email', v_email));
    end if;
    return jsonb_build_object('status', 'pending');
  end if;
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by)
  values (v_user, 'franchisee', 'partner', p_partner, v_actor) returning id into v_id;
  delete from public.pending_assignment where lower(email) = v_email and role = 'franchisee' and partner_id = p_partner;
  perform app_private.audit('access.grant', 'role_assignment', v_id, p_partner, jsonb_build_object('user', v_user));
  return jsonb_build_object('status', 'granted', 'assignment_id', v_id);
end $$;

create or replace function public.account_create(p_partner uuid, p_full_name text, p_email text, p_password text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, app_private, extensions, pg_temp as $$
declare v_actor uuid := app_private.require_user(); v_user uuid; v_email text := lower(trim(p_email));
begin
  perform app_private.require_perm('org.manage');
  if not exists (select 1 from public.partner where id = p_partner) then
    perform app_private.fail('not-found', 'Франчайзи не найден');
  end if;
  if coalesce(trim(p_full_name), '') = '' then perform app_private.fail('validation', 'Укажите имя', 'full_name'); end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app_private.fail('validation', 'Неверный email', 'email');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('franchisee-access:' || v_email, 0));
  if exists (select 1 from public.pending_assignment where lower(email) = v_email
      and role = 'franchisee' and partner_id <> p_partner) then
    perform app_private.fail('validation', 'Этот email уже связан с другой карточкой франчайзи', 'email');
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    perform app_private.fail('validation', 'Учётная запись с этим email уже есть — выдайте доступ кнопкой «Выдать»', 'email');
  end if;
  v_user := app_private.create_login(v_email, p_password, p_full_name);
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by)
  values (v_user, 'franchisee', 'partner', p_partner, v_actor);
  perform app_private.audit('account.create', 'app_user', v_user, p_partner, jsonb_build_object('email', v_email));
  return v_user;
end $$;

create function app_private.lock_auth_invitation_email() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.email is not null then
    perform pg_advisory_xact_lock(hashtextextended('franchisee-access:' || lower(trim(new.email)), 0));
  end if;
  return new;
end $$;

create trigger lock_auth_invitation_email before insert on auth.users
  for each row execute function app_private.lock_auth_invitation_email();
revoke all on function app_private.lock_auth_invitation_email() from public, anon, authenticated, service_role;

create or replace function app_private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare r record; v_email text := lower(trim(new.email)); v_conflict boolean;
begin
  insert into public.app_user(id, full_name, email, is_demo)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          new.email,
          coalesce((new.raw_app_meta_data ->> 'demo_seed')::boolean, false))
  on conflict (id) do nothing;
  select count(distinct partner_id) > 1 into v_conflict from public.pending_assignment
  where lower(email) = v_email and role = 'franchisee';
  -- Keep ambiguous legacy invitations visible for the manager to resolve.
  for r in select distinct role, partner_id from public.pending_assignment
    where lower(email) = v_email and (role <> 'franchisee' or not v_conflict) loop
    insert into public.role_assignment(user_id, role, scope_type, scope_id)
    values (new.id, r.role, case when r.partner_id is null then 'company' else 'partner' end, r.partner_id);
  end loop;
  delete from public.pending_assignment where lower(email) = v_email and (role <> 'franchisee' or not v_conflict);
  return new;
end $$;

create or replace function app_private.expense_partner() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
  where a.role = 'franchisee' and a.scope_type = 'partner';
  if coalesce(cardinality(ids), 0) = 0 then perform app_private.fail('forbidden', 'Расходы ведёт франчайзи'); end if;
  if cardinality(ids) > 1 then
    perform app_private.fail('validation', 'Нужен доступ к одной карточке франчайзи. Обратитесь к менеджеру');
  end if;
  perform app_private.require_perm('revenue.enter', ids[1]);
  return ids[1];
end $$;
