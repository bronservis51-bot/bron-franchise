-- 0026 CRM (решение владельца 14.10.2026): воронка будущих франчайзи. Главное правило — у каждого живого лида есть
-- следующий шаг с датой; касания (звонок, встреча, сообщение) пишутся одной кнопкой; дубли по телефону не создаются;
-- «Партнёр» создаёт карточку франчайзи и проект открытия точки.

insert into public.permission(code, description, is_financial) values
  ('crm.read', 'CRM: просмотр воронки франчайзи', false),
  ('crm.manage', 'CRM: работа с лидами', false);
insert into public.role_permission(role, permission) values
  ('founder', 'crm.read'), ('franchise_manager', 'crm.read'), ('franchise_manager', 'crm.manage');

create table public.crm_lead (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  name text not null check (length(trim(name)) > 0),
  company text,
  phone text,
  phone_digits text generated always as (nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')) stored,
  email text,
  country text references public.country(code),
  city text,
  source text not null default 'other' check (source in ('site', 'call', 'referral', 'social', 'exhibition', 'ads', 'other')),
  stage text not null default 'new' check (stage in ('new', 'contacted', 'meeting', 'negotiation', 'contract', 'won', 'lost')),
  investment_minor bigint check (investment_minor >= 0),
  points_planned int check (points_planned between 1 and 100),
  owner_id uuid references public.app_user(id),
  next_action text,
  next_action_at timestamptz,
  lost_reason text,
  partner_id uuid references public.partner(id),
  opening_id uuid references public.opening_project(id),
  stage_changed_at timestamptz not null default now(),
  last_touch_at timestamptz,
  created_by uuid references public.app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision int not null default 1,
  is_demo boolean not null default false
);
create index on public.crm_lead (owner_id, stage, next_action_at);
create index on public.crm_lead (phone_digits);

create table public.crm_activity (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.crm_lead(id),
  kind text not null check (kind in ('call', 'meeting', 'message', 'note', 'stage', 'created')),
  body text,
  actor_id uuid references public.app_user(id),
  at timestamptz not null default now()
);
create index on public.crm_activity (lead_id, at desc);

create function app_private.crm_require(p_manage boolean) returns uuid
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user();
begin
  if not app_private.has_perm_anywhere(case when p_manage then 'crm.manage' else 'crm.read' end) then
    perform app_private.fail('forbidden', case when p_manage then 'Лидами занимается менеджер франшизы' else 'Нет доступа к CRM' end);
  end if;
  return v_user;
end $$;

create function app_private.crm_log(p_lead uuid, p_kind text, p_body text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.crm_activity(lead_id, kind, body, actor_id) values (p_lead, p_kind, nullif(trim(p_body), ''), auth.uid())
$$;

create function app_private.crm_check_duplicate(p_phone text, p_except uuid) returns void
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare d text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), ''); c public.crm_lead;
begin
  if d is null then return; end if;
  select * into c from public.crm_lead where right(phone_digits, 10) = right(d, 10) and id is distinct from p_except and stage <> 'lost' limit 1;
  if found then perform app_private.fail('validation', 'Этот номер уже в CRM: ' || c.number || ' — ' || c.name, 'phone'); end if;
end $$;

create function public.crm_lead_create(p_name text, p_phone text, p_city text, p_country text, p_source text, p_comment text,
  p_next_action text, p_next_action_at timestamptz) returns public.crm_lead
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.crm_require(true); c public.crm_lead;
begin
  if coalesce(trim(p_name), '') = '' then perform app_private.fail('validation', 'Как зовут клиента?', 'name'); end if;
  if coalesce(trim(p_phone), '') = '' then perform app_private.fail('validation', 'Укажите телефон — по нему будем связываться', 'phone'); end if;
  perform app_private.crm_check_duplicate(p_phone, null);
  insert into public.crm_lead(number, name, phone, city, country, source, owner_id, next_action, next_action_at, created_by)
  values (app_private.next_number('ЛД'), trim(p_name), trim(p_phone), nullif(trim(p_city), ''), nullif(p_country, ''), coalesce(nullif(p_source, ''), 'other'), v_user,
    coalesce(nullif(trim(p_next_action), ''), 'Первый звонок: познакомиться и узнать город'), coalesce(p_next_action_at, now() + interval '2 hours'), v_user)
  returning * into c;
  perform app_private.crm_log(c.id, 'created', p_comment);
  return c;
