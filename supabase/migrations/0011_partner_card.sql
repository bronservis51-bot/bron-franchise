-- 0011
-- 1) Рейтинг ведётся только по франчайзи в России: иностранные в нём не участвуют и сами его не видят.
-- 2) Полная карточка франчайзи у менеджера: контакты, юрлицо, договор, заметки — и документы (договор, допсоглашения, акты).
--    Данные карточки и документы видит только менеджер: франчайзи их не читает (отдельные таблицы без прав чтения, доступ — командами).

------------------------------------------------------------------------------
-- 1. Рейтинг — Россия
------------------------------------------------------------------------------
create function app_private.rating_allowed() returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.is_manager() or exists (
    select 1 from app_private.active_assignments() a join public.partner p on p.id = a.scope_id
    where a.role = 'franchisee' and p.country = 'RU')
$$;

-- Меню строится по разрешениям: иностранному франчайзи «Рейтинг» не показывается.
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'is_demo', u.is_demo)
             from public.app_user u where u.id = auth.uid()),
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

create or replace function public.rating(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date))::date; v_rows jsonb; v_my uuid;
  v_fx_day date := least((date_trunc('month', coalesce(p_month, (now() at time zone 'Europe/Moscow')::date)) + interval '1 month - 1 day')::date,
                         (now() at time zone 'Europe/Moscow')::date);
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('rating.read') or not app_private.rating_allowed() then
    perform app_private.fail('forbidden', 'Рейтинг ведётся по франчайзи в России');
  end if;
  select scope_id into v_my from app_private.active_assignments() where scope_type = 'partner' limit 1;
  with per_loc as (
    select l.partner_id, x.*,
      case when x.elapsed_days > 0 then x.fact_minor::numeric / x.elapsed_days * x.active_days end as forecast_minor
    from public.location l join public.partner p on p.id = l.partner_id
    cross join lateral app_private.loc_progress(l, v_month) x
    where p.status = 'active' and p.country = 'RU' and l.status = 'active' and x.active_days > 0
  ), per_partner as (
    select p.id, p.name, p.currency,
      (select string_agg(distinct l.city, ', ') from public.location l where l.partner_id = p.id and l.status = 'active') as cities,
      count(*)::int as points,
      sum(g.forecast_minor) filter (where g.plan_minor is not null) as forecast_planned,
      sum(g.plan_minor) as plan_minor,
      sum(g.fact_minor) filter (where g.plan_minor is not null) as fact_planned,
      sum(g.fact_minor) as fact_minor,
      sum(g.forecast_minor) as forecast_minor,
      sum(g.elapsed_days) as elapsed, sum(g.filled_days) as filled,
      sum(g.fact_same_minor) as same, sum(g.prev_same_minor) as prev_same
    from public.partner p join per_loc g on g.partner_id = p.id group by p.id, p.name, p.currency
  ), scored as (
    select *,
      case when plan_minor > 0 and elapsed > 0 then round(forecast_planned * 100.0 / plan_minor, 1) end as forecast_pct,
      case when plan_minor > 0 then round(coalesce(fact_planned, 0) * 100.0 / plan_minor, 1) end as pct_to_date,
      case when elapsed > 0 then round(filled * 100.0 / elapsed) end as fill_pct,
      case when prev_same > 0 then round((same - prev_same) * 100.0 / prev_same, 1) end as growth_pct,
      app_private.fx_rub(currency, v_fx_day) as fx
    from per_partner
  ), ranked as (
    select *, row_number() over (order by forecast_pct desc nulls last, fill_pct desc nulls last, name) as rank from scored
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rank, 'partner_id', id, 'partner_name', name, 'cities', cities, 'is_me', id = v_my, 'points', points,
      'currency', currency, 'fact_minor', fact_minor, 'plan_minor', plan_minor, 'forecast_minor', round(forecast_minor)::bigint,
      'fact_rub_minor', round(fact_minor * fx)::bigint, 'forecast_rub_minor', round(forecast_minor * fx)::bigint,
      'forecast_pct', forecast_pct, 'pct_to_date', pct_to_date, 'fill_pct', fill_pct, 'growth_pct', growth_pct,
      'badges', to_jsonb(array_remove(array[
        case when rank = 1 and forecast_pct is not null then 'leader' end,
        case when forecast_pct >= 100 then 'plan' end,
        case when fill_pct = 100 and elapsed >= 3 then 'no_gaps' end,
        case when growth_pct >= 10 then 'growth' end], null))
    ) order by rank), '[]'::jsonb) into v_rows
  from ranked;
  return jsonb_build_object('month', v_month, 'rows', v_rows);
