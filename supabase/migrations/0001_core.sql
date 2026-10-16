-- 0001 Ядро кабинета франчайзи: схемы, ошибки, франчайзи и точки, пользователи, две роли, доступ, аудит, курсы валют.
-- Роли: «Менеджер по франшизе» (вся сеть, все права) и «Франчайзи» (владелец, только свои точки).
-- Клиент не пишет в таблицы напрямую: только именованные команды из реестра app_private.client_command.

create extension if not exists pg_trgm with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

-- Supabase выдаёт anon/authenticated все права на новые объекты public по умолчанию.
-- Отзываем: доступ выдаётся явно через apply_grants() в конце каждой миграции.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app_private revoke execute on functions from public;
revoke create on schema public from public;

------------------------------------------------------------------------------
-- Ошибки команд: message = стабильный код, detail = понятный текст.
------------------------------------------------------------------------------
create function app_private.fail(p_code text, p_text text default null, p_hint text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_text, p_code), hint = coalesce(p_hint, '');
end $$;

------------------------------------------------------------------------------
-- Франчайзи и точки
------------------------------------------------------------------------------
create table public.currency (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  name text not null,
  minor_unit smallint not null check (minor_unit between 0 and 4)
);

create table public.country (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  default_currency text not null references public.currency(code),
  default_timezone text not null
);

create table public.partner (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  country text not null references public.country(code),
  currency text not null references public.currency(code),
  status text not null default 'active' check (status in ('active', 'suspended', 'terminated')),
  contact_name text,
  contact_phone text,
  contact_email text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.location (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  partner_id uuid not null references public.partner(id),
  city text not null,
  address text,
  timezone text not null,
  currency text not null references public.currency(code),
  status text not null default 'active' check (status in ('active', 'closed')),
  opened_on date,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.location (partner_id);

------------------------------------------------------------------------------
-- Пользователи и доступ
------------------------------------------------------------------------------
create table public.app_user (
  id uuid primary key references auth.users(id),
  full_name text not null,
  email text,
  status text not null default 'active' check (status in ('active', 'suspended')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.permission (
  code text primary key,
  description text not null
);

create table public.role (
  code text primary key,
  name text not null,
  scope_type text not null check (scope_type in ('company', 'partner')),
  description text
);

create table public.role_permission (
  role text not null references public.role(code),
  permission text not null references public.permission(code),
  primary key (role, permission)
);

create table public.role_assignment (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user(id),
  role text not null references public.role(code),
  scope_type text not null check (scope_type in ('company', 'partner')),
  scope_id uuid references public.partner(id),
  granted_by uuid references public.app_user(id),
  revoked_at timestamptz,
  revoked_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  check ((scope_type = 'company') = (scope_id is null))
);
create index on public.role_assignment (user_id) where revoked_at is null;

insert into public.permission(code, description) values
  ('kb.read', 'Читать базу знаний'),
  ('kb.edit', 'Писать и публиковать статьи'),
  ('revenue.enter', 'Вносить выручку за день'),
  ('revenue.read', 'Видеть выручку и план'),
  ('plan.manage', 'Ставить план выручки'),
  ('royalty.manage', 'Роялти: начисления, долги, оплаты'),
  ('org.manage', 'Франчайзи, точки и доступ'),
  ('audit.read', 'Журнал действий');

insert into public.role(code, name, scope_type, description) values
  ('franchise_manager', 'Менеджер по франшизе', 'company', 'Вся сеть: франчайзи, выручка, планы, роялти, база знаний, доступ'),
  ('franchisee', 'Франчайзи', 'partner', 'Свои точки: план и выручка за день, база знаний');

insert into public.role_permission(role, permission)
select 'franchise_manager', code from public.permission
union all
select 'franchisee', p from unnest(array['kb.read', 'revenue.enter', 'revenue.read']) p;

-- Активные назначения текущего пользователя.
create function app_private.active_assignments() returns setof public.role_assignment
language sql stable security definer set search_path = public, pg_temp as $$
  select a.* from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  where a.user_id = auth.uid() and a.revoked_at is null
$$;

-- Есть ли у текущего пользователя разрешение на объект франчайзи (p_partner = null — действие уровня сети).
create function app_private.has_perm(p_perm text, p_partner uuid default null)
returns boolean language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    join public.role_permission rp on rp.role = a.role and rp.permission = p_perm
    where a.scope_type = 'company' or (p_partner is not null and a.scope_id = p_partner)
  )
$$;

-- Разрешение хотя бы в одной области (для меню и чтения).
create function app_private.has_perm_anywhere(p_perm text) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    join public.role_permission rp on rp.role = a.role and rp.permission = p_perm
  )
$$;

create function app_private.is_manager() returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from app_private.active_assignments() a where a.scope_type = 'company')
$$;

-- Франчайзи в области пользователя: менеджеру — все, франчайзи — свой.
create function app_private.in_scope(p_partner uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from app_private.active_assignments() a where a.scope_type = 'company' or a.scope_id = p_partner)
$$;

-- Первая строка каждой команды.
create function app_private.require_user() returns uuid
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null then perform app_private.fail('unauthenticated', 'Требуется вход'); end if;
  if not exists (select 1 from public.app_user where id = v and status = 'active') then
    perform app_private.fail('forbidden', 'Учётная запись неактивна');
  end if;
  return v;
end $$;

create function app_private.require_perm(p_perm text, p_partner uuid default null)
returns void language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  if not app_private.has_perm(p_perm, p_partner) then
    perform app_private.fail('forbidden', 'Недостаточно прав для действия', p_perm);
  end if;
end $$;

------------------------------------------------------------------------------
-- Аудит
------------------------------------------------------------------------------
create table public.audit_event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  partner_id uuid,
  diff jsonb,
  reason text
);
create index on public.audit_event (entity_type, entity_id);
create index on public.audit_event (at desc);