end $$;

create function public.crm_lead_update(p_lead uuid, p_patch jsonb, p_expected_revision int) returns public.crm_lead
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.crm_require(true); c public.crm_lead;
begin
  select * into c from public.crm_lead where id = p_lead for update;
  if not found then perform app_private.fail('not-found', 'Лид не найден'); end if;
  if p_expected_revision is not null and c.revision <> p_expected_revision then perform app_private.fail('version-conflict', 'Лид уже изменили. Обновите страницу'); end if;
  if p_patch ? 'phone' then perform app_private.crm_check_duplicate(p_patch ->> 'phone', c.id); end if;
  if p_patch ? 'name' and coalesce(trim(p_patch ->> 'name'), '') = '' then perform app_private.fail('validation', 'Имя не может быть пустым', 'name'); end if;
  update public.crm_lead set
    name = coalesce(nullif(trim(p_patch ->> 'name'), ''), name),
    company = case when p_patch ? 'company' then nullif(trim(p_patch ->> 'company'), '') else company end,
    phone = case when p_patch ? 'phone' then nullif(trim(p_patch ->> 'phone'), '') else phone end,
    email = case when p_patch ? 'email' then nullif(trim(p_patch ->> 'email'), '') else email end,
    city = case when p_patch ? 'city' then nullif(trim(p_patch ->> 'city'), '') else city end,
    country = case when p_patch ? 'country' then nullif(p_patch ->> 'country', '') else country end,
    source = coalesce(nullif(p_patch ->> 'source', ''), source),
    investment_minor = case when p_patch ? 'investment_minor' then (p_patch ->> 'investment_minor')::bigint else investment_minor end,
    points_planned = case when p_patch ? 'points_planned' then (p_patch ->> 'points_planned')::int else points_planned end,
    owner_id = case when p_patch ? 'owner_id' then (p_patch ->> 'owner_id')::uuid else owner_id end,
    updated_at = now(), revision = revision + 1
  where id = c.id returning * into c;
  return c;
end $$;

-- Касание одной кнопкой: что было + что дальше и когда
create function public.crm_touch(p_lead uuid, p_kind text, p_body text, p_next_action text, p_next_action_at timestamptz) returns public.crm_lead
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.crm_require(true); c public.crm_lead;
begin
  select * into c from public.crm_lead where id = p_lead for update;
  if not found then perform app_private.fail('not-found', 'Лид не найден'); end if;
  if p_kind not in ('call', 'meeting', 'message', 'note') then perform app_private.fail('validation', 'Неизвестный вид касания', 'kind'); end if;
  if coalesce(trim(p_body), '') = '' and coalesce(trim(p_next_action), '') = '' then perform app_private.fail('validation', 'Напишите, чем закончилось, или следующий шаг', 'body'); end if;
  if c.stage not in ('won', 'lost') and coalesce(trim(p_next_action), '') <> '' and p_next_action_at is null then
    perform app_private.fail('validation', 'Когда следующий шаг?', 'next_action_at');
  end if;
  if coalesce(trim(p_body), '') <> '' then perform app_private.crm_log(c.id, p_kind, p_body); end if;
  update public.crm_lead set
    next_action = case when coalesce(trim(p_next_action), '') <> '' then trim(p_next_action) else next_action end,
    next_action_at = case when coalesce(trim(p_next_action), '') <> '' then p_next_action_at else next_action_at end,
    last_touch_at = case when p_kind <> 'note' and coalesce(trim(p_body), '') <> '' then now() else last_touch_at end,
    stage = case when stage = 'new' and p_kind in ('call', 'meeting', 'message') and coalesce(trim(p_body), '') <> '' then 'contacted' else stage end,
    stage_changed_at = case when stage = 'new' and p_kind in ('call', 'meeting', 'message') and coalesce(trim(p_body), '') <> '' then now() else stage_changed_at end,
    owner_id = coalesce(owner_id, v_user), updated_at = now(), revision = revision + 1
  where id = c.id returning * into c;
  return c;
end $$;

create function public.crm_set_stage(p_lead uuid, p_stage text, p_reason text, p_planned_open date) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.crm_require(true); c public.crm_lead; p public.partner; cn public.country; v_dir uuid; v_project uuid;
  v_titles jsonb := '{"new":"Новый","contacted":"Связались","meeting":"Встреча","negotiation":"Переговоры","contract":"Договор","won":"Партнёр","lost":"Отказ"}';
