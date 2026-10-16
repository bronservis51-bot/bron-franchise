-- 0001 Основание: схемы, ошибки, организация, доступ, аудит, идемпотентность, уведомления, ядро интеграций.
-- Модули: Organization, Identity and Access, Analytics and Audit, Notifications, Integrations (таблицы ядра).

create extension if not exists pg_trgm with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

-- Supabase выдаёт anon/authenticated все права на новые объекты public по умолчанию.
-- Отзываем: доступ выдаётся явно в конце каждой миграции (ADR-0004).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app_private revoke execute on functions from public;
revoke create on schema public from public;

------------------------------------------------------------------------------
-- Ошибки команд (API-04). message = стабильный код, detail = понятный текст.
------------------------------------------------------------------------------
create function app_private.fail(p_code text, p_text text default null, p_hint text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_text, p_code), hint = coalesce(p_hint, '');
end $$;

create function app_private.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

------------------------------------------------------------------------------
-- Организация
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
  default_timezone text not null,
  default_locale text not null
);

create table public.operator (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sod_policy text not null default 'strict' check (sod_policy in ('strict', 'allow_with_log')),
  default_locale text not null default 'ru',
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.direction (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  warranty_days int check (warranty_days >= 0),
  warranty_note text,
  created_at timestamptz not null default now()
);

create table public.partner (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  country text not null references public.country(code),
  direction_id uuid not null references public.direction(id),
  locale text not null default 'ru',
  status text not null default 'active' check (status in ('prospect', 'active', 'suspended', 'terminated')),
  contact_name text,
  contact_phone text,
  contact_email text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1
);

create table public.legal_entity (
  id uuid primary key default gen_random_uuid(),
  owner_kind text not null check (owner_kind in ('operator', 'partner')),
  partner_id uuid references public.partner(id),
  name text not null,
  country text not null references public.country(code),
  tax_id text,
  created_at timestamptz not null default now(),
  check ((owner_kind = 'partner') = (partner_id is not null))
);

create table public.business_calendar (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null,
  workdays int[] not null default '{1,2,3,4,5}', -- ISO: 1 = понедельник
  work_start time not null default '09:00',
  work_end time not null default '18:00',
  is_test boolean not null default false,
  check (work_end > work_start)
);

create table public.holiday (
  calendar_id uuid not null references public.business_calendar(id) on delete cascade,
  day date not null,
  name text,
  primary key (calendar_id, day)
);

create table public.location (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind text not null check (kind in ('own', 'franchise')),
  partner_id uuid references public.partner(id),
  direction_id uuid not null references public.direction(id),
  country text not null references public.country(code),
  city text not null,
  address text,
  timezone text not null,
  currency text not null references public.currency(code),
  status text not null default 'active' check (status in ('planned', 'opening', 'active', 'closed')),
  opened_on date,
  closed_on date,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  check ((kind = 'franchise') = (partner_id is not null))
);
create index on public.location (partner_id);

create table public.location_ownership (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid references public.partner(id),
  valid_from date not null,
  valid_to date,
  check (valid_to is null or valid_to > valid_from)
);

-- Человекочитаемые номера документов (MODEL-02a): префикс + год + последовательность.
create table public.doc_counter (
  prefix text not null,
  year int not null,
  value bigint not null default 0,
  primary key (prefix, year)
);

create function app_private.next_number(p_prefix text) returns text
language plpgsql as $$
declare v_year int := extract(year from now() at time zone 'UTC'); v bigint;
begin
  insert into public.doc_counter(prefix, year, value) values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set value = public.doc_counter.value + 1
  returning value into v;
  return p_prefix || '-' || v_year || '-' || lpad(v::text, 6, '0');
end $$;

------------------------------------------------------------------------------
-- Доступ (Identity and Access)
------------------------------------------------------------------------------
create table public.app_user (
  id uuid primary key references auth.users(id),
  full_name text not null,
  email text,
  locale text not null default 'ru',
  status text not null default 'active' check (status in ('active', 'suspended', 'offboarded')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.permission (
  code text primary key,
  description text not null,
  is_financial boolean not null default false
);

create table public.role (
  code text primary key,
  name text not null,
  kind text not null check (kind in ('staff', 'partner')),
  allowed_scopes text[] not null,
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
  scope_type text not null check (scope_type in ('company', 'direction', 'partner', 'location')),
  scope_id uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  granted_by uuid references public.app_user(id),
  delegated_from uuid references public.app_user(id),
  revoked_at timestamptz,
  revoked_by uuid references public.app_user(id),
  revoke_reason text,
  created_at timestamptz not null default now(),
  check ((scope_type = 'company') = (scope_id is null)),
  check (valid_to is null or valid_to > valid_from)
);
create index on public.role_assignment (user_id) where revoked_at is null;
create index on public.role_assignment (role, scope_type, scope_id) where revoked_at is null;

-- Направление объекта для проверки области direction.
create function app_private.object_direction(p_partner uuid, p_location uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select direction_id from public.location where id = p_location),
    (select direction_id from public.partner where id = p_partner)
  )
$$;

-- Активные назначения текущего пользователя.
create function app_private.active_assignments() returns setof public.role_assignment
language sql stable security definer set search_path = public, pg_temp as $$
  select a.* from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  where a.user_id = auth.uid()
    and a.revoked_at is null
    and a.valid_from <= now()
    and (a.valid_to is null or a.valid_to > now())
$$;

-- Покрывает ли область назначения объект (partner_id, location_id).
create function app_private.scope_covers(p_scope_type text, p_scope_id uuid, p_partner uuid, p_location uuid)
returns boolean language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select case p_scope_type
    when 'company' then true
    when 'partner' then p_partner is not null and p_scope_id = p_partner
    when 'location' then p_location is not null and p_scope_id = p_location
    when 'direction' then p_scope_id = app_private.object_direction(p_partner, p_location)
    else false end
$$;

-- AUTH-01: есть ли у текущего пользователя разрешение на объект в области.
create function app_private.has_perm(p_perm text, p_partner uuid default null, p_location uuid default null)
returns boolean language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    join public.role_permission rp on rp.role = a.role and rp.permission = p_perm
    where app_private.scope_covers(a.scope_type, a.scope_id, p_partner, p_location)
  )
$$;

-- Разрешение хотя бы в одной области (для меню и форм создания).
create function app_private.has_perm_anywhere(p_perm text) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    join public.role_permission rp on rp.role = a.role and rp.permission = p_perm
  )