create function app_private.audit(p_action text, p_entity_type text, p_entity_id uuid,
  p_partner uuid default null, p_diff jsonb default null, p_reason text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_event(actor_id, action, entity_type, entity_id, partner_id, diff, reason)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_partner, p_diff, p_reason)
$$;

------------------------------------------------------------------------------
-- Профиль из auth.users и выдача доступа по email.
-- Менеджер вносит email франчайзи (pending_assignment); учётную запись создаёт администратор Supabase
-- (Invite user — самостоятельная регистрация выключена), и при первом создании роль назначается сама.
------------------------------------------------------------------------------
create table public.pending_assignment (
  id bigint generated always as identity primary key,
  email text not null,
  role text not null references public.role(code),
  partner_id uuid references public.partner(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (email, role, partner_id)
);

create function app_private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r record;
begin
  insert into public.app_user(id, full_name, email, is_demo)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          new.email,
          coalesce((new.raw_app_meta_data ->> 'demo_seed')::boolean, false))
  on conflict (id) do nothing;
  for r in select * from public.pending_assignment where lower(email) = lower(new.email) loop
    insert into public.role_assignment(user_id, role, scope_type, scope_id)
    values (new.id, r.role, case when r.partner_id is null then 'company' else 'partner' end, r.partner_id);
  end loop;
  delete from public.pending_assignment where lower(email) = lower(new.email);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.on_auth_user_created();

------------------------------------------------------------------------------
-- Команды: профиль, франчайзи, точки, доступ (только менеджер)
------------------------------------------------------------------------------
create function public.me() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'is_demo', u.is_demo)
             from public.app_user u where u.id = auth.uid()),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'role', a.role, 'role_name', r.name, 'scope_type', a.scope_type, 'scope_id', a.scope_id,
        'scope_name', case when a.scope_type = 'company' then 'Вся сеть' else (select name from public.partner where id = a.scope_id) end,
        'permissions', (select jsonb_agg(permission order by permission) from public.role_permission where role = a.role)
      ) order by r.name)
      from app_private.active_assignments() a join public.role r on r.code = a.role), '[]'::jsonb)
  )
$$;

create function public.partner_save(p_id uuid, p_name text, p_country text, p_contact_name text, p_contact_phone text,
  p_contact_email text, p_status text default 'active') returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); c public.country;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if coalesce(trim(p_name), '') = '' then perform app_private.fail('validation', 'Укажите имя франчайзи', 'name'); end if;
  select * into c from public.country where code = p_country;
  if not found then perform app_private.fail('validation', 'Выберите страну', 'country'); end if;
  if p_status not in ('active', 'suspended', 'terminated') then perform app_private.fail('validation', 'Неверный статус', 'status'); end if;
  insert into public.partner(id, code, name, country, currency, status, contact_name, contact_phone, contact_email)
  values (v_id, 'P-' || upper(left(replace(v_id::text, '-', ''), 6)), trim(p_name), p_country, c.default_currency, p_status,
          nullif(trim(p_contact_name), ''), nullif(trim(p_contact_phone), ''), nullif(trim(p_contact_email), ''))
  -- страна и валюта не меняются после создания: от них зависят суммы выручки и роялти
  on conflict (id) do update set name = excluded.name, status = excluded.status,
    contact_name = excluded.contact_name, contact_phone = excluded.contact_phone, contact_email = excluded.contact_email, updated_at = now();
  perform app_private.audit(case when p_id is null then 'partner.create' else 'partner.update' end, 'partner', v_id, v_id,
    jsonb_build_object('name', p_name, 'status', p_status));
  return v_id;