end $$;

------------------------------------------------------------------------------
-- 2. Карточка франчайзи
------------------------------------------------------------------------------
create table public.partner_profile (
  partner_id uuid primary key references public.partner(id),
  -- контакты
  owner_name text, phone2 text, telegram text, whatsapp text, contact_notes text,
  -- юрлицо
  legal_form text, legal_name text, inn text, ogrn text, legal_address text, bank_details text,
  -- договор
  contract_number text, contract_date date, contract_until date, franchise_fee_minor bigint check (franchise_fee_minor >= 0),
  started_on date, territory text,
  notes text,
  updated_by uuid references public.app_user(id),
  updated_at timestamptz not null default now()
);
alter table public.partner_profile enable row level security;

create table public.partner_document (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner(id),
  kind text not null check (kind in ('contract', 'addendum', 'act', 'passport', 'other')),
  title text not null check (length(trim(title)) between 1 and 200),
  path text not null unique,
  size_bytes bigint,
  mime text,
  signed_on date,
  uploaded_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index on public.partner_document (partner_id);
alter table public.partner_document enable row level security;

-- Файлы документов: private-files/partner/<partner_id>/<файл>; загружать, открывать и удалять может только менеджер.
insert into storage.buckets(id, name, public) values ('private-files', 'private-files', false) on conflict (id) do nothing;
create policy partner_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'private-files' and (storage.foldername(name))[1] = 'partner' and app_private.has_perm('org.manage'));
create policy partner_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'private-files' and (storage.foldername(name))[1] = 'partner' and app_private.has_perm('org.manage'));
create policy partner_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'private-files' and (storage.foldername(name))[1] = 'partner' and app_private.has_perm('org.manage'));

create function public.partner_card(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  return jsonb_build_object(
    'partner', to_jsonb(p),
    'profile', (select to_jsonb(x) - 'partner_id' - 'updated_by' from public.partner_profile x where x.partner_id = p_partner),
    'updated_by_name', (select u.full_name from public.partner_profile x join public.app_user u on u.id = x.updated_by where x.partner_id = p_partner),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'city', l.city, 'address', l.address,
        'status', l.status, 'opened_on', l.opened_on,
        'first_day', (select min(day) from public.daily_revenue r where r.location_id = l.id),
        'last_day', (select max(day) from public.daily_revenue r where r.location_id = l.id)) order by l.opened_on nulls last, l.name)
      from public.location l where l.partner_id = p_partner), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'path', d.path,
        'size_bytes', d.size_bytes, 'mime', d.mime, 'signed_on', d.signed_on, 'created_at', d.created_at, 'uploaded_by', u.full_name)
        order by d.created_at desc)
      from public.partner_document d left join public.app_user u on u.id = d.uploaded_by where d.partner_id = p_partner), '[]'::jsonb),
    'stats', jsonb_build_object(
      'opened_on', (select min(coalesce(l.opened_on, (select min(day) from public.daily_revenue r where r.location_id = l.id)))
                    from public.location l where l.partner_id = p_partner),
      'revenue_12m_minor', (select coalesce(sum(total_minor), 0) from public.daily_revenue
                            where partner_id = p_partner and day >= (current_date - interval '12 months')::date),
      'rate_bp', app_private.rate_bp(p_partner, app_private.current_month()),
      'users', (select count(*) from public.role_assignment where scope_id = p_partner and role = 'franchisee' and revoked_at is null),
      'staff', (select count(*) from public.staff_member where partner_id = p_partner and active)));
