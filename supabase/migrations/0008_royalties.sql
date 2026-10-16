-- 0008 Royalties: отчёты, редакции, импорт, расчёты, начисления, корректировки, оплаты, распределения, споры (ROY-01…13).
-- Деньги — bigint в минорных единицах; ставка — базисные пункты (ADR-0009).

create table public.revenue_report (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  contract_id uuid not null references public.contract(id),
  partner_id uuid not null references public.partner(id),
  period date not null check (extract(day from period) = 1),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'in_review', 'needs_correction', 'approved', 'closed')),
  current_revision_id uuid,
  partner_ref text, -- номер отчёта у партнёра: уникален только в области партнёра (AT-16)
  return_reason text,
  calculation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  unique (contract_id, period),
  unique (partner_id, partner_ref)
);

create table public.report_revision (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.revenue_report(id),
  rev_no int not null,
  source text not null default 'manual' check (source in ('manual', 'import', 'system')),
  verification_level text not null default 'reported' check (verification_level in ('reported', 'imported', 'verified')),
  comment text,
  locked boolean not null default false,
  submitted_at timestamptz,
  submitted_by uuid references public.app_user(id),
  import_batch_id uuid,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  unique (report_id, rev_no)
);
alter table public.revenue_report add foreign key (current_revision_id) references public.report_revision(id);

create table public.report_line (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.report_revision(id),
  location_id uuid not null references public.location(id),
  currency text not null references public.currency(code),
  gross_minor bigint not null check (gross_minor >= 0),
  returns_minor bigint not null default 0 check (returns_minor >= 0),
  excluded_minor bigint not null default 0 check (excluded_minor >= 0),
  base_minor bigint generated always as (gross_minor - returns_minor - excluded_minor) stored,
  zero_reason text,
  ops_from date,
  ops_to date,
  unique (revision_id, location_id),
  check (gross_minor - returns_minor - excluded_minor >= 0),
  check (gross_minor > 0 or zero_reason is not null)
);

-- Заблокированная редакция неизменна (ROY-04).
create function app_private.revision_guard() returns trigger language plpgsql as $$
declare v_locked boolean;
begin
  select locked into v_locked from public.report_revision where id = coalesce(new.revision_id, old.revision_id);
  if v_locked then perform app_private.fail('transition-not-allowed', 'Отправленная редакция не изменяется'); end if;
  return coalesce(new, old);
end $$;
create trigger report_line_guard before insert or update or delete on public.report_line
  for each row execute function app_private.revision_guard();

create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contract(id),
  period date not null,
  file_hash text not null,
  file_name text,
  rows jsonb not null,
  errors jsonb not null default '[]'::jsonb,
  status text not null check (status in ('applied', 'rejected')),
  revision_id uuid references public.report_revision(id),
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  unique (contract_id, period, file_hash)
);