end $$;

create function public.location_save(p_id uuid, p_partner uuid, p_name text, p_city text, p_address text,
  p_status text default 'active', p_opened_on date default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); p public.partner; c public.country;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_city), '') = '' then
    perform app_private.fail('validation', 'Укажите название точки и город', 'name');
  end if;
  if p_status not in ('active', 'closed') then perform app_private.fail('validation', 'Неверный статус', 'status'); end if;
  select * into c from public.country where code = p.country;
  insert into public.location(id, code, name, partner_id, city, address, timezone, currency, status, opened_on)
  values (v_id, 'L-' || upper(left(replace(v_id::text, '-', ''), 6)), trim(p_name), p_partner, trim(p_city), nullif(trim(p_address), ''),
          c.default_timezone, p.currency, p_status, p_opened_on)
  on conflict (id) do update set name = excluded.name, city = excluded.city, address = excluded.address,
    status = excluded.status, opened_on = excluded.opened_on, updated_at = now()
  where public.location.partner_id = p_partner;
  perform app_private.audit(case when p_id is null then 'location.create' else 'location.update' end, 'location', v_id, p_partner,
    jsonb_build_object('name', p_name, 'status', p_status));
  return v_id;
end $$;

-- Выдать франчайзи доступ по email: если пользователь уже есть — роль сразу, иначе — при первом входе.
create function public.access_grant(p_partner uuid, p_email text) returns jsonb
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
  if exists (select 1 from public.role_assignment where user_id = v_user and role = 'franchisee' and scope_id = p_partner and revoked_at is null) then
    return jsonb_build_object('status', 'exists');
  end if;
  insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by)
  values (v_user, 'franchisee', 'partner', p_partner, v_actor) returning id into v_id;
  perform app_private.audit('access.grant', 'role_assignment', v_id, p_partner, jsonb_build_object('user', v_user));
  return jsonb_build_object('status', 'granted', 'assignment_id', v_id);
end $$;

create function public.access_revoke(p_assignment uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); a public.role_assignment;
begin
  perform app_private.require_perm('org.manage');
  select * into a from public.role_assignment where id = p_assignment for update;
  if not found or a.revoked_at is not null then perform app_private.fail('not-found', 'Доступ не найден'); end if;
  if a.user_id = v_actor then perform app_private.fail('forbidden', 'Нельзя менять собственный доступ'); end if;
  update public.role_assignment set revoked_at = now(), revoked_by = v_actor where id = p_assignment;
  perform app_private.audit('access.revoke', 'role_assignment', p_assignment, a.scope_id, jsonb_build_object('user', a.user_id));
end $$;

create function public.access_cancel_invite(p_invite bigint) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  delete from public.pending_assignment where id = p_invite;
end $$;

-- Кто имеет доступ к франчайзи: действующие пользователи и ожидающие приглашения (с email — только менеджеру).
create function public.partner_access(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return jsonb_build_object(
    'users', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', a.id, 'user_id', u.id, 'full_name', u.full_name, 'email', u.email,
        'since', a.created_at) order by u.full_name)
      from public.role_assignment a join public.app_user u on u.id = a.user_id
      where a.scope_id = p_partner and a.revoked_at is null), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'created_at', i.created_at) order by i.created_at)
      from public.pending_assignment i where i.partner_id = p_partner), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------
-- Курсы валют к рублю (для итогов сети в рублях)
------------------------------------------------------------------------------
create table public.fx_rate (
  currency text not null references public.currency(code),
  day date not null,
  rub_per_unit numeric(14, 6) not null check (rub_per_unit > 0),
  set_by uuid,
  primary key (currency, day)
);

-- Курс на дату: последний известный не позже дня; рубль = 1; нет курса — null.
create function app_private.fx_rub(p_currency text, p_day date) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_currency = 'RUB' then 1::numeric else
    (select rub_per_unit from public.fx_rate where currency = p_currency and day <= p_day order by day desc limit 1) end
$$;