$$;

-- Объект в области любого действующего назначения (справочное чтение названий).
create function app_private.in_scope(p_partner uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (
    select 1 from app_private.active_assignments() a
    where app_private.scope_covers(a.scope_type, a.scope_id, p_partner, p_location)
       or (a.scope_type = 'location' and p_location is null and p_partner is not null
           and exists (select 1 from public.location l where l.id = a.scope_id and l.partner_id = p_partner))
  )
$$;

create function app_private.is_staff() returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from app_private.active_assignments() a join public.role r on r.code = a.role where r.kind = 'staff')
$$;

create function app_private.user_is_staff(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.role_assignment a join public.role r on r.code = a.role
    where a.user_id = p_user and r.kind = 'staff' and a.revoked_at is null
      and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
  )
$$;

-- Пользователи, входящие в очередь роли для объекта (очередь = действующее назначение роли, покрывающее объект).
create function app_private.queue_members(p_role text, p_partner uuid, p_location uuid) returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select distinct a.user_id from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  where a.role = p_role and a.revoked_at is null
    and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
    and app_private.scope_covers(a.scope_type, a.scope_id, p_partner, p_location)
$$;

create function app_private.user_in_queue(p_user uuid, p_role text, p_partner uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select p_user in (select app_private.queue_members(p_role, p_partner, p_location))
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

create function app_private.require_perm(p_perm text, p_partner uuid default null, p_location uuid default null)
returns void language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  if not app_private.has_perm(p_perm, p_partner, p_location) then
    perform app_private.fail('forbidden', 'Недостаточно прав для действия', p_perm);
  end if;
end $$;

------------------------------------------------------------------------------
-- Аудит (SEC-04) и идемпотентность (API-03)
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
  reason text,
  correlation_id uuid
);
create index on public.audit_event (entity_type, entity_id);
create index on public.audit_event (at desc);

