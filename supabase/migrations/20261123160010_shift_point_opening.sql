-- The opening date governs new retail shifts. Preserve existing shift records,
-- older clients and undated locations with recorded activity.
alter table public.work_shift add column submitted_without_open boolean not null default false;

create function app_private.point_has_recorded_activity(p_point uuid, p_today date) returns boolean
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.daily_revenue r where r.location_id = p_point and r.day <= p_today)
      or exists (select 1 from public.work_shift w where w.location_id = p_point and w.day <= p_today)
$$;

create function app_private.point_awaits_opening_date(p_point public.location, p_today date) returns boolean
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select p_point.opened_on is null
     and exists (select 1 from public.partner p where p.id = p_point.partner_id and p.preparation_stage is not null)
     and not app_private.point_has_recorded_activity(p_point.id, p_today)
$$;

create function app_private.require_shift_point_open(p_point public.location, p_day date) returns void
language plpgsql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  if p_day < p_point.opened_on then
    perform app_private.fail('validation', 'Точка ещё не была открыта в этот день', 'day');
  end if;
  if app_private.point_awaits_opening_date(p_point, app_private.local_today(p_point.id)) then
    perform app_private.fail('validation', 'Для точки ещё не указана дата открытия. Обратитесь к руководителю', 'day');
  end if;
end $$;

revoke execute on function app_private.point_has_recorded_activity(uuid,date),
  app_private.point_awaits_opening_date(public.location,date),
  app_private.require_shift_point_open(public.location,date)
from public, anon, authenticated, service_role;

-- Replaced staff RPCs keep their existing owners on native installations.
-- Only the trusted definers need the opening helpers and calendar columns.
do $acl$
declare trusted_owner name;
begin
  for trusted_owner in select rolname from pg_roles where rolname in ('postgres', 'supabase_admin') loop
    execute format('grant execute on function app_private.point_has_recorded_activity(uuid,date),
      app_private.point_awaits_opening_date(public.location,date),
      app_private.require_shift_point_open(public.location,date) to %I', trusted_owner);
    execute format('grant select (location_id, day) on app_private.revenue_day_off to %I', trusted_owner);
  end loop;
end $acl$;

create or replace function app_private.partner_launch_has_working_point(p_partner uuid) returns boolean
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  select exists (
    select 1 from public.location l where l.partner_id = p_partner and l.status = 'active' and (
      l.opened_on <= app_private.local_today(l.id)
      or (l.opened_on is null and app_private.point_has_recorded_activity(l.id, app_private.local_today(l.id)))
    )
  )
$$;

create or replace function public.shift_submit(
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
      where id = p_location and partner_id = employee.partner_id and id = any(employee.location_ids) for share;
    if not found then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
    if point.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
    if exists (select 1 from public.work_shift where employee_id = actor and location_id = p_location and day = p_day) then
      perform app_private.fail('version-conflict', 'Смена за эту дату уже закрыта. Откройте её и сверьте суммы');
    end if;
    today := app_private.local_today(p_location);
    if p_day not between today - 1 and today then
      perform app_private.fail('validation', 'Новую смену можно сдать за сегодня или вчера. За другую дату обратитесь к руководителю', 'day');
    end if;
    perform app_private.require_shift_point_open(point, p_day);
    insert into public.work_shift(partner_id, location_id, employee_id, day, submitted_without_open)
      values (point.partner_id, point.id, actor, p_day, true) returning * into shift;
  end if;
  result := public.shift_close(shift.id, p_cash, p_card, p_comment);
  insert into app_private.operation_receipt(user_id, operation_id, command, payload, result)
    values (actor, p_operation, 'shift_submit', payload, result);
  return result;
end $$;

create or replace function public.shift_open(p_location uuid) returns public.work_shift
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; l public.location; w public.work_shift; v_day date;
begin
  s := app_private.my_staff();
  perform pg_advisory_xact_lock(hashtextextended('shift-user:'||v_user,0));
  v_day := app_private.local_today(p_location);
  perform app_private.revenue_day_lock(p_location, v_day);
  select * into l from public.location where id = p_location and partner_id = s.partner_id for share;
  if not found or not (p_location = any(s.location_ids)) then perform app_private.fail('not-found', 'Эта точка вам не назначена'); end if;
  if l.status <> 'active' then perform app_private.fail('validation', 'Точка закрыта'); end if;
  select * into w from public.work_shift where employee_id = v_user and status = 'open';
  if found then
    if w.location_id = p_location then return w; end if;
    perform app_private.fail('validation', 'Сначала закройте смену на другой точке');
  end if;
  perform app_private.require_shift_point_open(l, v_day);
  if exists (select 1 from public.work_shift where employee_id = v_user and location_id = p_location and day = v_day) then
    perform app_private.fail('validation', 'Смена за сегодня уже закрыта. Исправить сумму можно в списке смен ниже');
  end if;
  insert into public.work_shift(partner_id, location_id, employee_id, day) values (l.partner_id, l.id, v_user, v_day) returning * into w;
  perform app_private.audit('shift.open', 'work_shift', w.id, l.partner_id);
  return w;
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
        'today', app_private.local_today(l.id), 'opened_on', l.opened_on,
        'awaiting_opening_date', app_private.point_awaits_opening_date(l, app_private.local_today(l.id)),
        'days_off', coalesce((select jsonb_agg(d.day order by d.day)
          from app_private.revenue_day_off d where d.location_id = l.id
            and d.day between app_private.local_today(l.id) - 1 and app_private.local_today(l.id)), '[]'::jsonb),
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