end $$;

-- Сохранить карточку: только перечисленные поля; пустая строка — очистить поле.
create function public.partner_profile_save(p_partner uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare
  t text[] := array['owner_name', 'phone2', 'telegram', 'whatsapp', 'contact_notes', 'legal_form', 'legal_name', 'inn', 'ogrn',
                    'legal_address', 'bank_details', 'contract_number', 'territory', 'notes'];
  d text[] := array['contract_date', 'contract_until', 'started_on'];
  k text; v text; sets text[] := '{}';
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if not exists (select 1 from public.partner where id = p_partner) then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  insert into public.partner_profile(partner_id, updated_by) values (p_partner, auth.uid()) on conflict (partner_id) do nothing;
  for k in select jsonb_object_keys(coalesce(p_data, '{}'::jsonb)) loop
    v := nullif(trim(p_data ->> k), '');
    if k = any(t) then
      if length(v) > 2000 then perform app_private.fail('validation', 'Слишком длинное значение', k); end if;
      sets := sets || format('%I = %L', k, v);
    elsif k = any(d) then
      begin perform v::date; exception when others then perform app_private.fail('validation', 'Неверная дата', k); end;
      sets := sets || format('%I = %L::date', k, v);
    elsif k = 'franchise_fee_minor' then
      if v is not null and (v !~ '^\d+$') then perform app_private.fail('validation', 'Неверная сумма', k); end if;
      sets := sets || format('franchise_fee_minor = %L::bigint', v);
    else
      perform app_private.fail('validation', 'Неизвестное поле карточки', k);
    end if;
  end loop;
  if (p_data ->> 'contract_date') is not null and (p_data ->> 'contract_until') is not null
     and nullif(p_data ->> 'contract_until', '')::date < nullif(p_data ->> 'contract_date', '')::date then
    perform app_private.fail('validation', 'Срок договора раньше даты заключения', 'contract_until');
  end if;
  if array_length(sets, 1) > 0 then
    execute format('update public.partner_profile set %s, updated_by = %L, updated_at = now() where partner_id = %L',
      array_to_string(sets, ', '), auth.uid(), p_partner);
  end if;
  perform app_private.audit('partner.profile', 'partner', p_partner, p_partner, p_data);
end $$;

create function public.partner_document_add(p_partner uuid, p_kind text, p_title text, p_path text, p_size bigint, p_mime text,
  p_signed_on date default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if not exists (select 1 from public.partner where id = p_partner) then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  if p_kind not in ('contract', 'addendum', 'act', 'passport', 'other') then perform app_private.fail('validation', 'Выберите тип документа', 'kind'); end if;
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название документа', 'title'); end if;
  if p_path is null or p_path not like 'partner/' || p_partner || '/%' then perform app_private.fail('validation', 'Неверный путь файла', 'path'); end if;
  insert into public.partner_document(partner_id, kind, title, path, size_bytes, mime, signed_on, uploaded_by)
  values (p_partner, p_kind, left(trim(p_title), 200), p_path, p_size, p_mime, p_signed_on, auth.uid()) returning id into v_id;
  perform app_private.audit('partner.document.add', 'partner', p_partner, p_partner, jsonb_build_object('title', p_title, 'kind', p_kind));
  return v_id;
end $$;

-- Удалить запись документа; файл из хранилища удаляет клиент по возвращённому пути.
create function public.partner_document_delete(p_id uuid) returns text
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare d public.partner_document;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  delete from public.partner_document where id = p_id returning * into d;
  if d.id is null then perform app_private.fail('not-found', 'Документ не найден'); end if;
  perform app_private.audit('partner.document.delete', 'partner', d.partner_id, d.partner_id, jsonb_build_object('title', d.title, 'path', d.path));
  return d.path;
end $$;

insert into app_private.client_command(fn) values
  ('public.partner_card(uuid)'), ('public.partner_profile_save(uuid, jsonb)'),
  ('public.partner_document_add(uuid, text, text, text, bigint, text, date)'), ('public.partner_document_delete(uuid)');
select app_private.apply_grants();
