-- 0005 Franchise: договоры и расчётные политики (ROY-01), проекты открытия (OPEN-01…05).

------------------------------------------------------------------------------
-- Organization: публичный контракт создания точки (вызывается модулями при открытии)
------------------------------------------------------------------------------
create function app_private.location_create(p_partner uuid, p_name text, p_city text, p_address text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner; c public.country; v_id uuid; v_code text;
begin
  select * into p from public.partner where id = p_partner;
  select * into c from public.country where code = p.country;
  v_code := p.code || '-' || (select count(*) + 1 from public.location where partner_id = p_partner);
  insert into public.location(code, name, kind, partner_id, direction_id, country, city, address, timezone, currency, status, is_demo)
  values (v_code, p_name, 'franchise', p_partner, p.direction_id, p.country, p_city, p_address, c.default_timezone,
          c.default_currency, 'opening', p.is_demo)
  returning id into v_id;
  insert into public.location_ownership(location_id, partner_id, valid_from) values (v_id, p_partner, current_date);
  perform app_private.audit('location.create', 'location', v_id, p_partner, jsonb_build_object('name', p_name, 'city', p_city));
  return v_id;
end $$;

create function app_private.location_set_opened(p_location uuid, p_date date) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.location set status = 'active', opened_on = p_date, updated_at = now(), revision = revision + 1 where id = p_location;
$$;

------------------------------------------------------------------------------
-- Договоры и политики
------------------------------------------------------------------------------
create table public.contract (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  partner_id uuid not null references public.partner(id),
  operator_entity_id uuid references public.legal_entity(id),
  partner_entity_id uuid references public.legal_entity(id),
  country text not null references public.country(code),
  currency text not null references public.currency(code),
  timezone text not null,
  valid_from date not null,
  valid_to date,
  status text not null default 'active' check (status in ('draft', 'active', 'terminated')),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  unique (partner_id, number)
);

create table public.contract_location (
  contract_id uuid not null references public.contract(id),
  location_id uuid not null references public.location(id),
  valid_from date not null,
  valid_to date,
  primary key (contract_id, location_id, valid_from)
);

create table public.contract_policy_version (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contract(id),
  version int not null,
  effective_from date not null,
  rate_bp int not null check (rate_bp between 0 and 10000),
  base_rule text not null default 'gross_minus_returns_minus_excluded' check (base_rule in ('gross_minus_returns_minus_excluded')),
  rounding text not null default 'half_up' check (rounding in ('half_up', 'half_even', 'down')),
  report_due_day int not null default 5 check (report_due_day between 1 and 28),
  payment_due_day int not null default 15 check (payment_due_day between 1 and 28),
  note text,
  is_test boolean not null default false,
  approved_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  unique (contract_id, version),
  unique (contract_id, effective_from)
);

create function public.contract_policy_add(p_contract uuid, p_effective_from date, p_rate_bp int, p_rounding text,
  p_report_due_day int, p_payment_due_day int, p_note text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); c public.contract; v_id uuid; v_ver int;
begin
  select * into c from public.contract where id = p_contract;
  if not found or not app_private.has_perm('contract.read', c.partner_id) then perform app_private.fail('not-found', 'Договор не найден'); end if;
  perform app_private.require_perm('contract.manage', c.partner_id);
  if coalesce(trim(p_note), '') = '' then perform app_private.fail('validation', 'Укажите основание изменения', 'note'); end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.contract_policy_version where contract_id = p_contract;
  insert into public.contract_policy_version(contract_id, version, effective_from, rate_bp, rounding, report_due_day, payment_due_day, note, is_test, approved_by)
  values (p_contract, v_ver, p_effective_from, p_rate_bp, coalesce(p_rounding, 'half_up'), coalesce(p_report_due_day, 5),
          coalesce(p_payment_due_day, 15), p_note, c.is_test, v_user)
  returning id into v_id;
  perform app_private.audit('contract.policy_add', 'contract', p_contract, c.partner_id,
    jsonb_build_object('version', v_ver, 'effective_from', p_effective_from, 'rate_bp', p_rate_bp), p_note);
  return v_id;
end $$;

------------------------------------------------------------------------------
-- Проекты открытия
------------------------------------------------------------------------------
create table public.opening_project (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  partner_id uuid not null references public.partner(id),
  location_id uuid not null references public.location(id),
  contract_id uuid references public.contract(id),
  format text,
  city text not null,
  address text,
  budget_minor bigint,
  budget_currency text references public.currency(code),
  planned_open_on date not null,
  actual_open_on date,
  manager_id uuid references public.app_user(id),
  owner_id uuid references public.app_user(id),
  status text not null default 'active' check (status in ('active', 'approved', 'opened', 'completed', 'cancelled')),
  status_reason text,
  instance_id uuid references public.workflow_instance(id),
  template_version_id uuid references public.workflow_template_version(id),
  crm_deal_ref text unique,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1
);

-- Внутренние заметки — отдельная таблица без доступа партнёру (OPEN-05).
create table public.opening_note (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.opening_project(id),
  body text not null,
  author_id uuid references public.app_user(id),
  created_at timestamptz not null default now()
);

create table public.opening_event (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.opening_project(id),
  actor_id uuid,
  action text not null,
  detail jsonb,
  comment text,
  at timestamptz not null default now()
);

create function app_private.opening_log(p_project uuid, p_action text, p_detail jsonb, p_comment text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.opening_event(project_id, actor_id, action, detail, comment) values (p_project, auth.uid(), p_action, p_detail, p_comment)
$$;

-- Создание без проверки прав пользователя — вызывается командой или обработчиком события CRM.
create function app_private.opening_create_internal(p_partner uuid, p_location uuid, p_location_name text, p_city text,
  p_address text, p_format text, p_planned_open date, p_manager uuid, p_contract uuid, p_template_code text, p_crm_ref text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid; v_loc uuid := p_location; v_ver public.workflow_template_version; v_inst uuid; v_tz text; v_start date;
begin
  if p_crm_ref is not null then
    select id into v_id from public.opening_project where crm_deal_ref = p_crm_ref;
    if found then return v_id; end if; -- OPEN-01: повтор события не создаёт второй проект
  end if;
  if p_planned_open is null then perform app_private.fail('validation', 'Укажите плановую дату открытия', 'planned_open_on'); end if;
  if not exists (select 1 from public.partner where id = p_partner) then perform app_private.fail('not-found', 'Партнёр не найден'); end if;
  if v_loc is null then
    if coalesce(trim(p_location_name), '') = '' or coalesce(trim(p_city), '') = '' then
      perform app_private.fail('validation', 'Укажите точку или название и город новой точки', 'location');
    end if;
    v_loc := app_private.location_create(p_partner, p_location_name, p_city, p_address);
  elsif not exists (select 1 from public.location where id = v_loc and partner_id = p_partner) then
    perform app_private.fail('validation', 'Точка не принадлежит партнёру', 'location_id'); -- MODEL-01
  end if;
  if p_contract is not null and not exists (select 1 from public.contract where id = p_contract and partner_id = p_partner) then
    perform app_private.fail('validation', 'Договор не принадлежит партнёру', 'contract_id');
  end if;
  select v.* into v_ver from public.workflow_template_version v join public.workflow_template t on t.id = v.template_id
  where t.code = coalesce(p_template_code, 'opening-standard') and v.status = 'published' order by v.version desc limit 1;
  if not found then perform app_private.fail('validation', 'Нет опубликованного шаблона открытия'); end if;
  select timezone into v_tz from public.location where id = v_loc;
  v_start := (now() at time zone v_tz)::date;
  if p_planned_open < v_start then perform app_private.fail('validation', 'Плановая дата в прошлом', 'planned_open_on'); end if;

  insert into public.opening_project(number, partner_id, location_id, contract_id, format, city, address, planned_open_on,
    manager_id, owner_id, template_version_id, crm_deal_ref, created_by)
  values (app_private.next_number('ОТ'), p_partner, v_loc, p_contract, p_format,
    coalesce(p_city, (select city from public.location where id = v_loc)), coalesce(p_address, (select address from public.location where id = v_loc)),
    p_planned_open, p_manager, p_manager, v_ver.id, p_crm_ref, auth.uid())
  returning id into v_id;
  update public.location set status = 'opening' where id = v_loc and status = 'planned';
  v_inst := app_private.workflow_start(v_ver.id, 'opening_project', v_id, p_partner, v_loc,
    jsonb_build_object('start', v_start, 'planned_open', p_planned_open), v_tz);
  update public.opening_project set instance_id = v_inst where id = v_id;
  perform app_private.opening_log(v_id, 'created', jsonb_build_object('template_version', v_ver.version, 'crm_ref', p_crm_ref), null);
  perform app_private.audit('opening.create', 'opening_project', v_id, p_partner, jsonb_build_object('planned_open_on', p_planned_open));
  return v_id;
end $$;

create function public.opening_create(p_partner uuid, p_location uuid, p_location_name text, p_city text, p_address text,
  p_format text, p_planned_open date, p_contract uuid default null, p_template_code text default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user();
begin
  perform app_private.require_perm('opening.manage', p_partner, p_location);
  return app_private.opening_create_internal(p_partner, p_location, p_location_name, p_city, p_address, p_format,
    p_planned_open, v_user, p_contract, p_template_code, null);
end $$;

create function app_private.opening_load(p_project uuid, p_perm text) returns public.opening_project
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project;
begin
  select * into p from public.opening_project where id = p_project for update;
  if not found or not app_private.has_perm('opening.read', p.partner_id, p.location_id) then
    perform app_private.fail('not-found', 'Проект не найден');
  end if;
  perform app_private.require_perm(p_perm, p.partner_id, p.location_id);
  return p;
end $$;

create function public.opening_change_date(p_project uuid, p_new_date date, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; v_changed jsonb;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.manage');
  if p.status not in ('active', 'approved') then perform app_private.fail('transition-not-allowed', 'Проект не активен'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину переноса', 'reason'); end if;
  v_changed := app_private.workflow_reschedule(p.instance_id, 'planned_open', p_new_date, p_reason);
  update public.opening_project set planned_open_on = p_new_date, updated_at = now(), revision = revision + 1 where id = p_project;
  perform app_private.opening_log(p_project, 'date_changed',
    jsonb_build_object('from', p.planned_open_on, 'to', p_new_date, 'tasks', jsonb_array_length(v_changed)), p_reason);
  perform app_private.audit('opening.change_date', 'opening_project', p_project, p.partner_id,
    jsonb_build_object('from', p.planned_open_on, 'to', p_new_date), p_reason);
  return jsonb_build_object('changed', v_changed);
end $$;

-- Блокеры разрешения на открытие: критические шаги до этапа ворот включительно, кроме самих ворот (OPEN-03, AT-03).
create function public.opening_blockers(p_project uuid)
returns table (task_id uuid, number text, title text, stage_title text, status text, queue_role text, due_at timestamptz)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select t.id, t.number, t.title, t.stage_title, t.status, t.queue_role, t.due_at
  from public.opening_project p
  join public.task t on t.instance_id = p.instance_id
  where p.id = p_project
    and app_private.has_perm('opening.read', p.partner_id, p.location_id)
    and t.is_critical and not t.is_gate and t.status <> 'done'
    and t.stage_order <= coalesce((select max(g.stage_order) from public.task g where g.instance_id = p.instance_id and g.is_gate), 1000)
  order by t.stage_order, t.step_order
$$;

create function public.opening_approve(p_project uuid, p_comment text default null) returns public.opening_project
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; v_blockers text; v_gate text;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.approve');
  if p.status <> 'active' then perform app_private.fail('transition-not-allowed', 'Разрешение уже выдано или проект закрыт', p.status); end if;
  select string_agg(number || ' ' || title, '; ') into v_blockers from public.opening_blockers(p_project);
  if v_blockers is not null then
    perform app_private.fail('transition-not-allowed', 'Не выполнены обязательные условия открытия', v_blockers);
  end if;
  select step_key into v_gate from public.task where instance_id = p.instance_id and is_gate limit 1;
  if v_gate is not null then
    perform app_private.workflow_complete_step(p.instance_id, v_gate, coalesce(p_comment, 'Разрешение на открытие выдано'));
  end if;
  update public.opening_project set status = 'approved', updated_at = now(), revision = revision + 1 where id = p_project returning * into p;
  perform app_private.opening_log(p_project, 'approved', null, p_comment);
  perform app_private.audit('opening.approve', 'opening_project', p_project, p.partner_id, null, p_comment);
  perform app_private.notify_queue('partner_owner', p.partner_id, null, 'opening.approved', 'Открытие разрешено', p.number,
    'opening_project', p.id, '/openings/' || p.id, 'opening.approved:' || p.id);
  return p;
end $$;

create function public.opening_mark_opened(p_project uuid, p_actual date, p_comment text default null) returns public.opening_project
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; v_step text;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.manage');
  if p.status <> 'approved' then perform app_private.fail('transition-not-allowed', 'Сначала нужно разрешение на открытие', p.status); end if;
  if p_actual is null or p_actual > current_date then perform app_private.fail('validation', 'Фактическая дата не может быть в будущем', 'actual_open_on'); end if;
  update public.opening_project set status = 'opened', actual_open_on = p_actual, updated_at = now(), revision = revision + 1
  where id = p_project returning * into p;
  perform app_private.location_set_opened(p.location_id, p_actual);
  select step_key into v_step from public.task where instance_id = p.instance_id and kind = 'opening_fact' limit 1;
  if v_step is not null then
    perform app_private.workflow_complete_step(p.instance_id, v_step, 'Открытие ' || to_char(p_actual, 'DD.MM.YYYY'));
  end if;
  -- задачи стабилизации считаются от фактической даты
  perform app_private.workflow_reschedule(p.instance_id, 'actual_open', p_actual, 'Фактическое открытие');
  perform app_private.opening_log(p_project, 'opened', jsonb_build_object('actual_open_on', p_actual), p_comment);
  perform app_private.audit('opening.opened', 'opening_project', p_project, p.partner_id, jsonb_build_object('actual_open_on', p_actual));
  return p;
end $$;

create function public.opening_complete(p_project uuid) returns public.opening_project
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; v_open int;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.manage');
  if p.status <> 'opened' then perform app_private.fail('transition-not-allowed', 'Проект ещё не открыт', p.status); end if;
  select count(*) into v_open from public.task where instance_id = p.instance_id and status not in ('done', 'cancelled');
  if v_open > 0 then perform app_private.fail('transition-not-allowed', 'Остались незавершённые задачи стабилизации', v_open::text); end if;
  update public.opening_project set status = 'completed', updated_at = now(), revision = revision + 1 where id = p_project returning * into p;
  perform app_private.workflow_complete(p.instance_id);
  perform app_private.opening_log(p_project, 'completed', null, null);
  return p;
end $$;

create function public.opening_cancel(p_project uuid, p_reason text) returns public.opening_project
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; n int;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.manage');
  if p.status not in ('active', 'approved') then perform app_private.fail('transition-not-allowed', 'Проект нельзя отменить', p.status); end if;
  if coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Укажите причину', 'reason'); end if;
  n := app_private.workflow_cancel(p.instance_id, 'Проект открытия отменён: ' || p_reason);
  update public.opening_project set status = 'cancelled', status_reason = p_reason, updated_at = now(), revision = revision + 1
  where id = p_project returning * into p;
  -- Документы и финансовые обязательства сохраняются; финансам — задача на обработку (OPEN-04)
  perform app_private.task_create('opening_cancel_review', 'Проверить обязательства отменённого открытия ' || p.number,
    'Причина отмены: ' || p_reason, 'finance', p.partner_id, p.location_id, 'opening_project', p.id, now() + interval '3 days',
    'high', false, 'opening_cancel:' || p.id);
  perform app_private.opening_log(p_project, 'cancelled', jsonb_build_object('tasks_cancelled', n), p_reason);
  perform app_private.audit('opening.cancel', 'opening_project', p_project, p.partner_id, null, p_reason);
  return p;
end $$;

create function public.opening_add_note(p_project uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare p public.opening_project; v_id uuid;
begin
  perform app_private.require_user();
  p := app_private.opening_load(p_project, 'opening.read');
  if not app_private.is_staff() then perform app_private.fail('forbidden', 'Внутренние заметки доступны только сотрудникам'); end if;
  if coalesce(trim(p_body), '') = '' then perform app_private.fail('validation', 'Пустая заметка', 'body'); end if;
  insert into public.opening_note(project_id, body, author_id) values (p_project, left(p_body, 4000), auth.uid()) returning id into v_id;
  return v_id;
end $$;

------------------------------------------------------------------------------
-- Чтение: прогресс открытия (вспомогательный) и критический путь
------------------------------------------------------------------------------
create view public.v_opening_progress with (security_invoker = true) as
select p.id as project_id,
  count(t.*) filter (where t.status <> 'cancelled') as total_tasks,
  count(t.*) filter (where t.status = 'done') as done_tasks,
  count(t.*) filter (where t.is_critical and t.status not in ('done', 'cancelled')) as critical_open,
  count(t.*) filter (where t.status in ('blocked', 'waiting_external')) as blocked_tasks,
  count(t.*) filter (where t.due_at < now() and t.status not in ('done', 'cancelled')) as overdue_tasks,
  min(t.due_at) filter (where t.status not in ('done', 'cancelled')) as next_due_at,
  bool_or(t.is_critical and t.status not in ('done', 'cancelled') and t.due_at > (p.planned_open_on::timestamp at time zone 'UTC')) as date_at_risk
from public.opening_project p
left join public.task t on t.instance_id = p.instance_id
group by p.id;

------------------------------------------------------------------------------
-- RLS и права
------------------------------------------------------------------------------
alter table public.contract enable row level security;
alter table public.contract_location enable row level security;
alter table public.contract_policy_version enable row level security;
alter table public.opening_project enable row level security;
alter table public.opening_note enable row level security;
alter table public.opening_event enable row level security;

create policy read_contract on public.contract for select to authenticated using (app_private.has_perm('contract.read', partner_id));
create policy read_contract on public.contract_location for select to authenticated
  using (exists (select 1 from public.contract c where c.id = contract_id and app_private.has_perm('contract.read', c.partner_id)));
create policy read_contract on public.contract_policy_version for select to authenticated
  using (exists (select 1 from public.contract c where c.id = contract_id and app_private.has_perm('contract.read', c.partner_id)));
create policy read_opening on public.opening_project for select to authenticated
  using (app_private.has_perm('opening.read', partner_id, location_id));
create policy read_staff on public.opening_note for select to authenticated
  using (app_private.is_staff() and exists (select 1 from public.opening_project p where p.id = project_id
         and app_private.has_perm('opening.read', p.partner_id, p.location_id)));
create policy read_opening on public.opening_event for select to authenticated
  using (exists (select 1 from public.opening_project p where p.id = project_id and app_private.has_perm('opening.read', p.partner_id, p.location_id)));

insert into app_private.client_table(tbl) values ('public.contract'), ('public.contract_location'), ('public.contract_policy_version'),
  ('public.opening_project'), ('public.opening_note'), ('public.opening_event'), ('public.v_opening_progress');
insert into app_private.client_command(fn) values
  ('public.contract_policy_add(uuid, date, int, text, int, int, text)'),
  ('public.opening_create(uuid, uuid, text, text, text, text, date, uuid, text)'),
  ('public.opening_change_date(uuid, date, text)'), ('public.opening_blockers(uuid)'), ('public.opening_approve(uuid, text)'),
  ('public.opening_mark_opened(uuid, date, text)'), ('public.opening_complete(uuid)'), ('public.opening_cancel(uuid, text)'),
  ('public.opening_add_note(uuid, text)');
select app_private.apply_grants();
