-- 0020 «Сегодня»: смена (открыта/закрыта), кто сейчас на смене у управляющего, поставки для заказывающих:
-- новинки, пришедшее из «Сообщить о поступлении», ожидаемые даты.

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
        where not exists (select 1 from public.daily_sale s where s.location_id = l.id and s.day = d::date)) m
      where l.status = 'active' and m.n > 0 and app_private.has_perm('sales.manage', l.partner_id, l.id) and l.partner_id is not distinct from coalesce(p_partner, l.partner_id)
        and (p_location is null or l.id = p_location) and not app_private.has_perm('sales.manage', null, null)), '[]'::jsonb),
    'on_shift', coalesce((select jsonb_agg(jsonb_build_object('location_name', l.name, 'name', u.full_name, 'opened_at', w.opened_at) order by w.opened_at)
      from public.work_shift w join public.location l on l.id = w.location_id join public.app_user u on u.id = w.employee_id
      where w.status = 'open' and w.employee_id <> v_user and app_private.has_perm('sales.manage', l.partner_id, l.id)
        and not app_private.has_perm('sales.manage', null, null)
        and (p_partner is null or l.partner_id = p_partner) and (p_location is null or l.id = p_location)), '[]'::jsonb)));
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