begin
  select * into c from public.crm_lead where id = p_lead for update;
  if not found then perform app_private.fail('not-found', 'Лид не найден'); end if;
  if p_stage not in ('new', 'contacted', 'meeting', 'negotiation', 'contract', 'won', 'lost') then perform app_private.fail('validation', 'Неизвестный этап', 'stage'); end if;
  if c.stage = 'won' then perform app_private.fail('transition-not-allowed', 'Лид уже стал партнёром'); end if;
  if p_stage = c.stage then return jsonb_build_object('lead', to_jsonb(c)); end if;
  if p_stage = 'lost' and coalesce(trim(p_reason), '') = '' then perform app_private.fail('validation', 'Почему отказ? Это поможет понять, что улучшить', 'reason'); end if;
  if p_stage = 'won' then
    if c.country is null or coalesce(c.city, '') = '' then perform app_private.fail('validation', 'Укажите страну и город будущей точки', 'city'); end if;
    if p_planned_open is null or p_planned_open < current_date then perform app_private.fail('validation', 'Укажите плановую дату открытия', 'planned_open'); end if;
    select * into cn from public.country where code = c.country;
    select id into v_dir from public.direction order by created_at nulls last limit 1;
    insert into public.partner(code, name, country, direction_id, locale, status, contact_name, contact_phone, contact_email)
    values ('P-' || right(c.number, 6), coalesce(c.company, c.name), c.country, v_dir, cn.default_locale, 'prospect', c.name, c.phone, c.email)
    returning * into p;
    v_project := app_private.opening_create_internal(p.id, null, c.city || ' (новая точка)', c.city, null, null, p_planned_open, c.owner_id, null, null, c.number);
  end if;
  update public.crm_lead set stage = p_stage, stage_changed_at = now(), lost_reason = case when p_stage = 'lost' then trim(p_reason) else null end,
    next_action = case when p_stage in ('won', 'lost') then null else next_action end,
    next_action_at = case when p_stage in ('won', 'lost') then null else next_action_at end,
    partner_id = coalesce(p.id, partner_id), opening_id = coalesce(v_project, opening_id), updated_at = now(), revision = revision + 1
  where id = c.id returning * into c;
  perform app_private.crm_log(c.id, 'stage', (v_titles ->> p_stage) || coalesce(': ' || nullif(trim(p_reason), ''), ''));
  perform app_private.audit('crm.stage', 'crm_lead', c.id, p.id, jsonb_build_object('stage', p_stage, 'reason', p_reason));
  return jsonb_build_object('lead', to_jsonb(c), 'partner_id', p.id, 'opening_id', v_project);
end $$;

