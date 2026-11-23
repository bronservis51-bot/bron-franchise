-- One employee command posts the selected day's shift, revenue and payroll together.
create function public.shift_submit(
  p_location uuid, p_day date, p_cash bigint, p_card bigint, p_operation uuid, p_comment text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  employee public.staff_member;
  point public.location;
  shift public.work_shift;
  today date;
  receipt app_private.operation_receipt;
  payload jsonb;
  result jsonb;
begin
  employee := app_private.my_staff();
  if p_operation is null or p_location is null or p_day is null or not isfinite(p_day) then
    perform app_private.fail('validation', 'Укажите точку и дату смены и обновите приложение');
  end if;
  payload := jsonb_build_object('location', p_location, 'day', p_day, 'cash', p_cash, 'card', p_card, 'comment', p_comment);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'shift_submit' or receipt.payload <> payload then
      perform app_private.fail('idempotency-conflict', 'Операция содержит другие данные');
    end if;
    return receipt.result;
  end if;

  -- Same order as shift_open and financial writers: employee, then day, then row.
  perform pg_advisory_xact_lock(hashtextextended('shift-user:' || actor, 0));
  perform app_private.revenue_day_lock(p_location, p_day);
  select * into shift from public.work_shift where employee_id = actor and status = 'open';
  if found and (shift.location_id <> p_location or shift.day <> p_day) then
    perform app_private.fail('version-conflict', 'Сначала закройте открытую смену или обратитесь к руководителю');
  end if;

  if shift.id is null then
    select * into point from public.location
      where id = p_location and partner_id = employee.partner_id and id = any(employee.location_ids);
    if not found then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
    if point.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
    if exists (select 1 from public.work_shift where employee_id = actor and location_id = p_location and day = p_day) then
      perform app_private.fail('version-conflict', 'Смена за эту дату уже закрыта. Откройте её и сверьте суммы');
    end if;
    today := app_private.local_today(p_location);
    if p_day not between today - 1 and today then
      perform app_private.fail('validation', 'Новую смену можно сдать за сегодня или вчера. За другую дату обратитесь к руководителю', 'day');
    end if;
    insert into public.work_shift(partner_id, location_id, employee_id, day)
      values (point.partner_id, point.id, actor, p_day) returning * into shift;
  end if;
  result := public.shift_close(shift.id, p_cash, p_card, p_comment);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'shift_submit', payload, result);
  return result;
end $$;

revoke execute on function public.shift_submit(uuid,date,bigint,bigint,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.shift_submit(uuid,date,bigint,bigint,uuid,text) to authenticated;
insert into app_private.client_command(fn) values ('public.shift_submit(uuid,date,bigint,bigint,uuid,text)');

-- Legacy queued closes used to lock the shift row before entering shift_close,
-- which now takes the day lock first. Keep their receipt format and compare
-- the expected closing time under the same lock order as current clients.
create or replace function public.shift_close_checked(
  p_shift uuid, p_cash bigint, p_card bigint, p_expected_closed_at timestamptz, p_operation uuid, p_comment text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  actor uuid := app_private.require_user();
  receipt app_private.operation_receipt;
  shift public.work_shift;
  payload jsonb;
  result jsonb;
begin
  perform app_private.my_staff();
  if p_operation is null then perform app_private.fail('validation', 'Обновите приложение'); end if;
  payload := jsonb_build_object('shift', p_shift, 'cash', p_cash, 'card', p_card, 'comment', p_comment, 'expected_closed_at', p_expected_closed_at);
  perform pg_advisory_xact_lock(hashtextextended(actor::text || p_operation::text, 0));
  select * into receipt from app_private.operation_receipt where user_id = actor and operation_id = p_operation;
  if found then
    if receipt.command <> 'shift_close' or receipt.payload <> payload then perform app_private.fail('idempotency-conflict','Операция содержит другие данные'); end if;
    return receipt.result;
  end if;
  select * into shift from public.work_shift where id = p_shift and employee_id = actor;
  if not found then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  perform app_private.revenue_day_lock(shift.location_id, shift.day);
  select * into shift from public.work_shift where id = p_shift and employee_id = actor for update;
  if not found then perform app_private.fail('not-found', 'Смена не найдена'); end if;
  if shift.closed_at is distinct from p_expected_closed_at then
    perform app_private.fail('version-conflict', 'Смена уже изменена. Откройте её заново и сверьте суммы.');
  end if;
  if shift.status = 'closed' then
    perform app_private.fail('version-conflict', 'Обновите приложение для исправления закрытой смены. Запись сохранена, сверьте её заново');
  end if;
  result := public.shift_close(p_shift, p_cash, p_card, p_comment);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'shift_close', payload, result);
  return result;
end $$;

create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor, 'use_partner_motivation',s.use_partner_motivation, 'employee_kind',s.employee_kind,'internship_from',s.internship_from,'internship_until',s.internship_until,'internship_floor_minor',s.internship_floor_minor,'learning_enabled',s.learning_enabled,'pay_policy',app_private.staff_pay_policy(s.user_id,app_private.local_today(s.location_ids[1])),
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency)
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    -- Both submission dates stay visible when the selected history month changes.
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'currency', l.currency,
        'today', app_private.local_today(l.id),
        'pay_today', app_private.staff_pay_policy(v_user, app_private.local_today(l.id)),
        'pay_yesterday', app_private.staff_pay_policy(v_user, app_private.local_today(l.id) - 1),
        'my_today', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id)),
        'my_yesterday', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id) - 1))
        order by l.name)
      from public.location l where l.id = any(s.location_ids) and l.status = 'active'), '[]'::jsonb),
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;
