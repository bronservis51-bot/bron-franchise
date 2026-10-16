-- 0023 Решения владельца 14.10.2026:
--   • руководитель компании не согласует заявки, не проверяет отчёты и не ставит подписи — он смотрит всю картину;
--   • разрешение на открытие точки выдаёт менеджер франшизы; задачи упразднённых ролей уходят профильным ролям;
--   • финансист один: свои операции он подтверждает сам, каждая такая операция записывается в журнал аудита;
--   • заметки к точкам с напоминанием — для всех, кто работает с точкой.

-- Руководитель: только просмотр и показатели
delete from public.role_permission where role = 'founder' and permission not in (
  'org.read', 'contract.read', 'royalty.read', 'finance.internal', 'order.read', 'catalog.read', 'opening.read', 'ticket.read', 'task.read',
  'kb.read', 'metrics.read', 'audit.read', 'sales.read', 'export.run', 'access.manage');
update public.role set description = 'Видит всю компанию: сеть, выручку, финансы, проблемы. Операций не согласует' where code = 'founder';
insert into public.role_permission(role, permission) values ('franchise_manager', 'opening.approve'), ('franchise_manager', 'kb.publish') on conflict do nothing;

-- Очереди ролей без людей: руководитель направления → менеджер франшизы, склад → снабжение, «руководитель» как очередь → менеджер франшизы
create or replace function app_private.queue_members(p_role text, p_partner uuid, p_location uuid) returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with target as (
    select case when p_role in ('direction_head', 'founder') then 'franchise_manager' when p_role = 'warehouse' then 'procurement' else p_role end as role)
  select distinct a.user_id from public.role_assignment a
  join public.app_user u on u.id = a.user_id and u.status = 'active'
  cross join target
  where a.role = target.role and a.revoked_at is null
    and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
    and app_private.scope_covers(a.scope_type, a.scope_id, p_partner, p_location)
$$;

-- Один финансист: операция разрешена, факт записывается в журнал (без задач руководителю)
update public.operator set sod_policy = 'allow_with_log';
create or replace function app_private.sod_check(p_other_actor uuid, p_action text, p_entity_type text, p_entity uuid, p_partner uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_policy text;
begin
  if p_other_actor is distinct from auth.uid() then return; end if;
  select sod_policy into v_policy from public.operator limit 1;
  -- Статьи базы знаний всегда публикует не автор; финансовые операции одного финансиста — с записью в журнал
  if coalesce(v_policy, 'strict') = 'strict' or p_action = 'article_publish' then
    perform app_private.fail('forbidden', 'Инициатор не может утвердить собственную операцию (разделение обязанностей)', p_action);
  end if;
  perform app_private.audit('sod_override', p_entity_type, p_entity, p_partner, jsonb_build_object('action', p_action), 'Один исполнитель: операция записана в журнал');
end $$;

-- Шаблон открытия меняет руководитель (настройка процесса, а не согласование)
create or replace function public.workflow_template_publish(p_template_code text, p_definition jsonb, p_note text) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_tpl uuid; v_ver int; v_id uuid;
begin
  if not exists (select 1 from app_private.active_assignments() a join public.role_permission rp on rp.role = a.role
                 where rp.permission in ('opening.approve', 'access.manage') and a.scope_type in ('company', 'direction')) then
    perform app_private.fail('forbidden', 'Недостаточно прав для изменения шаблона');
  end if;
  if coalesce(trim(p_note), '') = '' then perform app_private.fail('validation', 'Опишите изменение', 'note'); end if;
  select id into v_tpl from public.workflow_template where code = p_template_code;
  if not found then perform app_private.fail('not-found', 'Шаблон не найден'); end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.workflow_template_version where template_id = v_tpl;
  update public.workflow_template_version set status = 'retired' where template_id = v_tpl and status = 'published';
  insert into public.workflow_template_version(template_id, version, status, definition, change_note, created_by, published_at)
  values (v_tpl, v_ver, 'published', p_definition, p_note, v_user, now()) returning id into v_id;
  perform app_private.audit('workflow.publish', 'workflow_template', v_tpl, null, jsonb_build_object('version', v_ver), p_note);
  return v_id;
end $$;

------------------------------------------------------------------------------
-- Заметки к точкам
------------------------------------------------------------------------------
create table public.location_note (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location(id),
  partner_id uuid references public.partner(id),
  author_id uuid not null references public.app_user(id),
  body text not null check (length(trim(body)) between 1 and 2000),
  internal boolean not null default false, -- true: видят только сотрудники компании
  remind_on date,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.location_note (location_id, created_at desc);
create index on public.location_note (author_id, remind_on) where done_at is null;

create function app_private.can_read_note(n public.location_note) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select n.author_id = auth.uid()
    or (app_private.in_scope(n.partner_id, n.location_id) and (not n.internal or app_private.is_staff()))
$$;

create function public.location_note_add(p_location uuid, p_body text, p_remind_on date, p_internal boolean) returns public.location_note
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); l public.location; n public.location_note;
begin
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  if coalesce(trim(p_body), '') = '' then perform app_private.fail('validation', 'Напишите заметку', 'body'); end if;
  if p_remind_on is not null and p_remind_on < current_date then perform app_private.fail('validation', 'Напоминание — сегодня или позже', 'remind_on'); end if;
  insert into public.location_note(location_id, partner_id, author_id, body, internal, remind_on)
  values (l.id, l.partner_id, v_user, trim(p_body), coalesce(p_internal, false) and app_private.is_staff(), p_remind_on)
  returning * into n;
  return n;
end $$;

-- Отметить напоминание выполненным (или вернуть)
create function public.location_note_done(p_note uuid, p_done boolean) returns public.location_note
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare n public.location_note;
begin
  perform app_private.require_user();
  update public.location_note set done_at = case when p_done then now() end where id = p_note and author_id = auth.uid() returning * into n;
  if not found then perform app_private.fail('not-found', 'Заметка не найдена'); end if;
  return n;
end $$;

create function public.location_note_delete(p_note uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  delete from public.location_note where id = p_note and author_id = auth.uid();
  if not found then perform app_private.fail('not-found', 'Удалить можно только свою заметку'); end if;
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

alter table public.location_note enable row level security;
create policy read_note on public.location_note for select to authenticated using (app_private.can_read_note(location_note));
insert into app_private.client_table(tbl) values ('public.location_note');
insert into app_private.client_command(fn) values ('public.location_note_add(uuid, text, date, boolean)'), ('public.location_note_done(uuid, boolean)'), ('public.location_note_delete(uuid)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_note(public.location_note)');
select app_private.apply_grants();