-- Идентификатор запроса клиента (заголовок x-request-id, PostgREST передаёт заголовки в request.headers) — correlation ID (API-04).
create function app_private.request_id() returns uuid
language sql stable as $$
  select case when v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v::uuid end
  from (select coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-request-id', '') as v) h
$$;

create function app_private.audit(p_action text, p_entity_type text, p_entity_id uuid,
  p_partner uuid default null, p_diff jsonb default null, p_reason text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_event(actor_id, action, entity_type, entity_id, partner_id, diff, reason, correlation_id)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_partner, p_diff, p_reason, app_private.request_id())
$$;

create table public.command_log (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  action text not null,
  key text not null,
  fingerprint text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  unique (actor_id, action, key)
);

-- Возвращает сохранённый результат при повторе того же ключа; null — новая операция.
create function app_private.idem_begin(p_action text, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_fp text := md5(coalesce(p_payload, '{}'::jsonb)::text); v_row public.command_log;
begin
  if p_key is null or length(p_key) < 8 then
    perform app_private.fail('validation', 'Нужен ключ операции', 'idempotency_key');
  end if;
  insert into public.command_log(actor_id, action, key, fingerprint) values (auth.uid(), p_action, p_key, v_fp)
  on conflict (actor_id, action, key) do nothing;
  if found then return null; end if;
  select * into v_row from public.command_log where actor_id = auth.uid() and action = p_action and key = p_key;
  if v_row.fingerprint <> v_fp then
    perform app_private.fail('idempotency-conflict', 'Ключ операции уже использован с другими данными');
  end if;
  return coalesce(v_row.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
end $$;

create function app_private.idem_finish(p_action text, p_key text, p_result jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  update public.command_log set result = p_result
  where actor_id = auth.uid() and action = p_action and key = p_key;
  select p_result;
$$;

------------------------------------------------------------------------------
-- Уведомления (NOTIF-01)
------------------------------------------------------------------------------
create table public.notification (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user(id),
  kind text not null,
  title text not null,
  body text,
  entity_type text,
  entity_id uuid,
  link text,
  critical boolean not null default false,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index on public.notification (user_id, created_at desc);

create function app_private.notify(p_user uuid, p_kind text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid, p_link text, p_dedupe text, p_critical boolean default false)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.notification(user_id, kind, title, body, entity_type, entity_id, link, critical, dedupe_key)
  select p_user, p_kind, p_title, p_body, p_entity_type, p_entity_id, p_link, p_critical, p_dedupe
  where p_user is not null and p_user is distinct from auth.uid()
  on conflict (user_id, dedupe_key) do nothing
$$;

create function app_private.notify_queue(p_role text, p_partner uuid, p_location uuid, p_kind text, p_title text,
  p_body text, p_entity_type text, p_entity_id uuid, p_link text, p_dedupe text, p_critical boolean default false)
returns void language sql security definer set search_path = public, app_private, pg_temp as $$
  select app_private.notify(m, p_kind, p_title, p_body, p_entity_type, p_entity_id, p_link, p_dedupe, p_critical)
  from app_private.queue_members(p_role, p_partner, p_location) m
$$;

create function public.notification_mark_read(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); n int;
begin
  update public.notification set read_at = now()
  where user_id = v_user and id = any(p_ids) and read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

------------------------------------------------------------------------------
-- Ядро интеграций (Integrations): подключения, маппинг, outbox, inbox
------------------------------------------------------------------------------
create table public.integration_connection (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique,
  title text not null,
  mode text not null default 'demo' check (mode in ('demo', 'live', 'disabled')),
  status text not null default 'ok' check (status in ('ok', 'degraded', 'down', 'disabled')),
  demo_behavior text not null default 'success' check (demo_behavior in ('success', 'fail', 'lost_response')),
  settings jsonb not null default '{}'::jsonb, -- без секретов (INT-02)
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.integration_mapping (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connection(id),
  entity_type text not null,
  internal_id uuid not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (connection_id, entity_type, external_id),
  unique (connection_id, entity_type, internal_id)
);

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  partner_id uuid,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'unknown', 'dead', 'resolved_manually')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.outbox (status, next_attempt_at);
create index on public.outbox (aggregate_type, aggregate_id);

create table public.inbox (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'duplicate', 'failed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique (source, event_id)
);

create table public.sync_run (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null check (trigger in ('cron', 'manual')),
  started_by uuid,
  outbox_done int not null default 0,
  outbox_failed int not null default 0,
  inbox_processed int not null default 0,
  timers_fired int not null default 0,
  error text
);

create function app_private.enqueue(p_topic text, p_aggregate_type text, p_aggregate_id uuid, p_partner uuid,
  p_payload jsonb, p_dedupe text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.outbox(topic, aggregate_type, aggregate_id, partner_id, payload, dedupe_key)
  values (p_topic, p_aggregate_type, p_aggregate_id, p_partner, p_payload, p_dedupe)
  on conflict (dedupe_key) do nothing
$$;

------------------------------------------------------------------------------
-- Создание профиля пользователя из auth.users (только демо-seed через app_metadata,
-- который может выставить лишь администратор с секретным ключом).
------------------------------------------------------------------------------
create table public.pending_assignment (
  id bigint generated always as identity primary key,
  email text not null,
  role text not null references public.role(code),
  scope_type text not null,
  scope_code text
);

create function app_private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r record; v_scope uuid;
begin
  insert into public.app_user(id, full_name, email, locale, is_demo)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          new.email,
          coalesce(new.raw_user_meta_data ->> 'locale', 'ru'),
          coalesce((new.raw_app_meta_data ->> 'demo_seed')::boolean, false))
  on conflict (id) do nothing;

  if coalesce((new.raw_app_meta_data ->> 'demo_seed')::boolean, false) then
    for r in select * from public.pending_assignment where email = new.email loop
      v_scope := case r.scope_type
        when 'company' then null
        when 'partner' then (select id from public.partner where code = r.scope_code)
        when 'location' then (select id from public.location where code = r.scope_code)
        when 'direction' then (select id from public.direction where code = r.scope_code) end;
      insert into public.role_assignment(user_id, role, scope_type, scope_id) values (new.id, r.role, r.scope_type, v_scope);
    end loop;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.on_auth_user_created();

------------------------------------------------------------------------------
-- Команды доступа (AUTH-02, AUTH-03)
------------------------------------------------------------------------------
create function app_private.scope_partner(p_scope_type text, p_scope_id uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_scope_type
    when 'partner' then p_scope_id
    when 'location' then (select partner_id from public.location where id = p_scope_id)
    else null end
$$;

create function public.assign_role(p_user uuid, p_role text, p_scope_type text, p_scope_id uuid,
  p_valid_to timestamptz default null, p_delegated_from uuid default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  v_actor uuid := app_private.require_user();
  v_role public.role;
  v_partner uuid := app_private.scope_partner(p_scope_type, p_scope_id);
  v_location uuid := case when p_scope_type = 'location' then p_scope_id end;
  v_missing text;
  v_id uuid;
begin
  if p_user = v_actor then
    perform app_private.fail('forbidden', 'Нельзя изменять собственные полномочия');
  end if;
  select * into v_role from public.role where code = p_role;
  if not found then perform app_private.fail('validation', 'Неизвестная роль', 'role'); end if;
  if not (p_scope_type = any(v_role.allowed_scopes)) then
    perform app_private.fail('validation', 'Роль нельзя назначить в такой области', 'scope_type');
  end if;
  if (p_scope_type = 'company') <> (p_scope_id is null) then
    perform app_private.fail('validation', 'Неверная область', 'scope_id');
  end if;
  if p_scope_type = 'direction' then
    -- для области направления проверяем полномочия назначающего на уровне компании
    v_partner := null; v_location := null;
  end if;
  if p_scope_type = 'direction' and not exists (
       select 1 from app_private.active_assignments() a join public.role_permission rp on rp.role = a.role
       where rp.permission = 'access.manage' and (a.scope_type = 'company' or (a.scope_type = 'direction' and a.scope_id = p_scope_id))) then
    perform app_private.fail('forbidden', 'Недостаточно прав для назначения', 'access.manage');
  elsif p_scope_type <> 'direction' then
    if p_scope_type = 'company' then
      if not exists (select 1 from app_private.active_assignments() a join public.role_permission rp on rp.role = a.role
                     where rp.permission = 'access.manage' and a.scope_type = 'company') then
        perform app_private.fail('forbidden', 'Недостаточно прав для назначения', 'access.manage');
      end if;
    else
      perform app_private.require_perm('access.manage', v_partner, v_location);
    end if;
  end if;

  -- Запрет повышения: каждое разрешение роли должно быть у назначающего в той же области.
  select string_agg(rp.permission, ', ') into v_missing
  from public.role_permission rp
  where rp.role = p_role
    and not exists (
      select 1 from app_private.active_assignments() a
      join public.role_permission mine on mine.role = a.role and mine.permission = rp.permission
      where a.scope_type = 'company'
         or (p_scope_type <> 'company' and a.scope_type = p_scope_type and a.scope_id = p_scope_id)
         or (p_scope_type = 'location' and a.scope_type = 'partner' and a.scope_id = v_partner)
    );
  if v_missing is not null then
    perform app_private.fail('forbidden', 'Нельзя выдать полномочия, которых нет у назначающего', v_missing);
  end if;

  if not exists (select 1 from public.app_user where id = p_user and status = 'active') then
    perform app_private.fail('not-found', 'Пользователь не найден');
  end if;

  insert into public.role_assignment(user_id, role, scope_type, scope_id, valid_to, granted_by, delegated_from)
  values (p_user, p_role, p_scope_type, p_scope_id, p_valid_to, v_actor, p_delegated_from)
  returning id into v_id;
  perform app_private.audit('access.assign', 'role_assignment', v_id, v_partner,
    jsonb_build_object('user', p_user, 'role', p_role, 'scope_type', p_scope_type, 'scope_id', p_scope_id, 'valid_to', p_valid_to));
  return v_id;
end $$;

-- Хук для модулей: что делать с работой пользователя при отзыве назначения.
create table app_private.revoke_hook (fn regproc primary key);

create function public.revoke_assignment(p_assignment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); a public.role_assignment; h record;
begin
  select * into a from public.role_assignment where id = p_assignment for update;
  if not found or a.revoked_at is not null then perform app_private.fail('not-found', 'Назначение не найдено'); end if;
  if a.user_id = v_actor then perform app_private.fail('forbidden', 'Нельзя изменять собственные полномочия'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  if a.scope_type in ('company', 'direction') then
    if not exists (select 1 from app_private.active_assignments() x join public.role_permission rp on rp.role = x.role
                   where rp.permission = 'access.manage' and x.scope_type = 'company') then
      perform app_private.fail('forbidden', 'Недостаточно прав', 'access.manage');
    end if;
  else
    perform app_private.require_perm('access.manage', app_private.scope_partner(a.scope_type, a.scope_id),
      case when a.scope_type = 'location' then a.scope_id end);
  end if;
  update public.role_assignment set revoked_at = now(), revoked_by = v_actor, revoke_reason = p_reason where id = p_assignment;
  perform app_private.audit('access.revoke', 'role_assignment', p_assignment,
    app_private.scope_partner(a.scope_type, a.scope_id), jsonb_build_object('user', a.user_id, 'role', a.role), p_reason);
  for h in select fn from app_private.revoke_hook loop
    execute format('select %s($1)', h.fn) using p_assignment;
  end loop;
end $$;

-- Отключение пользователя (увольнение): все назначения отзываются, работа уходит в очереди.
create function public.offboard_user(p_user uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_actor uuid := app_private.require_user(); r record; n int := 0;
begin
  if p_user = v_actor then perform app_private.fail('forbidden', 'Нельзя отключить себя'); end if;
  if not exists (select 1 from app_private.active_assignments() x join public.role_permission rp on rp.role = x.role
                 where rp.permission = 'access.manage' and x.scope_type = 'company') then
    perform app_private.fail('forbidden', 'Недостаточно прав', 'access.manage');
  end if;
  for r in select id from public.role_assignment where user_id = p_user and revoked_at is null loop
    perform public.revoke_assignment(r.id, p_reason);
    n := n + 1;
  end loop;
  update public.app_user set status = 'offboarded', updated_at = now() where id = p_user;
  perform app_private.audit('access.offboard', 'app_user', p_user, null, null, p_reason);
  return n;
end $$;

-- Профиль текущего пользователя: назначения и разрешения по областям (для интерфейса; сервер проверяет сам).
create function public.me() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'user', (select to_jsonb(u) - 'email' || jsonb_build_object('email', u.email) from public.app_user u where u.id = auth.uid()),
    'operator', (select jsonb_build_object('name', name, 'is_demo', is_demo, 'sod_policy', sod_policy) from public.operator limit 1),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'role', a.role, 'role_name', r.name, 'role_kind', r.kind,
        'scope_type', a.scope_type, 'scope_id', a.scope_id,
        'scope_name', case a.scope_type
          when 'company' then 'Вся компания'
          when 'partner' then (select name from public.partner where id = a.scope_id)
          when 'location' then (select name from public.location where id = a.scope_id)
          when 'direction' then (select name from public.direction where id = a.scope_id) end,
        'valid_to', a.valid_to,
        'permissions', (select jsonb_agg(permission order by permission) from public.role_permission where role = a.role)
      ) order by r.kind, r.name)
      from app_private.active_assignments() a join public.role r on r.code = a.role), '[]'::jsonb)
  )
$$;

-- Список пользователей для управления доступом (с email) — только access.manage.
create function public.admin_users() returns table (id uuid, full_name text, email text, status text, is_demo boolean, assignments jsonb)
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
#variable_conflict use_column
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('access.manage') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  return query
    select u.id, u.full_name, u.email, u.status, u.is_demo,
      coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'role', a.role, 'scope_type', a.scope_type, 'scope_id', a.scope_id,
         'valid_to', a.valid_to, 'revoked_at', a.revoked_at) order by a.created_at)
       from public.role_assignment a where a.user_id = u.id and a.revoked_at is null), '[]'::jsonb)
    from public.app_user u order by u.full_name;
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.currency enable row level security;
alter table public.country enable row level security;
alter table public.operator enable row level security;
alter table public.direction enable row level security;
alter table public.partner enable row level security;
alter table public.legal_entity enable row level security;
alter table public.business_calendar enable row level security;
alter table public.holiday enable row level security;
alter table public.location enable row level security;
alter table public.location_ownership enable row level security;
alter table public.doc_counter enable row level security;
alter table public.app_user enable row level security;
alter table public.permission enable row level security;
alter table public.role enable row level security;
alter table public.role_permission enable row level security;
alter table public.role_assignment enable row level security;
alter table public.audit_event enable row level security;
alter table public.command_log enable row level security;
alter table public.notification enable row level security;
alter table public.integration_connection enable row level security;
alter table public.integration_mapping enable row level security;
alter table public.outbox enable row level security;
alter table public.inbox enable row level security;
alter table public.sync_run enable row level security;
alter table public.pending_assignment enable row level security;