create or replace function public.today(p_partner uuid default null, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v jsonb := '{}'::jsonb;
begin
  -- Мои задачи: ближайшие сроки первыми
  v := v || jsonb_build_object('my_tasks', coalesce((select jsonb_agg(x order by x.due_at nulls last, x.priority_order) from (
    select t.id, t.number, t.title, t.status, t.due_at, t.priority, t.is_critical, t.kind, t.subject_type, t.subject_id,
      (select name from public.location where id = t.location_id) as location_name,
      (select name from public.partner where id = t.partner_id) as partner_name,
      case t.priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end as priority_order,
      t.status_reason
    from public.task t
    where t.assignee_id = v_user and t.status not in ('done', 'cancelled', 'planned')
      and (p_partner is null or t.partner_id = p_partner) and (p_location is null or t.location_id = p_location)
    order by t.due_at nulls last limit 30) x), '[]'::jsonb));

  -- Очередь: задачи моих ролей без исполнителя
  v := v || jsonb_build_object('queue_tasks', coalesce((select jsonb_agg(x order by x.due_at nulls last) from (
    select t.id, t.number, t.title, t.status, t.due_at, t.priority, t.queue_role,
      (select name from public.role where code = t.queue_role) as queue_name,
      (select name from public.location where id = t.location_id) as location_name,
      (select name from public.partner where id = t.partner_id) as partner_name
    from public.task t
    where t.assignee_id is null and t.status in ('ready', 'in_review')
      and app_private.user_in_queue(v_user, t.queue_role, t.partner_id, t.location_id)
      and app_private.can_read_task(t)
      and (p_partner is null or t.partner_id = p_partner) and (p_location is null or t.location_id = p_location)
    order by t.due_at nulls last limit 30) x), '[]'::jsonb));

  -- Обращения: мои как исполнителя или автора; новые в моих очередях
  v := v || jsonb_build_object('tickets', coalesce((select jsonb_agg(x order by x.urgent desc, x.resolve_due) from (
    select k.id, k.number, k.subject, k.status, k.urgency, k.resolve_due, k.first_response_due, k.first_response_at,
      (k.urgency = 'stopped') as urgent, (select name from public.location where id = k.location_id) as location_name,
      case when k.created_by = v_user then 'author' when k.assignee_id = v_user then 'assignee' else 'queue' end as relation
    from public.ticket k
    where k.status not in ('closed')
      and (k.created_by = v_user or k.assignee_id = v_user
           or (k.assignee_id is null and k.status = 'new' and app_private.user_in_queue(v_user, k.queue_role, k.partner_id, k.location_id)))
      and (k.status <> 'resolved' or k.created_by = v_user)
      and (p_partner is null or k.partner_id = p_partner) and (p_location is null or k.location_id = p_location)
    limit 30) x), '[]'::jsonb));

  -- Согласования и подтверждения по моим разрешениям
  v := v || jsonb_build_object('approvals', coalesce((select jsonb_agg(x) from (
    select 'order' as kind, o.id, o.number as number, 'Согласовать заявку' as title, o.total_minor as amount_minor, o.currency, o.submitted_at as at,
      '/orders/' || o.id as link
    from public.sales_order o where o.approval_status = 'pending' and o.created_by <> v_user
      and app_private.has_perm('order.approve', o.partner_id, o.location_id)
    union all
    select 'order_payment', o.id, o.number, 'Подтвердить оплату заказа', o.total_minor, o.currency, o.submitted_at, '/orders/' || o.id
    from public.sales_order o where o.payment_status in ('required', 'reported') and o.status <> 'cancelled'
      and app_private.has_perm('order.payment.confirm', o.partner_id, o.location_id) and o.created_by <> v_user
    union all
    select 'report', r.id, r.number, 'Проверить отчёт о выручке', null, null, r.updated_at, '/royalties/reports/' || r.id
    from public.revenue_report r where r.status in ('submitted', 'in_review') and app_private.has_perm('royalty.review', r.partner_id)
    union all
    select 'accrual', r.id, r.number, 'Опубликовать начисление', null, null, r.updated_at, '/royalties/reports/' || r.id
    from public.revenue_report r where r.status = 'approved' and app_private.has_perm('royalty.publish', r.partner_id)
      and not exists (select 1 from public.accrual a where a.contract_id = r.contract_id and a.period = r.period and a.status = 'published')
    union all
    select 'payment', p.id, p.number, case p.status when 'reported' then 'Проверить сообщение об оплате' else 'Подтвердить зачисление' end,
      p.amount_minor, p.currency, p.created_at, '/royalties/payments/' || p.id
    from public.payment p where p.status in ('reported', 'registered') and app_private.has_perm('payment.confirm', p.partner_id)
      and (p.status = 'reported' or p.registered_by is distinct from v_user)
    union all
    select 'article', a.id, r.title, 'Согласовать статью', null, null, r.submitted_at, '/kb/articles/' || a.id || '/review'
    from public.article_revision r join public.article a on a.id = r.article_id
    where r.status = 'in_review' and app_private.has_perm_anywhere('kb.publish') and r.author_id is distinct from v_user
    union all
    select 'opening', p.id, p.number, 'Выдать разрешение на открытие', null, null, p.updated_at, '/openings/' || p.id
    from public.opening_project p where p.status = 'active' and app_private.has_perm('opening.approve', p.partner_id, p.location_id)
      and not exists (select 1 from public.opening_blockers(p.id))
    order by 7 limit 40) x), '[]'::jsonb));

  -- Обязательное обучение (ознакомления)
  v := v || jsonb_build_object('acks', coalesce((select jsonb_agg(x order by x.due_on) from (
    select k.id, k.article_id, k.revision_id, k.due_on, r.title
    from public.ack_assignment k join public.article_revision r on r.id = k.revision_id
    join public.article a on a.id = k.article_id and a.published_revision_id = k.revision_id
    where k.user_id = v_user and k.completed_at is null limit 20) x), '[]'::jsonb));

  -- Незавершённые черновики
  v := v || jsonb_build_object('drafts', coalesce((select jsonb_agg(x) from (
    select 'cart' as kind, o.id, 'Корзина: ' || (select name from public.location where id = o.location_id) as title, o.updated_at,
      '/catalog?order=' || o.id as link, (select count(*) from public.order_line where order_id = o.id) as items
    from public.sales_order o where o.created_by = v_user and o.status = 'draft' and exists (select 1 from public.order_line where order_id = o.id)
    union all
    select 'report', r.id, 'Отчёт ' || r.number || ' за ' || to_char(r.period, 'MM.YYYY'), r.updated_at, '/royalties/reports/' || r.id, null
    from public.revenue_report r where r.status in ('draft', 'needs_correction') and app_private.has_perm('royalty.report.submit', r.partner_id)
    union all
    select 'article', a.id, 'Черновик: ' || v2.title, v2.updated_at, '/kb/articles/' || a.id || '/edit', null
    from public.article_revision v2 join public.article a on a.id = v2.article_id
    where v2.author_id = v_user and v2.status in ('draft', 'rejected')
    limit 20) x), '[]'::jsonb));

  -- Критические события: срочные непрочитанные уведомления
  v := v || jsonb_build_object('critical', coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select n.id, n.title, n.body, n.link, n.created_at, n.kind from public.notification n
    where n.user_id = v_user and n.critical and n.read_at is null and n.kind <> 'kb.ack' -- ознакомления показаны отдельным блоком
    order by n.created_at desc limit 10) x), '[]'::jsonb));

  -- Сводка для открытия проектов партнёра/менеджера
  v := v || jsonb_build_object('openings', coalesce((select jsonb_agg(x order by x.planned_open_on) from (
    select p.id, p.number, p.status, p.planned_open_on, l.name as location_name, g.done_tasks, g.total_tasks, g.critical_open,
      g.overdue_tasks, g.date_at_risk
    from public.opening_project p join public.location l on l.id = p.location_id
    join public.v_opening_progress g on g.project_id = p.id
    where p.status in ('active', 'approved', 'opened') and app_private.has_perm('opening.read', p.partner_id, p.location_id)
      and (p_partner is null or p.partner_id = p_partner) limit 10) x), '[]'::jsonb));

  -- Финансы партнёра: открытые начисления
  v := v || jsonb_build_object('balances', coalesce((select jsonb_agg(x order by x.due_on) from (
    select b.accrual_id, b.number, b.period, b.currency, b.outstanding_minor, b.due_on, (b.due_on < current_date) as overdue
    from public.accrual a join public.v_accrual_balance b on b.accrual_id = a.id
    where b.outstanding_minor > 0 and app_private.has_perm('royalty.read', a.partner_id)
      and not app_private.has_perm('royalty.publish', a.partner_id)
      and (p_partner is null or a.partner_id = p_partner) limit 10) x), '[]'::jsonb));
  -- Выручка: моя смена и пропуски на точках, которыми я управляю
  v := v || jsonb_build_object('sales', jsonb_build_object(
    'my', case when exists (select 1 from public.location l where app_private.user_can_sell_at(v_user, l.id)) then public.my_earnings(current_date) end,
    'missing', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'days', m.n)) from public.location l
      cross join lateral (select count(*) as n from generate_series(date_trunc('month', now() at time zone l.timezone)::date,
          ((now() at time zone l.timezone)::date - 1), interval '1 day') d
        where not app_private.sales_day_covered(l.id, d::date)) m
      where l.status = 'active' and m.n > 0 and app_private.has_perm('sales.manage', l.partner_id, l.id) and l.partner_id is not distinct from coalesce(p_partner, l.partner_id)
        and (p_location is null or l.id = p_location) and not app_private.has_perm('sales.manage', null, null)), '[]'::jsonb),
    'on_shift', coalesce((select jsonb_agg(jsonb_build_object('location_name', l.name, 'name', u.full_name, 'opened_at', w.opened_at) order by w.opened_at)
      from public.work_shift w join public.location l on l.id = w.location_id join public.app_user u on u.id = w.employee_id
      where w.status = 'open' and w.employee_id <> v_user and app_private.has_perm('sales.manage', l.partner_id, l.id)
        and not app_private.has_perm('sales.manage', null, null)
        and (p_partner is null or l.partner_id = p_partner) and (p_location is null or l.id = p_location)), '[]'::jsonb)));
  -- Точки, которыми я управляю (франчайзи, управляющий): выручка месяца, заполненность, кто на смене
  v := v || jsonb_build_object('points', coalesce((select jsonb_agg(x order by x.status <> 'active', x.name) from (
    select l.id, l.name, l.status, l.currency,
      (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= date_trunc('month', now() at time zone l.timezone)::date)::bigint as revenue_minor,
      (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day = (now() at time zone l.timezone)::date)::bigint as today_minor,
      greatest(0, (now() at time zone l.timezone)::date - greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01'::date)))::int as days_passed,
      case when l.status = 'active' then (select count(*) from generate_series(greatest(date_trunc('month', now() at time zone l.timezone)::date, coalesce(l.opened_on, '1900-01-01'::date)),
          (now() at time zone l.timezone)::date - 1, interval '1 day') d where not app_private.sales_day_covered(l.id, d::date))::int else 0 end as missing,
      coalesce((select jsonb_agg(u.full_name) from public.work_shift w join public.app_user u on u.id = w.employee_id
        where w.location_id = l.id and w.status = 'open' and w.day = (now() at time zone l.timezone)::date), '[]'::jsonb) as on_shift
    from public.location l
    where l.status in ('active', 'opening') and app_private.has_perm('sales.manage', l.partner_id, l.id) and not app_private.has_perm('sales.manage', null, null)
      and (p_partner is null or l.partner_id = p_partner) and (p_location is null or l.id = p_location)) x), '[]'::jsonb));
  -- Мои напоминания из заметок к точкам: срок наступил, не отмечены выполненными
  v := v || jsonb_build_object('reminders', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'location_id', n.location_id, 'location_name', l.name,
      'body', n.body, 'remind_on', n.remind_on) order by n.remind_on)
    from public.location_note n join public.location l on l.id = n.location_id
    where n.author_id = v_user and n.remind_on is not null and n.remind_on <= current_date and n.done_at is null), '[]'::jsonb));
  -- CRM: мои следующие шаги на сегодня и просроченные; активные лиды без шага
  if app_private.has_perm_anywhere('crm.manage') then
    v := v || jsonb_build_object('crm', jsonb_build_object(
      'due', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'stage', c.stage, 'next_action', c.next_action,
          'next_action_at', c.next_action_at, 'phone', c.phone) order by c.next_action_at)
        from public.crm_lead c where c.owner_id = v_user and c.stage not in ('won', 'lost') and c.next_action_at < (current_date + 1)::timestamptz), '[]'::jsonb),
      'no_step', (select count(*) from public.crm_lead c where c.owner_id = v_user and c.stage not in ('won', 'lost') and c.next_action_at is null)));
  end if;
  -- Поставки: только тем, кто заказывает
  if app_private.has_perm_anywhere('order.create') then
    v := v || jsonb_build_object('supply', jsonb_build_object(
      'new_items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'subtitle', i.subtitle, 'visual', i.visual, 'sku', i.sku) order by i.published_at desc)
        from public.catalog_item i where i.active and i.published_at > now() - interval '14 days'), '[]'::jsonb),
      'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'available', app_private.stock_total(i.id) > 0,
          'expected_on', (select min(r.expected_on) from public.stock_incoming r where r.item_id = i.id and r.status = 'planned')) order by i.name)
        from public.stock_subscription s join public.catalog_item i on i.id = s.item_id where s.user_id = v_user), '[]'::jsonb)));
  end if;
  return v;
end $$;

alter table public.crm_lead enable row level security;
alter table public.crm_activity enable row level security;
create policy read_crm on public.crm_lead for select to authenticated using (app_private.has_perm_anywhere('crm.read'));
create policy read_crm on public.crm_activity for select to authenticated using (app_private.has_perm_anywhere('crm.read'));
insert into app_private.client_table(tbl) values ('public.crm_lead'), ('public.crm_activity');
insert into app_private.client_command(fn) values
  ('public.crm_lead_create(text, text, text, text, text, text, text, timestamptz)'), ('public.crm_lead_update(uuid, jsonb, int)'),
  ('public.crm_touch(uuid, text, text, text, timestamptz)'), ('public.crm_set_stage(uuid, text, text, date)');
select app_private.apply_grants();
