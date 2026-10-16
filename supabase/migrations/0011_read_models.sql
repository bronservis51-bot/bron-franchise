-- 0011 Analytics: экран «Сегодня» (CORE-01) и обзор исключений (MET-01). Только чтение; учитывает область пользователя.

create function public.today(p_partner uuid default null, p_location uuid default null) returns jsonb
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
      and app_private.has_perm('payment.confirm', o.partner_id, o.location_id)
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
  return v;
end $$;

-- Обзор исключений руководителя (MET-01): каждое число — с определением и ссылкой на список.
create function public.metrics_overview() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v jsonb := '[]'::jsonb; v_prev date := (date_trunc('month', now()) - interval '1 month')::date;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('metrics.read') then perform app_private.fail('forbidden', 'Нет доступа к показателям'); end if;

  v := v || jsonb_build_object('key', 'reports_pending', 'title', 'Неподтверждённые отчёты', 'link', '/royalties?status=submitted',
    'definition', 'Отчёты в статусах «отправлен» и «на проверке»', 'value',
    (select count(*) from public.revenue_report r where r.status in ('submitted', 'in_review') and app_private.has_perm('metrics.read', r.partner_id)));

  v := v || jsonb_build_object('key', 'reports_on_time', 'title', 'Сдача отчётности вовремя за ' || to_char(v_prev, 'MM.YYYY'),
    'link', '/royalties?period=' || v_prev,
    'definition', 'Отчёты, отправленные до срока сдачи / договоры, действующие в периоде. Отменённые и недействующие периоды не учитываются',
    'value', (select jsonb_build_object('on_time', count(*) filter (where rr.submitted_at is not null and (rr.submitted_at at time zone c.timezone)::date
        <= make_date(extract(year from v_prev + interval '1 month')::int, extract(month from v_prev + interval '1 month')::int, coalesce(pol.report_due_day, 5))),
        'expected', count(*))
      from public.contract c
      left join lateral (select * from public.contract_policy_version v where v.contract_id = c.id and v.effective_from <= v_prev + interval '1 month' - interval '1 day'
        order by effective_from desc limit 1) pol on true
      left join public.revenue_report r on r.contract_id = c.id and r.period = v_prev
      left join lateral (select min(submitted_at) as submitted_at from public.report_revision where report_id = r.id) rr on true
      where c.status = 'active' and c.valid_from <= v_prev + interval '1 month' - interval '1 day' and (c.valid_to is null or c.valid_to >= v_prev)
        and app_private.has_perm('metrics.read', c.partner_id)));

  v := v || jsonb_build_object('key', 'overdue_debt', 'title', 'Просроченная задолженность', 'link', '/royalties/accruals?overdue=1',
    'definition', 'Положительные непогашенные остатки начислений после договорного срока; по каждой валюте отдельно, без пересчёта',
    'value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amount_minor', s, 'count', n)) from (
      select b.currency, sum(b.outstanding_minor) as s, count(*) as n from public.v_accrual_balance b
      where b.outstanding_minor > 0 and b.due_on < current_date and app_private.has_perm('metrics.read', b.partner_id) group by b.currency) q), '[]'::jsonb));

  v := v || jsonb_build_object('key', 'royalty_collection', 'title', 'Сбор роялти', 'link', '/royalties/accruals',
    'definition', 'Подтверждённые распределения / опубликованные начисления с учётом корректировок; по валютам; авансы не учитываются',
    'value', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'collected_minor', collected, 'due_minor', due)) from (
      select b.currency, sum(b.allocated_minor) as collected, sum(b.amount_minor + b.debit_minor - b.credit_minor) as due
      from public.v_accrual_balance b where app_private.has_perm('metrics.read', b.partner_id) group by b.currency) q), '[]'::jsonb));

  v := v || jsonb_build_object('key', 'openings_at_risk', 'title', 'Открытия с риском даты', 'link', '/openings?risk=1',
    'definition', 'Активные проекты, где критическая задача просрочена или её срок позже плановой даты открытия',
    'value', (select count(*) from public.opening_project p join public.v_opening_progress g on g.project_id = p.id
      where p.status = 'active' and (g.date_at_risk or exists (select 1 from public.task t where t.instance_id = p.instance_id and t.is_critical
        and t.status not in ('done', 'cancelled') and t.due_at < now())) and app_private.has_perm('metrics.read', p.partner_id, p.location_id)));

  v := v || jsonb_build_object('key', 'tickets_sla', 'title', 'Обращения вне SLA', 'link', '/support?sla=breached',
    'definition', 'Открытые обращения с просроченной первой реакцией или решением; ожидание партнёра приостанавливает таймер решения',
    'value', (select count(*) from public.ticket k where k.status not in ('resolved', 'closed', 'waiting_partner')
      and ((k.first_response_at is null and k.first_response_due < now()) or k.resolve_due < now())
      and app_private.has_perm('metrics.read', k.partner_id, k.location_id)));

  v := v || jsonb_build_object('key', 'orders_transfer', 'title', 'Заказы не переданы на склад', 'link', '/orders?transfer=problem',
    'definition', 'Заказы со статусом передачи «ошибка» или «требуется сверка»',
    'value', (select count(*) from public.sales_order o where o.transfer_status in ('failed', 'needs_reconciliation')
      and app_private.has_perm('metrics.read', o.partner_id, o.location_id)));

  v := v || jsonb_build_object('key', 'queues_without_people', 'title', 'Очереди без исполнителя', 'link', '/settings/queues',
    'definition', 'Открытые задачи и обращения, в очереди и резерве которых нет ни одного активного сотрудника',
    'value', (select count(*) from (
      select t.queue_role, t.backup_role, t.partner_id, t.location_id from public.task t where t.status not in ('done', 'cancelled')
      union select k.queue_role, k.backup_role, k.partner_id, k.location_id from public.ticket k where k.status not in ('resolved', 'closed')) q
      where not exists (select 1 from app_private.queue_members(q.queue_role, q.partner_id, q.location_id))
        and (q.backup_role is null or not exists (select 1 from app_private.queue_members(q.backup_role, q.partner_id, q.location_id)))));

  v := v || jsonb_build_object('key', 'kb_review', 'title', 'Знания требуют пересмотра', 'link', '/kb?status=needs_review',
    'definition', 'Опубликованные статьи с наступившим сроком пересмотра или отметкой «требуется пересмотр»; архив не учитывается',
    'value', (select count(*) from public.article a where a.status = 'needs_review' or (a.status = 'published' and a.review_due < current_date)));

  v := v || jsonb_build_object('key', 'ack_completion', 'title', 'Обязательные ознакомления', 'link', '/learning?all=1',
    'definition', 'Завершённые назначения ознакомления с актуальными обязательными редакциями / все такие назначения; просмотры не учитываются',
    'value', (select jsonb_build_object('done', count(*) filter (where k.completed_at is not null), 'total', count(*))
      from public.ack_assignment k join public.article a on a.id = k.article_id and a.published_revision_id = k.revision_id));

  v := v || jsonb_build_object('key', 'integration_failures', 'title', 'Сбои обмена', 'link', '/settings/integrations',
    'definition', 'Команды обмена с ошибкой, неизвестным результатом или остановленные после исчерпания попыток',
    'value', (select count(*) from public.outbox where status in ('failed', 'unknown', 'dead')));

  v := v || jsonb_build_object('key', 'kb_export', 'title', 'Корпоративная копия знаний ожидает сохранения', 'link', '/settings/integrations',
    'definition', 'Опубликованные статьи, экспорт которых не выполнен или завершился ошибкой',
    'value', (select count(*) from public.article where export_status in ('pending', 'failed') and status <> 'archived'));

  return jsonb_build_object('generated_at', now(), 'timezone', 'UTC', 'items', v,
    'note', 'Демонстрационные данные. Выручка партнёров — по их отчётам, не подтверждённая внешним источником.');
