-- Сохраняем исходный номер. Ключ для сверки учитывает внутренний префикс 8 зоны +7.
-- Распределение кодов: ITU Operational Bulletin 1341, приложение к соглашению РФ и Казахстана.
create function app_private.lead_phone_key(p_phone text, p_digits text) returns text
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select case when p_phone ~ '^[[:space:]()0-9.-]+$' and p_digits ~ '^8[023456789][0-9]{9}$'
    then '7' || substr(p_digits, 2) else p_digits end
$$;
revoke execute on function app_private.lead_phone_key(text,text) from public, anon, authenticated, service_role;

-- PostgreSQL вычисляет индекс заполненной таблицы от имени её владельца.
grant execute on function app_private.lead_phone_key(text,text) to postgres;
create index franchise_lead_phone_key_created on public.franchise_lead
  (app_private.lead_phone_key(phone,phone_digits), created_at desc, id desc) where phone <> '';

-- Повторная анкета не редактирует и не восстанавливает исходную заявку.
create table app_private.lead_recontact (
  lead_id uuid not null references public.franchise_lead(id) on delete cascade,
  received_at timestamptz not null,
  name text not null,
  phone text not null,
  city text not null,
  contact_via text not null check (contact_via in ('whatsapp', 'telegram', 'call')),
  primary key (lead_id, received_at)
);
create index lead_recontact_received_at on app_private.lead_recontact(received_at);
alter table app_private.lead_recontact enable row level security;
revoke all on app_private.lead_recontact from public, anon, authenticated, service_role;

create or replace function app_private.lead_json(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  select to_jsonb(l)-'phone_digits'-'updated_by' || jsonb_build_object(
    'updated_by_name', u.full_name,
    'last_recontact_at', r.received_at,
    'last_recontact', to_jsonb(r)-'lead_id'-'received_at',
    'pending_recontact', coalesce(r.received_at > l.deleted_at, false)
  )
  from public.franchise_lead l
  left join public.app_user u on u.id=l.updated_by
  left join lateral (
    select * from app_private.lead_recontact where lead_id=l.id order by received_at desc limit 1
  ) r on true
  where l.id=p_id
$$;

create or replace function public.lead_trash_list() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return coalesce((select jsonb_agg(row order by (row->>'pending_recontact')::boolean desc,
    greatest(deleted_at, (row->>'last_recontact_at')::timestamptz) desc)
    from (select app_private.lead_json(id) row, deleted_at from public.franchise_lead where deleted_at is not null) trash),'[]');
end $$;

create function app_private.lead_pending_recontacts() returns int
language sql stable set search_path=pg_catalog,public,app_private,pg_temp as $$
  select count(*)::int from public.franchise_lead l where l.deleted_at is not null
    and exists (select 1 from app_private.lead_recontact r where r.lead_id=l.id and r.received_at > l.deleted_at)
$$;
revoke execute on function app_private.lead_pending_recontacts() from public, anon, authenticated, service_role;

create function public.lead_pending_recontacts() returns int
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return app_private.lead_pending_recontacts();
end $$;

create or replace function public.lead_inbox() returns int
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.has_perm('org.manage') then return 0; end if;
  return app_private.lead_pending_recontacts()
    + (select count(*)::int from public.franchise_lead where status='new' and deleted_at is null);
end $$;

revoke execute on function public.lead_pending_recontacts() from public, anon, authenticated, service_role;
grant execute on function public.lead_pending_recontacts() to authenticated;
insert into app_private.client_command(fn) values ('public.lead_pending_recontacts()');

-- Создание миграции от supabase_admin сохраняет владельца старых RPC (postgres).
grant execute on function app_private.lead_pending_recontacts() to postgres;
grant select, insert on app_private.lead_recontact to postgres;

create or replace function public.lead_submit(p_lead jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, app_private, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p_lead->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p_lead->>'phone', '')), 30);
  v_digits text := regexp_replace(coalesce(p_lead->>'phone', ''), '\D', '', 'g');
  v_phone_key text := app_private.lead_phone_key(v_phone,v_digits);
  v_city text := left(trim(coalesce(p_lead->>'city', '')), 80);
  v_budget text := p_lead->>'budget';
  v_timing text := p_lead->>'timing';
  v_manage text := p_lead->>'manage';
  v_experience text := p_lead->>'experience';
  v_place text := p_lead->>'place';
  v_score smallint;
  v_latest public.franchise_lead;
  v_received_at timestamptz;
begin
  -- Ловушка для ботов: скрытое поле, которое человек не видит и не заполняет
  if coalesce(p_lead->>'website', '') <> '' then return jsonb_build_object('ok', true); end if;
  if length(v_name) < 1 or length(v_city) < 2 or length(v_digits) not between 10 and 15 then
    perform app_private.fail('validation', 'Проверьте имя, город и телефон');
  end if;
  if coalesce(v_budget, '') not in ('full', 'partial', 'none') or coalesce(v_timing, '') not in ('month', 'quarter', 'half', 'research')
     or coalesce(v_manage, '') not in ('self', 'manager', 'undecided') or coalesce(v_experience, '') not in ('business', 'some', 'none')
     or coalesce(v_place, '') not in ('has', 'options', 'help')
     or coalesce(p_lead->>'contact_via', '') not in ('whatsapp', 'telegram', 'call') then
    perform app_private.fail('validation', 'Ответьте на все вопросы анкеты');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead-submit:' || v_phone_key, 0));
  select l.* into v_latest from public.franchise_lead l
    where l.phone <> '' and app_private.lead_phone_key(l.phone,l.phone_digits) = v_phone_key
    order by l.created_at desc, l.id desc limit 1 for update;
  v_received_at := clock_timestamp();
  if v_latest.deleted_at is not null then
    if exists (select 1 from app_private.lead_recontact r
      where r.lead_id = v_latest.id and r.received_at > v_latest.deleted_at
        and r.received_at > v_received_at - interval '10 minutes') then
      return jsonb_build_object('ok', true);
    end if;
  elsif v_latest.created_at > v_received_at - interval '10 minutes' then
    return jsonb_build_object('ok', true);
  end if;

  -- Повторные контакты также учитываются в лимите принятых анкет.
  if (select count(*) from public.franchise_lead where created_at > v_received_at - interval '1 day')
    + (select count(*) from app_private.lead_recontact where received_at > v_received_at - interval '1 day') >= 200 then
    perform app_private.fail('rate-limited', 'Слишком много заявок. Напишите нам в WhatsApp');
  end if;
  if v_latest.deleted_at is not null then
    insert into app_private.lead_recontact(lead_id, received_at, name, phone, city, contact_via)
      values(v_latest.id, v_received_at, v_name, v_phone, v_city, p_lead->>'contact_via');
    return jsonb_build_object('ok', true);
  end if;
  v_score := app_private.lead_score(v_budget, v_timing, v_manage, v_experience, v_place);
  insert into public.franchise_lead(name, phone, phone_digits, contact_via, city, budget, timing, manage, experience, place,
    comment, source, score, tier)
  values (v_name, v_phone, v_digits, p_lead->>'contact_via', v_city, v_budget, v_timing, v_manage, v_experience, v_place,
    nullif(left(trim(coalesce(p_lead->>'comment', '')), 1000), ''), nullif(left(coalesce(p_lead->>'source', ''), 300), ''),
    v_score, app_private.lead_tier(v_score, v_budget));
  return jsonb_build_object('ok', true);
end $$;
