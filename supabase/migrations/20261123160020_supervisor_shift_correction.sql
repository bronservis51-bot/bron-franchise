-- Supervisor correction uses the same employee revenue row and frozen shift terms.
create function public.staff_shift_correct(
  p_shift uuid, p_cash bigint, p_card bigint, p_expected_revision bigint, p_reason text, p_operation uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  previous public.work_shift;
  corrected public.work_shift;
  receipt app_private.operation_receipt;
  payload jsonb;
  result jsonb;
begin
  select * into previous from public.work_shift where id = p_shift;
  if not found or not app_private.has_perm('staff.manage', previous.partner_id)
    or not app_private.has_perm('revenue.enter', previous.partner_id)
    or not app_private.can_manage_user(previous.employee_id)
    or not app_private.staff_location_scope(previous.location_id) then
    perform app_private.fail('forbidden', 'Исправление доступно руководителю с правом внесения выручки на этой точке');
  end if;
  if p_operation is null or p_expected_revision is null then
    perform app_private.fail('validation', 'Обновите список смен');
  end if;
  payload := jsonb_build_object('shift', p_shift, 'cash', p_cash, 'card', p_card,
    'expected_revision', p_expected_revision, 'reason', p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'staff_shift_correct' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict', 'Операция содержит другие данные');
    end if;
    return receipt.result;
  end if;
  if p_cash is null or p_card is null or p_cash < 0 or p_card < 0 or p_cash::numeric + p_card::numeric > 100000000000 then
    perform app_private.fail('validation', 'Укажите обе суммы и проверьте выручку смены', 'cash');
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 3 and 1000 or p_reason !~ '[^[:space:]]' then
    perform app_private.fail('validation', 'Укажите причину исправления', 'reason');
  end if;

  perform app_private.revenue_day_lock(previous.location_id, previous.day);
  select * into previous from public.work_shift where id = p_shift for update;
  if not found or previous.status <> 'closed' or previous.revision <> p_expected_revision then
    perform app_private.fail('version-conflict', 'Смена изменилась. Откройте её заново и сверьте суммы');
  end if;
  -- revenue_save enforces the financial calendar and writes under the supervisor's identity.
  perform public.revenue_save(previous.location_id, previous.day, p_cash, p_card, previous.comment, previous.employee_id);
  select * into strict corrected from public.work_shift where id = p_shift;
  perform app_private.audit('shift.supervisor_correct', 'work_shift', p_shift, previous.partner_id,
    jsonb_build_object('employee', previous.employee_id, 'location', previous.location_id, 'day', previous.day,
      'before', jsonb_build_object('cash_minor', previous.cash_minor, 'card_minor', previous.card_minor,
        'earned_minor', previous.earned_minor, 'revision', previous.revision),
      'after', jsonb_build_object('cash_minor', corrected.cash_minor, 'card_minor', corrected.card_minor,
        'earned_minor', corrected.earned_minor, 'revision', corrected.revision)), btrim(p_reason));
  result := jsonb_build_object('ok', true, 'revision', corrected.revision);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'staff_shift_correct', payload, result);
  return result;
end $$;

revoke execute on function public.staff_shift_correct(uuid,bigint,bigint,bigint,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_shift_correct(uuid,bigint,bigint,bigint,text,uuid) to authenticated;
insert into app_private.client_command(fn) values ('public.staff_shift_correct(uuid,bigint,bigint,bigint,text,uuid)');

-- Permission-limited roster rows still contain no payroll details.
create or replace function public.staff_list(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  perform app_private.require_user();
  if not app_private.has_perm('staff.manage', p_partner) then
    perform app_private.require_perm('staff.view', p_partner);
    return coalesce((select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', '', 'active', s.active, 'can_manage', false,
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name),'[]')
        from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'is_manager', s.manager_enabled, 'employee_kind', s.employee_kind,
      'internship_completed', s.employee_kind='trainee' and s.internship_until < app_private.local_today(s.location_ids[1]),
      'month_shifts', 0, 'month_revenue_minor', 0, 'month_earned_minor', 0, 'shifts', '[]'::jsonb,
      'rate_bp', 0, 'shift_fee_minor', 0, 'open_shift', null
    ) order by s.active desc, u.full_name)
      from public.staff_member s join public.app_user u on u.id=s.user_id
      where s.partner_id=p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', s.user_id, 'full_name', u.full_name, 'phone', s.phone, 'active', s.active,
      'position', case when s.manager_enabled then 'manager' when s.employee_kind='trainee' then 'trainee' else 'sales_manager' end,
      'access', app_private.staff_access_flags(s), 'custom_pay', s.custom_pay,
      'location_ids', (select coalesce(jsonb_agg(x),'[]') from unnest(s.location_ids) x where app_private.staff_location_scope(x)), 'can_manage',app_private.can_manage_user(s.user_id), 'is_manager',exists(select 1 from role_assignment a where a.user_id=s.user_id and a.role='franchisee_manager' and a.revoked_at is null),
      'location_names', (select coalesce(jsonb_agg(l.name order by l.name), '[]'::jsonb) from public.location l where l.id = any(s.location_ids) and app_private.staff_location_scope(l.id)),
      'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation,
      'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
      'internship_completed', s.employee_kind='trainee' and s.internship_until < app_private.local_today(s.location_ids[1]),
      'open_shift', (select jsonb_build_object('id', w.id, 'location_name', l.name, 'opened_at', w.opened_at)
                     from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'open'),
      'month_shifts', (select count(*) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift w where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'day', w.day, 'location_name', l.name, 'total_minor', w.total_minor,
          'earned_minor', w.earned_minor, 'opened_at', w.opened_at, 'closed_at', w.closed_at, 'timezone', l.timezone,
          'submitted_without_open', w.submitted_without_open, 'cash_minor', w.cash_minor, 'card_minor', w.card_minor, 'revision', w.revision,
          'can_correct', app_private.can_manage_user(s.user_id) and app_private.has_perm('revenue.enter', w.partner_id)
            and l.status='active' and w.day <= app_private.local_today(l.id) and app_private.revenue_day_open(l.id,w.day)) order by w.day desc)
        from public.work_shift w join public.location l on l.id = w.location_id
        where w.employee_id = s.user_id and app_private.staff_location_scope(w.location_id) and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb)
    ) order by s.active desc, u.full_name)
    from public.staff_member s join public.app_user u on u.id = s.user_id where s.partner_id = p_partner and app_private.staff_member_scope(s.user_id)), '[]'::jsonb);
end $$;