create policy read_all on public.currency for select to authenticated using (true);
create policy read_all on public.country for select to authenticated using (true);
create policy read_all on public.operator for select to authenticated using (true);
create policy read_all on public.direction for select to authenticated using (true);
create policy read_all on public.permission for select to authenticated using (true);
create policy read_all on public.role for select to authenticated using (true);
create policy read_all on public.role_permission for select to authenticated using (true);
create policy read_all on public.business_calendar for select to authenticated using (true);
create policy read_all on public.holiday for select to authenticated using (true);

create policy read_scope on public.partner for select to authenticated
  using (app_private.in_scope(id, null));
create policy read_scope on public.location for select to authenticated
  using (app_private.in_scope(partner_id, id));
create policy read_scope on public.legal_entity for select to authenticated
  using (case when partner_id is null then app_private.is_staff() else app_private.has_perm('org.read', partner_id, null) end);
create policy read_staff on public.location_ownership for select to authenticated
  using (app_private.is_staff() and app_private.has_perm('org.read', partner_id, location_id));

-- Пользователи: сотрудники видят всех; партнёр — себя, сотрудников компании и коллег своего партнёра.
create policy read_users on public.app_user for select to authenticated using (
  id = auth.uid()
  or app_private.is_staff()
  or app_private.user_is_staff(id)
  or exists (select 1 from public.role_assignment a
             where a.user_id = app_user.id and a.revoked_at is null
               and app_private.in_scope(app_private.scope_partner(a.scope_type, a.scope_id), case when a.scope_type = 'location' then a.scope_id end))
);
create policy read_assignments on public.role_assignment for select to authenticated using (
  user_id = auth.uid() or app_private.has_perm_anywhere('access.manage')
);
create policy read_audit on public.audit_event for select to authenticated using (
  app_private.has_perm('audit.read', partner_id, null)
);
create policy read_own on public.notification for select to authenticated using (user_id = auth.uid());
create policy read_integration on public.integration_connection for select to authenticated
  using (app_private.has_perm_anywhere('integration.operate') or app_private.has_perm_anywhere('integration.manage'));