create function public.fx_rate_set(p_currency text, p_day date, p_rate numeric) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if p_currency = 'RUB' or not exists (select 1 from public.currency where code = p_currency) then
    perform app_private.fail('validation', 'Неверная валюта', 'currency');
  end if;
  if p_rate is null or p_rate <= 0 then perform app_private.fail('validation', 'Курс должен быть больше нуля', 'rate'); end if;
  insert into public.fx_rate(currency, day, rub_per_unit, set_by) values (p_currency, p_day, p_rate, auth.uid())
  on conflict (currency, day) do update set rub_per_unit = excluded.rub_per_unit, set_by = excluded.set_by;
  perform app_private.audit('fx.set', 'fx_rate', null, null, jsonb_build_object('currency', p_currency, 'day', p_day, 'rate', p_rate));
end $$;

------------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------------
alter table public.currency enable row level security;
alter table public.country enable row level security;
alter table public.partner enable row level security;
alter table public.location enable row level security;
alter table public.app_user enable row level security;
alter table public.permission enable row level security;
alter table public.role enable row level security;
alter table public.role_permission enable row level security;
alter table public.role_assignment enable row level security;
alter table public.audit_event enable row level security;
alter table public.pending_assignment enable row level security;
alter table public.fx_rate enable row level security;

create policy read_all on public.currency for select to authenticated using (true);
create policy read_all on public.country for select to authenticated using (true);
create policy read_all on public.permission for select to authenticated using (true);
create policy read_all on public.role for select to authenticated using (true);
create policy read_all on public.role_permission for select to authenticated using (true);
create policy read_all on public.fx_rate for select to authenticated using (true);
create policy read_scope on public.partner for select to authenticated using (app_private.in_scope(id));
create policy read_scope on public.location for select to authenticated using (app_private.in_scope(partner_id));
create policy read_users on public.app_user for select to authenticated using (id = auth.uid() or app_private.is_manager());
create policy read_assignments on public.role_assignment for select to authenticated using (user_id = auth.uid() or app_private.is_manager());
create policy read_audit on public.audit_event for select to authenticated using (app_private.has_perm('audit.read'));
-- pending_assignment: политик нет — только через partner_access().

------------------------------------------------------------------------------
-- Реестр клиентского доступа: миграция регистрирует команды и читаемые таблицы,
-- apply_grants() пересчитывает права. Всё, что не зарегистрировано, клиенту недоступно.
------------------------------------------------------------------------------
create table app_private.client_command (fn regprocedure primary key);
create table app_private.client_table (tbl regclass primary key, columns text[]);
create table app_private.policy_helper (fn regprocedure primary key);

create function app_private.apply_grants() returns void
language plpgsql as $$
declare r record;
begin
  execute 'revoke all on all tables in schema public from anon, authenticated';
  execute 'revoke all on all sequences in schema public from anon, authenticated';
  execute 'revoke execute on all functions in schema public from public, anon, authenticated';
  execute 'revoke execute on all functions in schema app_private from public, anon, authenticated';
  for r in select tbl, columns from app_private.client_table loop
    if r.columns is null then
      execute format('grant select on %s to authenticated', r.tbl);
    else
      execute format('grant select (%s) on %s to authenticated',
        (select string_agg(quote_ident(c), ', ') from unnest(r.columns) c), r.tbl);
    end if;
  end loop;
  for r in select fn from app_private.client_command loop
    execute format('grant execute on function %s to authenticated', r.fn);
  end loop;
  for r in select fn from app_private.policy_helper loop
    execute format('grant execute on function %s to authenticated', r.fn);
  end loop;
end $$;

alter default privileges revoke execute on functions from public;

insert into app_private.client_table(tbl, columns) values
  ('public.currency', null), ('public.country', null), ('public.partner', null), ('public.location', null),
  ('public.permission', null), ('public.role', null), ('public.role_permission', null), ('public.role_assignment', null),
  ('public.audit_event', null), ('public.fx_rate', null),
  -- email пользователя — только через partner_access()
  ('public.app_user', '{id,full_name,status,is_demo,created_at}');

insert into app_private.client_command(fn) values
  ('public.me()'),
  ('public.partner_save(uuid, text, text, text, text, text, text)'),
  ('public.location_save(uuid, uuid, text, text, text, text, date)'),
  ('public.access_grant(uuid, text)'), ('public.access_revoke(uuid)'), ('public.access_cancel_invite(bigint)'),
  ('public.partner_access(uuid)'), ('public.fx_rate_set(text, date, numeric)');

-- Политикам RLS нужны только функции проверки; остальные вызываются командами от имени владельца.
insert into app_private.policy_helper(fn) values
  ('app_private.has_perm(text, uuid)'), ('app_private.has_perm_anywhere(text)'), ('app_private.in_scope(uuid)'),
  ('app_private.is_manager()');

select app_private.apply_grants();