create table public.calculation (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.revenue_report(id),
  revision_id uuid not null references public.report_revision(id),
  inputs jsonb not null, -- строки, версии политик, сегменты: расчёт воспроизводим (AT-09)
  base_minor bigint not null,
  exact_amount numeric not null,
  amount_minor bigint not null,
  currency text not null references public.currency(code),
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
alter table public.revenue_report add foreign key (calculation_id) references public.calculation(id);

create table public.accrual (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  contract_id uuid not null references public.contract(id),
  partner_id uuid not null references public.partner(id),
  period date not null,
  kind text not null default 'royalty' check (kind in ('royalty')),
  calculation_id uuid not null references public.calculation(id),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null references public.currency(code),
  due_on date not null,
  status text not null default 'published' check (status in ('published', 'void')),
  published_by uuid references public.app_user(id),
  published_at timestamptz not null default now()
);
create unique index accrual_one_published on public.accrual (contract_id, period, kind) where status = 'published';

create table public.adjustment (
  id uuid primary key default gen_random_uuid(),
  accrual_id uuid not null references public.accrual(id),
  direction text not null check (direction in ('debit', 'credit')),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  ref text,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);

create table public.payment (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  partner_id uuid not null references public.partner(id),
  contract_id uuid references public.contract(id),
  source text not null check (source in ('partner_report', 'bank_statement', 'bank_import')),
  status text not null check (status in ('reported', 'registered', 'confirmed', 'rejected', 'reversed')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null references public.currency(code),
  paid_on date not null,
  partner_ref text,
  bank_ref text,
  receipt_file_id uuid references public.file_asset(id),
  comment text,
  reported_by uuid references public.app_user(id),
  registered_by uuid references public.app_user(id),
  registered_at timestamptz,
  confirmed_by uuid references public.app_user(id),
  confirmed_at timestamptz,
  status_reason text,
  created_at timestamptz not null default now(),
  revision int not null default 1
);
-- Одна банковская операция регистрируется один раз (повтор не засчитывает деньги повторно).
create unique index payment_bank_ref on public.payment (bank_ref) where bank_ref is not null and status <> 'rejected';

create table public.allocation (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payment(id),
  accrual_id uuid not null references public.accrual(id),
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'active' check (status in ('active', 'reversed')),
  reversed_reason text,
  reversed_by uuid references public.app_user(id),
  reversed_at timestamptz,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now()
);
create index on public.allocation (payment_id) where status = 'active';
create index on public.allocation (accrual_id) where status = 'active';

create table public.dispute (
  id uuid primary key default gen_random_uuid(),
  accrual_id uuid not null references public.accrual(id),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolution text,
  opened_by uuid references public.app_user(id),
  resolved_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.royalty_note (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  partner_id uuid not null references public.partner(id),
  body text not null,
  author_id uuid references public.app_user(id),
  created_at timestamptz not null default now()
);

create table public.royalty_event (
  id bigint generated always as identity primary key,
  subject_type text not null,
  subject_id uuid not null,
  partner_id uuid not null,
  actor_id uuid,
  action text not null,
  detail jsonb,
  comment text,
  at timestamptz not null default now()
);
create index on public.royalty_event (subject_type, subject_id);

create function app_private.roy_log(p_type text, p_id uuid, p_partner uuid, p_action text, p_detail jsonb, p_comment text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.royalty_event(subject_type, subject_id, partner_id, actor_id, action, detail, comment)
  values (p_type, p_id, p_partner, auth.uid(), p_action, p_detail, p_comment)
$$;

------------------------------------------------------------------------------
-- Остатки (ROY-11)
------------------------------------------------------------------------------
create view public.v_accrual_balance with (security_invoker = true) as
select a.id as accrual_id, a.number, a.contract_id, a.partner_id, a.period, a.currency, a.amount_minor, a.due_on, a.status,
  x.debit_minor, x.credit_minor, x.allocated_minor,
  (a.amount_minor + x.debit_minor - x.credit_minor - x.allocated_minor)::bigint as outstanding_minor,
  x.disputed_minor
from public.accrual a
cross join lateral (select
  coalesce((select sum(amount_minor) from public.adjustment j where j.accrual_id = a.id and j.direction = 'debit'), 0)::bigint as debit_minor,
  coalesce((select sum(amount_minor) from public.adjustment j where j.accrual_id = a.id and j.direction = 'credit'), 0)::bigint as credit_minor,
  coalesce((select sum(l.amount_minor) from public.allocation l join public.payment p on p.id = l.payment_id
            where l.accrual_id = a.id and l.status = 'active' and p.status = 'confirmed'), 0)::bigint as allocated_minor,
  coalesce((select sum(amount_minor) from public.dispute d where d.accrual_id = a.id and d.status = 'open'), 0)::bigint as disputed_minor) x
where a.status = 'published';

create view public.v_payment_balance with (security_invoker = true) as
select p.id as payment_id, p.number, p.partner_id, p.contract_id, p.currency, p.amount_minor, p.status, p.paid_on, p.source,
  x.allocated_minor, (p.amount_minor - x.allocated_minor)::bigint as unallocated_minor
from public.payment p
cross join lateral (select coalesce((select sum(amount_minor) from public.allocation l where l.payment_id = p.id and l.status = 'active'), 0)::bigint as allocated_minor) x;

create function app_private.accrual_outstanding(p_accrual uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select outstanding_minor from public.v_accrual_balance where accrual_id = p_accrual
$$;

------------------------------------------------------------------------------
-- Округление и расчёт (ROY-07, ROY-08)
------------------------------------------------------------------------------
create function app_private.round_money(v numeric, p_rule text) returns bigint
language sql immutable as $$
  select case p_rule
    when 'down' then trunc(v)::bigint
    when 'half_even' then case when v - floor(v) = 0.5 then (floor(v) + (floor(v)::bigint % 2))::bigint else round(v)::bigint end
    else round(v)::bigint end -- half_up для неотрицательных сумм
$$;

-- Версии политики, действующие в периоде [p_from, p_to].
create function app_private.policies_in_period(p_contract uuid, p_from date, p_to date) returns setof public.contract_policy_version
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.contract_policy_version v
  where v.contract_id = p_contract and v.effective_from <= p_to
    and (v.effective_from >= p_from or v.effective_from = (
      select max(effective_from) from public.contract_policy_version where contract_id = p_contract and effective_from <= p_from))
  order by v.effective_from
$$;

-- Чистая функция расчёта: по строкам, версиям и сегментам. Используется при утверждении и для воспроизведения.
create function app_private.royalty_compute(p_contract uuid, p_period date, p_base bigint, p_segments jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := p_period; v_to date := (p_period + interval '1 month' - interval '1 day')::date;
  v_versions jsonb; v_count int; v_exact numeric := 0; v_seg jsonb; v_pol public.contract_policy_version; v_prev_to date;
  v_seg_sum bigint := 0; v_rounding text; v_out jsonb := '[]'::jsonb;
begin
  select jsonb_agg(to_jsonb(v) order by v.effective_from), count(*) into v_versions, v_count
  from app_private.policies_in_period(p_contract, v_from, v_to) v;
  if v_count = 0 then perform app_private.fail('validation', 'Нет расчётной политики, действующей в периоде'); end if;
  if v_count = 1 then
    select * into v_pol from app_private.policies_in_period(p_contract, v_from, v_to);
    v_exact := p_base::numeric * v_pol.rate_bp / 10000;
    v_rounding := v_pol.rounding;
    v_out := jsonb_build_array(jsonb_build_object('from', v_from, 'to', v_to, 'base_minor', p_base, 'policy_version', v_pol.version,
      'policy_id', v_pol.id, 'rate_bp', v_pol.rate_bp, 'exact', v_exact));
  else
    -- ROY-01a: в периоде несколько версий — нужна подтверждённая разбивка базы
    if p_segments is null or jsonb_array_length(p_segments) = 0 then
      perform app_private.fail('policy-split-required', 'В периоде действовали разные ставки: разделите базу по датам', v_versions::text);
    end if;
    v_prev_to := v_from - 1;
    for v_seg in select * from jsonb_array_elements(p_segments) s order by (s ->> 'from')::date loop
      if (v_seg ->> 'from')::date <> v_prev_to + 1 or (v_seg ->> 'to')::date < (v_seg ->> 'from')::date then
        perform app_private.fail('validation', 'Сегменты должны покрывать период без разрывов и пересечений');
      end if;
      select * into v_pol from public.contract_policy_version
        where contract_id = p_contract and effective_from <= (v_seg ->> 'from')::date order by effective_from desc limit 1;
      if exists (select 1 from public.contract_policy_version where contract_id = p_contract
                 and effective_from > (v_seg ->> 'from')::date and effective_from <= (v_seg ->> 'to')::date) then
        perform app_private.fail('validation', 'Сегмент пересекает дату смены ставки', v_seg::text);
      end if;
      if (v_seg ->> 'base_minor')::bigint < 0 then perform app_private.fail('validation', 'Отрицательная база сегмента'); end if;
      v_exact := v_exact + (v_seg ->> 'base_minor')::numeric * v_pol.rate_bp / 10000;
      v_seg_sum := v_seg_sum + (v_seg ->> 'base_minor')::bigint;
      v_rounding := coalesce(v_rounding, v_pol.rounding);
      v_out := v_out || jsonb_build_object('from', v_seg ->> 'from', 'to', v_seg ->> 'to', 'base_minor', (v_seg ->> 'base_minor')::bigint,
        'policy_version', v_pol.version, 'policy_id', v_pol.id, 'rate_bp', v_pol.rate_bp,
        'exact', (v_seg ->> 'base_minor')::numeric * v_pol.rate_bp / 10000);
      v_prev_to := (v_seg ->> 'to')::date;
    end loop;
    if v_prev_to <> v_to then perform app_private.fail('validation', 'Сегменты должны покрывать весь период'); end if;
    if v_seg_sum <> p_base then perform app_private.fail('validation', 'Сумма сегментов не равна базе отчёта',
      v_seg_sum::text || ' ≠ ' || p_base::text); end if;
    -- правило округления — последней действующей версии периода
    select rounding into v_rounding from app_private.policies_in_period(p_contract, v_from, v_to) order by effective_from desc limit 1;
  end if;
  return jsonb_build_object('segments', v_out, 'exact', v_exact, 'rounding', v_rounding,
    'amount_minor', app_private.round_money(v_exact, v_rounding), 'policies', v_versions);
end $$;

------------------------------------------------------------------------------
-- Разделение обязанностей (AUTH-04)
------------------------------------------------------------------------------
create function app_private.sod_check(p_other_actor uuid, p_action text, p_entity_type text, p_entity uuid, p_partner uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_policy text;
begin
  if p_other_actor is distinct from auth.uid() then return; end if;
  select sod_policy into v_policy from public.operator limit 1;
  if coalesce(v_policy, 'strict') = 'strict' then
    perform app_private.fail('forbidden', 'Инициатор не может утвердить собственную операцию (разделение обязанностей)', p_action);
  end if;
  perform app_private.audit('sod_override', p_entity_type, p_entity, p_partner, jsonb_build_object('action', p_action),
    'Политика allow_with_log');
  perform app_private.task_create('sod_review', 'Проверить операцию без разделения обязанностей: ' || p_action, null,
    'founder', p_partner, null, p_entity_type, p_entity, now() + interval '3 days', 'high', false, 'sod:' || p_action || ':' || p_entity);
end $$;

------------------------------------------------------------------------------
-- Отчёт
------------------------------------------------------------------------------
create function app_private.can_read_royalty(p_partner uuid) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select app_private.has_perm('royalty.read', p_partner, null)
$$;

create function app_private.report_load(p_report uuid) returns public.revenue_report
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.revenue_report;
begin
  select * into r from public.revenue_report where id = p_report for update;
  if not found or not app_private.can_read_royalty(r.partner_id) then perform app_private.fail('not-found', 'Отчёт не найден'); end if;
  return r;
end $$;

-- Записать строки в редактируемую редакцию (создаёт её при необходимости).
create function app_private.report_write_lines(r public.revenue_report, p_lines jsonb, p_source text, p_comment text, p_batch uuid) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_rev public.report_revision; v_line jsonb; c public.contract; v_end date := (r.period + interval '1 month' - interval '1 day')::date;
begin
  select * into c from public.contract where id = r.contract_id;
  select * into v_rev from public.report_revision where id = r.current_revision_id;
  if v_rev.id is null or v_rev.locked then
    insert into public.report_revision(report_id, rev_no, source, verification_level, comment, created_by, import_batch_id)
    values (r.id, coalesce(v_rev.rev_no, 0) + 1, p_source, case when p_source = 'import' then 'imported' else 'reported' end,
            p_comment, auth.uid(), p_batch)
    returning * into v_rev;
    update public.revenue_report set current_revision_id = v_rev.id where id = r.id;
  else
    update public.report_revision set source = p_source, comment = p_comment, import_batch_id = p_batch,
      verification_level = case when p_source = 'import' then 'imported' else 'reported' end
    where id = v_rev.id;
    delete from public.report_line where revision_id = v_rev.id; -- замена, а не добавление (AT-07)
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    -- MODEL-01: точка должна входить в договор в этом периоде
    if not exists (select 1 from public.contract_location cl where cl.contract_id = c.id and cl.location_id = (v_line ->> 'location_id')::uuid
                   and cl.valid_from <= v_end and (cl.valid_to is null or cl.valid_to >= r.period)) then
      perform app_private.fail('validation', 'Точка не входит в договор в этом периоде', v_line ->> 'location_id');
    end if;
    if coalesce(v_line ->> 'currency', c.currency) <> c.currency then
      perform app_private.fail('validation', 'Валюта строки не совпадает с валютой договора', v_line ->> 'currency');
    end if;
    insert into public.report_line(revision_id, location_id, currency, gross_minor, returns_minor, excluded_minor, zero_reason, ops_from, ops_to)
    values (v_rev.id, (v_line ->> 'location_id')::uuid, c.currency, coalesce((v_line ->> 'gross_minor')::bigint, 0),
      coalesce((v_line ->> 'returns_minor')::bigint, 0), coalesce((v_line ->> 'excluded_minor')::bigint, 0),
      nullif(trim(v_line ->> 'zero_reason'), ''), (v_line ->> 'ops_from')::date, (v_line ->> 'ops_to')::date);
  end loop;
  return v_rev.id;
end $$;

create function public.report_save_draft(p_contract uuid, p_period date, p_lines jsonb, p_comment text default null,
  p_partner_ref text default null) returns public.revenue_report
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.contract; r public.revenue_report;
begin
  perform app_private.require_user();
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.can_read_royalty(c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  perform app_private.require_perm('royalty.report.submit', c.partner_id);
  if extract(day from p_period) <> 1 then perform app_private.fail('validation', 'Период — первый день месяца', 'period'); end if;
  if p_period < date_trunc('month', c.valid_from)::date or (c.valid_to is not null and p_period > c.valid_to) then
    perform app_private.fail('validation', 'Договор не действует в этом периоде', 'period');
  end if;
  if p_period > date_trunc('month', now())::date then perform app_private.fail('validation', 'Период ещё не наступил', 'period'); end if;
  insert into public.revenue_report(number, contract_id, partner_id, period, partner_ref)
  values (app_private.next_number('ОЧ'), c.id, c.partner_id, p_period, nullif(trim(p_partner_ref), ''))
  on conflict (contract_id, period) do nothing;
  select * into r from public.revenue_report where contract_id = p_contract and period = p_period for update;
  if r.status not in ('draft', 'needs_correction') then
    perform app_private.fail('transition-not-allowed', 'Отчёт уже отправлен; изменения — через возврат на исправление', r.status);
  end if;
  perform app_private.report_write_lines(r, coalesce(p_lines, '[]'::jsonb), 'manual', p_comment, null);
  update public.revenue_report set partner_ref = coalesce(nullif(trim(p_partner_ref), ''), partner_ref), updated_at = now(),
    revision = revision + 1 where id = r.id returning * into r;
  return r;
end $$;

-- Импорт строк из таблицы с протоколом ошибок; повтор того же файла не меняет базу (ROY-06, AT-07).
create function public.report_import(p_contract uuid, p_period date, p_file_hash text, p_file_name text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c public.contract; r public.revenue_report; b public.import_batch; v_row jsonb; v_errors jsonb := '[]'::jsonb;
  v_lines jsonb := '[]'::jsonb; v_loc uuid; v_seen text[] := '{}'; i int := 0; v_batch uuid;
begin
  perform app_private.require_user();
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.can_read_royalty(c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  perform app_private.require_perm('royalty.report.submit', c.partner_id);
  select * into b from public.import_batch where contract_id = p_contract and period = p_period and file_hash = p_file_hash;
  if found then
    return jsonb_build_object('batch_id', b.id, 'status', b.status, 'errors', b.errors, 'replayed', true);
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    select l.id into v_loc from public.location l join public.contract_location cl on cl.location_id = l.id and cl.contract_id = c.id
      where l.code = v_row ->> 'location_code';
    if v_loc is null then
      v_errors := v_errors || jsonb_build_object('row', i, 'field', 'location_code', 'error', 'Точка не входит в договор');
    elsif (v_row ->> 'location_code') = any(v_seen) then
      v_errors := v_errors || jsonb_build_object('row', i, 'field', 'location_code', 'error', 'Повтор точки в файле');
    elsif coalesce(v_row ->> 'currency', c.currency) <> c.currency then
      v_errors := v_errors || jsonb_build_object('row', i, 'field', 'currency', 'error', 'Валюта не совпадает с договором');
    elsif coalesce(v_row ->> 'gross_minor', '') !~ '^\d+$' or coalesce(v_row ->> 'returns_minor', '0') !~ '^\d+$' then
      v_errors := v_errors || jsonb_build_object('row', i, 'field', 'gross_minor', 'error', 'Сумма должна быть целым числом в минорных единицах');
    else
      v_seen := v_seen || (v_row ->> 'location_code');
      v_lines := v_lines || jsonb_build_object('location_id', v_loc, 'gross_minor', (v_row ->> 'gross_minor')::bigint,
        'returns_minor', coalesce((v_row ->> 'returns_minor')::bigint, 0), 'excluded_minor', coalesce((v_row ->> 'excluded_minor')::bigint, 0),
        'zero_reason', v_row ->> 'zero_reason');
    end if;
  end loop;
  v_batch := gen_random_uuid();
  if jsonb_array_length(v_errors) > 0 then
    insert into public.import_batch(id, contract_id, period, file_hash, file_name, rows, errors, status, created_by)
    values (v_batch, p_contract, p_period, p_file_hash, p_file_name, p_rows, v_errors, 'rejected', auth.uid());
    return jsonb_build_object('batch_id', v_batch, 'status', 'rejected', 'errors', v_errors, 'replayed', false);
  end if;
  r := public.report_save_draft(p_contract, p_period, '[]'::jsonb, 'Импорт ' || coalesce(p_file_name, ''));
  insert into public.import_batch(id, contract_id, period, file_hash, file_name, rows, errors, status, created_by)
  values (v_batch, p_contract, p_period, p_file_hash, p_file_name, p_rows, '[]'::jsonb, 'applied', auth.uid());
  update public.import_batch set revision_id = app_private.report_write_lines(r, v_lines, 'import', 'Импорт ' || coalesce(p_file_name, ''), v_batch)
  where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'status', 'applied', 'errors', '[]'::jsonb, 'rows', jsonb_array_length(v_lines), 'replayed', false);
end $$;

create function public.report_submit(p_report uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_prev jsonb; r public.revenue_report; v_rev public.report_revision; v_result jsonb;
begin
  v_prev := app_private.idem_begin('report_submit', p_key, jsonb_build_object('report', p_report));
  if v_prev is not null then return v_prev; end if;
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.report.submit', r.partner_id);
  if r.status not in ('draft', 'needs_correction') then perform app_private.fail('transition-not-allowed', 'Отчёт уже отправлен', r.status); end if;
  select * into v_rev from public.report_revision where id = r.current_revision_id;
  if v_rev.id is null or v_rev.locked then perform app_private.fail('validation', 'Нет черновика для отправки'); end if;
  if not exists (select 1 from public.report_line where revision_id = v_rev.id) then
    perform app_private.fail('validation', 'Добавьте строки по точкам (нулевая выручка — с причиной)');
  end if;
  update public.report_revision set locked = true, submitted_at = now(), submitted_by = v_user where id = v_rev.id;
  update public.revenue_report set status = 'submitted', return_reason = null, updated_at = now(), revision = revision + 1
  where id = p_report returning * into r;
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'submitted', jsonb_build_object('rev_no', v_rev.rev_no), null);
  perform app_private.audit('report.submit', 'revenue_report', r.id, r.partner_id, jsonb_build_object('rev_no', v_rev.rev_no));
  perform app_private.notify_queue('finance', r.partner_id, null, 'report.submitted', 'Отчёт на проверку: ' || r.number,
    to_char(r.period, 'MM.YYYY'), 'revenue_report', r.id, '/royalties/reports/' || r.id, 'report.submitted:' || r.id || ':' || v_rev.rev_no);
  v_result := jsonb_build_object('report_id', r.id, 'status', r.status, 'rev_no', v_rev.rev_no);
  return app_private.idem_finish('report_submit', p_key, v_result);
end $$;

create function public.report_take_review(p_report uuid) returns public.revenue_report
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.revenue_report;
begin
  perform app_private.require_user();
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.review', r.partner_id);
  if r.status <> 'submitted' then perform app_private.fail('transition-not-allowed', 'Отчёт не ожидает проверки', r.status); end if;
  update public.revenue_report set status = 'in_review', updated_at = now(), revision = revision + 1 where id = p_report returning * into r;
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'review_started', null, null);
  return r;
end $$;

create function public.report_return(p_report uuid, p_reason text) returns public.revenue_report
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.revenue_report;
begin
  perform app_private.require_user();
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.review', r.partner_id);
  if r.status not in ('submitted', 'in_review') then perform app_private.fail('transition-not-allowed', 'Отчёт не на проверке', r.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите, что исправить', 'reason'); end if;
  update public.revenue_report set status = 'needs_correction', return_reason = p_reason, updated_at = now(), revision = revision + 1
  where id = p_report returning * into r;
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'returned', null, p_reason);
  perform app_private.notify_queue('partner_owner', r.partner_id, null, 'report.returned', 'Исправьте отчёт ' || r.number, p_reason,
    'revenue_report', r.id, '/royalties/reports/' || r.id, 'report.returned:' || r.id || ':' || r.revision, true);
  return r;
end $$;

-- Утверждение: снимок входных данных и расчёт по версиям политики (ROY-07). Публикация начисления — отдельно.
create function public.report_approve(p_report uuid, p_segments jsonb default null, p_verification text default 'reported',
  p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); r public.revenue_report; v_rev public.report_revision; v_base bigint;
  v_calc jsonb; v_lines jsonb; v_id uuid; c public.contract;
begin
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.review', r.partner_id);
  if r.status not in ('submitted', 'in_review') then perform app_private.fail('transition-not-allowed', 'Отчёт не на проверке', r.status); end if;
  if p_verification not in ('reported', 'imported', 'verified') then perform app_private.fail('validation', 'Неверная степень проверки'); end if;
  select * into v_rev from public.report_revision where id = r.current_revision_id;
  select * into c from public.contract where id = r.contract_id;
  select coalesce(sum(base_minor), 0), jsonb_agg(jsonb_build_object('location_id', location_id, 'gross_minor', gross_minor,
         'returns_minor', returns_minor, 'excluded_minor', excluded_minor, 'base_minor', base_minor, 'zero_reason', zero_reason) order by location_id)
    into v_base, v_lines from public.report_line where revision_id = v_rev.id;
  v_calc := app_private.royalty_compute(r.contract_id, r.period, v_base, p_segments);
  insert into public.calculation(report_id, revision_id, inputs, base_minor, exact_amount, amount_minor, currency, created_by)
  values (r.id, v_rev.id, jsonb_build_object('lines', v_lines, 'segments', v_calc -> 'segments', 'policies', v_calc -> 'policies',
          'rounding', v_calc ->> 'rounding', 'rev_no', v_rev.rev_no, 'verification_level', p_verification),
          v_base, (v_calc ->> 'exact')::numeric, (v_calc ->> 'amount_minor')::bigint, c.currency, v_user)
  returning id into v_id;
  update public.report_revision set verification_level = p_verification where id = v_rev.id;
  update public.revenue_report set status = 'approved', calculation_id = v_id, updated_at = now(), revision = revision + 1
  where id = p_report returning * into r;
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'approved',
    jsonb_build_object('base_minor', v_base, 'amount_minor', (v_calc ->> 'amount_minor')::bigint), p_comment);
  perform app_private.audit('report.approve', 'revenue_report', r.id, r.partner_id,
    jsonb_build_object('calculation', v_id, 'base_minor', v_base, 'amount_minor', (v_calc ->> 'amount_minor')::bigint), p_comment);
  return jsonb_build_object('report_id', r.id, 'calculation_id', v_id, 'base_minor', v_base,
    'amount_minor', (v_calc ->> 'amount_minor')::bigint, 'currency', c.currency, 'segments', v_calc -> 'segments');
end $$;

-- Воспроизведение сохранённого расчёта по его входным данным (AT-09).
create function public.calculation_replay(p_calculation uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare k public.calculation; r public.revenue_report; v_exact numeric := 0; s jsonb;
begin
  perform app_private.require_user();
  select * into k from public.calculation where id = p_calculation;
  select * into r from public.revenue_report where id = k.report_id;
  if not found or not app_private.can_read_royalty(r.partner_id) then perform app_private.fail('not-found', 'Расчёт не найден'); end if;
  for s in select * from jsonb_array_elements(k.inputs -> 'segments') loop
    v_exact := v_exact + (s ->> 'base_minor')::numeric * (s ->> 'rate_bp')::int / 10000;
  end loop;
  return jsonb_build_object('stored_amount_minor', k.amount_minor, 'replayed_amount_minor', app_private.round_money(v_exact, k.inputs ->> 'rounding'),
    'matches', k.amount_minor = app_private.round_money(v_exact, k.inputs ->> 'rounding'));
end $$;

------------------------------------------------------------------------------
-- Начисление, закрытие, корректировки, споры
------------------------------------------------------------------------------
create function public.accrual_publish(p_report uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_prev jsonb; r public.revenue_report; k public.calculation; pol public.contract_policy_version;
  v_due date; v_id uuid; v_number text; v_result jsonb;
begin
  v_prev := app_private.idem_begin('accrual_publish', p_key, jsonb_build_object('report', p_report));
  if v_prev is not null then return v_prev; end if;
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.publish', r.partner_id);
  if r.status <> 'approved' then perform app_private.fail('transition-not-allowed', 'Начисление публикуется по утверждённому отчёту', r.status); end if;
  select * into k from public.calculation where id = r.calculation_id;
  perform app_private.sod_check(k.created_by, 'accrual_publish', 'revenue_report', r.id, r.partner_id);
  if exists (select 1 from public.accrual where contract_id = r.contract_id and period = r.period and kind = 'royalty' and status = 'published') then
    perform app_private.fail('transition-not-allowed', 'Начисление за период уже опубликовано; используйте корректировку');
  end if;
  select * into pol from public.contract_policy_version where contract_id = r.contract_id and effective_from <= (r.period + interval '1 month' - interval '1 day')::date
    order by effective_from desc limit 1;
  v_due := make_date(extract(year from r.period + interval '1 month')::int, extract(month from r.period + interval '1 month')::int, pol.payment_due_day);
  v_number := app_private.next_number('НЧ');
  insert into public.accrual(number, contract_id, partner_id, period, calculation_id, amount_minor, currency, due_on, published_by)
  values (v_number, r.contract_id, r.partner_id, r.period, k.id, k.amount_minor, k.currency, v_due, v_user) returning id into v_id;
  perform app_private.roy_log('accrual', v_id, r.partner_id, 'published', jsonb_build_object('amount_minor', k.amount_minor, 'currency', k.currency), null);
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'published', jsonb_build_object('accrual', v_number, 'amount_minor', k.amount_minor), null);
  perform app_private.audit('accrual.publish', 'accrual', v_id, r.partner_id, jsonb_build_object('amount_minor', k.amount_minor, 'currency', k.currency, 'due_on', v_due));
  perform app_private.notify_queue('partner_owner', r.partner_id, null, 'accrual.published', 'Начисление роялти ' || v_number,
    'Срок оплаты ' || to_char(v_due, 'DD.MM.YYYY'), 'accrual', v_id, '/royalties/accruals/' || v_id, 'accrual.published:' || v_id);
  v_result := jsonb_build_object('accrual_id', v_id, 'number', v_number, 'amount_minor', k.amount_minor, 'currency', k.currency, 'due_on', v_due);
  return app_private.idem_finish('accrual_publish', p_key, v_result);
end $$;

create function public.period_close(p_report uuid) returns public.revenue_report
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare r public.revenue_report;
begin
  perform app_private.require_user();
  r := app_private.report_load(p_report);
  perform app_private.require_perm('royalty.publish', r.partner_id);
  if r.status <> 'approved' then perform app_private.fail('transition-not-allowed', 'Закрыть можно утверждённый отчёт', r.status); end if;
  if not exists (select 1 from public.accrual where contract_id = r.contract_id and period = r.period and status = 'published') then
    perform app_private.fail('transition-not-allowed', 'Сначала опубликуйте начисление');
  end if;
  update public.revenue_report set status = 'closed', updated_at = now(), revision = revision + 1 where id = p_report returning * into r;
  perform app_private.roy_log('revenue_report', r.id, r.partner_id, 'closed', null, null);
  perform app_private.audit('period.close', 'revenue_report', r.id, r.partner_id);
  return r;
end $$;

create function public.adjustment_create(p_accrual uuid, p_direction text, p_amount bigint, p_reason text, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_prev jsonb; a public.accrual; v_id uuid; v_result jsonb;
begin
  perform app_private.require_user();
  v_prev := app_private.idem_begin('adjustment_create', p_key, jsonb_build_object('accrual', p_accrual, 'dir', p_direction, 'amount', p_amount));
  if v_prev is not null then return v_prev; end if;
  select * into a from public.accrual where id = p_accrual for update;
  if not found or not app_private.can_read_royalty(a.partner_id) then perform app_private.fail('not-found', 'Начисление не найдено'); end if;
  perform app_private.require_perm('royalty.publish', a.partner_id);
  if p_direction not in ('debit', 'credit') then perform app_private.fail('validation', 'Неверное направление', 'direction'); end if;
  if p_amount is null or p_amount <= 0 then perform app_private.fail('validation', 'Сумма должна быть положительной', 'amount'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину корректировки', 'reason'); end if;
  if p_direction = 'credit' and p_amount > app_private.accrual_outstanding(p_accrual)
     + coalesce((select sum(l.amount_minor) from public.allocation l join public.payment p on p.id = l.payment_id
                 where l.accrual_id = p_accrual and l.status = 'active' and p.status = 'confirmed'), 0) then
    perform app_private.fail('validation', 'Кредитовая корректировка больше суммы начисления', 'amount');
  end if;
  insert into public.adjustment(accrual_id, direction, amount_minor, reason, created_by) values (p_accrual, p_direction, p_amount, p_reason, auth.uid())
  returning id into v_id;
  perform app_private.roy_log('accrual', a.id, a.partner_id, 'adjustment', jsonb_build_object('direction', p_direction, 'amount_minor', p_amount), p_reason);
  perform app_private.audit('adjustment.create', 'accrual', a.id, a.partner_id, jsonb_build_object('direction', p_direction, 'amount_minor', p_amount), p_reason);
  v_result := jsonb_build_object('adjustment_id', v_id, 'outstanding_minor', app_private.accrual_outstanding(p_accrual));
  return app_private.idem_finish('adjustment_create', p_key, v_result);
end $$;

create function public.dispute_open(p_accrual uuid, p_amount bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.accrual; v_id uuid;
begin
  perform app_private.require_user();
  select * into a from public.accrual where id = p_accrual;
  if not found or not app_private.can_read_royalty(a.partner_id) then perform app_private.fail('not-found', 'Начисление не найдено'); end if;
  if not (app_private.has_perm('royalty.report.submit', a.partner_id) or app_private.has_perm('royalty.review', a.partner_id)) then
    perform app_private.fail('forbidden', 'Нет прав открыть спор');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > a.amount_minor then perform app_private.fail('validation', 'Неверная сумма спора', 'amount'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Опишите основание спора', 'reason'); end if;
  insert into public.dispute(accrual_id, amount_minor, reason, opened_by) values (p_accrual, p_amount, p_reason, auth.uid()) returning id into v_id;
  perform app_private.roy_log('accrual', a.id, a.partner_id, 'dispute_opened', jsonb_build_object('amount_minor', p_amount), p_reason);
  perform app_private.notify_queue('finance', a.partner_id, null, 'dispute.opened', 'Спор по начислению ' || a.number, p_reason,
    'accrual', a.id, '/royalties/accruals/' || a.id, 'dispute:' || v_id, true);
  return v_id;
end $$;

create function public.dispute_resolve(p_dispute uuid, p_status text, p_resolution text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare d public.dispute; a public.accrual;
begin
  perform app_private.require_user();
  select * into d from public.dispute where id = p_dispute for update;
  select * into a from public.accrual where id = d.accrual_id;
  if not found or not app_private.can_read_royalty(a.partner_id) then perform app_private.fail('not-found', 'Спор не найден'); end if;
  perform app_private.require_perm('royalty.publish', a.partner_id);
  if d.status <> 'open' then perform app_private.fail('transition-not-allowed', 'Спор уже закрыт'); end if;
  if p_status not in ('resolved', 'rejected') or coalesce(trim(p_resolution), '') = '' then
    perform app_private.fail('validation', 'Укажите итог и решение', 'resolution');
  end if;
  update public.dispute set status = p_status, resolution = p_resolution, resolved_by = auth.uid(), resolved_at = now() where id = p_dispute;
  perform app_private.roy_log('accrual', a.id, a.partner_id, 'dispute_' || p_status, null, p_resolution);
end $$;

------------------------------------------------------------------------------
-- Оплаты (ROY-09, ROY-10)
------------------------------------------------------------------------------
-- Партнёр сообщает об оплате: это НЕ подтверждение зачисления (AT-18).
create function public.payment_report(p_contract uuid, p_amount bigint, p_currency text, p_paid_on date, p_partner_ref text,
  p_comment text, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_prev jsonb; c public.contract; v_id uuid; v_number text; v_result jsonb;
begin
  perform app_private.require_user();
  v_prev := app_private.idem_begin('payment_report', p_key, jsonb_build_object('c', p_contract, 'a', p_amount, 'cur', p_currency, 'd', p_paid_on));
  if v_prev is not null then return v_prev; end if;
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.can_read_royalty(c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  perform app_private.require_perm('payment.report', c.partner_id);
  if p_amount is null or p_amount <= 0 then perform app_private.fail('validation', 'Сумма должна быть положительной', 'amount'); end if;
  if p_currency <> c.currency then perform app_private.fail('validation', 'Валюта оплаты не совпадает с валютой договора', 'currency'); end if;
  v_number := app_private.next_number('ОП');
  insert into public.payment(number, partner_id, contract_id, source, status, amount_minor, currency, paid_on, partner_ref, comment, reported_by)
  values (v_number, c.partner_id, c.id, 'partner_report', 'reported', p_amount, p_currency, p_paid_on, p_partner_ref, p_comment, auth.uid())
  returning id into v_id;
  perform app_private.roy_log('payment', v_id, c.partner_id, 'reported', jsonb_build_object('amount_minor', p_amount), p_comment);
  perform app_private.notify_queue('finance', c.partner_id, null, 'payment.reported', 'Партнёр сообщил об оплате ' || v_number,
    'Проверьте зачисление по выписке', 'payment', v_id, '/royalties/payments/' || v_id, 'payment.reported:' || v_id);
  v_result := jsonb_build_object('payment_id', v_id, 'number', v_number, 'status', 'reported');
  return app_private.idem_finish('payment_report', p_key, v_result);
end $$;

create function public.payment_attach_prepare(p_payment uuid, p_name text, p_mime text, p_size bigint, p_checksum text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.payment; v jsonb;
begin
  perform app_private.require_user();
  select * into p from public.payment where id = p_payment;
  if not found or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Оплата не найдена'); end if;
  v := app_private.file_prepare(case when app_private.is_staff() then 'payment.confirm' else 'payment.report' end,
    p.partner_id, null, 'scope', p_name, p_mime, p_size, p_checksum, 'payment', p.id);
  update public.payment set receipt_file_id = coalesce(receipt_file_id, (v ->> 'file_id')::uuid) where id = p_payment;
  return v;
end $$;

-- Финансы регистрируют зачисление по выписке (новое или по сообщению партнёра).
create function public.payment_register(p_partner uuid, p_contract uuid, p_amount bigint, p_currency text, p_paid_on date,
  p_bank_ref text, p_reported_payment uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_prev jsonb; p public.payment; v_id uuid; v_result jsonb;
begin
  v_prev := app_private.idem_begin('payment_register', p_key, jsonb_build_object('p', p_partner, 'a', p_amount, 'ref', p_bank_ref, 'rp', p_reported_payment));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_perm('payment.confirm', p_partner);
  if p_amount is null or p_amount <= 0 then perform app_private.fail('validation', 'Сумма должна быть положительной', 'amount'); end if;
  if coalesce(trim(p_bank_ref), '') = '' then perform app_private.fail('validation', 'Укажите идентификатор операции в выписке', 'bank_ref'); end if;
  if exists (select 1 from public.payment where bank_ref = p_bank_ref and status <> 'rejected') then
    perform app_private.fail('validation', 'Эта банковская операция уже зарегистрирована', 'bank_ref');
  end if;
  if p_contract is not null and not exists (select 1 from public.contract where id = p_contract and partner_id = p_partner and currency = p_currency) then
    perform app_private.fail('validation', 'Договор другого партнёра или другой валюты', 'contract_id');
  end if;
  if p_reported_payment is not null then
    select * into p from public.payment where id = p_reported_payment for update;
    if not found or p.partner_id <> p_partner or p.status <> 'reported' then
      perform app_private.fail('validation', 'Сообщение об оплате не найдено или уже обработано', 'reported_payment');
    end if;
    update public.payment set status = 'registered', source = 'bank_statement', amount_minor = p_amount, currency = p_currency,
      paid_on = p_paid_on, bank_ref = p_bank_ref, registered_by = v_user, registered_at = now(), revision = revision + 1
    where id = p.id returning id into v_id;
  else
    insert into public.payment(number, partner_id, contract_id, source, status, amount_minor, currency, paid_on, bank_ref, registered_by, registered_at)
    values (app_private.next_number('ОП'), p_partner, p_contract, 'bank_statement', 'registered', p_amount, p_currency, p_paid_on, p_bank_ref, v_user, now())
    returning id into v_id;
  end if;
  perform app_private.roy_log('payment', v_id, p_partner, 'registered', jsonb_build_object('amount_minor', p_amount, 'bank_ref', p_bank_ref), null);
  perform app_private.audit('payment.register', 'payment', v_id, p_partner, jsonb_build_object('amount_minor', p_amount, 'currency', p_currency, 'bank_ref', p_bank_ref));
  v_result := jsonb_build_object('payment_id', v_id, 'status', 'registered');
  return app_private.idem_finish('payment_register', p_key, v_result);
end $$;

create function public.payment_confirm(p_payment uuid) returns public.payment
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); p public.payment;
begin
  select * into p from public.payment where id = p_payment for update;
  if not found or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Оплата не найдена'); end if;
  perform app_private.require_perm('payment.confirm', p.partner_id);
  if p.status <> 'registered' then
    perform app_private.fail('transition-not-allowed', 'Подтверждается только зарегистрированное по выписке зачисление', p.status);
  end if;
  perform app_private.sod_check(p.registered_by, 'payment_confirm', 'payment', p.id, p.partner_id);
  update public.payment set status = 'confirmed', confirmed_by = v_user, confirmed_at = now(), revision = revision + 1
  where id = p_payment returning * into p;
  perform app_private.roy_log('payment', p.id, p.partner_id, 'confirmed', null, null);
  perform app_private.audit('payment.confirm', 'payment', p.id, p.partner_id, jsonb_build_object('amount_minor', p.amount_minor, 'currency', p.currency));
  perform app_private.notify_queue('partner_owner', p.partner_id, null, 'payment.confirmed', 'Оплата зачислена: ' || p.number, null,
    'payment', p.id, '/royalties/payments/' || p.id, 'payment.confirmed:' || p.id);
  return p;
end $$;

create function public.payment_reject(p_payment uuid, p_reason text) returns public.payment
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.payment;
begin
  perform app_private.require_user();
  select * into p from public.payment where id = p_payment for update;
  if not found or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Оплата не найдена'); end if;
  perform app_private.require_perm('payment.confirm', p.partner_id);
  if p.status not in ('reported', 'registered') then perform app_private.fail('transition-not-allowed', 'Оплату нельзя отклонить', p.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  update public.payment set status = 'rejected', status_reason = p_reason, revision = revision + 1 where id = p_payment returning * into p;
  perform app_private.roy_log('payment', p.id, p.partner_id, 'rejected', null, p_reason);
  perform app_private.notify_queue('partner_owner', p.partner_id, null, 'payment.rejected', 'Оплата не подтверждена: ' || p.number, p_reason,
    'payment', p.id, '/royalties/payments/' || p.id, 'payment.rejected:' || p.id, true);
  return p;
end $$;

-- Возврат платежа / отмена подтверждения: распределения сторнируются, долг восстанавливается.
create function public.payment_reverse(p_payment uuid, p_reason text) returns public.payment
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); p public.payment; n int;
begin
  select * into p from public.payment where id = p_payment for update;
  if not found or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Оплата не найдена'); end if;
  perform app_private.require_perm('payment.confirm', p.partner_id);
  if p.status <> 'confirmed' then perform app_private.fail('transition-not-allowed', 'Сторнировать можно подтверждённую оплату', p.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  update public.allocation set status = 'reversed', reversed_reason = 'Возврат платежа: ' || p_reason, reversed_by = v_user, reversed_at = now()
  where payment_id = p_payment and status = 'active';
  get diagnostics n = row_count;
  update public.payment set status = 'reversed', status_reason = p_reason, revision = revision + 1 where id = p_payment returning * into p;
  perform app_private.roy_log('payment', p.id, p.partner_id, 'reversed', jsonb_build_object('allocations_reversed', n), p_reason);
  perform app_private.audit('payment.reverse', 'payment', p.id, p.partner_id, jsonb_build_object('allocations_reversed', n), p_reason);
  return p;
end $$;

-- Распределение под блокировкой строк платежа и начисления (ROY-10, AT-10).
create function public.allocation_create(p_payment uuid, p_accrual uuid, p_amount bigint, p_key text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_prev jsonb; p public.payment; a public.accrual; v_unalloc bigint; v_out bigint; v_id uuid; v_result jsonb;
begin
  perform app_private.require_user();
  v_prev := app_private.idem_begin('allocation_create', p_key, jsonb_build_object('p', p_payment, 'a', p_accrual, 'amount', p_amount));
  if v_prev is not null then return v_prev; end if;
  select * into p from public.payment where id = p_payment for update;   -- порядок блокировок: платёж, затем начисление
  select * into a from public.accrual where id = p_accrual for update;
  if p.id is null or a.id is null or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Платёж или начисление не найдены'); end if;
  perform app_private.require_perm('payment.allocate', p.partner_id);
  if p.status <> 'confirmed' then perform app_private.fail('transition-not-allowed', 'Распределять можно только подтверждённую оплату', p.status); end if;
  if a.status <> 'published' then perform app_private.fail('transition-not-allowed', 'Начисление не опубликовано'); end if;
  if p.partner_id <> a.partner_id then perform app_private.fail('validation', 'Платёж и начисление разных партнёров'); end if;
  if p.currency <> a.currency then perform app_private.fail('validation', 'Валюты платежа и начисления различаются'); end if;
  if p_amount is null or p_amount <= 0 then perform app_private.fail('validation', 'Сумма должна быть положительной', 'amount'); end if;
  select p.amount_minor - coalesce(sum(amount_minor), 0) into v_unalloc from public.allocation where payment_id = p.id and status = 'active';
  v_out := app_private.accrual_outstanding(a.id);
  if p_amount > v_unalloc then
    perform app_private.fail('version-conflict', 'Сумма больше нераспределённого остатка платежа', v_unalloc::text);
  end if;
  if p_amount > v_out then
    perform app_private.fail('version-conflict', 'Сумма больше непогашенного остатка начисления', v_out::text);
  end if;
  insert into public.allocation(payment_id, accrual_id, amount_minor, created_by) values (p.id, a.id, p_amount, auth.uid()) returning id into v_id;
  perform app_private.roy_log('payment', p.id, p.partner_id, 'allocated', jsonb_build_object('accrual', a.number, 'amount_minor', p_amount), null);
  perform app_private.roy_log('accrual', a.id, a.partner_id, 'allocated', jsonb_build_object('payment', p.number, 'amount_minor', p_amount), null);
  perform app_private.audit('allocation.create', 'allocation', v_id, p.partner_id, jsonb_build_object('payment', p.id, 'accrual', a.id, 'amount_minor', p_amount));
  v_result := jsonb_build_object('allocation_id', v_id, 'payment_unallocated_minor', v_unalloc - p_amount,
    'accrual_outstanding_minor', v_out - p_amount);
  return app_private.idem_finish('allocation_create', p_key, v_result);
end $$;

create function public.allocation_reverse(p_allocation uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare l public.allocation; p public.payment;
begin
  perform app_private.require_user();
  select * into l from public.allocation where id = p_allocation for update;
  select * into p from public.payment where id = l.payment_id;
  if not found or not app_private.can_read_royalty(p.partner_id) then perform app_private.fail('not-found', 'Распределение не найдено'); end if;
  perform app_private.require_perm('payment.allocate', p.partner_id);
  if l.status <> 'active' then perform app_private.fail('transition-not-allowed', 'Распределение уже сторнировано'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину сторно', 'reason'); end if;
  update public.allocation set status = 'reversed', reversed_reason = p_reason, reversed_by = auth.uid(), reversed_at = now() where id = p_allocation;
  perform app_private.roy_log('payment', p.id, p.partner_id, 'allocation_reversed', jsonb_build_object('amount_minor', l.amount_minor), p_reason);
  perform app_private.audit('allocation.reverse', 'allocation', l.id, p.partner_id, jsonb_build_object('amount_minor', l.amount_minor), p_reason);
end $$;

create function public.royalty_note_add(p_subject_type text, p_subject uuid, p_partner uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid;
begin
  perform app_private.require_user();
  perform app_private.require_perm('finance.internal', p_partner);
  if coalesce(trim(p_body), '') = '' then perform app_private.fail('validation', 'Пустая заметка', 'body'); end if;
  insert into public.royalty_note(subject_type, subject_id, partner_id, body, author_id) values (p_subject_type, p_subject, p_partner, left(p_body, 4000), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Напоминания о сдаче отчёта и оплате (фоновая обработка). Дедупликация — ключом задачи/уведомления.
create function app_private.royalty_timers() returns int
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare c record; a record; n int := 0; v_period date := (date_trunc('month', now()) - interval '1 month')::date; v_due date; pol public.contract_policy_version;
begin
  for c in select * from public.contract where status = 'active' and valid_from <= v_period + interval '1 month' - interval '1 day'
             and (valid_to is null or valid_to >= v_period) loop
    if not exists (select 1 from public.revenue_report where contract_id = c.id and period = v_period and status <> 'draft') then
      select * into pol from public.contract_policy_version where contract_id = c.id and effective_from <= now()::date order by effective_from desc limit 1;
      if pol.id is null then continue; end if;
      v_due := make_date(extract(year from now())::int, extract(month from now())::int, pol.report_due_day);
      perform app_private.task_create('report_due', 'Сдать отчёт о выручке за ' || to_char(v_period, 'MM.YYYY'),
        'Договор ' || c.number, 'partner_owner', c.partner_id, null, 'contract', c.id,
        (v_due + time '18:00') at time zone c.timezone, 'high', true, 'report_due:' || c.id || ':' || v_period);
      n := n + 1;
    end if;
  end loop;
  for a in select * from public.v_accrual_balance where outstanding_minor > 0 and due_on < current_date loop
    perform app_private.notify_queue('partner_owner', a.partner_id, null, 'accrual.overdue', 'Просрочена оплата начисления ' || a.number,
      null, 'accrual', a.accrual_id, '/royalties/accruals/' || a.accrual_id, 'accrual.overdue:' || a.accrual_id || ':' || to_char(now(), 'IYYY-IW'), true);
    perform app_private.notify_queue('finance', a.partner_id, null, 'accrual.overdue', 'Просрочена оплата ' || a.number,
      null, 'accrual', a.accrual_id, '/royalties/accruals/' || a.accrual_id, 'accrual.overdue:' || a.accrual_id || ':' || to_char(now(), 'IYYY-IW'));
    n := n + 1;
  end loop;
  return n;
end $$;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.revenue_report enable row level security;
alter table public.report_revision enable row level security;
alter table public.report_line enable row level security;
alter table public.import_batch enable row level security;
alter table public.calculation enable row level security;
alter table public.accrual enable row level security;
alter table public.adjustment enable row level security;
alter table public.payment enable row level security;
alter table public.allocation enable row level security;
alter table public.dispute enable row level security;
alter table public.royalty_note enable row level security;
alter table public.royalty_event enable row level security;

create policy read_roy on public.revenue_report for select to authenticated using (app_private.can_read_royalty(partner_id));
create policy read_roy on public.report_revision for select to authenticated
  using (exists (select 1 from public.revenue_report r where r.id = report_id and app_private.can_read_royalty(r.partner_id)));
create policy read_roy on public.report_line for select to authenticated
  using (exists (select 1 from public.report_revision v join public.revenue_report r on r.id = v.report_id
                 where v.id = revision_id and app_private.can_read_royalty(r.partner_id)));
create policy read_roy on public.import_batch for select to authenticated
  using (exists (select 1 from public.contract c where c.id = contract_id and app_private.can_read_royalty(c.partner_id)));
create policy read_roy on public.calculation for select to authenticated
  using (exists (select 1 from public.revenue_report r where r.id = report_id and app_private.can_read_royalty(r.partner_id)));
create policy read_roy on public.accrual for select to authenticated using (app_private.can_read_royalty(partner_id));
create policy read_roy on public.adjustment for select to authenticated
  using (exists (select 1 from public.accrual a where a.id = accrual_id and app_private.can_read_royalty(a.partner_id)));
create policy read_roy on public.payment for select to authenticated using (app_private.can_read_royalty(partner_id));
create policy read_roy on public.allocation for select to authenticated
  using (exists (select 1 from public.payment p where p.id = payment_id and app_private.can_read_royalty(p.partner_id)));
create policy read_roy on public.dispute for select to authenticated
  using (exists (select 1 from public.accrual a where a.id = accrual_id and app_private.can_read_royalty(a.partner_id)));
create policy read_internal on public.royalty_note for select to authenticated using (app_private.has_perm('finance.internal', partner_id));
create policy read_roy on public.royalty_event for select to authenticated using (app_private.can_read_royalty(partner_id));

insert into app_private.client_table(tbl) values ('public.revenue_report'), ('public.report_revision'), ('public.report_line'),
  ('public.import_batch'), ('public.calculation'), ('public.accrual'), ('public.adjustment'), ('public.payment'), ('public.allocation'),
  ('public.dispute'), ('public.royalty_note'), ('public.royalty_event'), ('public.v_accrual_balance'), ('public.v_payment_balance');
insert into app_private.client_command(fn) values
  ('public.report_save_draft(uuid, date, jsonb, text, text)'), ('public.report_import(uuid, date, text, text, jsonb)'),
  ('public.report_submit(uuid, text)'), ('public.report_take_review(uuid)'), ('public.report_return(uuid, text)'),
  ('public.report_approve(uuid, jsonb, text, text)'), ('public.calculation_replay(uuid)'), ('public.accrual_publish(uuid, text)'),
  ('public.period_close(uuid)'), ('public.adjustment_create(uuid, text, bigint, text, text)'), ('public.dispute_open(uuid, bigint, text)'),
  ('public.dispute_resolve(uuid, text, text)'), ('public.payment_report(uuid, bigint, text, date, text, text, text)'),
  ('public.payment_attach_prepare(uuid, text, text, bigint, text)'),
  ('public.payment_register(uuid, uuid, bigint, text, date, text, uuid, text)'), ('public.payment_confirm(uuid)'),
  ('public.payment_reject(uuid, text)'), ('public.payment_reverse(uuid, text)'), ('public.allocation_create(uuid, uuid, bigint, text)'),
  ('public.allocation_reverse(uuid, text)'), ('public.royalty_note_add(text, uuid, uuid, text)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_royalty(uuid)');
select app_private.apply_grants();