create policy read_integration on public.integration_mapping for select to authenticated
  using (app_private.has_perm_anywhere('integration.operate'));
create policy read_integration on public.outbox for select to authenticated
  using (app_private.has_perm_anywhere('integration.operate'));
create policy read_integration on public.inbox for select to authenticated
  using (app_private.has_perm_anywhere('integration.operate'));
create policy read_integration on public.sync_run for select to authenticated
  using (app_private.has_perm_anywhere('integration.operate'));
-- doc_counter, command_log, pending_assignment: политик нет — клиенту недоступны.

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
  ('public.currency', null), ('public.country', null), ('public.operator', null), ('public.direction', null),
  ('public.partner', null), ('public.legal_entity', null), ('public.business_calendar', null), ('public.holiday', null),
  ('public.location', null), ('public.location_ownership', null), ('public.permission', null), ('public.role', null),
  ('public.role_permission', null), ('public.role_assignment', null), ('public.audit_event', null),
  ('public.notification', null), ('public.integration_connection', null), ('public.integration_mapping', null),
  ('public.outbox', null), ('public.inbox', null), ('public.sync_run', null),
  -- email пользователя — только через admin_users()
  ('public.app_user', '{id,full_name,locale,status,is_demo,created_at}');

insert into app_private.client_command(fn) values
  ('public.notification_mark_read(uuid[])'), ('public.assign_role(uuid, text, text, uuid, timestamptz, uuid)'),
  ('public.revoke_assignment(uuid, text)'), ('public.offboard_user(uuid, text)'), ('public.me()'), ('public.admin_users()');

-- Политикам RLS нужны только функции проверки; остальные вызываются командами от имени владельца.
insert into app_private.policy_helper(fn) values
  ('app_private.has_perm(text, uuid, uuid)'), ('app_private.has_perm_anywhere(text)'), ('app_private.in_scope(uuid, uuid)'),
  ('app_private.is_staff()'), ('app_private.user_is_staff(uuid)'), ('app_private.scope_partner(text, uuid)');

select app_private.apply_grants();