end $$;

-- Очереди и их исполнители (CORE-07): конфигурационные ошибки видны администратору.
create function public.queue_health() returns table (queue_role text, queue_name text, partner_name text, location_name text,
  open_items bigint, members bigint, backup_members bigint)
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
#variable_conflict use_column
begin
  perform app_private.require_user();
  if not (app_private.has_perm_anywhere('metrics.read') or app_private.has_perm_anywhere('access.manage')) then
    perform app_private.fail('forbidden', 'Нет доступа');
  end if;
  return query
    select q.queue_role, r.name, p.name, l.name, count(*),
      (select count(*) from app_private.queue_members(q.queue_role, q.partner_id, q.location_id)),
      case when q.backup_role is null then 0::bigint else (select count(*) from app_private.queue_members(q.backup_role, q.partner_id, q.location_id)) end
    from (select t.queue_role, t.backup_role, t.partner_id, t.location_id from public.task t where t.status not in ('done', 'cancelled')
          union all select k.queue_role, k.backup_role, k.partner_id, k.location_id from public.ticket k where k.status not in ('resolved', 'closed')) q
    join public.role r on r.code = q.queue_role
    left join public.partner p on p.id = q.partner_id
    left join public.location l on l.id = q.location_id
    group by q.queue_role, r.name, q.backup_role, q.partner_id, q.location_id, p.name, l.name
    order by 6, 5 desc;
end $$;

insert into app_private.client_command(fn) values ('public.today(uuid, uuid)'), ('public.metrics_overview()'), ('public.queue_health()');
select app_private.apply_grants();
