-- 0012 Демо-назначения при обновлении app_metadata.
-- Supabase Auth создаёт пользователя и записывает app_metadata отдельным UPDATE через доли секунды,
-- поэтому триггер только на INSERT не видел отметку demo_seed (обнаружено при первой установке на Supabase 13.10.2026).

create function app_private.apply_demo_seed(p_user uuid, p_email text) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r record; v_scope uuid; n int := 0;
begin
  if exists (select 1 from public.role_assignment where user_id = p_user) then return 0; end if; -- уже применено
  update public.app_user set is_demo = true where id = p_user;
  for r in select * from public.pending_assignment where email = p_email loop
    v_scope := case r.scope_type
      when 'company' then null
      when 'partner' then (select id from public.partner where code = r.scope_code)
      when 'location' then (select id from public.location where code = r.scope_code)
      when 'direction' then (select id from public.direction where code = r.scope_code) end;
    insert into public.role_assignment(user_id, role, scope_type, scope_id) values (p_user, r.role, r.scope_type, v_scope);
    n := n + 1;
  end loop;
  return n;
end $$;

create function app_private.on_auth_user_updated() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  if coalesce((new.raw_app_meta_data ->> 'demo_seed')::boolean, false)
     and not coalesce((old.raw_app_meta_data ->> 'demo_seed')::boolean, false) then
    perform app_private.apply_demo_seed(new.id, new.email);
  end if;
  return new;
end $$;

create trigger on_auth_user_updated after update of raw_app_meta_data on auth.users
  for each row execute function app_private.on_auth_user_updated();

-- Досоздать назначения пользователям, созданным до этой миграции
select app_private.apply_demo_seed(u.id, u.email)
from auth.users u join public.app_user a on a.id = u.id
where coalesce((u.raw_app_meta_data ->> 'demo_seed')::boolean, false);
